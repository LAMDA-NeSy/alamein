"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Rules = require("../../rule_engine.js");
const Transcript = require("../experiments/external_ai_transcript.js");
const { groundGoalPlan, localGoalPlan } = require("../core/goal_manager.js");
const { buildTacticalSummary } = require("../core/sae_runtime.js");
const { createTaskManager, alliedDefensePosture, taskEvents, modelTaskEvidence } = require("../core/task_manager.js");
const { resolveSidePrompt } = require("../core/prompt_registry.js");

function scenarioState(scenario = "october", side = "axis") {
  return {
    scenario, turn: scenario === "october" ? 11 : 1, active_side: side, phase: `${side}_initial_movement`,
    units: {
      engineer: { side: "axis", kind: "engineer", hex: "0101", attack: 2, defense: 2, movement: 4, state: "fresh", supply_state: "supplied" },
      supply: { side: "axis", kind: "supply", hex: "0102", movement: 4, state: "fresh" },
      defender: { side: "allies", kind: "ground", hex: "3711", attack: 2, defense: 2, movement: 4, state: "fresh" },
      mine: { side: "allies", kind: "mine", hex: "0302", state: "fresh" }
    }
  };
}

test("both side goal prompts explain scenario metrics instead of imposing July columns", () => {
  for (const side of ["axis", "allies"]) {
    const prompt = resolveSidePrompt(side, "external.goal_manager_system");
    assert.match(prompt, /mine_clearance/);
    assert.match(prompt, /withdrawal_vp/);
    assert.match(prompt, /target_column.*null/);
    assert.match(prompt, /[Oo]nly in July/);
    const checker = resolveSidePrompt(side, "external.task_checker_system");
    assert.match(checker, /September/);
    assert.match(checker, /October/);
  }
});

test("observable task criteria require every all-condition and preserve unknown values", () => {
  const state = scenarioState("july", "axis");
  state.units.engineer.kind = "ground";
  const task = {
    id: "two_facts", type: "model_task", model_task_type: "advance",
    assigned_units: ["engineer"], target_column: 35,
    completion_criteria: { all: [
      { metric: "scoring_frontier", relation: "at_least", target: 35 },
      { metric: "unit_supply", relation: "at_least", target: 1, unit_ids: ["missing"] }
    ] }
  };
  const evidence = modelTaskEvidence(task, {
    global_farthest_scoring_column: 35, target_column_reached: true,
    supplied_ratio: 1, assigned: 1, current_vp: 25
  }, {}, { state, side: "axis" });
  assert.equal(evidence.completed, false);
  assert.equal(evidence.status, "unknown");
});

test("October movement scores do not reward a return east toward the July landmark", () => {
  const state = scenarioState();
  state.turn = 5;
  state.units.engineer.hex = "1207";
  const built = Transcript.buildContext(Transcript.readConfig(), { state, decisionMode: "direct", includeInitialMap: false });
  const east = { type: "move", unit: "engineer", path: ["1207", "2005"], destination: "2005" };
  const west = { type: "move", unit: "engineer", path: ["1207", "1107"], destination: "1107" };
  assert.ok(Transcript.actionEvaluation(built.ctx, east, built.allUnits).progress < 0);
  assert.ok(Transcript.movementActionScore(built.ctx, west, built.allUnits) > Transcript.movementActionScore(built.ctx, east, built.allUnits));
  state.units.engineer.hex = "3021";
  assert.doesNotThrow(() => Transcript.moveTarget(built.ctx, state.units.engineer, built.allUnits));
});

test("withdrawal preparation advances partially without declaring an exit or VP", () => {
  const state = scenarioState();
  state.units.engineer.hex = "1005";
  const manager = managerFor(state, { id: "extract", task_type: "exit_west", assigned_unit_ids: ["engineer"] });
  const next = structuredClone(state);
  next.units.engineer.hex = "0505";
  const plan = manager.refresh({ state: next, side: "axis", turn: 11 });
  assert.ok(plan.children[0].progress > 0 && plan.children[0].progress < 1);
  assert.notEqual(plan.children[0].status, "completed");
  assert.equal(plan.children[0].current_metrics.axis_exit_vp, 0);
});

test("a screening task mentioning west withdrawal is not an extraction task", () => {
  const state = scenarioState();
  const manager = managerFor(state, { id: "screen", task_type: "screen", title: "screen the west withdrawal", assigned_unit_ids: ["engineer"] });
  const plan = manager.refresh({ state, side: "axis", turn: 11 });
  assert.match(plan.children[0].progress_evidence, /exposed to enemy ZOC/);
  assert.doesNotMatch(plan.children[0].progress_evidence, /exited legally/);
});

test("tactical summary excludes mine counters from supply bottlenecks and uses scenario baseline", () => {
  const state = scenarioState("october", "allies");
  const built = Transcript.buildContext(Transcript.readConfig(), { state, decisionMode: "direct" });
  built.publicContext.victory.current_vp = -16;
  const summary = buildTacticalSummary({ state, side: "allies" }, built);
  assert.equal(summary.supply_bottlenecks.some((unit) => unit.unit === "mine"), false);
  assert.equal(summary.enemy_threats.some((unit) => unit.threatened_unit === "mine"), false);
  assert.equal(summary.baseline_vp, -20);
  assert.equal(summary.vp_delta_from_baseline, 4);
});

function exited(state, id = "engineer", extra = {}) {
  const next = structuredClone(state);
  Object.assign(next.units[id], { hex: null, off_map: true, exited_edge: "west", exited_turn: 11, ...extra });
  return next;
}

function mineCleared(state) {
  const next = structuredClone(state);
  Object.assign(next.units.mine, { eliminated: true, eliminated_reason: "mine_cleared", cleared_by_side: "axis" });
  return next;
}

function managerFor(state, task, goal) {
  const manager = createTaskManager({ taskGeneration: "model_defined" });
  manager.initialize({
    intent: { side: state.active_side, goal_plan: goal ? { primary_goal: goal } : null },
    operation: "scenario_test", input: { state, side: state.active_side, turn: state.turn },
    rawPlan: { children: [task] }, taskGeneration: "model_defined"
  });
  return manager;
}

test("scenario context and tactical summary report rule-scored mines and withdrawal, not July columns", () => {
  for (const scenario of ["september", "october"]) {
    const state = scenario === "september" ? mineCleared(scenarioState(scenario)) : exited(exited(scenarioState(), "supply"));
    const built = Transcript.buildContext(Transcript.readConfig(), { state, decisionMode: "direct" });
    const score = Rules.calculateVictoryPoints({ state });
    assert.equal(built.publicContext.victory.current_vp, score.victory_points);
    assert.equal(built.publicContext.victory.current_scoring.july_advance, undefined);
    const summary = buildTacticalSummary({ state, side: "axis" }, built);
    assert.equal(summary.next_scoring_change.current_scoring_column, null);
    assert.equal(summary.next_scoring_change.next_scoring_column, null);
    if (scenario === "september") {
      assert.equal(built.publicContext.victory.current_scoring.september_mine_clearance.vp_from_mines, 3);
      assert.equal(summary.next_scoring_change.vp_gain, 3);
    } else {
      const withdrawal = built.publicContext.victory.current_scoring.october_withdrawal;
      assert.equal(withdrawal.vp_from_withdrawal, 12);
      assert.equal(withdrawal.combat_units_exited, 1);
      assert.equal(withdrawal.supply_units_exited, 1);
      assert.equal(summary.next_scoring_change.vp_gain, null);
    }
  }
});

test("action evaluation reports October withdrawal value only in an eligible state", () => {
  const config = Transcript.readConfig();
  for (const [scenario, turn, phase, expected] of [
    ["october", 11, "axis_initial_movement", 10],
    ["october", 10, "axis_initial_movement", 0],
    ["october", 11, "axis_combat", 0],
    ["september", 11, "axis_initial_movement", 0]
  ]) {
    const state = { ...scenarioState(scenario), turn, phase };
    const built = Transcript.buildContext(config, { state, decisionMode: "direct" });
    const impact = Transcript.actionEvaluation(built.ctx, { type: "exit_west", unit: "supply" }, built.allUnits).victory_impact;
    assert.equal(impact.estimated_vp_delta, expected, `${scenario}/${turn}/${phase}`);
    assert.equal(impact.self_vp_delta, null);
    assert.equal(impact.projected_vp_delta_from_current_state, expected);
  }
});

test("Allied October movement and landmark combat are not labelled as direct VP gains", () => {
  const state = scenarioState("october", "allies");
  const built = Transcript.buildContext(Transcript.readConfig(), { state, decisionMode: "direct" });
  const move = Transcript.actionEvaluation(built.ctx, { type: "move", unit: "defender", path: ["3711", "3811"], destination: "3811" }, built.allUnits).victory_impact;
  assert.equal(move.self_vp_delta, null);
  assert.equal(move.projected_vp_delta_from_current_state, 0);
  assert.equal(move.objective_hex, null);
  assert.equal(move.current_farthest_scoring_column, null);
  assert.equal(move.vp_relevance, "withdrawal_denial_setup");
  const combat = Transcript.actionEvaluation(built.ctx, { type: "combat", attackers: ["engineer"], defender_hexes: ["3711"] }, built.allUnits).victory_impact;
  assert.equal(combat.targets_primary_objective, false);
});

test("July scoring is a single current frontier, not cumulative column crossings", () => {
  const state = JSON.parse(JSON.stringify(require("../../scenarios/july.json")));
  const rules = require("../../rules_el_alamein.json");
  const terrain = require("../../terrain.json");
  const unit = "july-62-It-mech-01";
  state.units[unit].hex = "3510";
  assert.equal(Rules.calculateVictoryPoints(Rules.createContext({ state, rules, terrain })).victory_points, 28);
  state.units[unit].hex = "3610";
  assert.equal(Rules.calculateVictoryPoints(Rules.createContext({ state, rules, terrain })).victory_points, 31);
  state.units[unit].hex = "3710";
  assert.equal(Rules.calculateVictoryPoints(Rules.createContext({ state, rules, terrain })).victory_points, 25);
});

test("goal compiler replaces incompatible columns without turning them into score targets", () => {
  for (const [scenario, metric, current] of [["september", "mine_clearance", 2], ["october", "withdrawal_vp", 12]]) {
    for (const side of ["axis", "allies"]) {
      const state = scenarioState(scenario, side);
      const publicContext = {
        game: { scenario, active_side: side },
        victory: { current_scoring: {
          september_mine_clearance: { mines_cleared: current },
          october_withdrawal: { vp_from_withdrawal: current }
        } }
      };
      const plan = groundGoalPlan({ primary_goal: { metric: "scoring_frontier", target: 37, target_column: 37 } }, { state, side, publicContext });
      assert.equal(plan.primary_goal.metric, metric);
      assert.equal(plan.primary_goal.target_column, null);
      assert.equal(plan.primary_goal.target, current + 1);
      assert.equal(plan.primary_goal.subject_side, "axis");
      const local = localGoalPlan({ state, side, publicContext });
      assert.equal(local.primary_goal.target, current + (side === "axis" ? 1 : 0));
      if (side === "allies") assert.equal(plan.primary_goal.evaluation_scope, "game_end");
      const zero = groundGoalPlan({ primary_goal: { metric, target: 0 } }, { state, side, publicContext });
      assert.equal(zero.primary_goal.target, 0);
      const missing = groundGoalPlan({ primary_goal: { metric, target: null } }, { state, side, publicContext });
      assert.notEqual(missing.primary_goal.target, 0);
    }
  }
});

test("generic scenario goals are grounded to the authoritative September and October metrics", () => {
  for (const [scenario, metric, current] of [
    ["september", "mine_clearance", 4],
    ["october", "withdrawal_vp", 12]
  ]) {
    for (const side of ["axis", "allies"]) {
      const publicContext = {
        game: { scenario, active_side: side },
        victory: {
          current_scoring: {
            [scenario === "september" ? "september_mine_clearance" : "october_withdrawal"]:
              scenario === "september" ? { mines_cleared: current } : { vp_from_withdrawal: current }
          }
        }
      };
      const plan = groundGoalPlan({
        primary_goal: {
          id: `${scenario}_${side}`,
          metric: "scenario_scoring",
          relation: side === "allies" ? "keep_below" : "at_least",
          title: "Choose the best scenario operation"
        }
      }, { state: scenarioState(scenario, side), side, publicContext });
      const goal = plan.primary_goal;
      assert.equal(goal.metric, metric);
      assert.equal(goal.subject_side, "axis");
      assert.equal(goal.target, current + (side === "axis" || goal.relation === "keep_below" ? 1 : 0));
      assert.equal(goal.relation, side === "allies" ? "keep_below" : "at_least");
      assert.ok(goal.observable_conditions.some((condition) => condition.kind === metric));
      assert.ok(plan.grounding.corrections.some((correction) => correction.field.endsWith(".metric")));
    }
  }
});

test("scenario grounding removes an incompatible target_vp from an explicit generic metric", () => {
  const plan = groundGoalPlan({
    primary_goal: { metric: "scenario_scoring", target_vp: 40, title: "Improve the scenario result" }
  }, {
    side: "axis",
    state: scenarioState("september", "axis"),
    publicContext: {
      game: { scenario: "september", active_side: "axis" },
      victory: { current_scoring: { september_mine_clearance: { mines_cleared: 2 } } }
    }
  });
  assert.equal(plan.primary_goal.metric, "axis_vp");
  assert.equal(plan.primary_goal.target_vp, 40);
  assert.equal(plan.primary_goal.target, 40);
  assert.ok(plan.grounding.corrections.some((correction) => correction.field.endsWith(".metric") && correction.grounded === "axis_vp"));
});

test("campaign VP evaluation is preserved when the operational goal is grounded", () => {
  const plan = groundGoalPlan({
    campaign_goal: { metric: "scenario_scoring", target_vp: 40, title: "Reach the campaign result" },
    primary_goal: { metric: "scenario_scoring", title: "Clear the next mine" }
  }, {
    side: "axis",
    state: scenarioState("september", "axis"),
    publicContext: {
      game: { scenario: "september", active_side: "axis" },
      victory: { current_scoring: { september_mine_clearance: { mines_cleared: 2 } } }
    }
  });
  assert.equal(plan.campaign_goal.metric, "axis_vp");
  assert.equal(plan.campaign_goal.target_vp, 40);
  assert.equal(plan.primary_goal.metric, "mine_clearance");
  assert.equal(plan.primary_goal.target, 3);
});

test("withdrawal tasks use scored exits including engineers, not disappearance or premature exits", () => {
  const state = scenarioState();
  const task = { id: "withdraw", task_type: "exit_west", assigned_unit_ids: ["engineer"], target_column: null };
  for (const [extra, completed] of [[{}, true], [{ exited_turn: 10 }, false], [{ eliminated: true }, false], [{ exited_edge: "east" }, false]]) {
    const manager = managerFor(state, task);
    const next = exited(state, "engineer", extra);
    const plan = manager.refresh({ state: next, side: "axis", turn: 11 });
    assert.equal(plan.children[0].status === "completed", completed, JSON.stringify(extra));
    assert.equal(plan.children[0].current_metrics.farthest_scoring_column, null);
    assert.equal(plan.children[0].current_metrics.axis_exit_vp, completed ? 2 : 0);
    if (!completed) {
      const checked = manager.applyCheck({ task_id: "withdraw", task_status: "completed", task_progress: 1, confidence: 1 });
      assert.notEqual(checked.children[0].status, "completed");
      assert.equal(checked.children[0].progress, 0);
    }
  }
});

test("a full progress score without a completed state does not create a completion event", () => {
  const state = scenarioState("october", "allies");
  const record = { final_action: { type: "move", unit: "defender" } };
  assert.equal(taskEvents({ state }, record, { progress: 1, status_before: "active", status_after: "active" }).includes("task_completed"), false);
  assert.equal(taskEvents({ state }, record, { progress: 1, status_before: "active", status_after: "completed" }).includes("task_completed"), true);
});

test("accepted but unsuccessful mine clearance does not complete a task, actual clearance does", () => {
  const state = scenarioState("september");
  const manager = managerFor(state, { id: "clear", task_type: "mine_clearance", assigned_unit_ids: ["engineer"], target_hex: "0302" });
  const record = {
    final_action: { type: "clear_mine", unit: "engineer", hex: "0302" },
    action_attempts: [{ accepted: true }],
    action_applied: { result: { legal: true, details: { cleared: false, removed: [] } } }
  };
  const failed = manager.observe({ state, side: "axis", turn: 1, step: 1 }, record);
  assert.notEqual(failed.plan.children[0].status, "completed");
  const checked = manager.applyCheck({ task_id: "clear", task_status: "completed", task_progress: 1, confidence: 1 });
  assert.notEqual(checked.children[0].status, "completed");
  const cleared = manager.refresh({ state: mineCleared(state), side: "axis", turn: 1 });
  assert.equal(cleared.children[0].status, "completed");
  assert.equal(cleared.children[0].current_metrics.allied_mines_cleared_by_axis, 1);
});

test("scenario defensive goals settle only at game end and distinguish strict from inclusive limits", () => {
  for (const [scenario, metric, target] of [["october", "withdrawal_vp", 2], ["september", "mine_clearance", 1]]) {
    for (const relation of ["at_most", "keep_below"]) {
      const state = scenarioState(scenario, "allies");
      const manager = managerFor(state, { id: "deny", type: "deny_scoring_frontier", assigned_unit_ids: ["defender"], metric, target, relation }, {
        id: "deny", subject_side: "axis", metric, target, relation, evaluation_scope: "game_end"
      });
      const next = scenario === "october" ? exited(state) : mineCleared(state);
      let plan = manager.refresh({ state: next, side: "allies" });
      assert.notEqual(plan.parent.state, "completed");
      assert.equal(alliedDefensePosture(plan, { state: next }).next_threatened_column, null);
      next.turn = Rules.scenarioFinalTurn(scenario);
      next.phase = "end_game_turn";
      plan = manager.refresh({ state: next, side: "allies" });
      assert.equal(plan.parent.state, relation === "at_most" ? "completed" : "failed");
      assert.equal(plan.children[0].status, relation === "at_most" ? "completed" : "failed");
      const evidence = plan.parent.goal_completion_evidence || plan.parent.goal_failure_evidence;
      assert.equal(evidence[0].actual, target);
      assert.equal(evidence[0].source, "rules_engine_victory_breakdown");
    }
  }
});
