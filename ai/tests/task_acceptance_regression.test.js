"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateObservableCriteria, createTaskManager } = require("../core/task_manager.js");

const units = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`u${i}`, {
  side: "allies", hex: "3410", supply: "supplied", eliminated: false, attack: 2, defense: 2
}]));
const state = { scenario: "october", turn: 3, phase: "allies_initial_movement", active_side: "allies", units };
function evaluate(metric, target, relation = "at_least", extra = {}) {
  const task = { id: "test", assigned_units: Object.keys(units), completion_criteria: {
    all: [{ metric, target, relation, unit_ids: Object.keys(units), ...extra }]
  } };
  return evaluateObservableCriteria(task.completion_criteria, task, {}, { state, side: "allies", turn: 3 });
}

test("survival counts cannot be silently evaluated as fractions", () => {
  assert.equal(evaluate("unit_survival", 6).status, "unknown");
  assert.equal(evaluate("unit_survival", 3, "at_most").status, "unknown");
  const count = evaluate("surviving_unit_count", 6);
  assert.equal(count.status, "met");
  assert.equal(count.conditions[0].value, 7);
});

test("occupancy is not a distance metric and malformed targets do not settle", () => {
  assert.equal(evaluate("position", 2, "at_most", { target_hex: "3410" }).status, "unknown");
  assert.equal(evaluate("target_distance", 2, "at_most", { target_hex: "3410" }).status, "met");
  for (const target of [null, "", "2", -1, 1.5]) assert.equal(evaluate("surviving_unit_count", target).status, "unknown");
  assert.equal(evaluate("surviving_unit_count", 2, "something_else").status, "unknown");
});

test("acceptance contracts require location and sufficient settlement scope", () => {
  const task = { id: "hold", require_acceptance_contract: true, target_column: 36,
    assigned_units: ["u0"], acceptance_contract: { evaluation_scope: "turn_end", obligations: [
      { description: "hold supplied position", condition_ids: ["supply"] }
    ] }, completion_criteria: { all: [{ id: "supply", metric: "unit_supply", relation: "at_least", target: 1,
      unit_ids: ["u0"], evaluation_scope: "immediate" }] } };
  let result = evaluateObservableCriteria(task.completion_criteria, task, {}, { state, side: "allies" });
  assert.equal(result.status, "unknown");
  assert.ok(result.validation_errors.includes("declared_column_without_location_evidence"));
  assert.ok(result.validation_errors.includes("condition_settles_before_promise:supply"));
  task.completion_criteria.all[0].evaluation_scope = "turn_end";
  task.completion_criteria.all.push({ id: "location", metric: "position", relation: "at_least", target: 1,
    unit_ids: ["u0"], target_region: { column: 36 }, evaluation_scope: "turn_end" });
  task.acceptance_contract.obligations.push({ description: "occupy column", condition_ids: ["location"] });
  result = evaluateObservableCriteria(task.completion_criteria, task, {}, { state, side: "allies" });
  assert.equal(result.status, "not_met");
});

test("turn-end conditions settle on explicit boundary and game-end but not routine movement", () => {
  const task = { id: "hold", completion_criteria: { all: [{ metric: "surviving_unit_count", target: 7,
    relation: "at_least", unit_ids: Object.keys(units), evaluation_scope: "turn_end" }] } };
  const input = { state, side: "allies", turn: 3 };
  assert.equal(evaluateObservableCriteria(task.completion_criteria, task, {}, input).scope_ready, false);
  assert.equal(evaluateObservableCriteria(task.completion_criteria, task, {}, { ...input,
    settlement: { kind: "turn_end", turn: 3 } }).scope_ready, true);
});

test("maintenance cannot hide an observed loss followed by recovery", () => {
  const task = { id: "hold", acceptance_contract: { mode: "maintain" }, completion_criteria: { all: [{
    metric: "position", target: 1, relation: "at_least", unit_ids: ["u0"], target_hex: "3510", evaluation_scope: "game_end"
  }] } };
  evaluateObservableCriteria(task.completion_criteria, task, {}, { state, side: "allies", turn: 3 });
  const after = structuredClone(state);
  after.units.u0.hex = "3510";
  after.phase = "end_game_turn";
  after.turn = 15;
  const result = evaluateObservableCriteria(task.completion_criteria, task, {}, { state: after, side: "allies", turn: 15 });
  assert.equal(result.status, "not_met");
  assert.ok(result.maintenance_breach);
});

test("ledger manager requests a single evidenced strategic update when October window opens", () => {
  const manager = createTaskManager({ executionLedger: true, taskGeneration: "model_defined" });
  const input = { state: structuredClone(state), side: "allies", turn: 3, phase: state.phase };
  manager.initialize({ input, taskGeneration: "model_defined", intent: { side: "allies" },
    rawPlan: { children: [{ id: "hold", type: "recon", assigned_unit_ids: ["u0"] }] } });
  const late = { ...input, turn: 11, state: { ...input.state, turn: 11 } };
  manager.refresh(late);
  assert.equal(manager.consumeReplanReason(), "scenario_action_window_changed");
  manager.refresh(late);
  assert.equal(manager.needsReplan(), false);
});

test("new protocol keeps missing acceptance contracts unverified", () => {
  const manager = createTaskManager({ executionLedger: true, taskProtocol: "side-aware-task-v4" });
  const input = { state: structuredClone(state), side: "allies", turn: 3, phase: state.phase };
  manager.initialize({ input, taskGeneration: "model_defined", intent: { side: "allies" }, rawPlan: { children: [{
    id: "hold", type: "hold_position", assigned_unit_ids: ["u0"], completion_criteria: { all: [{
      metric: "unit_survival", target: 1, relation: "at_least", unit_ids: ["u0"]
    }] }
  }] } });
  const task = manager.refresh(input).children.find((item) => item.id === "hold");
  assert.notEqual(task.status, "completed");
  assert.equal(task.completion_evidence.status, "unknown");
});
