"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { readConfig } = require("../experiments/external_ai_transcript.js");
const { makeSingleActionProvider } = require("../experiments/external_ai_full_game_transcript.js");

test("manual provider sends a stable opening prefix and compact v3 current state from step one", async () => {
  const requests = [];
  const client = {
    async complete(request) {
      requests.push(request);
      return {
        ok: true,
        status: 200,
        request_body: request,
        response_json: {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "act",
                  arguments: JSON.stringify({ action: { type: "pass", reason: "test" } })
                }
              }]
            }
          }]
        }
      };
    }
  };
  const runtime = {
    run_id: "manual-context-test",
    profile: {
      provider: "local_mock",
      model: "mock",
      limits: { output: 2048 },
      capabilities: { structured_output: "json_object" },
      defaults: { temperature: 0, timeout_ms: 3000, thinking: "omitted" }
    }
  };
  const payload = {
    provider: "local_mock",
    model: "mock",
    rules_summary: "rules",
    context: {
      protocol: { allowed_tools: ["act"] },
      game: { turn: 1, phase: "axis_combat" },
      game_overview: {
        current_side: "axis",
        player_goal_summary: "Score with supplied combat units.",
        initial_map_reference_2d: { format: "hex", layout_rows: ["opening-map-row"] }
      },
      forces: { verbose: "x".repeat(5000) },
      battlefield_summary: { verbose: "x".repeat(5000) },
      unit_index: { active: [{ id: "u1" }], enemy: [{ id: "e1" }] },
      tools: [{ name: "act", description: "x".repeat(5000), parameters: { type: "object" } }],
      phase_status: { can_pass: true, remaining_units: [] }
    }
  };
  const bridge = {
    prepareStep() {
      return { public_payload: JSON.parse(JSON.stringify(payload)), has_non_pass: true };
    },
    executeTool() {
      return { accepted: true, action: { type: "pass", reason: "test" } };
    },
    fallbackAction() {
      return { type: "pass", reason: "fallback" };
    }
  };
  const transcript = { model_steps: [] };
  const provider = makeSingleActionProvider(readConfig(), runtime, transcript, {
    client,
    bridge,
    decisionPolicy: "direct",
    toolProfile: "single_action",
    progress: false
  });

  const result = await provider({ step: 1, turn: 1, phase: "axis_combat", side: "axis", state: {} });
  assert.equal(result.action.type, "pass");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[1].role, "user");
  assert.match(requests[0].messages[1].content, /^OPENING_STATIC_CONTEXT/);
  assert.match(requests[0].messages[1].content, /opening-map-row/);
  assert.match(requests[0].messages[2].content, /^CURRENT_STATE/);
  assert.doesNotMatch(requests[0].messages[2].content, /opening-map-row/);
  assert.doesNotMatch(requests[0].messages[2].content, /"forces"/);
  assert.doesNotMatch(requests[0].messages[2].content, /"description":"xxxxx/);
  assert.deepEqual(JSON.parse(requests[0].messages[2].content.split("\n\nTOOL_RESULTS_FROM_THIS_STEP\n")[1]), []);
  assert.equal(transcript.model_steps[0].context_profile, "compact_current_state_v3");
  assert.ok(transcript.model_steps[0].context_bytes < transcript.model_steps[0].raw_context_bytes);
  assert.ok(transcript.model_steps[0].static_context_bytes > 0);
  assert.ok(transcript.model_steps[0].effective_context_bytes > transcript.model_steps[0].context_bytes);
});
