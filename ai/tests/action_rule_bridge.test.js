"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createActionRuleBridge, reviewStrategicCombat, reviewStrategicMovement, reviewTaskDispatch } = require("../core/action_rule_bridge.js");
const { readConfig } = require("../experiments/external_ai_transcript.js");
const RulesEngine = require("../../rule_engine.js");

const ROOT = path.resolve(__dirname, "../..");

test("hierarchical movement guard rejects unproductive reversals", () => {
  const result = reviewStrategicMovement({
    decisionMode: "hierarchical_sae",
    action: { type: "move", unit: "mover", destination: "3510" },
    assessment: {
      evaluation: {
        enemy_zoc_sources: [],
        victory_impact: {
          estimated_vp_delta: 0,
          unit_supply_before_move: "supplied",
          projected_supply_after_move: "supplied"
        }
      }
    },
    history: ["3510", "3511"],
    state: { units: { mover: { side: "axis", kind: "ground", hex: "3511" } } }
  });
  assert.equal(result.accept, false);
  assert.match(result.issues[0], /immediate reversal/);
});

test("hierarchical movement guard rejects a recent no-gain destination, not only an immediate reversal", () => {
  const result = reviewStrategicMovement({
    decisionMode: "hierarchical_sae",
    action: { type: "move", unit: "mover", destination: "3510" },
    assessment: {
      evaluation: {
        enemy_zoc_sources: [],
        victory_impact: {
          estimated_vp_delta: 0,
          unit_supply_before_move: "supplied",
          projected_supply_after_move: "supplied"
        }
      }
    },
    history: ["3509", "3510", "3511", "3512"],
    state: { units: { mover: { side: "axis", kind: "ground", hex: "3512" } } }
  });
  assert.equal(result.accept, false);
  assert.match(result.issues[0], /repeated destination/);
});

test("hierarchical task dispatch prefers current-phase task units without requiring a joint attack", () => {
  const result = reviewTaskDispatch({
    decisionMode: "hierarchical_sae",
    action: { type: "move", unit: "reserve-unit" },
    operationState: {
      phase_dispatch: {
        primary_task_id: "advance",
        allowed_unit_ids: ["advance-unit"]
      }
    },
    candidates: [{ action: { type: "move", unit: "advance-unit", destination: "3510" } }]
  });
  assert.equal(result.accept, true);
  assert.equal(result.issues.length, 0);
  assert.match(result.warnings[0], /cross_task_dispatch_without_detected_gain/);
  assert.deepEqual(result.exemptions, ["cross_task_model_discretion"]);
});

test("hierarchical movement reports supply risk without blocking a tactical move", () => {
  const result = reviewStrategicMovement({
    decisionMode: "hierarchical_sae",
    action: { type: "move", unit: "mover", destination: "3512" },
    assessment: {
      evaluation: {
        enemy_zoc_sources: [],
        victory_impact: {
          estimated_vp_delta: 0,
          unit_supply_before_move: "supplied",
          projected_supply_after_move: "partially_supplied"
        }
      }
    },
    operationState: { operation_policy: { supply_policy: "preserve supply" } },
    history: ["3510", "3511"],
    state: { units: { mover: { side: "axis", kind: "ground", hex: "3511" } } }
  });
  assert.equal(result.accept, true);
  assert.deepEqual(result.issues, []);
  assert.match(result.warnings[0], /supply_worsened/);
});

test("Allied hierarchical movement rejects opening the scoring defense line", () => {
  const result = reviewStrategicMovement({
    decisionMode: "hierarchical_sae",
    action: { type: "move", unit: "allied-line", destination: "3814" },
    assessment: {
      evaluation: {
        enemy_zoc_sources: [],
        victory_impact: {
          unit_supply_before_move: "supplied",
          projected_supply_after_move: "supplied",
          axis_scoring_threat_delta: 1,
          released_axis_frontier_units: ["axis-frontier"]
        }
      }
    },
    state: { units: { "allied-line": { side: "allies", kind: "ground", hex: "3714" } } }
  });
  assert.equal(result.accept, false);
  assert.match(result.issues[0], /opens the defensive line/);
});

test("hierarchical task dispatch records a tactical cross-task exception", () => {
  const result = reviewTaskDispatch({
    decisionMode: "hierarchical_sae",
    action: { type: "move", unit: "reserve-unit", destination: "3712" },
    assessment: {
      evaluation: {
        progress: 2,
        victory_impact: { estimated_vp_delta: 3, vp_relevance: "direct" }
      }
    },
    operationState: {
      operation_policy: { minimum_attack_odds: "2-1" },
      phase_dispatch: { primary_task_id: "advance", allowed_unit_ids: ["advance-unit"] }
    },
    candidates: [{ action: { type: "move", unit: "advance-unit", destination: "3510" } }]
  });
  assert.equal(result.accept, true);
  assert.match(result.warnings[0], /direct_vp_or_objective_gain/);
  assert.deepEqual(result.exemptions, ["cross_task_tactical_gain"]);
});

test("hierarchical combat guard rejects odds below policy and returns a viable alternative", () => {
  const result = reviewStrategicCombat({
    decisionMode: "hierarchical_sae",
    action: { type: "combat", attackers: ["a"], defender_hexes: ["2524"] },
    assessment: { evaluation: { odds_column: "1-1", victory_impact: { turns_remaining: 4 } } },
    operationState: { operation_policy: { minimum_attack_odds: "2-1" } },
    candidates: [{
      action: { type: "combat", attackers: ["a", "b"], defender_hexes: ["2524"] },
      evaluation: { odds_column: "2-1" },
      score: 42
    }]
  });
  assert.equal(result.accept, false);
  assert.match(result.issues[0], /below strategic minimum 2-1/);
  assert.equal(result.alternatives.length, 1);
  assert.deepEqual(result.alternatives[0].action.attackers, ["a", "b"]);
});

test("hierarchical combat guard accepts odds at the configured minimum", () => {
  const result = reviewStrategicCombat({
    decisionMode: "hierarchical_sae",
    action: { type: "combat", attackers: ["a", "b"], defender_hexes: ["2524"] },
    assessment: { evaluation: { odds_column: "2-1" } },
    operationState: { operation_policy: { minimum_attack_odds: "2-1" } }
  });
  assert.equal(result.accept, true);
});

test("Allied combat guard rejects a negative expected attack without an immediate frontier threat", () => {
  const result = reviewStrategicCombat({
    decisionMode: "hierarchical_sae",
    action: { type: "combat", attackers: ["allied-a"], defender_hexes: ["3510"] },
    assessment: {
      evaluation: {
        odds_column: "2-1",
        expected_crt_score: -1.5,
        victory_impact: { turns_remaining: 4 },
        defensive_effect: { immediate_axis_frontier_threat: false }
      }
    },
    operationState: { operation_policy: { minimum_attack_odds: "2-1" } },
    state: { units: { "allied-a": { side: "allies" } } }
  });
  assert.equal(result.accept, false);
  assert.match(result.issues[0], /negative expected combat value/);
});

test("Allied combat guard permits a non-negative two-to-one attack against a verified supplied frontier threat", () => {
  const result = reviewStrategicCombat({
    decisionMode: "hierarchical_sae",
    action: { type: "combat", attackers: ["allied-a"], defender_hexes: ["3610"] },
    assessment: {
      evaluation: {
        odds_column: "2-1",
        expected_crt_score: 0.5,
        victory_impact: { turns_remaining: 3 },
        defensive_effect: { immediate_axis_frontier_threat: true }
      }
    },
    operationState: { operation_policy: { minimum_attack_odds: "3-1" } },
    state: { units: { "allied-a": { side: "allies" } } }
  });
  assert.equal(result.accept, true);
  assert.deepEqual(result.exemptions, ["verified_frontier_threat_counterattack"]);
});

test("Axis combat keeps the configured two-to-one policy", () => {
  const result = reviewStrategicCombat({
    decisionMode: "hierarchical_sae",
    action: { type: "combat", attackers: ["axis-a", "axis-b"], defender_hexes: ["3510"] },
    assessment: { evaluation: { odds_column: "2-1", expected_crt_score: -1.5 } },
    operationState: { operation_policy: { minimum_attack_odds: "2-1" } },
    state: { units: { "axis-a": { side: "axis" }, "axis-b": { side: "axis" } } }
  });
  assert.equal(result.accept, true);
});

test("hierarchical movement guard grounds a dynamic non-assigned scoring advance in projected supply", () => {
  const result = reviewStrategicMovement({
    decisionMode: "hierarchical_sae",
    action: { type: "move", unit: "spearhead", destination: "3916" },
    assessment: {
      evaluation: {
        victory_impact: {
          estimated_vp_delta: 0,
          unit_supply_before_move: "unsupplied",
          projected_supply_after_move: "unsupplied"
        }
      }
    },
    operationState: {
      target_column: 37,
      goal_plan: {
        primary_goal: {
          target_column: 37,
          observable_conditions: [{ kind: "scoring_frontier_at_least", target: 37 }]
        }
      },
      phase_dispatch: { frontier_breakthrough: { current_column: 37 } },
      units: { spearhead: { role: "reserve" } }
    },
    history: ["3716"],
    state: { units: { spearhead: { side: "axis", kind: "ground", hex: "3716" } } }
  });
  assert.equal(result.accept, false);
  assert.match(result.issues[0], /projected supply unsupplied/);
});

test("single action bridge accepts once, rejects invalid proposals, and owns its session", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "single_action", token: "bridge-token" });
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));
  const original = structuredClone(state);
  const prepared = bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: state.active_side, session_id: "session-a", decisionMode: "direct" });
  assert.deepEqual(prepared.public_payload.context.protocol.allowed_tools, ["act"]);
  assert.deepEqual(prepared.public_payload.context.tools.map((tool) => tool.name), ["act"]);
  const invalid = bridge.executeTool("act", { action: { type: "move_intent", unit: "missing", destination: "3711" } }, "session-a");
  assert.equal(invalid.accepted, false);
  assert.equal(invalid.retryable, true);
  assert.deepEqual(state, original);
  const repeatedInvalid = bridge.executeTool("act", { action: { type: "move_intent", unit: "missing", destination: "3711" } }, "session-a");
  assert.equal(repeatedInvalid.accepted, false);
  assert.equal(repeatedInvalid.retryable, false);
  assert.equal(repeatedInvalid.stop, true);
  assert.equal(repeatedInvalid.repeated_rejection_count, 2);
  const accepted = bridge.executeTool("act", { action: { type: "pass", reason: "test" } }, "session-a");
  assert.equal(accepted.accepted, true);
  assert.deepEqual(bridge.submittedAction(), { type: "pass", reason: "test" });
  const repeat = bridge.executeTool("act", { action: { type: "pass", reason: "again" } }, "session-a");
  assert.equal(repeat.accepted, false);
  assert.equal(repeat.stop, true);

  bridge.prepareStep({ state, step: 2, turn: 1, phase: state.phase, side: state.active_side, session_id: "session-b", decisionMode: "direct" });
  assert.throws(() => bridge.executeTool("act", { action: { type: "pass" } }, "session-a"), /does not own/);
});

test("single action bridge applies the replay-owned October west-exit rule", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "single_action", token: "bridge-token" });
  const state = {
    scenario: "october",
    turn: 11,
    phase: "axis_mechanized_movement",
    active_side: "axis",
    units: {
      withdrawer: { side: "axis", hex: "0101", state: "fresh", kind: "ground", attack: 3, defense: 3, movement: 4 }
    }
  };
  const prepared = bridge.prepareStep({ state, step: 1, turn: 11, phase: state.phase, side: "axis", session_id: "october", decisionMode: "direct" });
  assert.equal(prepared.has_non_pass, true);
  const accepted = bridge.executeTool("act", { action: { type: "exit_west", unit: "withdrawer" } }, "october");
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.canonical_action, { type: "exit_west", unit: "withdrawer" });
});

test("rules tool returns selected authoritative rule sections without changing state", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_rules_tactical", token: "rules-token" });
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));
  const original = structuredClone(state);
  const prepared = bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: state.active_side, session_id: "rules-session", decisionMode: "hierarchical_sae" });
  assert.equal(prepared.public_payload.context.phase_status.snapshot.phase, state.phase);
  assert.ok(Array.isArray(prepared.public_payload.context.phase_status.remaining_units));
  const scoring = bridge.executeTool("inspect_rules", { topic: "scoring" }, "rules-session");
  assert.equal(scoring.ok, true);
  assert.equal(scoring.read_only, true);
  assert.equal(scoring.topic, "scoring");
  assert.ok(scoring.current.current_scoring);
  const movement = bridge.executeTool("inspect_rules", { topic: "movement" }, "rules-session");
  assert.equal(movement.ok, true);
  assert.ok(movement.movement.length > 0);
  assert.deepEqual(state, original);
});

test("map and action bridge returns a current read-only map without exposing candidates", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "map_and_action", token: "bridge-token" });
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));
  const original = structuredClone(state);
  const prepared = bridge.prepareStep({ state, step: 7, turn: 1, phase: state.phase, side: state.active_side, session_id: "map-session", decisionMode: "direct" });
  assert.deepEqual(prepared.public_payload.context.protocol.allowed_tools, ["view_map", "act"]);

  const map = bridge.executeTool("view_map", { focus: "overview" }, "map-session");
  assert.equal(map.ok, true);
  assert.equal(map.read_only, true);
  assert.deepEqual(map.snapshot, { step: 7, turn: 1, phase: state.phase, side: state.active_side });
  assert.ok(map.actionable_units.some((unit) => unit.id && unit.hex));
  assert.ok(map.minefields.some((mine) => mine.hex && mine.side));
  assert.equal(map.battlefield_summary.strategic_objective.type, "eastern_scoring_frontier");
  assert.equal(map.battlefield_summary.strategic_objective.next_scoring_column, 35);
  assert.equal(map.battlefield_summary.reference_landmark_hex, undefined);
  assert.equal(map.battlefield_summary.reference_landmark_role, undefined);
  assert.equal(map.candidate_actions, undefined);
  assert.equal(bridge.submittedAction(), null);
  assert.deepEqual(state, original);

  const focused = bridge.executeTool("view_map", { focus: "hex", target: "3711" }, "map-session");
  assert.equal(focused.ok, true);
  assert.equal(focused.hex.hex, "3711");

  const accepted = bridge.executeTool("act", { action: { type: "pass", reason: "map test" } }, "map-session");
  assert.equal(accepted.accepted, true);
  const afterAccepted = bridge.executeTool("view_map", { focus: "overview" }, "map-session");
  assert.equal(afterAccepted.accepted, false);
  assert.equal(afterAccepted.stop, true);

  bridge.prepareStep({ state, step: 8, turn: 1, phase: state.phase, side: state.active_side, session_id: "next-session", decisionMode: "direct" });
  assert.throws(() => bridge.executeTool("view_map", {}, "map-session"), /does not own/);
});

test("tactical tools read combat and supply information without accepting an action", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "map_tactical_action", token: "tactical-token" });
  const state = {
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
  };
  const original = structuredClone(state);
  bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: state.active_side, session_id: "tactical", decisionMode: "direct" });

  const combat = bridge.executeTool("check_combat", {
    attackers: ["attacker"],
    defender_hexes: ["2524"]
  }, "tactical");
  assert.equal(combat.legal, true, combat.reason);
  assert.equal(combat.details.attack, 2);
  assert.equal(combat.details.defense, 2);
  assert.ok(combat.details.odds_column);

  const supply = bridge.executeTool("inspect_supply", { unit: "attacker" }, "tactical");
  assert.equal(supply.legal, true);
  assert.equal(supply.unit, "attacker");
  assert.ok(["supplied", "partial", "unsupplied", ""].includes(supply.supply_state));
  assert.ok(Array.isArray(supply.path));
  const status = bridge.executeTool("phase_status", {}, "tactical");
  assert.equal(status.ok, true);
  assert.deepEqual(status.eligible_units, ["attacker"]);
  assert.deepEqual(status.acted_units, []);
  assert.deepEqual(status.remaining_units, ["attacker"]);
  assert.equal(status.has_legal_non_pass_action, true);
  assert.equal(status.can_pass, true);
  assert.equal(bridge.submittedAction(), null);
  assert.deepEqual(state, original);
});

test("combat phase_status groups attackable units by target without enumerating joint combinations", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "map_tactical_action", token: "combat-status-token" });
  const state = {
    scenario: "july",
    turn: 1,
    phase: "axis_combat",
    active_side: "axis",
    units: {
      attacker_a: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      attacker_b: { side: "axis", hex: "2423", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      defender: { side: "allies", hex: "2524", state: "fresh", attack: 1, defense: 2, movement: 4, kind: "ground" }
    }
  };
  bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: state.active_side, session_id: "combat-status", decisionMode: "direct" });
  const status = bridge.executeTool("phase_status", {}, "combat-status");
  assert.equal(status.combat_target_count, 1);
  assert.equal(status.combat_targets[0].target_hex, "2524");
  assert.deepEqual(status.combat_targets[0].attackers_that_can_attack.map((unit) => unit.unit).sort(), ["attacker_a", "attacker_b"]);
  assert.match(status.combat_targets[0].joint_attack_rule, /any subset/);
  assert.ok(Array.isArray(status.combat_targets[0].recommended_attackers));
  assert.ok(Array.isArray(status.combat_targets[0].recommended_defender_hexes));
  assert.equal(typeof status.combat_targets[0].recommendation_reason, "string");
  assert.equal(Object.hasOwn(status.combat_targets[0], "joint_attacks"), false);
  const incomplete = bridge.executeTool("check_combat", { attackers: ["attacker_a"], defender_hexes: ["2524"] }, "combat-status");
  assert.equal(incomplete.legal, false);
  assert.deepEqual(incomplete.details.missing_attackers, ["attacker_b"]);
  const complete = bridge.executeTool("check_combat", { attackers: ["attacker_a", "attacker_b"], defender_hexes: ["2524"] }, "combat-status");
  assert.equal(complete.legal, true, complete.reason);
  assert.ok(complete.details.odds_column);
});

test("combat phase exposes and accepts rule-authorized combat-unit mine clearance", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "map_tactical_action", token: "mine-clear-token" });
  const state = {
    scenario: "september",
    turn: 5,
    phase: "axis_combat",
    active_side: "axis",
    units: {
      engineer: { side: "axis", hex: "3319", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      mine: { side: "allies", hex: "3319", state: "fresh", attack: 0, defense: 0, movement: 0, kind: "mine" }
    }
  };
  bridge.prepareStep({ state, step: 1, turn: 5, phase: state.phase, side: "axis", session_id: "mine-clear", decisionMode: "direct" });
  const status = bridge.executeTool("phase_status", {}, "mine-clear");
  assert.deepEqual(status.clear_mine_options.map((item) => item.unit), ["engineer"]);
  const accepted = bridge.executeTool("act", { action: { type: "clear_mine", unit: "engineer", hex: "3319" } }, "mine-clear");
  assert.equal(accepted.accepted, true, accepted.reason);
  assert.deepEqual(accepted.canonical_action, { type: "clear_mine", unit: "engineer", hex: "3319" });
  assert.equal(Object.hasOwn(accepted.canonical_action, "die"), false);
});

test("hierarchical combat may pass without holding every attack-capable unit", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_rules_tactical", token: "combat-pass-token" });
  const state = {
    scenario: "july",
    turn: 2,
    phase: "axis_combat",
    active_side: "axis",
    units: {
      attacker: { side: "axis", hex: "2424", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      defender: { side: "allies", hex: "2524", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  };
  bridge.prepareStep({
    state,
    step: 1,
    turn: 2,
    phase: state.phase,
    side: "axis",
    session_id: "combat-pass",
    decisionMode: "hierarchical_sae",
    operationState: { operation_policy: { minimum_attack_odds: "2-1" } }
  });
  const status = bridge.executeTool("phase_status", {}, "combat-pass");
  assert.equal(status.remaining_units.length, 1);
  assert.equal(status.can_pass, true);
  const pass = bridge.executeTool("act", { action: { type: "pass", reason: "no attack reaches 2-1" } }, "combat-pass");
  assert.equal(pass.accepted, true);
});

test("hierarchical combat fallback passes instead of bypassing the minimum odds guard", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_rules_tactical", token: "combat-fallback-token" });
  const state = {
    scenario: "july",
    turn: 2,
    phase: "axis_combat",
    active_side: "axis",
    units: {
      attacker: { side: "axis", hex: "2424", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      defender: { side: "allies", hex: "2524", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  };
  bridge.prepareStep({
    state,
    step: 1,
    turn: 2,
    phase: state.phase,
    side: "axis",
    session_id: "combat-fallback",
    decisionMode: "hierarchical_sae",
    operationState: { operation_policy: { minimum_attack_odds: "2-1" } }
  });
  const fallback = bridge.fallbackAction();
  assert.equal(fallback.type, "pass");
  assert.match(fallback.reason, /no combat meets strategic minimum 2-1/);
});

test("phase_status tracks a moved unit and keeps the phase-start snapshot", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "map_tactical_action", token: "phase-status-token" });
  const state = {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {
      mover: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      reserve: { side: "axis", hex: "2524", state: "fresh", attack: 1, defense: 1, movement: 0, kind: "ground" }
    }
  };
  bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: state.active_side, session_id: "phase-status", decisionMode: "direct" });
  const before = bridge.executeTool("phase_status", {}, "phase-status");
  assert.deepEqual(before.eligible_units, ["mover"]);
  assert.deepEqual(before.remaining_units, ["mover"]);
  assert.equal(before.can_pass, false);

  state.units.mover.hex = "2524";
  state.units.mover.state = "spent";
  bridge.prepareStep({ state, step: 2, turn: 1, phase: state.phase, side: state.active_side, session_id: "phase-status", decisionMode: "direct" });
  const after = bridge.executeTool("phase_status", {}, "phase-status");
  assert.deepEqual(after.eligible_units, ["mover"]);
  assert.deepEqual(after.acted_units, ["mover"]);
  assert.deepEqual(after.remaining_units, []);
  assert.equal(after.can_pass, true);
  assert.equal(after.advance_reason, "all_eligible_units_handled");
});

test("rolling movement requires every eligible unit to move or hold before pass", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", token: "rolling-token" });
  const state = {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {
      first: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      second: { side: "axis", hex: "2624", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  };
  bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: "axis", session_id: "rolling", decisionMode: "unit_plan_hybrid" });

  const earlyPass = bridge.executeTool("act", { action: { type: "pass", reason: "too early" } }, "rolling");
  assert.equal(earlyPass.accepted, false);
  assert.match(earlyPass.reason, /cannot pass/);

  const heldFirst = bridge.executeTool("hold_unit", { unit: "first", reason: "screen the flank" }, "rolling");
  assert.equal(heldFirst.accepted, true);
  assert.deepEqual(heldFirst.phase_status.held_units, ["first"]);
  assert.deepEqual(heldFirst.phase_status.remaining_units, ["second"]);

  const moveHeld = bridge.executeTool("act", {
    action: { type: "move_intent", unit: "first", destination: "2524", mode: "auto" }
  }, "rolling");
  assert.equal(moveHeld.accepted, false);
  assert.match(moveHeld.reason, /already held/);

  const heldSecond = bridge.executeTool("hold_unit", { unit: "second", reason: "maintain reserve" }, "rolling");
  assert.equal(heldSecond.accepted, true);
  assert.equal(heldSecond.phase_complete, true);
  assert.equal(heldSecond.phase_status.can_pass, true);

  const pass = bridge.executeTool("act", { action: { type: "pass", reason: "all units handled" } }, "rolling");
  assert.equal(pass.accepted, true);
  assert.equal(bridge.submittedAction().type, "pass");
});

test("batch hold is atomic and updates phase bookkeeping once", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", token: "batch-hold-token" });
  const batchState = {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {
      first: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      second: { side: "axis", hex: "2624", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  };
  bridge.prepareStep({ state: batchState, step: 1, turn: 1, phase: batchState.phase, side: "axis", session_id: "batch-hold", decisionMode: "unit_plan_hybrid" });
  const rejected = bridge.executeTool("hold_units", { orders: [
    { unit: "first", reason: "screen" },
    { unit: "missing", reason: "reserve" }
  ] }, "batch-hold");
  assert.equal(rejected.accepted, false);
  assert.deepEqual(bridge.phaseStatus().held_units, []);
  const accepted = bridge.executeTool("hold_units", { orders: [
    { unit: "first", reason: "screen" },
    { unit: "second", reason: "reserve" }
  ] }, "batch-hold");
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.newly_held, ["first", "second"]);
  assert.equal(accepted.phase_status.can_pass, true);
});

test("Allied hierarchical hold requires a concrete assigned defensive role", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", token: "allied-hold-role-token" });
  const defensiveState = {
    scenario: "july",
    turn: 1,
    phase: "allies_initial_movement",
    active_side: "allies",
    units: {
      defender: { side: "allies", hex: "3714", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" }
    }
  };
  const prepare = (step) => bridge.prepareStep({
    state: defensiveState,
    step,
    turn: 1,
    phase: defensiveState.phase,
    side: "allies",
    session_id: "allied-hold-role",
    decisionMode: "hierarchical_sae",
    operationState: {
      task_plan: {
        side: "allies",
        children: [{ id: "line", type: "hold_blocking_line", status: "active", assigned_units: ["defender"] }]
      }
    }
  });
  prepare(1);
  const rejected = bridge.executeTool("hold_unit", { unit: "defender", reason: "stay here" }, "allied-hold-role");
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /concrete defensive role/);
  prepare(2);
  const accepted = bridge.executeTool("hold_unit", { unit: "defender", reason: "hold the blocking line and screen the Axis route" }, "allied-hold-role");
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.defensive_role, "hold_blocking_line");
});

test("an unchanged rejected action cannot be repeated in a later replay step", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", token: "rejection-memory-token" });
  const repeatState = {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {
      mover: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" }
    }
  };
  const proposal = { action: { type: "move_intent", unit: "mover", destination: "9999", mode: "auto" } };
  bridge.prepareStep({ state: repeatState, step: 1, turn: 1, phase: repeatState.phase, side: "axis", session_id: "rejection-memory", decisionMode: "hierarchical_sae" });
  const first = bridge.executeTool("act", proposal, "rejection-memory");
  assert.equal(first.accepted, false);
  bridge.prepareStep({ state: repeatState, step: 2, turn: 1, phase: repeatState.phase, side: "axis", session_id: "rejection-memory", decisionMode: "hierarchical_sae" });
  const repeated = bridge.executeTool("act", proposal, "rejection-memory");
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.retryable, false);
  assert.match(repeated.reason, /unchanged_state_repeat/);
});

test("an irrelevant remote move does not clear rejection memory", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", token: "local-rejection-memory-token" });
  const repeatState = {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {
      mover: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      remote: { side: "allies", hex: "4910", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  };
  const proposal = { action: { type: "move_intent", unit: "mover", destination: "9999", mode: "auto" } };
  bridge.prepareStep({ state: repeatState, step: 1, turn: 1, phase: repeatState.phase, side: "axis", session_id: "local-rejection-memory", decisionMode: "hierarchical_sae" });
  const first = bridge.executeTool("act", proposal, "local-rejection-memory");
  assert.equal(first.accepted, false);
  const changed = structuredClone(repeatState);
  changed.turn = 2;
  changed.units.remote.hex = "4911";
  bridge.prepareStep({ state: changed, step: 2, turn: 2, phase: changed.phase, side: "axis", session_id: "local-rejection-memory", decisionMode: "hierarchical_sae" });
  const repeated = bridge.executeTool("act", proposal, "local-rejection-memory");
  assert.equal(repeated.retryable, false);
  assert.match(repeated.reason, /unchanged_state_repeat/);
});

test("rolling movement cannot hold a unit required to repair temporary overstack", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", token: "stack-token" });
  const units = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `stack-${index + 1}`,
    {
      side: "axis",
      hex: "2424",
      state: "fresh",
      attack: 1,
      defense: 1,
      movement: 4,
      kind: "ground",
      temporary_overstack: true
    }
  ]));
  const state = {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units
  };
  bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: "axis", session_id: "stack", decisionMode: "unit_plan_hybrid" });

  const status = bridge.executeTool("phase_status", {}, "stack");
  assert.equal(status.mandatory_actions.length, 1);
  assert.equal(status.can_pass, false);
  const held = bridge.executeTool("hold_unit", { unit: "stack-1", reason: "stay in place" }, "stack");
  assert.equal(held.accepted, false);
  assert.match(held.reason, /must help repair temporary overstack/);
});

test("rolling phase marks a rule-eligible but immobile unit unavailable", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", token: "blocked-token" });
  const state = {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {
      blocked: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      enemy: { side: "allies", hex: "2524", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" }
    }
  };
  bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: "axis", session_id: "blocked", decisionMode: "unit_plan_hybrid" });

  const status = bridge.executeTool("phase_status", {}, "blocked");
  assert.deepEqual(status.eligible_units, ["blocked"]);
  assert.deepEqual(status.remaining_units, []);
  assert.deepEqual(status.unavailable_units, ["blocked"]);
  assert.equal(status.can_pass, true);
  assert.equal(status.advance_reason, "no_legal_non_pass_action");
});

test("rolling fallback moves a remaining legal unit instead of ending the phase", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", token: "fallback-token" });
  const state = {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {
      mover: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" }
    }
  };
  bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: "axis", session_id: "fallback", decisionMode: "unit_plan_hybrid" });

  const fallback = bridge.fallbackAction();
  assert.equal(fallback.type, "move");
  assert.equal(fallback.unit, "mover");
  assert.ok(Array.isArray(fallback.path) && fallback.path.length > 1);
  assert.notEqual(fallback.destination, "2424");
});

test("ledger fallback exposes a validated repair move in mechanized movement", () => {
  const bridge = createActionRuleBridge(readConfig(), {
    toolProfile: "rolling_unit_rules_tactical",
    token: "mechanized-stack-token",
    executionLedger: true
  });
  const units = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `mechanized-stack-${index + 1}`,
    {
      side: "axis",
      hex: "3410",
      state: "fresh",
      attack: 2,
      defense: 2,
      movement: 4,
      kind: "ground",
      piece_type: "Mech",
      temporary_overstack: true
    }
  ]));
  const state = {
    scenario: "july",
    turn: 6,
    phase: "axis_mechanized_movement",
    active_side: "axis",
    units
  };
  bridge.prepareStep({
    state,
    step: 1,
    turn: 6,
    phase: state.phase,
    side: "axis",
    session_id: "mechanized-stack",
    decisionMode: "hierarchical_sae"
  });
  const status = bridge.phaseStatus();
  assert.equal(status.mandatory_actions.length, 1);
  assert.ok(status.mandatory_actions[0].repair_options.length > 0);
  const fallback = bridge.fallbackAction();
  assert.equal(fallback.type, "move");
  assert.equal(fallback.unit, "mechanized-stack-1");
  assert.ok(Array.isArray(fallback.path) && fallback.path.length === 2);
  assert.equal(RulesEngine.checkMove(bridge.current().built.ctx, fallback.unit, fallback.path, { mode: "normal" }).legal, true);
});
