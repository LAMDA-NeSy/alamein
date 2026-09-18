"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Rules = require("../../rule_engine.js");
const { createTaskManager, phaseDispatchTasks, axisTacticalOpportunities } = require("../core/task_manager.js");
const { compactAgentPayload } = require("../core/agent_context.js");
const { continuationErrors } = require("../core/task_review.js");
const { checkerPayload } = require("../core/task_checker_runtime.js");

function fixture({ scenario = "july", side = "axis", phase = "axis_combat", children } = {}) {
  const state = { scenario, turn: 2, phase, active_side: side, units: {
    a: { side: "axis", hex: "3515", state: "fresh", attack: 100, defense: 2, movement: 4, kind: "ground" },
    b: { side: "axis", hex: "3210", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
    e: { side: "allies", hex: "3516", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
  } };
  const ctx = Rules.createContext({ state, rules: Rules.DEFAULT_RULES, terrain: { hexes: {}, edges: {} } });
  const input = { state, side, turn: 2, phase, ctx, step: 1 };
  const manager = createTaskManager({ taskGeneration: "model_defined", taskProtocol: "side-aware-task-v4",
    executionLedger: true, monitorPolicy: "separate_monitors_v1", scoringAnchorPolicy: "july_terminal_v1" });
  const args = { input, intent: { side }, operation: "chosen_operation", allocation: {},
    rawPlan: { children: children || [{ id: "advance", type: "maneuver", assigned_unit_ids: ["a"],
      applicable_phases: ["initial_movement", "mechanized_movement"] }] } };
  manager.initialize(args);
  return { manager, input, ctx, state, args };
}

const localTask = (manager) => manager.plan.children.find((task) => task.activation_policy === "rule_verified_breakthrough_contact");

function combat(f) {
  const action = { type: "combat", attackers: ["a"], defender_hexes: ["3516"] };
  const result = Rules.resolveCombat(f.ctx, { ...action, die: 1, auto_retreat: true });
  assert.equal(result.legal, true);
  return { final_action: action, action_attempts: [{ accepted: true }], action_applied: { applied: true, result } };
}

test("omitted July blocker track is conditional and phase dispatched without taking ownership", () => {
  const f = fixture({ phase: "axis_initial_movement" });
  const pending = localTask(f.manager);
  assert.equal(pending.status, "pending");
  assert.ok(pending.combat_preparation.length);
  assert.equal(pending.target_hex, undefined);
  assert.deepEqual(pending.assigned_units, []);
  f.state.phase = f.input.phase = "axis_combat";
  const plan = f.manager.refresh(f.input);
  const dispatch = phaseDispatchTasks(plan, f.input);
  assert.equal(localTask(f.manager).status, "active");
  assert.equal(dispatch.primary_task_id, pending.id);
  assert.deepEqual(plan.children.find((task) => task.id === "advance").assigned_units, ["a"]);
  assert.deepEqual(localTask(f.manager).assigned_units, []);
  assert.deepEqual(localTask(f.manager).compatible_units, ["a"]);
  assert.deepEqual(continuationErrors({ review_decision: "continue",
    next_action_at: { turn: 2, phase: "axis_combat", boundary: "start" } }, f.input, localTask(f.manager)), []);
});

test("full model plans retain all six tasks and expose the omitted blocker planning gap", () => {
  const children = Array.from({ length: 6 }, (_, i) => ({ id: `plan_${i}`, type: "maneuver", priority: i + 1,
    assigned_unit_ids: i === 0 ? ["a"] : i === 1 ? ["b"] : [], applicable_phases: ["initial_movement"] }));
  const f = fixture({ children });
  assert.deepEqual(f.manager.plan.children.map((task) => task.id), children.map((task) => task.id));
  assert.equal(localTask(f.manager), undefined);
  assert.equal(f.manager.plan.breakthrough_planning.missing_model_task, true);
  assert.ok(f.manager.plan.breakthrough_planning.candidate_count > 0);
  assert.ok(f.manager.plan.normalization_corrections.some((item) => item.correction === "breakthrough_review_requires_model_task"));
});

test("blocker planning neither completes model tasks by name nor overrides hard dependencies", () => {
  const f = fixture({ children: [
    { id: "supply", type: "supply", assigned_unit_ids: ["b"], applicable_phases: ["supply_movement"] },
    { id: "breach", type: "clear_blocker", assigned_unit_ids: ["a"], applicable_phases: ["initial_movement", "combat"],
      hard_dependencies: ["supply"] }
  ] });
  assert.equal(localTask(f.manager), undefined);
  const breach = f.manager.plan.children.find((task) => task.id === "breach");
  assert.equal(breach.model_task_type, "clear_blocker");
  assert.ok(breach.candidate_blockers.length);
  assert.equal(breach.status, "pending");
  assert.equal(phaseDispatchTasks(f.manager.plan, f.input).tasks.some((task) => task.id === "breach"), false);
  const result = f.manager.observe(f.input, combat(f));
  assert.notEqual(result.plan.children.find((task) => task.id === "breach").status, "completed");
});

test("only an applied effect on a presented combat target resolves the local blocker track", () => {
  const f = fixture();
  const checks = [
    { final_action: { type: "move", unit: "a", destination: "3515" }, action_applied: { applied: true, result: { legal: true } } },
    { final_action: { type: "pass" }, action_applied: { applied: true, result: { legal: true } } },
    { final_action: { type: "combat", attackers: ["a"], defender_hexes: ["3516"] },
      action_applied: { applied: true, result: { legal: true, details: { defenders: ["e"], effects: { eliminated: [] } } } } },
    { final_action: { type: "combat", attackers: ["a"], defender_hexes: ["3516"] },
      action_applied: { applied: false, result: { legal: true, details: { defenders: ["e"], effects: { eliminated: ["e"] } } } } },
    { final_action: { type: "combat", attackers: ["a"], defender_hexes: ["3516"] },
      action_applied: { applied: true, result: { legal: true, details: { defenders: ["other"], effects: { eliminated: ["other"] } } } } }
  ];
  for (const record of checks) {
    f.manager.observe(f.input, { ...record, action_attempts: [{ accepted: true }] });
    assert.notEqual(localTask(f.manager).status, "completed");
  }
  const observed = f.manager.observe(f.input, combat(f));
  const task = localTask(f.manager);
  assert.equal(task.status, "completed");
  assert.equal(task.completion_evidence.status, "met");
  assert.equal(task.blocker_resolution.route_open_verified, false);
  assert.deepEqual(task.blocker_resolution.affected_defender_ids, ["e"]);
  assert.ok(observed.events.includes("task_completed"));
  f.manager.refresh(f.input);
  assert.equal(localTask(f.manager).status, "completed");
  f.manager.initialize({ ...f.args, preserveParent: true });
  assert.equal(localTask(f.manager).status, "completed");
  assert.equal(localTask(f.manager).completion_evidence.status, "met");
  assert.deepEqual(localTask(f.manager).blocker_resolution.affected_defender_ids, ["e"]);
});

test("enemy-specific model acceptance releases exploitation only after the blocker is displaced", () => {
  const breach = { id: "breach", type: "blocker_reduction", assigned_unit_ids: ["a"], priority: 1,
    applicable_phases: ["initial_movement", "combat"], target_hex: "3516", target_role: "reference", target_units: ["e"],
    acceptance_contract: { evaluation_scope: "immediate", obligations: [{ description: "Displace selected blocker", condition_ids: ["displaced"] }] },
    completion_criteria: { all: [{ id: "displaced", metric: "units_at_target", subject_side: "allies", unit_ids: ["e"],
      target_hex: "3516", relation: "at_most", target: 0, evaluation_scope: "immediate" }] } };
  const f = fixture({ children: [breach, { id: "exploit", type: "maneuver", priority: 2, assigned_unit_ids: ["b"],
    hard_dependencies: ["breach"], applicable_phases: ["mechanized_movement"] }] });
  f.manager.refresh(f.input);
  assert.equal(f.manager.plan.children.find((task) => task.id === "exploit").status, "pending");
  assert.equal(f.manager.plan.children.find((task) => task.id === "breach").completion_evidence.status, "not_met");
  const observed = f.manager.observe(f.input, combat(f));
  assert.equal(observed.plan.children.find((task) => task.id === "breach").status, "completed");
  assert.equal(observed.plan.children.find((task) => task.id === "exploit").status, "active");
});

test("compact context and checker preserve blocker evidence without claiming route access", () => {
  const f = fixture();
  const before = JSON.stringify(f.state);
  const plan = f.manager.plan;
  const dispatch = phaseDispatchTasks(plan, f.input);
  const compact = compactAgentPayload({ context: { operation_state: { task_plan: plan, phase_dispatch: dispatch } } });
  const retained = compact.context.operation_state;
  assert.ok(retained.task_plan.children.find((task) => task.type === "clear_blocker").candidate_blockers.length);
  assert.equal(retained.phase_dispatch.tasks[0].candidate_blockers[0].route_blocking_verified, false);
  assert.equal(retained.phase_dispatch.breakthrough_planning.missing_model_task, true);
  const checked = checkerPayload({ input: f.input, taskPlan: plan, events: ["phase_end"] });
  assert.ok(checked.active_tasks.find((task) => task.type === "clear_blocker").candidate_blockers.length);
  assert.ok(checked.rule_grounded_unit_state.a);
  assert.equal(JSON.stringify(f.state), before);
});

test("new blocker activation is isolated from other scenarios and Allies", () => {
  for (const scenario of ["july", "september", "october"]) for (const side of ["axis", "allies"]) {
    if (scenario === "july" && side === "axis") continue;
    const f = fixture({ scenario, side, phase: `${side}_combat` });
    assert.equal(localTask(f.manager), undefined);
    assert.equal(f.manager.plan.breakthrough_planning, undefined);
    assert.deepEqual(axisTacticalOpportunities(f.manager.plan, f.input).candidate_blocker, []);
  }
});
