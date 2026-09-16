"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { makeReplay } = require("../experiments/ai_replay.js");
const { readConfig } = require("../experiments/external_ai_transcript.js");
const { makeSingleActionProvider } = require("../experiments/external_ai_full_game_transcript.js");
const { createActionRuleBridge } = require("../core/action_rule_bridge.js");

function setup({ decisionPolicy = "direct", initialMovement = false, response } = {}) {
  const replay = makeReplay("july", { seed: 1942 });
  Object.assign(replay.state, {
    phase: initialMovement ? "axis_initial_movement" : "axis_combat",
    active_side: "axis",
    road_supply_markers: { axis: "2424" },
    scenario_meta: { road_path: ["0101", "2424"] },
    units: {
      a: { side: "axis", kind: "ground", hex: "2424", attack: 4, defense: 2, movement: 4, state: "fresh" },
      b: { side: "allies", kind: "ground", hex: initialMovement ? "3030" : "2525", attack: 1, defense: 1, movement: 4, state: "fresh" }
    }
  });
  const config = readConfig();
  const bridge = createActionRuleBridge(config, { toolProfile: decisionPolicy === "hierarchical_sae" ? "rolling_unit_rules_tactical" : "map_and_action" });
  const transcript = { model_steps: [] };
  const provider = makeSingleActionProvider(config, {
    run_id: "provider-recovery-test",
    profile: { provider: "local_mock", model: "mock", limits: { output: 1000 }, capabilities: {}, defaults: { temperature: 0, timeout_ms: 10000 } }
  }, transcript, {
    bridge, decisionPolicy, progress: false,
    client: { complete: async (request) => ({ ok: true, status: 200, request_body: request,
      response_json: { choices: [{ message: response ? response(request) : { content: "{}" } }] } }) }
  });
  return { replay, bridge, transcript, provider };
}

test("real SAE recovery rebuilds the current bridge after an early coordinate exception", async () => {
  const { replay, bridge, transcript, provider } = setup({ decisionPolicy: "hierarchical_sae", initialMovement: true });
  const prepare = bridge.prepareStep;
  let prepares = 0;
  bridge.prepareStep = (input) => {
    if (++prepares === 1) throw new Error("invalid hex: 28xx");
    return prepare(input);
  };
  const result = await replay.playWithProvider({ maxSteps: 1, externalSide: "axis", externalAction: provider });
  assert.equal(result.status, "step_limit");
  assert.equal(prepares, 2);
  assert.equal(transcript.model_steps.length, 1);
  const step = transcript.model_steps[0];
  assert.equal(step.fallback_used, true);
  assert.equal(step.fallback_reason_class, "model_protocol_failure");
  assert.equal(step.protocol_failures[0].reason, "invalid hex: 28xx");
  assert.equal(step.transport_failures.length, 0);
  assert.equal(step.action_applied.result.legal, true);
  assert.equal(step.action_effect.accepted, true);
  assert.ok(step.sae_plan);
  assert.equal(result.log[0].model.provider_recovery.original_error, "invalid hex: 28xx");
});

test("protocol recovery retains the failed model response and does not count its fallback as a model proposal", async () => {
  const { replay, bridge, transcript, provider } = setup({ response: () => ({
    content: null,
    tool_calls: [{ id: "bad-combat", type: "function", function: { name: "act",
      arguments: JSON.stringify({ action: { type: "combat", attackers: ["a"], defender_hexes: ["28xx"] } }) } }]
  }) });
  const execute = bridge.executeTool;
  bridge.executeTool = (tool, args, sessionId) => {
    if (tool === "act" && args.action.defender_hexes?.includes("28xx")) throw new Error("invalid hex: 28xx");
    return execute(tool, args, sessionId);
  };
  const result = await replay.playWithProvider({ maxSteps: 1, externalSide: "axis", externalAction: provider });
  assert.equal(result.status, "step_limit");
  assert.equal(transcript.model_steps.length, 1);
  const step = transcript.model_steps[0];
  assert.equal(step.rounds.length, 1);
  assert.equal(step.rounds[0].parsed_output.arguments.action.defender_hexes[0], "28xx");
  assert.equal(step.fallback_reason_class, "model_protocol_failure");
  assert.equal(step.action_attempts.length, 1);
  assert.equal(step.action_attempts[0].accepted, false);
  assert.equal(step.action_applied.result.legal, true);
});

test("malformed combat coordinates normally produce rule rejections without provider recovery", async () => {
  const { replay, transcript, provider } = setup({ response: () => ({
    content: null,
    tool_calls: [{ id: "bad-combat", type: "function", function: { name: "act",
      arguments: JSON.stringify({ action: { type: "combat", attackers: ["a"], defender_hexes: ["28xx"] } }) } }]
  }) });
  const result = await replay.playWithProvider({ maxSteps: 1, externalSide: "axis", externalAction: provider });
  assert.equal(result.status, "step_limit");
  const [step] = transcript.model_steps;
  assert.equal(step.provider_recovery, undefined);
  assert.ok(step.action_attempts.length > 0);
  assert.ok(step.action_attempts.every((attempt) => attempt.accepted === false));
  assert.equal(step.action_applied.result.legal, true);
});

test("unexpected implementation errors are not hidden as recoverable model failures", async () => {
  const { replay, bridge, transcript, provider } = setup();
  bridge.prepareStep = () => { throw new ReferenceError("missingInternalBinding is not defined"); };
  const result = await replay.playWithProvider({ maxSteps: 1, externalSide: "axis", externalAction: provider });
  assert.equal(result.status, "provider_error");
  assert.match(result.error, /missingInternalBinding/);
  assert.equal(transcript.model_steps.length, 1);
  assert.equal(transcript.model_steps[0].fallback_used, false);
});

test("a provider recovery cannot bypass replay rule validation", async () => {
  const { replay } = setup({ initialMovement: true });
  const provider = async () => { throw new Error("invalid hex: 28xx"); };
  provider.onProviderError = async () => ({ action: { type: "move", unit: "a", path: ["2424", "28xx"] } });
  const result = await replay.playWithProvider({ maxSteps: 1, externalSide: "axis", externalAction: provider });
  assert.equal(result.status, "provider_error");
  assert.equal(replay.state.units.a.hex, "2424");
  assert.equal(result.log[0].fallback_recovery_failed, true);
});
