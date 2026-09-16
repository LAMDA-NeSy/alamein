"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const RulesEngine = require("../../rule_engine.js");
const { goalIntent, groundGoalPlan, localGoalPlan } = require("../core/goal_manager.js");

const state = JSON.parse(fs.readFileSync(path.join(__dirname, "../../scenarios/july.json"), "utf8"));
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "../../rules_el_alamein.json"), "utf8"));
const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, "../../terrain.json"), "utf8"));
const ctx = RulesEngine.createContext({ state: JSON.parse(JSON.stringify(state)), rules, terrain });
const axisUnit = Object.keys(state.units).find((id) => state.units[id].side === "axis" && (state.units[id].kind || "ground") === "ground");

function publicContext() {
  return {
    game: { scenario: "july", active_side: "axis", turn: 3, turns_remaining: 5 },
    victory: {
      current_vp: 33,
      current_level: "Draw",
      current_scoring: {
        total_vp: 33,
        current_level: "Draw",
        next_axis_threshold: { vp: 40, level: "Axis Marginal", vp_needed: 7 },
        july_advance: {
          farthest_scoring_column: 36,
          next_scoring_column: 37,
          vp_gain_for_reaching_next_column: 3,
          scoring_requirement: "surviving supplied or partially supplied Axis ground combat unit"
        }
      }
    },
    objective_resolution: {
      candidates: [{ unit: axisUnit, destination: "3710", crosses_frontier: true, projected_supply: "partially_supplied" }]
    }
  };
}

test("open goal compiler preserves original strategy while grounding hard facts", () => {
  const plan = groundGoalPlan({
    type: "open_goal_plan",
    operation: "southern_feint",
    campaign_goal: { title: "Win by dislocating the defense", target_vp: 40 },
    primary_goal: {
      id: "transfer_south",
      title: "Feint north, then transfer the mobile force south",
      goal_type: "axis_transfer_and_feint",
      target_column: 37,
      target_hex: "9999",
      target_units: [axisUnit, "invented-unit"],
      expected_vp_delta: 6,
      observable_conditions: ["mobile force reaches the southern assembly area"]
    },
    operation_policy: { main_axis: "south", minimum_attack_odds: "3:1", risk_posture: "aggressive" }
  }, { publicContext: publicContext(), state, side: "axis", ctx });

  assert.equal(plan.primary_goal.goal_type, "axis_transfer_and_feint");
  assert.equal(plan.primary_goal.title, "Feint north, then transfer the mobile force south");
  assert.equal(plan.primary_goal.expected_vp_delta, 3);
  assert.equal(plan.primary_goal.target_vp, null);
  assert.equal(plan.primary_goal.target_hex, "");
  assert.deepEqual(plan.primary_goal.target_units, [axisUnit]);
  assert.equal(plan.operation_policy.minimum_attack_odds, "3-1");
  assert.ok(plan.grounding.correction_count >= 3);
  assert.equal(plan.grounding.route_feasibility, "locally_confirmed_option_exists");
});

test("goal intent compiles free goals into execution intent without changing the goal", () => {
  const plan = groundGoalPlan({
    type: "open_goal_plan",
    primary_goal: { id: "isolate", title: "Isolate the northern defender", goal_type: "isolate_enemy" },
    supporting_goals: [{ id: "screen", title: "Pin the central reserve", goal_type: "feint" }]
  }, { publicContext: publicContext(), state, side: "axis" });
  const intent = goalIntent(plan);
  assert.equal(intent.intent.type, "attack_pressure");
  assert.equal(intent.goal_plan.primary_goal.goal_type, "isolate_enemy");
  assert.equal(intent.priorities[0], "Isolate the northern defender");
});

test("local goal fallback uses the current authoritative scoring frontier", () => {
  const plan = localGoalPlan({ publicContext: publicContext(), state, side: "axis" });
  assert.equal(plan.source, "local_default");
  assert.equal(plan.primary_goal.target_column, 37);
  assert.equal(plan.primary_goal.expected_vp_delta, 3);
});

test("Allied goal grounding observes Axis and uses denial semantics", () => {
  const facts = publicContext();
  facts.game.active_side = "allies";
  const plan = localGoalPlan({ publicContext: facts, state, side: "allies" });
  assert.equal(plan.protocol, "side-aware-goal-v2");
  assert.equal(plan.primary_goal.subject_side, "axis");
  assert.equal(plan.primary_goal.metric, "scoring_frontier");
  assert.equal(plan.primary_goal.relation, "keep_below");
  assert.equal(plan.primary_goal.evaluation_scope, "game_end");
  assert.equal(plan.primary_goal.expected_vp_delta, 0);
});

test("local recovery has no fixed July column floor or Allied VP limit", () => {
  for (const nextColumn of [35, 36, 38]) {
    const facts = publicContext();
    facts.victory.current_scoring.july_advance.farthest_scoring_column = nextColumn - 1;
    facts.victory.current_scoring.july_advance.next_scoring_column = nextColumn;
    facts.objective_resolution.candidates = [];
    const plan = localGoalPlan({ publicContext: facts, state, side: "axis" });
    assert.equal(plan.primary_goal.target_column, nextColumn);
    assert.equal(plan.primary_goal.target_hex, "");
    const allies = localGoalPlan({ publicContext: facts, state, side: "allies" });
    assert.equal(allies.campaign_goal.target_vp, 33);
  }
});

test("model-selected locations survive grounding, including the former landmark", () => {
  for (const targetHex of ["3711", "2424"]) {
    const plan = groundGoalPlan({
      primary_goal: { id: "chosen", title: "Model-selected maneuver", goal_type: "maneuver", target_hex: targetHex }
    }, { publicContext: publicContext(), state, side: "axis", ctx });
    assert.equal(plan.primary_goal.target_hex, targetHex);
    assert.equal(goalIntent(plan).intent.target_hex, targetHex);
    assert.equal(plan.source, "model");
  }
});

test("Allied campaign target is normalized from generic target and drives recovery mode", () => {
  const facts = publicContext();
  facts.game.active_side = "allies";
  const plan = groundGoalPlan({
    campaign_goal: {
      id: "campaign",
      metric: "axis_vp",
      relation: "at_most",
      target: 29,
      evaluation_scope: "game_end"
    },
    primary_goal: {
      id: "deny_37",
      goal_type: "deny_scoring_frontier",
      metric: "scoring_frontier",
      relation: "keep_below",
      target: 37,
      evaluation_scope: "game_end"
    }
  }, { publicContext: facts, state, side: "allies", ctx });
  assert.equal(plan.campaign_goal.target_vp, 29);
  assert.equal(plan.primary_goal.target_column, 37);
  assert.equal(plan.strategy_mode, "recover_result");
  assert.equal(goalIntent(plan).intent.type, "pressure");
});
