"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { readConfig } = require("../experiments/external_ai_transcript.js");
const { makeSingleActionProvider } = require("../experiments/external_ai_full_game_transcript.js");
const { createActionRuleBridge } = require("../core/action_rule_bridge.js");
const RulesEngine = require("../../rule_engine.js");

test("rolling provider records fallback provenance, exit eligibility and applied feedback", async () => {
  const config = readConfig();
  const bridge = createActionRuleBridge(config, { toolProfile: "rolling_unit_rules_tactical" });
  const state = { scenario: "october", active_side: "axis", turn: 11, phase: "axis_initial_movement", units: {
    a: { side: "axis", kind: "ground", hex: "0101", attack: 2, defense: 2, movement: 4, state: "fresh" }
  } };
  const responses = [
    { type: "strategic_intent", operation: "withdrawal", intent_type: "withdraw" },
    { type: "force_allocation", spearhead: [{ unit: "a", task: "withdraw" }], support: [], supply: [], reserve: [] },
    [{ type: "phase_unit_plan", unit_orders: [] }]
  ];
  const transcript = { model_steps: [] };
  const provider = makeSingleActionProvider(config, {
    run_id: "rolling-integration",
    profile: { provider: "local_mock", model: "mock", limits: { output: 1000 }, capabilities: {}, defaults: { temperature: 0 } }
  }, transcript, {
    bridge, decisionPolicy: "hierarchical_sae", progress: false,
    unitPlanSettings: { max_recommendation_expansions: 1 },
    client: { complete: async (request) => ({ ok: true, status: 200, request_body: request,
      response_json: { choices: [{ message: { content: JSON.stringify(responses.shift()) } }] } }) }
  });
  const chosen = await provider({ state, side: "axis", turn: 11, phase: state.phase, step: 1 });
  assert.equal(chosen.action.type, "exit_west");
  assert.equal(transcript.model_steps[0].fallback_used, true);
  assert.deepEqual(transcript.model_steps[0].movement_phase.withdrawal_eligible_units, ["a"]);
  const ctx = bridge.current().built.ctx;
  const after = structuredClone(state);
  const result = RulesEngine.applyExitWest(RulesEngine.createContext({ state: after, rules: ctx.rules, terrain: ctx.terrain }), "a");
  await provider.onActionApplied({ step: 1, state: after, action: chosen.action, result, applied: true });
  assert.equal(transcript.model_steps[0].action_effect.accepted, true);
  assert.equal(transcript.model_steps[0].action_effect.actual_vp_delta, 2);
  assert.equal(transcript.model_steps[0].action_effect.unavailable, undefined);
});

test("manual provider sends a stable opening prefix and compact current state from step one", async () => {
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
  assert.equal(transcript.model_steps[0].context_profile, "compact_current_state_v4_reasoning_memory");
  assert.ok(transcript.model_steps[0].context_bytes < transcript.model_steps[0].raw_context_bytes);
  assert.ok(transcript.model_steps[0].static_context_bytes > 0);
  assert.ok(transcript.model_steps[0].effective_context_bytes > transcript.model_steps[0].context_bytes);
});

test("manual provider preserves assistant reasoning and tool output within one step", async () => {
  const requests = [];
  let calls = 0;
  const client = {
    async complete(request) {
      requests.push(request);
      calls += 1;
      return {
        ok: true,
        status: 200,
        request_body: request,
        response_json: {
          choices: [{ message: calls === 1 ? {
            role: "assistant",
            content: null,
            reasoning_content: "Inspect the board before acting.",
            tool_calls: [{ id: "map-call", type: "function", function: { name: "view_map", arguments: "{}" } }]
          } : {
            role: "assistant",
            content: null,
            reasoning_content: "The inspection supports ending this test step.",
            tool_calls: [{ id: "act-call", type: "function", function: { name: "act", arguments: JSON.stringify({ action: { type: "pass", reason: "test" } }) } }]
          } }]
        }
      };
    }
  };
  const runtime = {
    run_id: "manual-reasoning-chain",
    profile: {
      provider: "local_mock",
      model: "mock",
      limits: { output: 2048 },
      capabilities: { structured_output: "json_object" },
      defaults: { temperature: 0, timeout_ms: 3000, thinking: "omitted" }
    }
  };
  const payload = {
    context: {
      game: { turn: 1, phase: "axis_combat" },
      game_overview: { current_side: "axis" },
      tools: [{ name: "view_map" }, { name: "act" }]
    }
  };
  const bridge = {
    prepareStep() { return { public_payload: structuredClone(payload), has_non_pass: true }; },
    executeTool(name) {
      return name === "view_map"
        ? { ok: true, read_only: true, reason: "map inspected" }
        : { accepted: true, action: { type: "pass", reason: "test" } };
    },
    fallbackAction() { return { type: "pass", reason: "fallback" }; }
  };
  const transcript = { model_steps: [] };
  const provider = makeSingleActionProvider(readConfig(), runtime, transcript, {
    client,
    bridge,
    decisionPolicy: "direct",
    toolProfile: "map_and_action",
    progress: false
  });
  const result = await provider({ step: 1, turn: 1, phase: "axis_combat", side: "axis", state: {} });
  assert.equal(result.action.type, "pass");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-2).role, "assistant");
  assert.equal(requests[1].messages.at(-2).reasoning_content, "Inspect the board before acting.");
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[1].messages.at(-1).tool_call_id, "map-call");
  assert.equal(transcript.model_steps[0].reasoning.reasoning_rounds, 2);
  assert.match(transcript.model_steps[0].reasoning_memory_entry.reasoning_excerpt, /Inspect the board/);
});

test("manual provider can exclude reasoning from the in-step request chain while retaining it in the transcript", async () => {
  const requests = [];
  let calls = 0;
  const client = {
    async complete(request) {
      requests.push(request);
      calls += 1;
      return {
        ok: true,
        status: 200,
        request_body: request,
        response_json: {
          choices: [{ message: calls === 1 ? {
            role: "assistant",
            content: null,
            reasoning_content: "Inspect without replaying reasoning.",
            tool_calls: [{ id: "map-call", type: "function", function: { name: "view_map", arguments: "{}" } }]
          } : {
            role: "assistant",
            content: null,
            reasoning_content: "Finish the action.",
            tool_calls: [{ id: "act-call", type: "function", function: { name: "act", arguments: JSON.stringify({ action: { type: "pass", reason: "test" } }) } }]
          } }]
        }
      };
    }
  };
  const runtime = {
    run_id: "manual-reasoning-none",
    profile: {
      provider: "local_mock",
      model: "mock",
      limits: { output: 2048 },
      capabilities: { structured_output: "json_object" },
      defaults: { temperature: 0, timeout_ms: 3000, thinking: "omitted" }
    }
  };
  const payload = {
    context: {
      game: { turn: 1, phase: "axis_combat" },
      game_overview: { current_side: "axis" },
      tools: [{ name: "view_map" }, { name: "act" }]
    }
  };
  const bridge = {
    prepareStep() { return { public_payload: structuredClone(payload), has_non_pass: true }; },
    executeTool(name) {
      return name === "view_map"
        ? { ok: true, read_only: true, reason: "map inspected" }
        : { accepted: true, action: { type: "pass", reason: "test" } };
    },
    fallbackAction() { return { type: "pass", reason: "fallback" }; }
  };
  const transcript = { model_steps: [] };
  const provider = makeSingleActionProvider(readConfig(), runtime, transcript, {
    client,
    bridge,
    decisionPolicy: "direct",
    toolProfile: "map_and_action",
    reasoningMemoryConfig: {
      enabled: true,
      within_step: "none",
      cross_step: "summary_plus_excerpt"
    },
    progress: false
  });

  const result = await provider({ step: 1, turn: 1, phase: "axis_combat", side: "axis", state: {} });
  assert.equal(result.action.type, "pass");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-2).role, "assistant");
  assert.equal(requests[1].messages.at(-2).reasoning_content, undefined);
  assert.deepEqual(requests[1].messages.at(-2).tool_calls.map((call) => call.id), ["map-call"]);
  assert.equal(transcript.model_steps[0].rounds[0].model_output.choices[0].message.reasoning_content, "Inspect without replaying reasoning.");
  assert.match(transcript.model_steps[0].reasoning_memory_entry.reasoning_excerpt, /Inspect without replaying reasoning/);
});
