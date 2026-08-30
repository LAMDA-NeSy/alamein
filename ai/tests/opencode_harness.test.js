"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createHarnessPromptContract } = require("../core/harness_prompt_contract.js");
const { normalizeOpenCodeToolArgs } = require("../core/opencode_tool_args.js");

const { readConfig } = require("../experiments/external_ai_transcript.js");
const { createModelRuntime, closeModelRuntime, startModelGateway } = require("../core/model_runtime.js");
const { createRuleBridge } = require("../core/opencode_rule_bridge.js");
const { compactAgentPayload } = require("../core/agent_context.js");

const ROOT = path.resolve(__dirname, "../..");

test("rule bridge exposes the shared map and action tools and accepts only one action", () => {
  const bridge = createRuleBridge(readConfig(), { token: "test-token" });
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));
  const prepared = bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: state.active_side, session_id: "session-a" });
  assert.deepEqual(prepared.public_payload.context.tools.map((tool) => tool.name), ["view_map", "act"]);
  assert.doesNotMatch(JSON.stringify(prepared.public_payload.context.tools), /find_path|check_combat|inspect_unit/);
  const submitted = bridge.executeTool("act", { action: { type: "pass", reason: "test" } }, "session-a");
  assert.equal(submitted.accepted, true);
  assert.deepEqual(bridge.submittedAction(), { type: "pass", reason: "test" });

  bridge.prepareStep({ state, step: 2, turn: 1, phase: state.phase, side: state.active_side, session_id: "session-a" });
  assert.throws(() => bridge.executeTool("act", { action: { type: "pass" } }, "session-b"), /does not own/);
});

test("OpenCode config exposes model limits and enables only view_map and act", async () => {
  const runtime = createModelRuntime("mock_secondary", { run_id: "config-test" });
  try {
    await startModelGateway(runtime);
    const { createHarnessConfig } = await import("../harnesses/opencode_harness.mjs");
    const config = createHarnessConfig(runtime, "file:///tmp/plugin.mjs", "map_and_action", "axis");
    const model = config.provider.alamein_gateway.models[runtime.profile.model];
    assert.equal(model.limit.context, 64000);
    assert.equal(model.limit.input, 61952);
    assert.equal(model.limit.output, 2048);
    assert.equal(config.agent.wargame.steps, 6);
    assert.equal(config.compaction.auto, true);
    assert.equal(config.compaction.prune, false);
    assert.equal(config.compaction.reserved, 16000);
    assert.equal(config.agent.wargame.tools.act, true);
    assert.equal(config.agent.wargame.tools.view_map, true);
    assert.equal(config.agent.wargame.prompt, createHarnessPromptContract(["view_map", "act"], "axis").templates.system);
    for (const name of ["inspect", "evaluate_action", "submit_action"]) assert.notEqual(config.agent.wargame.tools[name], true);
    for (const name of ["bash", "read", "task", "webfetch", "todowrite"]) assert.equal(config.agent.wargame.tools[name], false);
  }
  finally {
    await closeModelRuntime(runtime);
  }
});

test("OpenCode projects each current state before appending it to the durable session", async () => {
  const bridge = createRuleBridge(readConfig(), { token: "projection-test-token" });
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));
  const prepared = bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: state.active_side, session_id: "session-a" });
  const projected = compactAgentPayload(prepared.public_payload);

  assert.equal(projected.context.forces, undefined);
  assert.equal(projected.context.battlefield_summary, undefined);
  assert.deepEqual(projected.context.map_intel.key_hexes, prepared.public_payload.context.map_intel.key_hexes.slice(0, 8));
  assert.deepEqual(projected.context.map_intel.frontline, prepared.public_payload.context.map_intel.frontline.slice(0, 6));
  assert.deepEqual(projected.context.tools.map((tool) => tool.name), ["view_map", "act"]);
  assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") < 40000);
});

test("OpenCode plugin removes its duplicate act wrapper without changing valid arguments", () => {
  const action = { type: "move_intent", unit: "unit-1", destination: "3410", mode: "auto" };
  assert.deepEqual(normalizeOpenCodeToolArgs("act", { action: { action } }), { action });
  assert.deepEqual(normalizeOpenCodeToolArgs("act", { action }), { action });
  assert.deepEqual(normalizeOpenCodeToolArgs("view_map", { action: { action } }), { action: { action } });
});
