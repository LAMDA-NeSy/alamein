"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONTEXT_PROFILE_ID,
  compactAgentPayload,
  compactToolFeedback,
  contextBytes
} = require("../core/agent_context.js");

test("shared context projection preserves execution controls and bounds repeated board detail", () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({ action: { type: "pass", reason: String(index) } }));
  const payload = {
    provider: "mock",
    model: "mock",
    rules_summary: "rules",
    context: {
      protocol: { allowed_tools: ["act"] },
      game: { turn: 1, phase: "axis_initial_movement" },
      game_overview: {
        title: "阿拉曼六角格兵棋",
        current_side: "axis",
        player_goal_summary: "你现在扮演 Axis。优先推进到下一计分前沿并保持补给。",
        player_goal: {
          side: "axis",
          win_condition: "cross the next scoring frontier while preserving supply"
        },
        decision_order: ["score first"]
      },
      forces: { large: true },
      battlefield_summary: { redundant: true },
      unit_index: { active: { a: {} }, enemy: { b: {} } },
      map_intel: {
        key_hexes: Array.from({ length: 12 }, (_, index) => ({ hex: String(index) })),
        frontline: Array.from({ length: 10 }, (_, index) => ({ unit: String(index) }))
      },
      phase_intent: { type: "advance" },
      execution_candidate_count: 8,
      candidate_actions: candidates,
      tools: [{ name: "act" }]
    }
  };
  const compact = compactAgentPayload(payload);
  assert.equal(CONTEXT_PROFILE_ID, "compact_current_state_v3");
  assert.equal(compact.context.forces, undefined);
  assert.equal(compact.context.battlefield_summary, undefined);
  assert.equal(compact.context.map_intel.key_hexes.length, 8);
  assert.equal(compact.context.map_intel.frontline.length, 6);
  assert.equal(compact.context.candidate_actions.length, 6);
  assert.deepEqual(compact.context.tools, [{ name: "act" }]);
  assert.equal(compact.context.game_overview.title, "阿拉曼六角格兵棋");
  assert.match(compact.context.game_overview.player_goal_summary, /你现在扮演 Axis/);
  assert.equal(compact.context.game_overview.player_goal.side, "axis");
  assert.match(compact.context.game_overview.player_goal.win_condition, /scoring frontier/);
  assert.ok(contextBytes(compact) < contextBytes(payload));
});

test("dynamic projection omits the opening map and repeated operation copies", () => {
  const payload = {
    context: {
      game_overview: {
        current_side: "axis",
        player_goal_summary: "Score with supplied Axis combat units.",
        initial_map_reference_2d: { layout_rows: ["large opening map"] }
      },
      tools: [{ name: "view_map", description: "long description", parameters: { type: "object" } }],
      strategic_intent: { intent: "advance", goal_plan: { primary_goal: { id: "score" } } },
      operation_state: {
        operation: "breakthrough",
        goal_plan: { duplicate: true },
        force_allocation: { duplicate: true },
        task_plan: {
          parent: { id: "operation", state: "active" },
          children: [{ id: "supply", status: "active", assigned_units: ["u1"] }]
        },
        active_tasks: [{ id: "supply", status: "active", assigned_units: ["u1"] }],
        phase_status: { duplicate: true }
      },
      phase_status: { can_pass: false, remaining_units: ["u1"], counts: { eligible: 1 } },
      unit_index: { active: [{ id: "u1" }], enemy: [{ id: "e1" }] }
    }
  };
  const compact = compactAgentPayload(payload, { includeInitialMap: false });
  assert.equal(compact.context.game_overview.initial_map_reference_2d, undefined);
  assert.equal(compact.context.game_overview.player_goal_summary, "Score with supplied Axis combat units.");
  assert.deepEqual(compact.context.tools, [{ name: "view_map" }]);
  assert.equal(compact.context.strategic_intent.goal_plan, undefined);
  assert.equal(compact.context.operation_state.goal_plan, undefined);
  assert.equal(compact.context.operation_state.force_allocation, undefined);
  assert.equal(compact.context.operation_state.task_plan.children[0].assigned_units[0], "u1");
  assert.equal(compact.context.phase_status.remaining_units[0], "u1");
});

test("dynamic operation projection preserves movement combat preparation", () => {
  const compact = compactAgentPayload({
    context: {
      operation_state: {
        phase_dispatch: {
          phase_kind: "initial_movement",
          upcoming_combat_opportunities: [{
            target_hex: "3011",
            approaching_units: ["axis-1", "axis-2"],
            joint_attack_potential: true,
            verified_combat: false
          }],
          preparation_actions: ["preserve supply while preparing contact"],
          recommended_preparation_unit_ids: ["axis-1", "axis-2"]
        }
      }
    }
  }, { includeInitialMap: false });
  const dispatch = compact.context.operation_state.phase_dispatch;
  assert.equal(dispatch.upcoming_combat_opportunities[0].target_hex, "3011");
  assert.equal(dispatch.upcoming_combat_opportunities[0].verified_combat, false);
  assert.deepEqual(dispatch.recommended_preparation_unit_ids, ["axis-1", "axis-2"]);
  assert.deepEqual(dispatch.preparation_actions, ["preserve supply while preparing contact"]);
});

test("stable opening fields can be removed from the per-step projection", () => {
  const compact = compactAgentPayload({
    provider: "provider",
    model: "model",
    rules_summary: "stable rules",
    context: {
      protocol: { allowed_tools: ["act"] },
      game: { turn: 2 },
      mission: "stable mission",
      map_topology: { rule: "stable" },
      tools: [{ name: "act" }],
      game_overview: {
        player_goal_summary: "stable side briefing",
        turn_goal_update: "dynamic frontier update",
        player_goal: { primary_objective: "dynamic objective" }
      }
    }
  }, { includeInitialMap: false, includeStableContext: false });
  assert.equal(compact.provider, undefined);
  assert.equal(compact.rules_summary, undefined);
  assert.equal(compact.context.protocol, undefined);
  assert.equal(compact.context.mission, undefined);
  assert.equal(compact.context.map_topology, undefined);
  assert.equal(compact.context.tools, undefined);
  assert.equal(compact.context.game_overview.player_goal_summary, undefined);
  assert.equal(compact.context.game_overview.turn_goal_update, "dynamic frontier update");
  assert.equal(compact.context.game_overview.player_goal.primary_objective, "dynamic objective");
});

test("compact action feedback retains rejection and bounded repair guidance", () => {
  const feedback = compactToolFeedback({
    tool: "act",
    arguments: { action: { type: "move_intent", unit: "u1", destination: "3511" } },
    result: {
      accepted: false,
      retryable: true,
      reason: "destination is blocked",
      rejection_type: "rule",
      assessment: {
        legal: false,
        recommended_recovery: "choose a legal adjacent destination",
        alternatives: Array.from({ length: 5 }, (_, index) => ({
          action: { type: "move", unit: "u1", destination: `35${index}1` },
          score: 10 - index,
          evaluation: {
            summary: `alternative ${index}`,
            victory_impact: {
              self_vp_delta: 0,
              projected_supply_after_move: "supplied",
              verbose_internal_trace: "x".repeat(2000)
            },
            risks: ["zoc"]
          }
        }))
      }
    }
  });
  assert.equal(feedback.result.accepted, false);
  assert.equal(feedback.result.reason, "destination is blocked");
  assert.equal(feedback.result.assessment.recommended_recovery, "choose a legal adjacent destination");
  assert.equal(feedback.result.alternatives.length, 3);
  assert.equal(feedback.result.alternatives[0].evaluation.victory_impact.verbose_internal_trace, undefined);
  assert.ok(contextBytes(feedback) < 2000);
});
