"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Rules = require("../../rule_engine.js");
const { createTaskManager } = require("../core/task_manager.js");
const { continuationErrors } = require("../core/task_review.js");
const { acceptanceErrors } = require("../core/task_predicate_schema.js");
const { parseModelJson } = require("../core/unit_plan_runtime.js");
const { parseModelObject } = require("../core/model_json.js");
const { terrainRouteEvidence, taskRouteEvidence, combatPreparationEvidence } = require("../core/sae_runtime.js");

function fixture() {
  const state = { scenario: "july", turn: 3, phase: "axis_initial_movement", active_side: "axis", units: Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`unit${i}`, { side: "axis", kind: "ground", hex: `32${String(10 + i).padStart(2, "0")}`,
      attack: 2, defense: 2, movement: 4, state: "fresh", supply_state: "supplied" }])) };
  const input = { state, side: "axis", turn: 3, phase: state.phase, step: 90 };
  const manager = createTaskManager({ executionLedger: true, taskGeneration: "model_defined", taskProtocol: "side-aware-task-v4",
    scoringAnchorPolicy: "july_terminal_v1", monitorPolicy: "separate_monitors_v1", reviewPolicy: "model_review_wait_v1" });
  const children = Array.from({ length: 6 }, (_, i) => ({ id: `task${i}`, type: "maneuver", priority: i + 1,
    assigned_unit_ids: [`unit${i}`], completion_criteria: { all: [{ id: "arrival", metric: "position", relation: "at_least", target: 1,
      unit_ids: [`unit${i}`], target_hex: "3510", subject_side: "axis", evaluation_scope: "immediate" }] },
    acceptance_contract: { evaluation_scope: "immediate", obligations: [{ description: "Arrive", condition_ids: ["arrival"] }] } }));
  const args = { input, intent: { side: "axis" }, rawPlan: { children }, taskGeneration: "model_defined" };
  return { state, input, manager, children, args };
}

test("observation monitor cannot own spearhead units or consume one of six execution slots", () => {
  const f = fixture();
  f.children.unshift({ id: "july_scoring_anchor", type: "observation_only", observation_only: true,
    assigned_unit_ids: ["unit0", "unit1"] });
  const plan = f.manager.initialize(f.args);
  assert.equal(plan.children.length, 6);
  assert.equal(plan.monitors.length, 1);
  assert.deepEqual(plan.monitors[0].assigned_units, []);
  assert.deepEqual(plan.children.find((task) => task.id === "task0").assigned_units, ["unit0"]);
  assert.deepEqual(plan.children.find((task) => task.id === "task1").assigned_units, ["unit1"]);
  assert.ok(plan.normalization_corrections.some((item) => item.correction === "observation_does_not_allocate_units"));
  assert.ok(!f.manager.pendingReviews(f.input).some((request) => request.task_id === "july_scoring_anchor"));
});

test("allocation conflicts preserve prior ownership and prioritize empty execution tasks for review", () => {
  const f = fixture();
  f.manager.initialize(f.args);
  f.children[0].assigned_unit_ids.push("unit1");
  f.children[2].assigned_unit_ids = ["unit1"];
  const plan = f.manager.initialize({ ...f.args, preserveParent: true });
  assert.deepEqual(plan.children.find((task) => task.id === "task1").assigned_units, ["unit1"]);
  const empty = plan.children.find((task) => task.id === "task2");
  assert.deepEqual(empty.assigned_units, []);
  assert.equal(empty.status, "blocked");
  assert.ok(empty.normalization_corrections.some((item) => item.unit === "unit1" && item.retained_task_id === "task1"));
  const review = f.manager.pendingReviews(f.input)[0];
  assert.equal(review.task_id, "task2");
  assert.match(review.id, /^review_\d+$/);
  assert.equal(review.event_id.length, 64);
  assert.deepEqual(continuationErrors({ review_decision: "continue" }, f.input, empty), ["continue_requires_execution_units"]);
});

test("execution reconnaissance and observations with colliding IDs remain distinct", () => {
  const f = fixture();
  f.children[0].id = "july_scoring_anchor";
  f.children[0].type = "recon";
  f.args.rawPlan.monitors = [{ id: "task1", type: "observation_only", assigned_units: "invalid-array" }];
  const plan = f.manager.initialize(f.args);
  assert.deepEqual(plan.children.find((task) => task.id === "july_scoring_anchor_model").assigned_units, ["unit0"]);
  assert.deepEqual(plan.children.find((task) => task.id === "task1").assigned_units, ["unit1"]);
  assert.ok(plan.monitors.some((monitor) => monitor.id === "task1_monitor"));
  assert.equal(new Set([...plan.children, ...plan.monitors].map((task) => task.id)).size, 8);
});

test("satisfied maintenance does not consume ordinary checker reviews", () => {
  const f = fixture();
  f.args.rawPlan.children = [f.children[0]];
  f.children[0].completion_criteria.all[0].target_hex = f.state.units.unit0.hex;
  f.children[0].completion_criteria.all[0].evaluation_scope = "game_end";
  f.children[0].acceptance_contract.evaluation_scope = "game_end";
  f.manager.initialize(f.args);
  f.manager.refresh(f.input);
  f.manager.observe(f.input, { turn: 3, phase: f.input.phase, step: 90, final_action: { type: "pass" } });
  assert.equal(f.manager.plan.children[0].completion_evidence.status, "met");
  assert.equal(f.manager.pendingReviews(f.input).length, 0);
});

test("arrival at a hex entails its column, not absence, distance or an optional arrival branch", () => {
  const criteria = { all: [{ id: "p", metric: "position", relation: "at_least", target: 1,
    target_hex: "3710", evaluation_scope: "immediate" }] };
  const task = { require_acceptance_contract: true, target_hex: "3710", target_column: 37,
    acceptance_contract: { evaluation_scope: "immediate", obligations: [{ description: "Arrive", condition_ids: ["p"] }] } };
  assert.deepEqual(acceptanceErrors(task, criteria), []);
  for (const patch of [{ target_hex: "3610" }, { relation: "at_most", target: 0 }, { metric: "target_distance", relation: "at_most", target: 2 }]) {
    assert.ok(acceptanceErrors(task, { all: [{ ...criteria.all[0], ...patch }] }).includes("declared_column_without_location_evidence"));
  }
  const optional = { any: [criteria.all[0], { id: "s", metric: "unit_supply", relation: "at_least", target: 1, evaluation_scope: "immediate" }] };
  assert.ok(acceptanceErrors(task, optional).includes("declared_column_without_location_evidence"));
});

test("unit plans allow an unambiguous answer with operational note, but reject competing answers and truncation", () => {
  const plan = { type: "phase_unit_plan", unit_orders: [{ unit: "unit0", disposition: "hold", reason: "reserve" }] };
  const response = (value, finish = "stop") => ({ response_json: { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: finish }] } });
  assert.equal(parseModelJson(response({ answer: plan, operational_note: "Wait for supply." })).type, "phase_unit_plan");
  assert.ok(parseModelObject(response({ answer: plan, final_answer: { ...plan, unit_orders: [] } }), (value) => value.type === "phase_unit_plan").error);
  assert.equal(parseModelObject(response(plan, "length")).parse_status, "truncated");
});

test("route evidence separates an impassable coast edge from phase eligibility without mutating state", () => {
  const f = fixture();
  f.state.units.unit0.hex = "3610";
  const edge = Rules.normalizeEdge("3610", "3710");
  const ctx = Rules.createContext({ state: f.state, rules: Rules.DEFAULT_RULES, terrain: { hexes: {}, edges: { [edge]: ["sea"] } } });
  const before = JSON.stringify(f.state);
  const facts = terrainRouteEvidence(ctx, "unit0", "3710");
  assert.ok(facts.some((fact) => fact.from === "3610" && fact.to === "3710"));
  assert.ok(facts.length < Rules.neighbors("3710").length);
  assert.equal(JSON.stringify(f.state), before);
  f.state.phase = "axis_combat";
  const routes = taskRouteEvidence(ctx, [{ id: "advance", target_hex: "3710", assigned_units: ["unit0"] }], "combat");
  assert.equal(routes[0].status, "not_applicable_now");
  assert.equal(routes[0].reason, "unit_phase_ineligible");
  assert.ok(routes[0].terrain_obstacles.length);
});

test("combat preparation uses mandatory defender closure and rule odds, never mutating real units", () => {
  const f = fixture();
  f.state.units = { own: { ...f.state.units.unit0, hex: "3412", attack: 7, state: "spent" },
    enemy1: { ...f.state.units.unit0, side: "allies", hex: "3512", defense: 3 },
    enemy2: { ...f.state.units.unit0, side: "allies", hex: "3413", defense: 2 } };
  const ctx = Rules.createContext({ state: f.state, rules: Rules.DEFAULT_RULES, terrain: { hexes: {}, edges: {} } });
  const before = JSON.stringify(f.state);
  const result = combatPreparationEvidence(ctx, "axis");
  assert.equal(result.status, "conditional_estimate");
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].mandatory_defender_hexes, ["3413", "3512"]);
  assert.equal(result.groups[0].evaluation.defense, 5);
  assert.equal(result.groups[0].evaluation.odds_column, "1-1");
  assert.equal(JSON.stringify(f.state), before);
});

test("combat preparation skips supply-heavy participation checks when no enemy is adjacent", () => {
  const f = fixture();
  const ctx = Rules.createContext({ state: f.state, rules: Rules.DEFAULT_RULES, terrain: { hexes: {}, edges: {} } });
  const original = Rules.requiredAttackerIds;
  let calls = 0;
  Rules.requiredAttackerIds = (...args) => { calls += 1; return original(...args); };
  try {
    assert.deepEqual(combatPreparationEvidence(ctx, "axis").groups, []);
    assert.equal(calls, 0);
  } finally { Rules.requiredAttackerIds = original; }
});
