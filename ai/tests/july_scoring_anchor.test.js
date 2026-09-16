"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const RulesEngine = require("../../rule_engine.js");
const { createTaskManager, buildTaskSkeleton, normalizeTaskPlan, phaseDispatchTasks } = require("../core/task_manager.js");
const { compactAgentPayload } = require("../core/agent_context.js");

function input(column = 34, supply = "supplied", extra = {}) {
  const state = { scenario: "july", turn: 1, phase: "axis_initial_movement", active_side: "axis", units: {
    u: { side: "axis", kind: "ground", hex: `${column}10`, supply_state: supply, attack: 3, defense: 3, movement: 4, state: "fresh" }
  }, ...extra };
  return { state, turn: state.turn, phase: state.phase, side: state.active_side };
}

const findAnchor = (plan) => plan.children.find((task) => task.type === "preserve_scoring_anchor");
const modelTask = (id, unit = "u") => ({ id, task_type: "maneuver", assigned_unit_ids: [unit] });
function managerAt(initial = input(), children = [modelTask("maneuver")]) {
  const manager = createTaskManager({ executionLedger: true, taskProtocol: "side-aware-task-v4",
    taskGeneration: "model_defined", scoringAnchorPolicy: "july_terminal_v1" });
  manager.initialize({ input: initial, intent: { side: "axis" }, operation: "test", rawPlan: { children } });
  return manager;
}

test("July anchor is opt-in and never added for Allies or other scenarios", () => {
  for (const scenario of ["july", "september", "october"]) for (const side of ["axis", "allies"]) {
    const state = input(34, "supplied", { scenario, active_side: side }).state;
    const plan = buildTaskSkeleton({ state, side, taskGeneration: "model_defined", scoringAnchorPolicy: "july_terminal_v1" });
    assert.equal(!!findAnchor(plan), scenario === "july" && side === "axis");
    assert.equal(!!findAnchor(buildTaskSkeleton({ state, side, taskGeneration: "model_defined" })), false);
  }
});

test("unsupplied arrival is not secured and terminal loss is evidenced", () => {
  const manager = managerAt();
  assert.equal(findAnchor(manager.plan).target_column, 35);
  assert.equal(findAnchor(manager.plan).progress, 0);
  let anchor = findAnchor(manager.refresh(input(35, "isolated")));
  assert.equal(anchor.scoring_anchor_state, "reached");
  assert.equal(anchor.completion_evidence.status, "not_met");
  assert.equal(anchor.completion_evidence.scope_ready, false);
  assert.equal(anchor.status, "active");
  anchor = findAnchor(manager.refresh(input(35, "partially_supplied")));
  assert.equal(anchor.scoring_anchor_state, "secured");
  assert.equal(anchor.status, "active");
  manager.refresh(input(35, "unsupplied"));
  assert.equal(findAnchor(manager.plan).scoring_anchor_state, "lost");
  assert.equal(manager.consumeReplanReason(), "scoring_anchor_lost");
  anchor = findAnchor(manager.settle(input(34, "supplied", { turn: 7, phase: "end_game_turn" })));
  assert.equal(anchor.status, "failed");
  assert.equal(anchor.completion_evidence.scope_ready, true);
  assert.equal(anchor.failure_evidence.status, "not_met");
});

test("replanning preserves the high-water column and deduplicates each distinct loss", () => {
  const manager = managerAt(input(36));
  assert.equal(findAnchor(manager.plan).target_column, 36);
  manager.refresh(input(35));
  assert.equal(manager.consumeReplanReason(), "scoring_anchor_lost");
  manager.initialize({ input: input(35), intent: { side: "axis" }, operation: "new-operation",
    rawPlan: { children: [modelTask("different-task")] }, preserveParent: true });
  assert.equal(findAnchor(manager.plan).target_column, 36);
  assert.equal(findAnchor(manager.plan).scoring_anchor_loss_count, 1);
  manager.refresh(input(34));
  assert.equal(manager.consumeReplanReason(), "");
  assert.equal(manager.plan.strategic_events.filter((event) => event.reason === "scoring_anchor_lost").length, 1);
  manager.refresh(input(37));
  assert.equal(findAnchor(manager.plan).target_column, 37);
  manager.refresh(input(36));
  assert.equal(manager.consumeReplanReason(), "scoring_anchor_lost");
  assert.equal(findAnchor(manager.plan).scoring_anchor_loss_count, 2);
  const settled = findAnchor(manager.settle(input(37, "supplied", { turn: 7, phase: "end_game_turn" })));
  assert.equal(settled.status, "completed");
  assert.equal(settled.completion_evidence.status, "met");
  assert.equal(settled.completion_evidence.conditions[0].target, 37);
  assert.equal(settled.completion_evidence.conditions[0].value, 37);
});

test("post-action anchor losses are recorded immediately without assigning the acting unit", () => {
  const manager = managerAt(input(35));
  const observed = manager.observe(input(34), { final_action: { type: "move", unit: "u", destination: "3410" },
    action_applied: { applied: true, result: { legal: true } }, execution_ledger: { events: [] } });
  assert.equal(findAnchor(observed.plan).scoring_anchor_state, "lost");
  assert.equal(observed.task_progress_delta.july_scoring_anchor.delta, -1);
  assert.equal(manager.consumeReplanReason(), "scoring_anchor_lost");
  assert.deepEqual(findAnchor(observed.plan).assigned_units, []);
});

test("monitor does not consume execution slots or appear as a blocked executable task", () => {
  const initial = input();
  for (const id of ["v", "w"]) initial.state.units[id] = { ...initial.state.units.u, hex: "3310" };
  const manager = managerAt(initial, [modelTask("one"), modelTask("two", "v"), modelTask("three", "w")]);
  const plan = manager.refresh(initial);
  assert.equal(plan.children.filter((task) => task.status === "active" && !task.observation_only).length, 3);
  const dispatch = phaseDispatchTasks(plan, initial);
  assert.equal(dispatch.blocked_tasks.some((task) => task.id === findAnchor(plan).id), false);
  assert.notEqual(dispatch.primary_task_id, findAnchor(plan).id);
});

test("model task ID collisions cannot override the local invariant", () => {
  const initial = input();
  const skeleton = buildTaskSkeleton({ ...initial, taskGeneration: "model_defined", scoringAnchorPolicy: "july_terminal_v1" });
  const plan = normalizeTaskPlan({ children: [modelTask("july_scoring_anchor")] }, skeleton, { ...initial, allocation: {} });
  assert.equal(new Set(plan.children.map((task) => task.id)).size, plan.children.length);
  assert.equal(findAnchor(plan).source, "local_safety_invariant");
  assert.deepEqual(findAnchor(plan).assigned_units, []);
  const manager = managerAt();
  const replanned = manager.initialize({ input: initial, intent: { side: "axis" }, preserveParent: true,
    rawPlan: { children: [modelTask("july_scoring_anchor"), modelTask("preserve_scoring_anchor")] } });
  assert.equal(new Set(replanned.children.map((task) => task.id)).size, replanned.children.length);
  assert.equal(findAnchor(replanned).id, "july_scoring_anchor");
  assert.equal(findAnchor(replanned).observation_only, true);
});

test("compact execution context keeps anchor state and loss evidence", () => {
  const manager = managerAt(input(35));
  const plan = manager.refresh(input(34));
  const anchor = findAnchor(plan);
  const compact = compactAgentPayload({ context: { operation_state: { task_plan: plan,
    tactical_summary: { scoring_anchor: anchor } } } });
  const retained = compact.context.operation_state.tactical_summary.scoring_anchor;
  assert.equal(retained.observation_only, true);
  assert.equal(retained.scoring_anchor_state, "lost");
  assert.equal(retained.scoring_anchor_loss_count, 1);
  assert.equal(retained.completion_evidence.conditions[0].value, 34);
});

test("anchor uses authoritative rule supply instead of stale unit supply labels", () => {
  const state = structuredClone(require("../../scenarios/july.json"));
  const terrain = require("../../terrain.json");
  const rules = require("../../rules_el_alamein.json");
  const id = Object.keys(state.units).find((id) => state.units[id].side === "axis" && RulesEngine.isCombatUnit(state.units[id]));
  state.units[id].hex = "4910";
  state.units[id].supply_state = "supplied";
  const ctx = RulesEngine.createContext({ state, rules, terrain });
  const before = JSON.stringify(state);
  const expected = RulesEngine.checkVictory(ctx).breakdown.find((item) => item.id === "july_east_of_3400")?.farthest_column || 34;
  assert.ok(expected < 49);
  const manager = managerAt({ state, ctx, side: "axis", turn: 1, phase: state.phase });
  const anchor = findAnchor(manager.plan);
  assert.equal(anchor.current_metrics.global_farthest_scoring_column, expected);
  assert.equal(anchor.target_column, Math.max(35, expected));
  assert.equal(JSON.stringify(state), before);
});
