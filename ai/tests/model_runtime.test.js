"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyProfileRequestDefaults,
  buildChatCompletionsBody,
  closeModelRuntime,
  classifyTransportFailure,
  createChatCompletionsClient,
  createModelRuntime,
  createOpenCodeProviderConfig,
  loadRegistry,
  resolveModel,
  startModelGateway,
  validateCapabilities
} = require("../core/model_runtime.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("model profiles normalize defaults and reject invalid entries", () => {
  const primary = resolveModel("mock_primary");
  assert.equal(primary.profile_id, "mock_primary");
  assert.equal(primary.limits.context, 256000);
  assert.equal(primary.defaults.thinking, "omitted");
  assert.equal(resolveModel("deepseek_flash").defaults.thinking, "disabled");
  const glm = resolveModel("glm_47_flash");
  assert.equal(glm.provider, "zhipu");
  assert.equal(glm.model, "glm-4.7-flash");
  assert.equal(glm.base_url, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(glm.api_key_env, "ZHIPU_API_KEY");
  assert.equal(glm.limits.context, 200000);
  assert.equal(glm.limits.output, 6000);
  assert.equal(glm.capabilities.tool_calling, true);
  assert.equal(glm.capabilities.structured_output, "json_object");
  assert.equal(glm.capabilities.prompt_cache, true);
  assert.equal(glm.defaults.thinking, "disabled");
  assert.equal(resolveModel("glm_47_flash_checker").defaults.temperature, 0);
  const coding = resolveModel("glm_53_flash_coding_plan");
  assert.equal(coding.model, "glm-5.3-flash");
  assert.equal(coding.base_url, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(coding.api_key_env, "ZHIPU_CODING_API_KEY");
  assert.equal(coding.access.billing_channel, "coding_plan");
  assert.equal(coding.defaults.thinking, "omitted");
  assert.equal(coding.defaults.top_p, 0.95);
  assert.equal(coding.defaults.reasoning_effort, "low");
  const metered = resolveModel("glm_53_flash_api");
  assert.equal(metered.model, coding.model);
  assert.equal(metered.base_url, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(metered.api_key_env, "ZHIPU_API_KEY");
  assert.equal(metered.access.billing_channel, "metered_api");
  assert.equal(metered.defaults.thinking, "omitted");
  assert.equal(metered.defaults.reasoning_effort, "low");
  assert.throws(() => resolveModel("missing"), /unknown model profile/);
  assert.throws(() => resolveModel("bad", { registry: { bad: { adapter: "unknown" } } }), /unknown adapter/);
  assert.throws(() => resolveModel("bad", { registry: { bad: {
    adapter: "mock", provider: "mock", model: "bad", base_url: "mock://bad",
    limits: { context: 100, output: 100 }, capabilities: {}
  } } }), /output must be smaller/);
  assert.throws(() => resolveModel("bad", { registry: { bad: {
    adapter: "mock", provider: "mock", model: "bad", base_url: "mock://bad",
    limits: { context: 1000, output: 100 }, capabilities: {}, defaults: { thinking: "sometimes" }
  } } }), /defaults\.thinking/);
});

test("model profile thinking mode is applied by the gateway when callers omit it", () => {
  const runtime = createModelRuntime("deepseek_flash", { run_id: "configured-thinking" });
  try {
    const body = buildChatCompletionsBody(runtime, {
      messages: [{ role: "user", content: "act" }],
      tools: [{ type: "function", function: { name: "act", parameters: { type: "object" } } }],
      tool_choice: "auto"
    });
    assert.deepEqual(body.thinking, { type: "disabled" });
  }
  finally {
    runtime._credential = "";
  }
});

test("GLM 5.3 uses low reasoning effort while omitting the incompatible thinking field", () => {
  const profile = resolveModel("glm_53_flash");
  const body = applyProfileRequestDefaults({ profile }, { messages: [] });
  assert.equal(profile.defaults.thinking, "omitted");
  assert.equal(body.reasoning_effort, "low");
  assert.equal(Object.hasOwn(body, "thinking"), false);
});

test("registry rejects duplicate profile ids", () => {
  const file = path.join(os.tmpdir(), `duplicate-models-${process.pid}.json`);
  fs.writeFileSync(file, '{"same":{},"same":{}}');
  try {
    assert.throws(() => loadRegistry(file), /duplicate model profile_id: same/);
  }
  finally {
    fs.rmSync(file, { force: true });
  }
});

test("capability preflight fails before a harness starts", () => {
  const profile = resolveModel("mock_primary");
  assert.deepEqual(validateCapabilities(profile, { tool_calling: true, min_context: 64000 }), { compatible: true, profile_id: "mock_primary" });
  assert.throws(() => validateCapabilities({ ...profile, capabilities: { tool_calling: false } }, { tool_calling: true }), /tool_calling/);
});

test("raw gateway requests inherit model-specific generation defaults", () => {
  const profile = resolveModel("glm_53_flash_coding_plan");
  const body = applyProfileRequestDefaults({ profile }, { messages: [] });
  assert.equal(body.temperature, 0.25);
  assert.equal(body.top_p, 0.95);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(Object.hasOwn(body, "thinking"), false);
  assert.equal(body.max_tokens, 6000);
});

test("missing external API key fails before gateway startup", () => {
  const profile = resolveModel("deepseek_flash");
  assert.throws(() => createModelRuntime(profile, { env: { DEEPSEEK_API_KEY: "" }, envFile: "/missing" }), /DEEPSEEK_API_KEY/);
});

test("gateway isolates model profiles and redacts credentials", async () => {
  const first = createModelRuntime("mock_primary", { run_id: "run-a" });
  const second = createModelRuntime("mock_secondary", { run_id: "run-b" });
  try {
    await Promise.all([startModelGateway(first), startModelGateway(second)]);
    assert.notEqual(first.gateway_port, second.gateway_port);
    const [a, b] = await Promise.all([
      createChatCompletionsClient(first).complete({ messages: [{ role: "user", content: "a" }] }),
      createChatCompletionsClient(second).complete({ messages: [{ role: "user", content: "b" }] })
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.response_json.model, "mock-wargame-primary");
    assert.equal(b.response_json.model, "mock-wargame-secondary");
    assert.equal(first.transport.length, 1);
    assert.equal(second.transport.length, 1);
    const serialized = JSON.stringify({ first, second, transport: [...first.transport, ...second.transport] });
    assert.doesNotMatch(serialized, /mock-upstream-token/);
    assert.doesNotMatch(serialized, new RegExp(first.local_token));
    assert.equal(first.transport[0].request_headers.authorization, "[REDACTED]");
  }
  finally {
    await Promise.all([closeModelRuntime(first), closeModelRuntime(second)]);
  }
});

test("chat completions includes required tool choice in the gateway request body", () => {
  const runtime = createModelRuntime("mock_primary", { run_id: "required-tool-choice" });
  try {
    const body = buildChatCompletionsBody(runtime, {
      messages: [{ role: "user", content: "act now" }],
      tools: [{ type: "function", function: { name: "act", parameters: { type: "object" } } }],
      tool_choice: "required",
      thinking: { type: "disabled" }
    });
    assert.equal(body.tool_choice, "required");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.tools[0].function.name, "act");
  }
  finally {
    runtime._credential = "";
  }
});

test("gateway retries 502 upstream failures and exports OpenCode limits", async () => {
  let calls = 0;
  const runtime = createModelRuntime("mock_primary", {
    run_id: "retry-run",
    mockResponder(_runtime, body) {
      calls += 1;
      if (calls === 1) return { status: 502, body: { error: { message: "retry" } } };
      return { ...body, model: "mock-wargame-primary", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
    }
  });
  runtime.profile.defaults.retries = 1;
  try {
    await startModelGateway(runtime);
    assert.equal(runtime._server.keepAliveTimeout, 180000);
    assert.equal(runtime._server.headersTimeout, 185000);
    const result = await createChatCompletionsClient(runtime).complete({ messages: [] });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.recovered_after_retry, true);
    assert.equal(calls, 2);
    assert.equal(runtime.transport[0].attempts, 2);
    assert.equal(runtime.transport[0].error_class, "none");
    assert.equal(runtime.transport[0].recovered_after_retry, true);
    assert.equal(runtime.transport[0].retryable_failures.length, 1);
    assert.equal(runtime.usage.input_tokens, 2);
    const provider = createOpenCodeProviderConfig(runtime);
    assert.equal(provider.models[runtime.profile.model].limit.context, 256000);
    assert.equal(provider.models[runtime.profile.model].limit.output, 6000);
    assert.equal(provider.options.baseURL, runtime.gateway_url);
  }
  finally {
    await closeModelRuntime(runtime);
  }
});

test("gateway records nested cached tokens and prices cached input separately", async () => {
  const runtime = createModelRuntime("mock_primary", {
    run_id: "nested-cache-usage",
    mockResponder() {
      return {
        model: "mock-wargame-primary",
        choices: [{ message: { content: "{}" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 40 }
        }
      };
    }
  });
  runtime.profile.pricing = {
    input_per_million: 1,
    cache_per_million: 0.1,
    output_per_million: 2
  };
  try {
    const result = await createChatCompletionsClient(runtime).complete({ messages: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(runtime.usage, {
      input_tokens: 100,
      uncached_input_tokens: 60,
      output_tokens: 10,
      cache_tokens: 40,
      estimated_cost: 0.000084
    });
  }
  finally {
    await closeModelRuntime(runtime);
  }
});

test("gateway does not retry a 400 request error", async () => {
  let calls = 0;
  const runtime = createModelRuntime("mock_primary", {
    run_id: "no-retry-400",
    mockResponder() {
      calls += 1;
      return { status: 400, body: { error: { message: "bad request" } } };
    }
  });
  runtime.profile.defaults.retries = 2;
  try {
    const result = await createChatCompletionsClient(runtime).complete({ messages: [] });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error_class, "request_error");
    assert.equal(calls, 1);
    assert.equal(runtime.transport[0].attempts, 1);
  }
  finally {
    await closeModelRuntime(runtime);
  }
});

test("transport failures are classified consistently", () => {
  const error = (code, name = "Error") => ({ code, name });
  assert.equal(classifyTransportFailure({ error: error("ETIMEDOUT") }), "network_timeout");
  assert.equal(classifyTransportFailure({ error: error("ENOTFOUND") }), "dns_error");
  assert.equal(classifyTransportFailure({ error: error("ECONNRESET") }), "connection_error");
  assert.equal(classifyTransportFailure({ status: 429 }), "rate_limit");
  assert.equal(classifyTransportFailure({ status: 502 }), "upstream_unavailable");
  assert.equal(classifyTransportFailure({ status: 400 }), "request_error");
});

test("all retries share one total request timeout", async () => {
  let calls = 0;
  const runtime = createModelRuntime("mock_primary", {
    run_id: "total-timeout",
    async mockResponder() {
      calls += 1;
      await delay(25);
      return { status: 503, body: { error: { message: "retry later" } } };
    }
  });
  runtime.profile.defaults.retries = 3;
  runtime.profile.defaults.retry_delays_ms = [30, 30, 30];
  runtime.profile.defaults.timeout_ms = 45;
  const started = Date.now();
  try {
    const result = await createChatCompletionsClient(runtime).complete({ messages: [], timeout_ms: 45 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.error_class, "upstream_unavailable");
    assert.equal(calls, 1);
    assert.ok(elapsed < 250, `request took ${elapsed}ms`);
    assert.ok(runtime.transport[0].elapsed_ms < 150, `upstream attempts took ${runtime.transport[0].elapsed_ms}ms`);
  }
  finally {
    await closeModelRuntime(runtime);
  }
});

test("circuit breaker blocks requests after consecutive retryable failures", async () => {
  let calls = 0;
  const runtime = createModelRuntime("mock_primary", {
    run_id: "circuit-breaker",
    mockResponder() {
      calls += 1;
      return { status: 503, body: { error: { message: "unavailable" } } };
    }
  });
  runtime.profile.defaults.retries = 0;
  runtime.profile.defaults.circuit_breaker_failures = 2;
  runtime.profile.defaults.circuit_breaker_cooldown_ms = 10000;
  try {
    const client = createChatCompletionsClient(runtime);
    await client.complete({ messages: [] });
    await client.complete({ messages: [] });
    const blocked = await client.complete({ messages: [] });
    assert.equal(calls, 2);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error_class, "circuit_open");
    assert.equal(runtime.transport_health.circuit_open_events, 1);
    assert.equal(runtime.transport[2].attempts, 0);
  }
  finally {
    await closeModelRuntime(runtime);
  }
});

test("gateway returns the final upstream error after retry exhaustion", async () => {
  let calls = 0;
  const runtime = createModelRuntime("mock_primary", {
    run_id: "error-run",
    mockResponder() {
      calls += 1;
      return { status: 503, body: { error: { message: "still unavailable" } } };
    }
  });
  runtime.profile.defaults.retries = 2;
  try {
    const result = await createChatCompletionsClient(runtime).complete({ messages: [] });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(calls, 3);
    assert.equal(runtime.transport[0].attempts, 3);
  }
  finally {
    await closeModelRuntime(runtime);
  }
});

test("gateway forwards only one tool call while preserving the raw provider response", async () => {
  const runtime = createModelRuntime("mock_primary", {
    run_id: "serial-tool-run",
    mockResponder() {
      const call = (id, destination) => ({
        id,
        type: "function",
        function: { name: "act", arguments: JSON.stringify({ action: { type: "move_intent", unit: "u", destination } }) }
      });
      return {
        model: "mock-wargame-primary",
        choices: [{ message: { role: "assistant", tool_calls: [call("first", "0101"), call("second", "0202")] } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 }
      };
    }
  });
  try {
    const result = await createChatCompletionsClient(runtime).complete({
      messages: [{ role: "user", content: "move" }],
      tools: [{ type: "function", function: { name: "act", parameters: { type: "object" } } }]
    });
    assert.equal(result.response_json.choices[0].message.tool_calls.length, 1);
    assert.equal(runtime.transport[0].response.choices[0].message.tool_calls.length, 2);
    assert.deepEqual(runtime.transport[0].gateway_normalization, { parallel_tool_calls: false, dropped_tool_calls: 1 });
  }
  finally {
    await closeModelRuntime(runtime);
  }
});
