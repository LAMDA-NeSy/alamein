const test = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("../../rule_engine.js");
const Transcript = require("../experiments/external_ai_transcript.js");

function combatContext() {
  const config = Transcript.readConfig();
  return Transcript.buildContext(config, {
    state: {
      scenario: "july",
      turn: 1,
      phase: "axis_combat",
      active_side: "axis",
      road_supply_markers: { axis: "2424" },
      scenario_meta: { road_path: ["0101", "2424"] },
      units: {
        attacker: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
        defender: { side: "allies", hex: "2524", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
      }
    }
  });
}

test("external AI unit intel reports the unit's actual ZOC", () => {
  const built = combatContext();
  const result = Transcript.runTool(
    { ctx: built.ctx, allUnits: built.allUnits },
    built.publicContext,
    "inspect_unit",
    { unit: "attacker" }
  );
  assert.equal(result.legal, true);
  assert.deepEqual([...result.unit.zoc_hexes].sort(), Rules.neighbors("2424").sort());
});

test("current context includes a dynamic overall game overview", () => {
  const config = Transcript.readConfig();
  const built = combatContext();
  const overview = built.publicContext.game_overview;
  assert.equal(overview.title, "阿拉曼六角格兵棋");
  assert.equal(overview.current_scenario, "july");
  assert.equal(overview.current_side, "axis");
  assert.match(overview.player_goal_summary, /你现在扮演 Axis/);
  assert.match(overview.player_goal_summary, /开局地图是二维交错六角格地图/);
  assert.match(overview.player_goal_summary, /01 到 49 列、01 到 34 行/);
  assert.match(overview.player_goal_summary, /实际可玩的六角格为 1014 个/);
  assert.match(overview.player_goal_summary, /不代表当前地形、控制方/);
  assert.match(overview.player_goal_summary, /坐标格式为 CCRR/);
  assert.doesNotMatch(overview.player_goal_summary, /当前最远有效计分列/);
  assert.match(overview.player_goal_summary, /每个因战斗、阻断撤退或孤立而被消灭的 Allied 地面作战单位增加 1 VP/);
  assert.match(overview.turn_goal_update, /当前最远有效计分列是第 34 列/);
  assert.match(overview.turn_goal_update, /下一项可争取的计分列是第 35 列/);
  assert.ok(overview.initial_map_reference_2d);
  assert.equal(overview.initial_map_reference_2d.format, "staggered_hex_coordinate_map");
  assert.ok(overview.initial_map_reference_2d.layout_rows.length > 20);
  assert.deepEqual(overview.initial_map_reference_2d.connection_rule.odd_column_offsets[0], [0, -1]);
  assert.ok(overview.initial_map_reference_2d.key_connections.some((item) => item.hex === "3208"));

  const laterStep = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "direct",
    includeInitialMap: false
  });
  assert.equal(laterStep.publicContext.game_overview.initial_map_reference_2d, undefined);
  assert.ok(overview.turn_structure.sequence.includes("axis_combat"));
  assert.ok(overview.scoring_rules.some((rule) => /Start at 25 VP/.test(rule)));
  assert.ok(overview.core_rules.some((rule) => /补给/.test(rule)));
  assert.ok(overview.decision_order.length >= 4);
});

test("game overview states the active side's concrete scenario goal", () => {
  const config = Transcript.readConfig();
  const axis = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "direct"
  });
  const axisGoal = axis.publicContext.game_overview.player_goal;
  assert.equal(axisGoal.side, "axis");
  assert.match(axisGoal.win_condition, /更高 VP/);
  assert.match(axisGoal.win_condition, /下一东部计分列/);
  assert.match(axisGoal.primary_objective, /35/);
  assert.ok(axisGoal.tactical_priorities.some((item) => /补给/.test(item)));
  assert.match(axisGoal.non_goal, /没有 VP 或明确战术收益/);
  assert.match(axis.publicContext.game_overview.player_goal_summary, /你现在扮演 Axis/);
  assert.doesNotMatch(axis.publicContext.game_overview.player_goal_summary, /当前最远有效计分列是/);
  assert.match(axis.publicContext.game_overview.turn_goal_update, /当前最远有效计分列是第 34 列/);
  assert.match(axis.publicContext.game_overview.turn_goal_update, /第 35 列/);

  const allies = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "allies_initial_movement",
    activeSide: "allies",
    decisionMode: "direct"
  });
  const alliesGoal = allies.publicContext.game_overview.player_goal;
  assert.equal(alliesGoal.side, "allies");
  assert.match(alliesGoal.win_condition, /阻止 Axis/);
  assert.ok(alliesGoal.tactical_priorities.some((item) => /切断 Axis 补给/.test(item)));
  assert.match(alliesGoal.non_goal, /不要为了追逐 Axis 单位而放弃/);
  assert.match(allies.publicContext.game_overview.player_goal_summary, /你现在扮演 Allies/);
  assert.match(allies.publicContext.game_overview.player_goal_summary, /开局地图是二维交错六角格地图/);
  assert.match(allies.publicContext.game_overview.player_goal_summary, /阻断 Axis 的计分推进/);
  assert.match(allies.publicContext.game_overview.player_goal_summary, /避免 Allied 地面作战单位被战斗、阻断撤退或孤立消灭/);
  assert.match(allies.publicContext.game_overview.turn_goal_update, /下一项直接得分机会是第 35 列/);
});

test("September and October contexts expose their actual VP baselines and objectives", () => {
  const config = Transcript.readConfig();
  const september = Transcript.buildContext(config, {
    state: { scenario: "september", turn: 1, phase: "axis_initial_movement", active_side: "axis", units: {} }
  }).publicContext;
  assert.ok(september.game_overview.scoring_rules.some((rule) => /Start at 35 VP/.test(rule)));
  assert.equal(september.objectives.axis_primary_type, "mine_clearance");
  assert.match(september.objectives.axis_primary, /minefield/i);
  assert.doesNotMatch(september.objectives.axis_primary, /3711/);

  const octoberBefore = Transcript.buildContext(config, {
    state: { scenario: "october", turn: 1, phase: "allies_initial_movement", active_side: "allies", units: {} }
  }).publicContext;
  assert.ok(octoberBefore.game_overview.scoring_rules.some((rule) => /Start at -20 VP/.test(rule)));
  assert.equal(octoberBefore.objectives.axis_primary_type, "withdrawal_preparation");
  assert.match(octoberBefore.objectives.allies_primary, /withdrawal/i);
  assert.doesNotMatch(octoberBefore.objectives.axis_primary, /3711/);

  const octoberAfter = Transcript.buildContext(config, {
    state: { scenario: "october", turn: 11, phase: "axis_initial_movement", active_side: "axis", units: {} }
  }).publicContext;
  assert.equal(octoberAfter.objectives.axis_primary_type, "west_edge_withdrawal");
  assert.match(octoberAfter.objectives.axis_primary, /west edge/i);
});

test("external AI combat intel applies ridge defense and cancels D retreats", () => {
  const built = combatContext();
  const result = Transcript.runTool(
    { ctx: built.ctx, allUnits: built.allUnits },
    built.publicContext,
    "check_combat",
    { attackers: ["attacker"], defender_hexes: ["2524"] }
  );
  assert.equal(result.legal, true, result.reason);
  assert.equal(result.details.defense, 2);
  assert.equal(result.details.crt_column["1"], "No Effect");

  const candidate = built.publicContext.candidate_actions.find((item) => item.action?.type === "combat");
  const target = candidate?.evaluation?.targets?.find((item) => item.hex === "2524");
  assert.equal(target?.terrain_defense_bonus, 0);
  assert.equal(target?.terrain_defense_multiplier, 2);
  assert.equal(target?.rugged_defense_cancels_retreat, true);
});

test("intent mode omits action candidates but validates a planned move intent", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "intent"
  });
  assert.equal(built.publicContext.decision_mode, "intent");
  assert.equal(Object.hasOwn(built.publicContext, "candidate_actions"), false);
  assert.equal(
    Transcript.runTool({ ctx: built.ctx, allUnits: built.allUnits }, built.publicContext, "list_legal_actions", {}).legal,
    false
  );

  const mover = built.publicContext.decision_brief.available_movers[0];
  const reachable = Rules.reachableHexes(built.ctx, mover.unit, { mode: "normal", maxHexes: 20 });
  const [destination] = [...reachable.entries()].find(([hex, item]) => hex !== mover.hex && item.path?.length > 1);
  const assessment = Transcript.evaluateProbeAction(built.publicContext, {
    type: "move_intent",
    unit: mover.unit,
    destination,
    mode: "auto"
  }, built.ctx);
  assert.equal(assessment.legal, true, assessment.reason);
  assert.equal(assessment.action.type, "move");
});

test("direct mode omits candidates and validates a planned move with the rules engine", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "direct"
  });
  assert.equal(built.publicContext.decision_mode, "direct");
  assert.equal(Object.hasOwn(built.publicContext, "candidate_actions"), false);
  const mover = built.publicContext.decision_brief.available_movers[0];
  const reachable = Rules.reachableHexes(built.ctx, mover.unit, { mode: "normal", maxHexes: 20 });
  const [destination] = [...reachable.entries()].find(([hex, item]) => hex !== mover.hex && item.path?.length > 1);
  const assessment = Transcript.evaluateProbeAction(built.publicContext, {
    type: "move_intent", unit: mover.unit, destination, mode: "auto"
  }, built.ctx);
  assert.equal(assessment.legal, true, assessment.reason);
});

test("July context exposes exact scoring rules and the next scoring column", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "direct"
  });
  const victory = built.publicContext.victory;

  assert.equal(built.publicContext.game.victory_points, 25);
  assert.equal(victory.current_vp, 25);
  assert.equal(victory.current_scoring.total_vp, 25);
  assert.equal(victory.current_scoring.july_advance.farthest_scoring_column, 34);
  assert.equal(victory.current_scoring.july_advance.next_scoring_column, 35);
  assert.equal(victory.current_scoring.july_advance.vp_gain_for_reaching_next_column, 3);
  assert.equal(built.publicContext.objectives.axis_primary_type, "eastern_scoring_frontier");
  assert.equal(built.publicContext.objectives.axis_next_scoring_column, 35);
  assert.match(built.publicContext.objectives.alamein_role, /no separate July capture bonus/);
  assert.match(victory.scoring_rules.scenario_rules.join(" "), /35xx=3, 36xx=6, 37xx=9/);
  assert.match(victory.scoring_rules.scenario_rules.join(" "), /no separate capture bonus/);
});

test("objective resolution separates scoring frontier from operational landmark", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "intent",
    privateCandidates: true
  });
  assert.equal(built.publicContext.objective_resolution.frontier.type, "scoring_frontier");
  assert.equal(built.publicContext.objective_resolution.frontier.next_value, 35);
  assert.equal(built.publicContext.objective_resolution.operational_landmark, "3711");
  assert.match(built.publicContext.objective_resolution.selection_rule, /projected supply/);
});

test("failed move intent returns legal alternatives instead of only a fixed target error", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "intent"
  });
  const mover = built.publicContext.decision_brief.available_movers[0];
  const result = Transcript.resolveMoveIntent(built.ctx, {
    type: "move_intent",
    unit: mover.unit,
    destination: "0101",
    mode: "auto"
  });
  assert.equal(result.legal, false);
  assert.ok(Array.isArray(result.alternatives));
  assert.equal(result.recommended_recovery, result.alternatives.length ? "choose_one_of_the_legal_alternatives" : "replan_operation");
});

test("July move evaluation reports whether it crosses a scoring column", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "direct"
  });
  const mover = built.publicContext.decision_brief.available_movers.find((item) => item.unit === "july-200-pzg-01");
  assert.ok(mover);

  const assessment = Transcript.evaluateProbeAction(built.publicContext, {
    type: "move_intent",
    unit: mover.unit,
    destination: "3412",
    mode: "auto"
  }, built.ctx);
  assert.equal(assessment.legal, true, assessment.reason);
  assert.equal(assessment.evaluation.victory_impact.estimated_vp_delta, 0);
  assert.equal(assessment.evaluation.victory_impact.crosses_new_scoring_column, false);
  assert.equal(assessment.evaluation.victory_impact.current_farthest_scoring_column, 34);
  assert.ok(assessment.evaluation.victory_impact.projected_supply_after_move);
});

test("July move evaluation does not award VP for an advance that breaks scoring supply", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "direct"
  });
  const action = {
    type: "move",
    unit: "july-115-panzer-01",
    path: [built.ctx.state.units["july-115-panzer-01"].hex, "4418"],
    destination: "4418",
    mode: "normal"
  };
  const evaluation = Transcript.actionEvaluation(built.ctx, action, built.allUnits);
  assert.ok(["unsupplied", "isolated"].includes(evaluation.victory_impact.projected_supply_after_move));
  assert.equal(evaluation.victory_impact.maintains_july_scoring_supply, false);
  assert.equal(evaluation.victory_impact.estimated_vp_delta, 0);
});

test("Allied eastward movement is not credited without a verified defensive effect", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "allies_initial_movement",
    activeSide: "allies",
    decisionMode: "direct"
  });
  const unit = built.allUnits.find((item) => item.side === "allies" && item.hex && (item.kind || "ground") === "ground");
  const evaluation = Transcript.actionEvaluation(built.ctx, {
    type: "move",
    unit: unit.id,
    path: [unit.hex, "4910"],
    destination: "4910",
    mode: "normal"
  }, built.allUnits);
  assert.equal(evaluation.victory_impact.self_vp_delta, 0);
  assert.equal(evaluation.victory_impact.opponent_vp_delta, 0);
  assert.equal(evaluation.victory_impact.axis_scoring_threat_delta, 0);
  assert.equal(evaluation.victory_impact.destination_is_primary_objective, false);
  assert.deepEqual(evaluation.victory_impact.axis_scoring_threat_evidence, []);
});

test("strategy_execute exposes a cached strategy without action candidates", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "strategy_execute",
    phaseIntent: { type: "advance", sector: "central", target_hex: "3711" }
  });
  assert.equal(built.publicContext.decision_mode, "strategy_execute");
  assert.equal(Object.hasOwn(built.publicContext, "candidate_actions"), false);
  assert.equal(built.publicContext.phase_intent.type, "advance");
  assert.equal(built.publicContext.phase_intent.target_hex, "3711");
  assert.equal(built.publicContext.strategy_execution.no_action_candidates, true);
});

test("hybrid mode exposes a small execution set only after a valid phase intent", () => {
  const config = Transcript.readConfig();
  const base = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "hybrid"
  });
  assert.equal(Object.hasOwn(base.publicContext, "candidate_actions"), false);
  assert.ok(base.candidatePool.length > 1);

  const built = Transcript.buildContext(config, {
    scenario: "scenarios/july.json",
    phase: "axis_initial_movement",
    activeSide: "axis",
    decisionMode: "hybrid",
    phaseIntent: { type: "advance", sector: "north", priority_units: ["missing"] }
  });
  assert.ok(built.publicContext.candidate_actions.length <= 6);
  assert.equal(built.publicContext.candidate_actions.at(-1).action.type, "pass");
  assert.ok(built.publicContext.candidate_actions.slice(0, -1).every((item) => item.action.type === "move"));
});

test("opportunity-aware hybrid removes negative expected combats and annotates candidates", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    state: {
      scenario: "july",
      turn: 1,
      phase: "axis_combat",
      active_side: "axis",
      road_supply_markers: { axis: "2424" },
      scenario_meta: { road_path: ["0101", "2424"] },
      units: {
        attacker: { side: "axis", hex: "2424", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
        defender: { side: "allies", hex: "2524", state: "fresh", attack: 5, defense: 5, movement: 4, kind: "ground" }
      }
    },
    decisionMode: "opportunity_aware_hybrid",
    phaseIntent: { type: "attack_pressure", sector: "central" }
  });
  assert.equal(built.publicContext.candidate_actions.at(-1).action.type, "pass");
  assert.equal(built.publicContext.candidate_actions.some((item) => item.action.type === "combat"), false);
  assert.ok(built.publicContext.candidate_actions.every((item) => item.opportunity));
  assert.ok(built.publicContext.opportunity_filter.rejected_candidate_count >= 1);
});

test("opportunity-aware hybrid backfills a legal combat when the intent-matched combat is rejected", () => {
  const config = Transcript.readConfig();
  const built = Transcript.buildContext(config, {
    state: {
      scenario: "july",
      turn: 1,
      phase: "axis_combat",
      active_side: "axis",
      road_supply_markers: { axis: "2424" },
      scenario_meta: { road_path: ["0101", "2424"] },
      units: {
        weak_attacker: { side: "axis", hex: "2424", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
        strong_defender: { side: "allies", hex: "2524", state: "fresh", attack: 5, defense: 5, movement: 4, kind: "ground" },
        strong_attacker: { side: "axis", hex: "2410", state: "fresh", attack: 6, defense: 4, movement: 4, kind: "ground" },
        weak_defender: { side: "allies", hex: "2510", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
      }
    },
    decisionMode: "opportunity_aware_hybrid",
    phaseIntent: { type: "attack_pressure", sector: "south", target_hex: "2524" }
  });
  const combats = built.publicContext.candidate_actions.filter((item) => item.action.type === "combat");
  assert.ok(combats.some((item) => item.action.defender_hexes.includes("2510")));
  assert.ok(built.publicContext.opportunity_filter.backfill_candidate_count >= 1);
});

test("invalid phase intent falls back to the phase default", () => {
  const result = Transcript.normalizePhaseIntent({ type: "invalid", sector: "west", priority_units: ["none"] }, {
    phase: "axis_supply_movement",
    units: {}
  });
  assert.equal(result.type, "extend_supply");
  assert.equal(result.source, "local_default");
});
