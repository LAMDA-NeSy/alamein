"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveToolProfile } = require("../core/agent_tools.js");

test("LangGraph feeds map results and rejected actions back to the model, then stops after acceptance", async () => {
  const { createLangGraphActionGraph } = await import("../harnesses/langgraph_harness.mjs");
  let modelCalls = 0;
  const modelInputs = [];
  const model = {
    async invoke(messages) {
      modelCalls += 1;
      modelInputs.push(messages.map((message) => String(message.content)).join("\n"));
      if (modelCalls === 1) return { tool_calls: [{ id: "map-1", name: "view_map", args: { focus: "frontline" } }] };
      return { tool_calls: [{ id: `act-${modelCalls}`, name: "act", args: { action: { type: "pass", reason: "test" } } }] };
    }
  };
  let actCalls = 0;
  const bridge = {
    executeTool(name) {
      if (name === "view_map") return { ok: true, read_only: true, frontline: [{ unit: "axis-1" }] };
      assert.equal(name, "act");
      actCalls += 1;
      return actCalls === 1
        ? { accepted: false, reason: "first action rejected", issues: [] }
        : { accepted: true, action: { type: "pass", reason: "accepted" }, assessment: {} };
    },
    fallbackAction() { return { type: "pass", reason: "fallback" }; },
    profile: resolveToolProfile("map_and_action")
  };
  const graph = createLangGraphActionGraph({ model, bridge, toolProfile: bridge.profile, side: "axis" });
  const state = await graph.invoke({
    prompt: "CURRENT_STATE",
    sessionId: "langgraph-test",
    allowedTools: ["view_map", "act"],
    maxToolCalls: 4,
    toolCalls: 0,
    modelRounds: 0,
    observations: [],
    actionAttempts: [],
    accepted: false,
    fallbackUsed: false,
    finalAction: null,
    error: null
  }, { configurable: { thread_id: "langgraph-test" } });
  assert.equal(modelCalls, 3);
  assert.equal(actCalls, 2);
  assert.equal(state.fallbackUsed, false);
  assert.deepEqual(state.finalAction, { type: "pass", reason: "accepted" });
  assert.equal(state.actionAttempts.length, 2);
  assert.match(modelInputs[1], /frontline/);
  assert.match(modelInputs[2], /first action rejected/);
});

test("LangGraph timeout aborts the active invocation before returning", async () => {
  const { invokeWithTimeout } = await import("../harnesses/langgraph_harness.mjs");
  let aborted = false;
  await assert.rejects(() => invokeWithTimeout((signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true });
    setTimeout(resolve, 1000);
  }), 10, "test step"), /test step exceeded 10ms/);
  assert.equal(aborted, true);
});

test("LangGraph model delegates retries to the shared model gateway", async () => {
  const { createLangGraphModel } = await import("../harnesses/langgraph_harness.mjs");
  const model = createLangGraphModel({
    profile: {
      model: "mock-model",
      defaults: { temperature: 0 },
      limits: { output: 1024 }
    },
    local_token: "local-token",
    gateway_url: "http://127.0.0.1:1/v1"
  }, resolveToolProfile("single_action"));
  assert.equal(model.caller.maxRetries, 0);
  assert.equal(model.clientConfig.maxRetries, 0);
});
