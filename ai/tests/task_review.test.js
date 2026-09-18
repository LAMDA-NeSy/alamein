"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createTaskManager } = require("../core/task_manager.js");
const { REVIEW_POLICY, normalizeWait, reachedPoint, remainingTaskWindows, continuationErrors } = require("../core/task_review.js");
const { checkerPayload, createTaskCheckerRuntime } = require("../core/task_checker_runtime.js");

function fixture(side = "axis", scenario = "july") {
  const state = { scenario, turn: 1, phase: `${side}_initial_movement`, active_side: side, units: {
    main: { side, kind: "ground", hex: "3210", state: "fresh", supply_state: "isolated", attack: 2, defense: 2, movement: 4 },
    supply: { side, kind: "supply", hex: "3211", state: "fresh", supply_state: "supplied", movement: 4 },
    reserve: { side, kind: "ground", hex: "3212", state: "fresh", supply_state: "supplied", attack: 2, defense: 2, movement: 4 }
  } };
  const input = { state, side, turn: 1, phase: state.phase, step: 1 };
  const manager = createTaskManager({ executionLedger: true, taskGeneration: "model_defined", reviewPolicy: REVIEW_POLICY, noProgressThreshold: 2 });
  const args = { input, intent: { side }, allocation: { spearhead: [{ unit: "main" }], supply: [{ unit: "supply" }],
    support: [], reserve: ["reserve"] }, rawPlan: { children: [
    { id: "main_task", task_type: "maneuver", assigned_unit_ids: ["main"], applicable_phases: ["initial_movement"],
      completion_criteria: { all: [{ metric: "position", relation: "at_least", target: 1, target_hex: "3310", unit_ids: ["main"], evaluation_scope: "immediate" }] } },
    { id: "supply_task", task_type: "supply", assigned_unit_ids: ["supply"],
      completion_criteria: { all: [{ metric: "unit_supply", relation: "at_least", target: 1, beneficiary_unit_ids: ["main"], evaluation_scope: "immediate" }] } },
    { id: "reserve_task", task_type: "reserve", assigned_unit_ids: ["reserve"] }
  ] }, taskGeneration: "model_defined" };
  manager.initialize(args);
  const observe = (extra = {}) => manager.observe(input, { turn: input.turn, phase: input.phase, step: input.step,
    final_action: { type: "pass" }, ...extra });
  observe();
  return { state, input, manager, args, observe };
}

function decide(f, decision, wait = null, patch = {}) {
  const request = f.manager.pendingReviews(f.input)[0];
  assert.ok(request, "a review must be pending");
  return f.manager.applyCheck({ task_id: request.task_id, review_id: request.id, review_decision: decision,
    next_action_at: remainingTaskWindows(f.input, f.manager.plan.children.find((task) => task.id === request.task_id)).next,
    confidence: 0.9, abstain: false, task_status: "continue", reason: "Preparation remains viable.",
    evidence: { step: f.input.step, state_change: "The next supply phase has not occurred." }, wait, ...patch }, f.input);
}

function waitForSupply(f) {
  return { reason: "Wait for supplied main force, not for the truck's own supply.",
    expected_change: "The supply unit can restore the main force before its next movement phase.",
    condition: { kind: "observable", criteria: { all: [{ metric: "unit_supply", relation: "at_least", target: 1,
      subject_side: f.input.side, beneficiary_unit_ids: ["main"], evaluation_scope: "immediate" }] } },
    review_at: { turn: 1, phase: `${f.input.side}_supply_movement`, boundary: "end" } };
}

function advance(f, turn, phase, step = f.input.step + 1) {
  Object.assign(f.state, { turn, phase });
  Object.assign(f.input, { turn, phase, step });
  return f.manager.refresh(f.input);
}

test("a model wait is advisory, survives phases, and is reviewed only after the specified boundary", () => {
  for (const side of ["axis", "allies"]) {
    const f = fixture(side);
    const before = structuredClone(f.state);
    const plan = decide(f, "wait", waitForSupply(f));
    assert.equal(plan.children[0].wait_state.status, "waiting");
    assert.equal(plan.children[0].status, "active");
    assert.deepEqual(f.state, before);
    advance(f, 1, `${side}_supply_movement`);
    assert.equal(f.manager.pendingReviews(f.input).length, 0);
    assert.equal(f.manager.needsReplan(), false);
    advance(f, 2, `${side}_initial_movement`);
    assert.equal(f.manager.pendingReviews(f.input)[0].reasons[0], "wait_review_due");
    assert.equal(f.manager.plan.children[0].status, "active");
    assert.equal(f.manager.needsReplan(), false);
    const id = f.manager.pendingReviews(f.input)[0].id;
    f.manager.refresh(f.input);
    assert.equal(f.manager.pendingReviews(f.input)[0].id, id);
  }
});

test("waiting releases early on verified beneficiary supply, not on the truck's supply", () => {
  const f = fixture();
  decide(f, "wait", waitForSupply(f));
  advance(f, 1, "axis_combat");
  assert.equal(f.manager.pendingReviews(f.input).length, 0);
  f.state.units.main.supply_state = "supplied";
  f.manager.refresh(f.input);
  assert.equal(f.manager.pendingReviews(f.input)[0].reasons[0], "wait_condition_met");
  assert.equal(f.manager.needsReplan(), false);
  assert.equal(f.manager.plan.children[0].status, "active");
});

test("loss of a watched prerequisite unit interrupts waiting before its due phase", () => {
  const f = fixture();
  const wait = waitForSupply(f);
  wait.condition.criteria.all[0].beneficiary_unit_ids.push("supply");
  decide(f, "wait", wait);
  f.state.units.supply.eliminated = true;
  advance(f, 1, "axis_combat");
  assert.equal(f.manager.pendingReviews(f.input)[0].reasons[0], "wait_key_unit_lost");
});

test("waiting survives semantic task reuse and keeps its original review appointment", () => {
  const f = fixture();
  const original = decide(f, "wait", waitForSupply(f)).children[0].wait_state;
  f.manager.initialize({ ...f.args, preserveParent: true });
  assert.deepEqual(f.manager.plan.children[0].wait_state, original);
  assert.equal(f.manager.plan.children[0].review_history.length, 1);
});

test("expired waiting requests another decision, never an automatic strategic reset", () => {
  const f = fixture();
  decide(f, "wait", waitForSupply(f));
  advance(f, 2, "axis_initial_movement");
  const before = f.manager.plan.parent.id;
  decide(f, "continue");
  assert.equal(f.manager.needsReplan(), false);
  assert.equal(f.manager.plan.parent.id, before);
  assert.equal(f.manager.plan.children[0].wait_state.status, "reviewed");
});

test("only an evidence-backed current review may request strategic replanning", () => {
  const f = fixture();
  const request = f.manager.pendingReviews(f.input)[0];
  decide(f, "replan", null, { review_id: "stale" });
  assert.equal(f.manager.needsReplan(), false);
  assert.deepEqual(f.manager.plan.children[0].review_history[0].errors, ["stale_or_missing_review_id"]);
  decide(f, "replan", null, { review_id: request.id });
  assert.equal(f.manager.consumeReplanReason(), "task_checker_requested_replan");
  assert.equal(f.manager.plan.children[0].status, "active");
});

test("renewal needs an explicit reassessment and another future review appointment", () => {
  const f = fixture();
  decide(f, "wait", waitForSupply(f));
  advance(f, 2, "axis_initial_movement");
  const renewed = waitForSupply(f);
  renewed.review_at.turn = 2;
  decide(f, "wait", renewed);
  assert.ok(f.manager.plan.children[0].review_history.at(-1).errors.includes("renewed_wait_requires_reassessment_reason"));
  renewed.renewal_reason = "The supply unit survives and has another supply phase; the required route remains available.";
  decide(f, "wait", renewed);
  assert.equal(f.manager.plan.children[0].wait_state.review_at.turn, 2);
  assert.equal(f.manager.plan.children[0].review_history.at(-1).accepted, true);
  assert.equal(f.manager.needsReplan(), false);
});

test("invalid waits are logged and cannot silently postpone a task", () => {
  for (const mutate of [
    (wait) => { wait.reason = ""; },
    (wait) => { wait.review_at = { turn: 1, phase: "axis_initial_movement", boundary: "start" }; },
    (wait) => { wait.review_at.turn = 8; },
    (wait) => { wait.condition.kind = "some_day"; },
    (wait) => { wait.condition.criteria = {}; },
    (wait) => { wait.condition.criteria.all[0].beneficiary_unit_ids = ["missing"]; },
    (wait) => { wait.condition.criteria.all[0].metric = "unverified"; }
  ]) {
    const f = fixture();
    const wait = waitForSupply(f); mutate(wait);
    decide(f, "wait", wait);
    assert.equal(f.manager.plan.children[0].wait_state, undefined);
    assert.equal(f.manager.plan.children[0].review_history[0].accepted, false);
    assert.equal(f.manager.pendingReviews(f.input).length, 1);
    assert.equal(f.manager.needsReplan(), false);
  }
});

test("phase appointments follow October Allies-first order and September's skipped phase", () => {
  const f = fixture("allies", "october");
  assert.equal(reachedPoint({ turn: 1, phase: "allies_supply_movement", boundary: "end" },
    { ...f.input, state: { ...f.state, phase: "axis_initial_movement" } }), true);
  const september = fixture("axis", "september");
  const result = normalizeWait({ reason: "wait", condition: { kind: "task_condition_met", task_id: "supply_task" },
    review_at: { turn: 1, phase: "allies_initial_movement", boundary: "end" } },
  { input: september.input, task: september.manager.plan.children[0], plan: september.manager.plan, evaluate() {} });
  assert.ok(result.errors.includes("review_phase_not_reachable_in_schedule"));
});

test("failed checker reviews are deferred to a later phase without losing the pending event", () => {
  const f = fixture();
  const ids = f.manager.pendingReviews(f.input).map((request) => request.id);
  f.manager.recordReviewAttempt(ids, f.input, { ok: false, fallback: true, reason: "network failure" });
  assert.deepEqual(f.manager.pendingReviews(f.input), []);
  f.input.step += 1;
  assert.deepEqual(f.manager.pendingReviews(f.input), []);
  advance(f, 1, "axis_combat");
  assert.equal(f.manager.pendingReviews(f.input)[0].id, ids[0]);
  assert.equal(f.manager.needsReplan(), false);
});

test("dependency waiting can release on currently met evidence without terminal completion", () => {
  const f = fixture();
  f.args.rawPlan.children[1].completion_criteria.all[0].evaluation_scope = "game_end";
  f.manager.initialize({ ...f.args, preserveParent: true });
  decide(f, "wait", { reason: "Wait for the supporting task's current conditions.", expected_change: "The supply task can restore the main force.",
    condition: { kind: "task_condition_met", task_id: "supply_task" },
    review_at: { turn: 2, phase: "axis_initial_movement", boundary: "start" } });
  f.state.units.main.supply_state = "supplied";
  advance(f, 1, "axis_combat");
  assert.equal(f.manager.pendingReviews(f.input)[0].reasons[0], "wait_condition_met");
  assert.notEqual(f.manager.plan.children.find((task) => task.id === "supply_task").status, "completed");
});

test("a stale-step review cannot request replanning even with a matching review ID", () => {
  const f = fixture();
  decide(f, "replan", null, { evidence: { step: 0, state_change: "Old observation" } });
  assert.ok(f.manager.plan.children[0].review_history.at(-1).errors.includes("review_evidence_step_mismatch"));
  assert.equal(f.manager.needsReplan(), false);
});

test("review calls share the unchanged four-call turn limit", async () => {
  const f = fixture();
  let calls = 0;
  const checker = createTaskCheckerRuntime({ maxCallsPerTurn: 4, client: { async complete() {
    calls += 1;
    throw new Error("network failure");
  } }, runtime: { profile: { defaults: {}, limits: { output: 2048 }, capabilities: {} } } });
  for (let step = 1; step <= 5; step += 1) {
    const result = await checker.check({ input: { ...f.input, step }, taskPlan: f.manager.plan,
      events: ["wait_review_due"], reviewRequests: f.manager.pendingReviews(f.input) });
    if (step === 5) assert.equal(result.reason, "turn_check_limit");
    else assert.equal(result.fallback, true);
  }
  assert.equal(calls, 4);
  assert.equal(f.manager.needsReplan(), false);
});

test("no-progress reviews count task action windows, not repeated actions or holds", () => {
  const f = fixture();
  decide(f, "continue");
  const move = { type: "move", unit: "main", destination: "3210" };
  const movement = { final_action: move, action_attempts: [{ accepted: true, action: move }] };
  for (let step = 2; step < 8; step += 1) { f.input.step = step; f.observe(movement); }
  assert.equal(f.manager.needsReplan(), false);
  assert.equal(f.manager.plan.children[0].stagnant_windows || 0, 0);
  // Start fresh windows so the fixture's initial phase-end record is not reused.
  for (let turn = 2; turn <= 3; turn += 1) {
    advance(f, turn, "axis_initial_movement");
    f.observe(movement); f.observe();
  }
  assert.equal(f.manager.plan.children[0].stagnant_windows, 2);
  assert.ok(f.manager.pendingReviews(f.input)[0].reasons.includes("task_no_progress"));
  assert.equal(f.manager.needsReplan(), false);
});

test("stagnation uses the same movement and supply aliases as task dispatch", () => {
  for (const [scope, phase] of [["movement", "axis_initial_movement"], ["supply", "axis_supply_movement"]]) {
    const f = fixture();
    f.args.rawPlan.children[0].applicable_phases = [scope];
    f.manager.initialize(f.args);
    const action = { type: "move", unit: "main", destination: "3210" };
    for (let turn = 2; turn <= 3; turn += 1) {
      advance(f, turn, phase);
      f.observe({ final_action: action, action_attempts: [{ accepted: true, action }] });
      f.observe();
    }
    assert.equal(f.manager.plan.children[0].stagnant_windows, 2, scope);
    assert.ok(f.manager.pendingReviews(f.input).some((request) => request.reasons.includes("task_no_progress")), scope);
    assert.equal(f.manager.needsReplan(), false);
  }
});

test("waiting suppresses ordinary phase-end reviews and hold-only stagnation", () => {
  const f = fixture();
  decide(f, "wait", waitForSupply(f));
  advance(f, 1, "axis_combat");
  const observed = f.observe({ execution_ledger: { events: [{ status: "held", unit: "main", event_id: "hold" }] } });
  assert.deepEqual(observed.checker_events, []);
  assert.equal(f.manager.plan.children[0].stagnant_windows || 0, 0);
  assert.equal(f.manager.needsReplan(), false);
});

test("checker payload includes waiting and blocked review tasks with separate action and observation clocks", () => {
  const f = fixture();
  const plan = f.manager.plan;
  plan.children[0].status = "blocked";
  const payload = checkerPayload({ input: f.input, taskPlan: plan, reviewRequests: f.manager.pendingReviews(f.input),
    stepRecord: { step: 0, turn: 1, phase: "axis_combat" }, events: ["wait_review_due"] });
  assert.equal(payload.protocol, "task-check-review-v4-action-windows");
  assert.equal(payload.review_tasks[0].id, "main_task");
  assert.equal(payload.action_origin.phase, "axis_combat");
  assert.equal(payload.current_clock.phase, "axis_initial_movement");
});

test("checker invalid review IDs fall back and preserve the local game state", async () => {
  const f = fixture();
  const before = structuredClone(f.state);
  const checker = createTaskCheckerRuntime({ client: { async complete() { return { ok: true, status: 200,
    response_json: { choices: [{ message: { content: JSON.stringify({ type: "task_check", task_id: "main_task",
      review_id: "other", review_decision: "replan", confidence: 0.9, evidence: { state_change: "unchanged" } }) } }] } }; } },
  runtime: { profile: { defaults: {}, limits: { output: 2048 }, capabilities: { structured_output: true } } } });
  const result = await checker.check({ input: f.input, taskPlan: f.manager.plan,
    events: ["wait_review_due"], reviewRequests: f.manager.pendingReviews(f.input) });
  assert.equal(result.fallback, true);
  assert.match(result.reason, /invalid review/);
  assert.deepEqual(f.state, before);
});
