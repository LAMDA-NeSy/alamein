"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { phaseAllowedActions, scenarioPolicy, actionGuidance } = require("../core/scenario_policy.js");

test("scenario policy exposes July scoring semantics without a special action", () => {
  const state = { scenario: "july", turn: 3, phase: "axis_initial_movement", active_side: "axis", units: {} };
  assert.deepEqual(phaseAllowedActions(state), ["move_intent", "move", "pass"]);
  assert.equal(scenarioPolicy(state).primary_metric, "scoring_frontier");
  assert.match(scenarioPolicy(state).supply_meaning, /计分/);
  assert.equal(actionGuidance(state, { type: "move" }).direct_vp.includes("July"), true);
});

test("September combat policy only exposes clear_mine when a combat unit is in a minefield", () => {
  const empty = { scenario: "september", turn: 5, phase: "axis_combat", active_side: "axis", units: {} };
  assert.deepEqual(phaseAllowedActions(empty), ["combat", "pass"]);
  const state = {
    ...empty,
    units: {
      axis: { side: "axis", kind: "ground", hex: "3319", state: "fresh" },
      mine: { side: "allies", kind: "mine", hex: "3319" }
    }
  };
  assert.deepEqual(phaseAllowedActions(state), ["combat", "clear_mine", "pass"]);
  assert.equal(scenarioPolicy(state).primary_metric, "mine_clearance");
  assert.match(actionGuidance(state, { type: "clear_mine" }).objective, /雷区/);
});

test("October policy only exposes west exit after turn 10 at the west edge", () => {
  const unit = { side: "axis", kind: "ground", hex: "0101", state: "fresh" };
  const before = { scenario: "october", turn: 10, phase: "axis_initial_movement", active_side: "axis", units: { axis: unit } };
  assert.deepEqual(phaseAllowedActions(before), ["move_intent", "move", "pass"]);
  const after = { ...before, turn: 11 };
  assert.deepEqual(phaseAllowedActions(after), ["move_intent", "move", "exit_west", "pass"]);
  assert.equal(scenarioPolicy(after).primary_metric, "withdrawal_vp");
  assert.match(actionGuidance(after, { type: "exit_west" }).objective, /西侧/);
});
