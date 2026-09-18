"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Rules = require("../../rule_engine.js");
const { createTaskManager, evaluateObservableCriteria, taskExecutionSummary, updateTaskExecutionHistory } = require("../core/task_manager.js");
const { remainingTaskWindows, continuationErrors, normalizeWait } = require("../core/task_review.js");
const { scoringRecoveryEvidence } = require("../core/sae_runtime.js");
const { makeReplay } = require("../experiments/ai_replay.js");

function input() {
  return { side: "axis", turn: 4, phase: "axis_initial_movement", step: 20,
    state: { scenario: "july", turn: 4, phase: "axis_initial_movement", active_side: "axis", units: {
      own: { side: "axis", kind: "ground", hex: "3510", attack: 2, defense: 2, movement: 4, state: "fresh", supply_state: "supplied" },
      other: { side: "axis", kind: "ground", hex: "3411", attack: 2, defense: 2, movement: 4, state: "fresh", supply_state: "supplied" },
      enemy: { side: "allies", kind: "ground", hex: "3610", attack: 2, defense: 2, movement: 4, state: "fresh", supply_state: "supplied" }
    } } };
}

function evaluate(condition, ctx = input()) {
  const task = { id: "objective", subject_side: "axis", assigned_units: ["own"], completion_criteria: { all: [
    { id: "condition", relation: "at_least", evaluation_scope: "immediate", ...condition }
  ] } };
  return evaluateObservableCriteria(task.completion_criteria, task, {}, ctx);
}

test("enemy predicates infer their observed side from known units, never the executing side", () => {
  const condition = { metric: "surviving_unit_count", unit_ids: ["enemy"], target: 0, relation: "at_most" };
  const ctx = input();
  assert.equal(evaluate(condition, ctx).status, "not_met");
  assert.equal(evaluate(condition, ctx).conditions[0].subject_side, "allies");
  ctx.state.units.enemy.eliminated = true;
  assert.equal(evaluate(condition, ctx).status, "met");
  for (const patch of [{ subject_side: "axis" }, { unit_ids: ["missing"] }, { unit_ids: ["enemy", "own"] }]) {
    const result = evaluate({ ...condition, ...patch }, ctx);
    assert.equal(result.status, "unknown");
    assert.ok(result.validation_errors.length);
  }
});

test("column intervals compute occupancy, while malformed or reversed regions stay unknown", () => {
  const condition = { metric: "position", unit_ids: ["own", "other"], target: 0.5, target_region: { min_column: 35 } };
  assert.equal(evaluate(condition).status, "met");
  assert.equal(evaluate(condition).conditions[0].value, 0.5);
  assert.equal(evaluate({ ...condition, target_region: { min_column: 34, max_column: 35 }, target: 1 }).status, "met");
  for (const region of [{ min_column: 36, max_column: 34 }, { min_column: "35" }, {}, { min_column: 35, column: 35 }]) {
    assert.equal(evaluate({ ...condition, target_region: region }).status, "unknown");
  }
});

test("enemy displacement can satisfy an occupancy predicate without inventing a casualty", () => {
  const ctx = input();
  const condition = { metric: "units_at_target", unit_ids: ["enemy"], target: 0, relation: "at_most", target_hex: "3610" };
  assert.equal(evaluate(condition, ctx).status, "not_met");
  ctx.state.units.enemy.hex = "3711";
  assert.equal(evaluate(condition, ctx).status, "met");
  assert.equal(evaluate({ metric: "surviving_unit_count", target: 0, relation: "at_most", unit_ids: ["enemy"] }, ctx).status, "not_met");
});

test("model task dependency preferences stay soft and explicit hard prerequisites stay hard", () => {
  for (const [dependency, hard] of [["breach", false], [{ id: "breach", kind: "hard" }, true]]) {
    const ctx = input();
    const manager = createTaskManager({ executionLedger: true, taskGeneration: "model_defined", dependencyPolicy: "explicit_hard_default_soft_v2" });
    const plan = manager.initialize({ input: ctx, intent: { side: "axis" }, taskGeneration: "model_defined", rawPlan: { children: [
      { id: "breach", type: "breach", assigned_unit_ids: ["own"] },
      { id: "exploit", type: "exploit", assigned_unit_ids: ["other"], dependencies: [dependency] }
    ] } });
    const task = plan.children.find((item) => item.id === "exploit");
    assert.deepEqual(task.depends_on, hard ? ["breach"] : []);
    assert.deepEqual(task.soft_depends_on, hard ? [] : ["breach"]);
    assert.equal(task.status, hard ? "pending" : "active");
  }
});

test("continue and wait cannot manufacture an eighth July combat phase", () => {
  const ctx = input();
  Object.assign(ctx.state, { turn: 7, phase: "axis_mechanized_movement" });
  const task = { id: "breach", phase_scope: ["combat"], assigned_units: ["own"], completion_evidence: { status: "not_met" } };
  assert.equal(remainingTaskWindows(ctx, task).remaining_count, 0);
  assert.deepEqual(continuationErrors({ review_decision: "continue", next_action_at: { turn: 8, phase: "axis_combat", boundary: "start" } }, ctx, task), ["no_remaining_task_action_window"]);
  const wait = normalizeWait({ reason: "Try later", expected_change: "Another attack", condition: { kind: "phase_reached", turn: 8, phase: "axis_combat", boundary: "start" },
    review_at: { turn: 8, phase: "axis_combat", boundary: "end" } }, { input: ctx, task, plan: { children: [task] } });
  assert.ok(wait.errors.includes("review_point_after_game_end"));
  assert.ok(wait.errors.includes("no_remaining_task_action_window"));
});

test("review schedules respect September skipped phases and October Allies-first ordering", () => {
  const ctx = input();
  Object.assign(ctx.state, { scenario: "september", turn: 1, phase: "axis_supply_movement" });
  ctx.side = "allies";
  const september = remainingTaskWindows(ctx, { phase_scope: ["initial_movement"] });
  assert.ok(!september.windows.some((window) => window.turn === 1));
  Object.assign(ctx.state, { scenario: "october", turn: 15, phase: "axis_initial_movement" });
  assert.equal(remainingTaskWindows(ctx, { phase_scope: ["combat"] }).remaining_count, 0);
});

test("every scenario and side can use legal combat actions beyond historical phase quotas", async () => {
  for (const scenario of ["july", "september", "october"]) for (const side of ["axis", "allies"]) {
    const replay = makeReplay(scenario);
    replay.state.phase = `${side}_combat`; replay.state.active_side = side;
    replay.state.ai_phase_action_counts[`${scenario}:${replay.state.turn}:${replay.state.phase}`] = 20;
    assert.equal(replay.debugPhaseActionLimit(side), 0);
    let calls = 0;
    const result = await replay.playWithProvider({ maxSteps: 1, externalSide: side, async externalAction() {
      calls += 1; return { action: { type: "pass", reason: "model choice" } };
    } });
    assert.equal(calls, 1);
    assert.ok(!result.log.some((event) => event.action === "budget_then_advance"));
    const legacy = makeReplay(scenario, { combatPhasePolicy: "combat_experiment_budget" });
    legacy.state.phase = `${side}_combat`;
    assert.equal(legacy.debugPhaseActionLimit(side), scenario === "july" ? side === "axis" ? 3 : 2 : 1);
  }
});

test("scoring recovery reports forward isolated units as alternatives, without changing game state", () => {
  const inputState = input().state;
  inputState.units.other.hex = "3616";
  const ctx = Rules.createContext({ state: inputState, rules: Rules.DEFAULT_RULES, terrain: { hexes: {}, edges: {} } });
  const before = JSON.stringify(inputState);
  const evidence = scoringRecoveryEvidence(ctx, "axis", { children: [] }, { own: "supplied", other: "isolated" });
  assert.equal(evidence.current_scoring_column, 35);
  assert.equal(evidence.units_without_scoring_supply[0].unit, "other");
  assert.equal(evidence.units_without_scoring_supply[0].vp_gain_if_resupplied_now, 3);
  assert.match(evidence.units_without_scoring_supply[0].recovery_feasibility, /unknown/);
  assert.equal(JSON.stringify(inputState), before);
  assert.equal(scoringRecoveryEvidence(ctx, "allies"), null);
  ctx.state.scenario = "october";
  assert.equal(scoringRecoveryEvidence(ctx, "axis"), null);
});

test("deterministic blocked targets remain forbidden after another task action", () => {
  const plan = { side: "axis", children: [{ id: "approach-3609", type: "advance", status: "active",
    assigned_units: ["own"], target_hex: "3609", execution_history: [] }] };
  const context = input();
  const failed = { execution_ledger: { events: [{ event_id: "blocked-1", status: "attempt", accepted: false,
    task_id: "approach-3609", unit: "own", failure_class: "path_unavailable", requested_target: "3609", reason: "all_sea" }] },
    phase_unit_plan: { unit_orders: [] } };
  updateTaskExecutionHistory(plan, failed, context);
  const task = plan.children[0];
  assert.equal(task.status, "blocked");
  assert.equal(task.execution_blocked, true);
  assert.equal(task.repeat_allowed, false);
  assert.equal(task.blocking_mode, "permanent");
  assert.ok(task.blocked_targets.some((entry) => entry.target_hex === "3609"));

  updateTaskExecutionHistory(plan, { execution_ledger: { events: [{ event_id: "other-1", status: "executed",
    task_id: "approach-3609", unit: "own", executed_target: "3410" }] } }, context);
  assert.equal(task.execution_blocked, true);
  assert.ok(taskExecutionSummary(plan).forbidden_targets.some((entry) => entry.target_hex === "3609"));

  const manager = createTaskManager({ executionLedger: true, taskGeneration: "model_defined" });
  manager.initialize({ input: context, intent: { side: "axis" }, rawPlan: { children: [
    { id: "first", type: "advance", target_hex: "3609", assigned_unit_ids: ["own"] }
  ] } });
  manager.observe(context, failed);
  const replanned = manager.initialize({ input: { ...context, step: 2 }, intent: { side: "axis" }, preserveParent: true,
    rawPlan: { children: [{ id: "renamed", type: "advance", target_hex: "3609", assigned_unit_ids: ["other"] }] } });
  const renamed = replanned.children.find((item) => item.target_hex === "3609");
  assert.equal(renamed.status, "blocked");
  assert.equal(renamed.execution_blocked, true);
  assert.ok(renamed.normalization_corrections.some((item) => item.correction === "blocked_target_rejected_on_replan"));
});
