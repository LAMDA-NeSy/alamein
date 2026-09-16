"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createReasoningMemory } = require("../core/reasoning_memory.js");

function stepRecord(overrides = {}) {
  return {
    step: 1,
    turn: 1,
    side: "axis",
    phase: "axis_initial_movement",
    final_action: { type: "move", unit: "axis-1", destination: "3511", reason: "advance under supply" },
    rounds: [{
      model_output: {
        choices: [{ message: {
          content: null,
          reasoning_content: "The unit can keep supply while approaching the scoring frontier.",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "act", arguments: "{}" } }]
        } }]
      },
      tool_result: { tool: "act", result: { accepted: true, reason: "action accepted" } }
    }],
    action_effect: { accepted: true, action_type: "move", self_vp_delta: 0, supply_risk_delta: 0 },
    ...overrides
  };
}

test("reasoning memory retains compact decision evidence but invalidates it after a replan", () => {
  const memory = createReasoningMemory({ max_excerpt_tokens: 40, max_summary_tokens: 80 });
  memory.begin({ step: 1, turn: 1, side: "axis", phase: "axis_initial_movement" });
  memory.recordStep(stepRecord(), { step: 1, turn: 1, side: "axis", phase: "axis_initial_movement" });
  let prompt = memory.forPrompt({ step: 2, turn: 1, side: "axis", phase: "axis_initial_movement" });
  assert.equal(prompt.recent_decisions.length, 1);
  assert.match(prompt.recent_decisions[0].reasoning_excerpt, /supply/);
  memory.markReplanned({ turn: 1, side: "axis", phase: "axis_initial_movement" }, "route_blocked");
  prompt = memory.forPrompt({ step: 2, turn: 1, side: "axis", phase: "axis_initial_movement" });
  assert.equal(prompt.recent_decisions.length, 0);
  assert.equal(memory.stats().invalidated_entries, 1);
});

test("reasoning memory retains a prior-phase summary without replaying its reasoning excerpt", () => {
  const memory = createReasoningMemory();
  memory.begin({ step: 1, turn: 1, side: "axis", phase: "axis_initial_movement" });
  memory.recordStep(stepRecord(), { step: 1, turn: 1, side: "axis", phase: "axis_initial_movement" });
  memory.begin({ step: 2, turn: 1, side: "axis", phase: "axis_combat" });
  const prompt = memory.forPrompt({ step: 2, turn: 1, side: "axis", phase: "axis_combat" });
  assert.equal(prompt.recent_decisions.length, 0);
  assert.equal(prompt.previous_phase_decision.phase, "axis_initial_movement");
  assert.equal(Object.hasOwn(prompt.previous_phase_decision, "reasoning_excerpt"), false);
});
