"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { readConfigFile } = require("./config_file.js");
const { CONFIG_DIR, PROJECT_ROOT } = require("./project_paths.js");

const REGISTRY_FILE = path.join(CONFIG_DIR, "ai_models.yaml");
const ADAPTERS = new Set(["openai_compatible", "mock"]);
const THINKING_MODES = new Set(["disabled", "enabled", "omitted"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
}

function normalizeIntegerList(value, fallback = []) {
  if (value == null) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(Number(item)) || Number(item) < 0)) {
    throw new Error("transport retry lists must contain non-negative integers");
  }
  return value.map(Number);
}

function normalizeThinkingMode(value, label) {
  const mode = String(value ?? "omitted").trim().toLowerCase();
  if (!THINKING_MODES.has(mode)) {
    throw new Error(`${label} must be one of: disabled, enabled, omitted`);
  }
  return mode;
}

function thinkingRequest(runtime) {
  const mode = runtime?.profile?.defaults?.thinking || "omitted";
  return mode === "omitted" ? undefined : { type: mode };
}

function normalizeProfile(profileId, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`model profile ${profileId} must be an object`);
  if (!ADAPTERS.has(raw.adapter)) throw new Error(`model profile ${profileId} uses unknown adapter ${raw.adapter || "<missing>"}`);
  if (!raw.provider || !raw.model || !raw.base_url) throw new Error(`model profile ${profileId} requires provider, model, and base_url`);
  assertPositiveInteger(raw.limits?.context, `${profileId}.limits.context`);
  assertPositiveInteger(raw.limits?.output, `${profileId}.limits.output`);
  if (Number(raw.limits.output) >= Number(raw.limits.context)) throw new Error(`${profileId}.limits.output must be smaller than context`);
  if (raw.adapter === "openai_compatible" && !raw.api_key_env) throw new Error(`model profile ${profileId} requires api_key_env`);
  return {
    profile_id: profileId,
    adapter: raw.adapter,
    provider: String(raw.provider),
    model: String(raw.model),
    base_url: String(raw.base_url).replace(/\/+$/, ""),
    api_key_env: raw.api_key_env ? String(raw.api_key_env) : "",
    access: {
      billing_channel: String(raw.access?.billing_channel || "metered_api")
    },
    limits: {
      context: Number(raw.limits.context),
      output: Number(raw.limits.output)
    },
    capabilities: {
      tool_calling: !!raw.capabilities?.tool_calling,
      structured_output: raw.capabilities?.structured_output || false,
      parallel_tool_calls: !!raw.capabilities?.parallel_tool_calls,
      prompt_cache: !!raw.capabilities?.prompt_cache
    },
    defaults: {
      temperature: Number(raw.defaults?.temperature ?? 0.25),
      top_p: raw.defaults?.top_p == null ? null : Number(raw.defaults.top_p),
      reasoning_effort: raw.defaults?.reasoning_effort == null ? null : String(raw.defaults.reasoning_effort),
      thinking: normalizeThinkingMode(raw.defaults?.thinking, `${profileId}.defaults.thinking`),
      timeout_ms: Number(raw.defaults?.timeout_ms ?? 30000),
      retries: Math.max(0, Number(raw.defaults?.retries ?? 2)),
      retry_statuses: normalizeIntegerList(raw.defaults?.retry_statuses, [429, 502, 503, 504]),
      retry_delays_ms: normalizeIntegerList(raw.defaults?.retry_delays_ms, [2000, 5000]),
      circuit_breaker_failures: Math.max(1, Number(raw.defaults?.circuit_breaker_failures ?? 3)),
      circuit_breaker_cooldown_ms: Math.max(0, Number(raw.defaults?.circuit_breaker_cooldown_ms ?? 30000))
    },
    pricing: raw.pricing ? clone(raw.pricing) : null
  };
}

function duplicateTopLevelKeys(source) {
  const keys = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        if (depth === 1 && start >= 0) {
          let next = index + 1;
          while (/\s/.test(source[next] || "")) next += 1;
          if (source[next] === ":") keys.push(JSON.parse(source.slice(start, index + 1)));
        }
        start = -1;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      start = index;
    }
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  const seen = new Set();
  return keys.filter((key) => seen.has(key) || !seen.add(key));
}

function loadRegistryDocument(registryFile = REGISTRY_FILE) {
  const source = fs.readFileSync(registryFile, "utf8");
  if (path.extname(registryFile).toLowerCase() === ".json") {
    const duplicates = duplicateTopLevelKeys(source);
    if (duplicates.length) throw new Error(`duplicate model profile_id: ${[...new Set(duplicates)].join(", ")}`);
  }
  const parsed = readConfigFile(registryFile);
  if (parsed.models && Number(parsed.version || 0) !== 1) throw new Error("model registry version must be 1");
  const models = parsed.models || parsed;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("model registry must be an object keyed by profile_id");
  return {
    version: Number(parsed.models ? parsed.version || 1 : 1),
    default_profile: String(parsed.models ? parsed.default_profile || "mock_primary" : "mock_primary"),
    models
  };
}

function loadRegistry(registryFile = REGISTRY_FILE) {
  return loadRegistryDocument(registryFile).models;
}

function resolveModel(profileId, options = {}) {
  const document = options.registry
    ? { default_profile: options.defaultProfile || "mock_primary", models: options.registry }
    : loadRegistryDocument(options.registryFile);
  const resolvedId = profileId || document.default_profile;
  if (!Object.hasOwn(document.models, resolvedId)) throw new Error(`unknown model profile ${resolvedId}`);
  return normalizeProfile(resolvedId, document.models[resolvedId]);
}

function validateCapabilities(profile, requirements = {}) {
  const missing = [];
  if (requirements.tool_calling && !profile.capabilities?.tool_calling) missing.push("tool_calling");
  if (requirements.structured_output && !profile.capabilities?.structured_output) missing.push("structured_output");
  if (requirements.min_context && Number(profile.limits?.context || 0) < Number(requirements.min_context)) missing.push(`context>=${requirements.min_context}`);
  if (requirements.min_output && Number(profile.limits?.output || 0) < Number(requirements.min_output)) missing.push(`output>=${requirements.min_output}`);
  if (missing.length) throw new Error(`model profile ${profile.profile_id} lacks required capabilities: ${missing.join(", ")}`);
  return { compatible: true, profile_id: profile.profile_id };
}

function readLocalEnv(envFile = path.join(PROJECT_ROOT, ".env")) {
  try {
    const values = {};
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith("#")) continue;
      const index = value.indexOf("=");
      if (index <= 0) continue;
      values[value.slice(0, index).trim()] = value.slice(index + 1).trim().replace(/^[\"']|[\"']$/g, "");
    }
    return values;
  }
  catch {
    return {};
  }
}

function publicRuntimeMetadata(runtime) {
  return {
    adapter: runtime.profile.adapter,
    provider: runtime.profile.provider,
    model: runtime.profile.model,
    billing_channel: runtime.profile.access.billing_channel,
    context_limit: runtime.profile.limits.context,
    output_limit: runtime.profile.limits.output,
    capabilities: clone(runtime.profile.capabilities),
    thinking_mode: runtime.profile.defaults.thinking,
    transport_policy: {
      request_timeout_ms: runtime.profile.defaults.timeout_ms,
      retries: runtime.profile.defaults.retries,
      retry_statuses: clone(runtime.profile.defaults.retry_statuses),
      retry_delays_ms: clone(runtime.profile.defaults.retry_delays_ms),
      circuit_breaker_failures: runtime.profile.defaults.circuit_breaker_failures,
      circuit_breaker_cooldown_ms: runtime.profile.defaults.circuit_breaker_cooldown_ms
    },
    raw_transport_capture: true
  };
}

function modelContractConfiguration(profile) {
  return {
    identity: {
      profile_id: profile.profile_id,
      adapter: profile.adapter,
      provider: profile.provider,
      model: profile.model,
      billing_channel: profile.access.billing_channel,
      endpoint_hash: crypto.createHash("sha256").update(profile.base_url).digest("hex")
    },
    limits: clone(profile.limits),
    defaults: clone(profile.defaults),
    capabilities: clone(profile.capabilities)
  };
}

function createModelRuntime(profileOrId, runContext = {}) {
  const profile = typeof profileOrId === "string" || !profileOrId
    ? resolveModel(profileOrId, runContext)
    : normalizeProfile(profileOrId.profile_id || runContext.profileId || "inline", profileOrId);
  const env = { ...readLocalEnv(runContext.envFile), ...process.env, ...(runContext.env || {}) };
  const credential = profile.adapter === "mock" ? "mock-upstream-token" : env[profile.api_key_env];
  if (!credential) throw new Error(`${profile.api_key_env} is required for model profile ${profile.profile_id}`);
  const runId = String(runContext.run_id || runContext.runId || crypto.randomUUID());
  const localToken = crypto.randomBytes(24).toString("base64url");
  return {
    profile,
    run_id: runId,
    local_token: localToken,
    gateway_url: "",
    gateway_port: null,
    transport: [],
    usage: { input_tokens: 0, uncached_input_tokens: 0, output_tokens: 0, cache_tokens: 0, estimated_cost: null },
    transport_health: {
      consecutive_failures: 0,
      circuit_open_until: 0,
      circuit_open_events: 0
    },
    closed: false,
    _credential: credential,
    _server: null,
    _mockResponder: runContext.mockResponder || null,
    toJSON() {
      return { run_id: runId, model_profile: profile.profile_id, model_runtime: publicRuntimeMetadata(this), usage: clone(this.usage) };
    }
  };
}

function redactHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    output[key] = /authorization|api[-_]?key|token|cookie/i.test(key) ? "[REDACTED]" : value;
  }
  return output;
}

function redactValue(value, secrets = []) {
  if (typeof value === "string") {
    let output = value;
    for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[REDACTED]");
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /authorization|api[-_]?key|token/i.test(key) ? "[REDACTED]" : redactValue(item, secrets)]));
  }
  return value;
}

function parseBody(text) {
  try { return JSON.parse(text); }
  catch { return { raw_text: text }; }
}

function responseUsage(json = {}) {
  const usage = json.usage || {};
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const cacheTokens = Number(
    usage.prompt_cache_hit_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? 0
  );
  return {
    input_tokens: inputTokens,
    uncached_input_tokens: Math.max(0, inputTokens - cacheTokens),
    output_tokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    cache_tokens: cacheTokens
  };
}

function updateUsage(runtime, json) {
  const usage = responseUsage(json);
  runtime.usage.input_tokens += usage.input_tokens;
  runtime.usage.uncached_input_tokens += usage.uncached_input_tokens;
  runtime.usage.output_tokens += usage.output_tokens;
  runtime.usage.cache_tokens += usage.cache_tokens;
  const pricing = runtime.profile.pricing;
  if (pricing) {
    runtime.usage.estimated_cost = Number((
      runtime.usage.uncached_input_tokens / 1_000_000 * Number(pricing.input_per_million || 0)
      + runtime.usage.output_tokens / 1_000_000 * Number(pricing.output_per_million || 0)
      + runtime.usage.cache_tokens / 1_000_000 * Number(pricing.cache_per_million || 0)
    ).toFixed(8));
  }
}

function defaultMockResponse(runtime, body) {
  const messages = body.messages || [];
  const lastUserIndex = messages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
  const lastUserContent = String(messages[lastUserIndex]?.content || "");
  const lastTool = [...messages.slice(lastUserIndex + 1)].reverse().find((message) => message.role === "tool");
  let toolPayload = null;
  try { toolPayload = lastTool ? JSON.parse(lastTool.content) : null; }
  catch {}
  let message;
  const toolNames = new Set((body.tools || []).map((item) => item.function?.name || item.name));
  let planningPayload = null;
  try { planningPayload = JSON.parse(lastUserContent); }
  catch {}
  let embeddedPayload = null;
  let embeddedToolResults = [];
  const toolResultsMarker = "\n\nTOOL_RESULTS_FROM_THIS_STEP\n";
  const markerIndex = lastUserContent.indexOf(toolResultsMarker);
  if (markerIndex >= 0) {
    const statePayload = lastUserContent.slice(0, markerIndex).replace(/^CURRENT_STATE\s*\n/, "");
    try { embeddedPayload = JSON.parse(statePayload); }
    catch {}
    try { embeddedToolResults = JSON.parse(lastUserContent.slice(markerIndex + toolResultsMarker.length)); }
    catch {}
  }
  if (planningPayload?.planning_request === "phase_unit_plan") {
    message = {
      role: "assistant",
      content: JSON.stringify({
        type: "phase_unit_plan",
        unit_orders: (planningPayload.actionable_units || []).map((unit, index) => {
          const target = unit.recommended_options?.[0]?.destination || "";
          return {
            unit: unit.unit,
            disposition: target ? "move" : "hold",
            target_hex: target,
            role: unit.kind === "supply" ? "supply" : target ? "support" : "reserve",
            priority: index + 1,
            reason: target ? "mock best recommended move" : "mock no legal move"
          };
        })
      })
    };
  }
  else if (planningPayload?.protocol === "task-check-evidence-v2") {
    const task = planningPayload.active_tasks?.[0];
    message = {
      role: "assistant",
      content: JSON.stringify({
        type: "task_check",
        task_id: task?.id || "",
        task_status: "continue",
        action_assessment: "neutral",
        task_progress: Number(task?.progress || 0),
        supply_preserved: true,
        risk_level: "medium",
        next_task: "",
        confidence: 1,
        abstain: false,
        evidence: {
          step: Number(planningPayload?.step || 0),
          unit_ids: planningPayload?.accepted_action?.unit
            ? [planningPayload.accepted_action.unit]
            : (planningPayload?.accepted_action?.attackers || []),
          hexes: [planningPayload?.accepted_action?.destination, ...(planningPayload?.accepted_action?.defender_hexes || [])].filter(Boolean),
          state_change: "mock checker observed the supplied action and retained the current task"
        },
        reason: "mock checker retained the current task after the observed action"
      })
    };
  }
  else if (messages.some((item) => {
    const content = String(item.content);
    return item.role === "system" && (content.includes("strategic commander") || content.includes("goal commander"));
  })) {
    message = {
      role: "assistant",
      content: JSON.stringify({
        type: "strategic_intent",
        operation: "eastward_breakthrough",
        intent_type: "pressure",
        sector: "central",
        target_column: 37,
        priority: ["cross the next scoring column", "preserve supply"],
        priority_units: [],
        abort_condition: "abort if the spearhead becomes unsupplied"
      })
    };
  }
  else if (planningPayload?.planning_request === "force_allocation") {
    const activeUnits = planningPayload.units?.active || planningPayload.unit_index?.active || [];
    const combat = activeUnits.filter((unit) => unit.kind === "ground");
    const supply = activeUnits.filter((unit) => unit.kind === "supply");
    message = {
      role: "assistant",
      content: JSON.stringify({
        type: "force_allocation",
        operation: planningPayload.strategic_intent?.operation || "eastward_breakthrough",
        spearhead: combat.slice(0, 2).map((unit) => ({ unit: unit.id, task: "advance toward the scoring column" })),
        support: combat.slice(2, 5).map((unit) => ({ unit: unit.id, task: "support the spearhead" })),
        supply: supply.slice(0, 2).map((unit) => ({ unit: unit.id, task: "maintain the supply corridor" })),
        reserve: combat.slice(5, 7).map((unit) => unit.id)
      })
    };
  }
  else if (planningPayload?.planning_request === "unit_order_repair") {
    const target = planningPayload.legal_options?.[0]?.destination || "";
    message = {
      role: "assistant",
      content: JSON.stringify({
        type: "unit_order_repair",
        disposition: target ? "move" : "hold",
        target_hex: target,
        reason: target ? "mock first legal repair" : "mock hold"
      })
    };
  }
  else if (lastUserContent.includes('"phase_intent_catalog"') && !toolNames.size) {
    message = {
      role: "assistant",
      content: JSON.stringify({
        type: "phase_intent",
        intent: { type: "advance", sector: "central", target_hex: "3711", priority_units: [] }
      })
    };
  }
  else if (toolNames.has("phase_status")
    && embeddedPayload?.context?.game?.phase_kind?.includes("movement")) {
    const latestStatus = [...embeddedToolResults].reverse().map((record) => (
      record.tool === "phase_status"
        ? record.result
        : ["hold_unit", "hold_units"].includes(record.tool)
          ? record.result?.phase_status
          : null
    )).find(Boolean);
    if (!latestStatus) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call-${crypto.randomUUID()}`,
          type: "function",
          function: { name: "phase_status", arguments: "{}" }
        }]
      };
    }
    else if (latestStatus.can_pass) {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call-${crypto.randomUUID()}`,
          type: "function",
          function: { name: "act", arguments: JSON.stringify({ action: { type: "pass", reason: "mock rolling phase complete" } }) }
        }]
      };
    }
    else {
      const mandatoryUnits = new Set((latestStatus.mandatory_actions || []).flatMap((item) => item.removable_unit_ids || item.units || []));
      const holdable = (latestStatus.remaining_units || []).filter((unit) => !mandatoryUnits.has(unit));
      const unit = holdable[0];
      const batch = toolNames.has("hold_units") ? holdable.slice(0, 32) : [];
      message = {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call-${crypto.randomUUID()}`,
          type: "function",
          function: batch.length
            ? { name: "hold_units", arguments: JSON.stringify({ orders: batch.map((item) => ({ unit: item, reason: "mock protocol hold the defensive blocking line" })) }) }
            : unit
            ? { name: "hold_unit", arguments: JSON.stringify({ unit, reason: "mock protocol hold the defensive blocking line" }) }
            : { name: "act", arguments: JSON.stringify({ action: { type: "pass", reason: "mock no remaining unit" } }) }
        }]
      };
    }
  }
  else if (toolNames.has("act") && toolPayload?.accepted) {
    message = { role: "assistant", content: "Action accepted." };
  }
  else if (toolNames.has("view_map") && !lastTool && !/TOOL_RESULTS_FROM_THIS_STEP[\s\S]*\"tool\":\"view_map\"/.test(lastUserContent)) {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `call-${crypto.randomUUID()}`,
        type: "function",
        function: { name: "view_map", arguments: JSON.stringify({ focus: "overview" }) }
      }]
    };
  }
  else if (toolNames.has("act")) {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `call-${crypto.randomUUID()}`,
        type: "function",
        function: { name: "act", arguments: JSON.stringify({ action: { type: "pass", reason: "mock profile" } }) }
      }]
    };
  }
  else if (Array.isArray(body.tools) && body.tools.length && !lastTool) {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `call-${crypto.randomUUID()}`,
        type: "function",
        function: { name: "evaluate_action", arguments: JSON.stringify({ action: { type: "pass", reason: "mock profile" } }) }
      }]
    };
  }
  else if (Array.isArray(body.tools) && toolPayload?.proposal_id) {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `call-${crypto.randomUUID()}`,
        type: "function",
        function: { name: "submit_action", arguments: JSON.stringify({ proposal_id: toolPayload.proposal_id }) }
      }]
    };
  }
  else {
    const content = JSON.stringify({ type: "final_action", action: { type: "pass", reason: "mock profile" }, reason: "mock profile" });
    message = { role: "assistant", content };
  }
  return {
    id: `mock-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: runtime.profile.model,
    choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
    usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages || []).length / 4), completion_tokens: Math.ceil(JSON.stringify(message).length / 4), total_tokens: 0 }
  };
}

async function callMock(runtime, body, attempt, timeoutMs) {
  const responder = runtime._mockResponder || defaultMockResponse;
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => responder(runtime, clone(body), attempt)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`mock model request exceeded ${timeoutMs}ms`);
          error.name = "AbortError";
          reject(error);
        }, Math.max(1, Number(timeoutMs)));
      })
    ]);
    return { status: Number(response?.status || 200), headers: { "content-type": "application/json" }, json: response?.body || response };
  }
  finally {
    clearTimeout(timer);
  }
}

function classifyTransportFailure({ status = 0, error = null } = {}) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const name = String(error?.name || "");
  if (name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "network_timeout";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns_error";
  if (["ECONNRESET", "EPIPE", "ECONNREFUSED", "ENETDOWN", "ENETUNREACH"].includes(code)) return "connection_error";
  if (Number(status) === 429) return "rate_limit";
  if ([502, 503, 504].includes(Number(status))) return "upstream_unavailable";
  if (Number(status) >= 500) return "upstream_5xx";
  if (Number(status) >= 400) return "request_error";
  return error ? "network_error" : "none";
}

function retryableFailure(profile, status, error) {
  const errorClass = classifyTransportFailure({ status, error });
  return profile.defaults.retry_statuses.includes(Number(status))
    || ["network_timeout", "dns_error", "connection_error", "network_error"].includes(errorClass);
}

function systemCaCertificate() {
  const candidates = [
    process.env.AGENT_CA_CERT_FILE,
    process.platform === "darwin" ? "/etc/ssl/cert.pem" : null
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      return fs.readFileSync(file);
    }
    catch {
      // Try the next configured system certificate location.
    }
  }
  return undefined;
}

function requestHttps(url, options, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      ca: systemCaCertificate(),
      signal: options.signal
    }, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ response, responseText: chunks.join("") }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function normalizeHttpsHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.join(", ") : String(value)
  ]));
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function callOpenAiCompatible(runtime, body, attempt, timeoutMs) {
  const controller = new AbortController();
  const effectiveTimeoutMs = Math.max(1, Number(timeoutMs || runtime.profile.defaults.timeout_ms));
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  let timeoutId;
  try {
    const request = (async () => {
      const { response, responseText } = await requestHttps(`${runtime.profile.base_url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${runtime._credential}` },
        signal: controller.signal
      }, JSON.stringify({
          ...body,
          model: runtime.profile.model,
          stream: false,
          stream_options: undefined,
          parallel_tool_calls: runtime.profile.capabilities.parallel_tool_calls
        }));
      return { response, responseText };
    })();
    const { response, responseText } = await Promise.race([
      request,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          const error = new Error(`upstream request exceeded ${effectiveTimeoutMs}ms`);
          error.name = "AbortError";
          reject(error);
        }, effectiveTimeoutMs);
      })
    ]);
    return { status: response.statusCode, headers: normalizeHttpsHeaders(response.headers), json: parseBody(responseText), attempt };
  }
  finally {
    clearTimeout(timeout);
    clearTimeout(timeoutId);
  }
}

async function dispatchUpstream(runtime, body, options = {}) {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  const totalTimeoutMs = Math.max(1, Number(options.timeoutMs || runtime.profile.defaults.timeout_ms));
  const deadline = started + totalTimeoutMs;
  const maxAttempts = runtime.profile.defaults.retries + 1;
  let result;
  let error;
  let attempts = 0;
  let errorClass = "none";
  const retryableFailures = [];
  if (Date.now() < runtime.transport_health.circuit_open_until) {
    errorClass = "circuit_open";
    const record = {
      request_id: requestId,
      run_id: runtime.run_id,
      model_profile: runtime.profile.profile_id,
      started_at: new Date(started).toISOString(),
      elapsed_ms: 0,
      attempts: 0,
      request: redactValue(body, [runtime._credential, runtime.local_token]),
      response: { error: { message: "model transport circuit is open" } },
      status: 503,
      error_class: errorClass,
      request_headers: redactHeaders({ authorization: `Bearer ${runtime.local_token}`, "content-type": "application/json" }),
      response_headers: {}
    };
    runtime.transport.push(record);
    return { result: { status: 503, headers: {}, json: record.response }, error: new Error("model transport circuit is open"), record };
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const timeoutError = new Error(`model request exceeded ${totalTimeoutMs}ms total timeout`);
      timeoutError.name = "AbortError";
      error = timeoutError;
      errorClass = "network_timeout";
      break;
    }
    attempts += 1;
    try {
      result = runtime.profile.adapter === "mock"
        ? await callMock(runtime, body, attempt, remaining)
        : await callOpenAiCompatible(runtime, body, attempt, remaining);
      error = null;
      errorClass = classifyTransportFailure({ status: result.status });
      if (!retryableFailure(runtime.profile, result.status, null)) break;
      retryableFailures.push({
        attempt: attempt + 1,
        status: Number(result.status || 0),
        error_class: errorClass
      });
      error = new Error(`upstream status ${result.status}`);
    }
    catch (caught) {
      error = caught;
      errorClass = classifyTransportFailure({ error: caught });
      retryableFailures.push({
        attempt: attempt + 1,
        status: 0,
        error_class: errorClass
      });
    }
    if (!retryableFailure(runtime.profile, result?.status || 0, error) || attempt + 1 >= maxAttempts) break;
    const delay = Number(runtime.profile.defaults.retry_delays_ms[attempt] || 0);
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
  }
  const successful = !error && Number(result?.status || 0) >= 200 && Number(result?.status || 0) < 400;
  if (successful) {
    runtime.transport_health.consecutive_failures = 0;
  }
  else if (retryableFailure(runtime.profile, result?.status || 0, error)) {
    runtime.transport_health.consecutive_failures += 1;
    if (runtime.transport_health.consecutive_failures >= runtime.profile.defaults.circuit_breaker_failures) {
      runtime.transport_health.circuit_open_until = Date.now() + runtime.profile.defaults.circuit_breaker_cooldown_ms;
      runtime.transport_health.circuit_open_events += 1;
    }
  }
  const record = {
    request_id: requestId,
    run_id: runtime.run_id,
    model_profile: runtime.profile.profile_id,
    started_at: new Date(started).toISOString(),
    elapsed_ms: Date.now() - started,
    attempts,
    request: redactValue(body, [runtime._credential, runtime.local_token]),
    response: redactValue(result?.json || { error: error?.message || "upstream request failed" }, [runtime._credential, runtime.local_token]),
    status: result?.status || 502,
    error_class: successful ? "none" : result?.status
      ? classifyTransportFailure({ status: result.status })
      : errorClass,
    recovered_after_retry: successful && retryableFailures.length > 0,
    retryable_failures: retryableFailures,
    total_timeout_ms: totalTimeoutMs,
    request_headers: redactHeaders({ authorization: `Bearer ${runtime.local_token}`, "content-type": "application/json" }),
    response_headers: redactHeaders(result?.headers || {})
  };
  runtime.transport.push(record);
  if (result?.json) updateUsage(runtime, result.json);
  return { result, error, record };
}

function enforceSingleToolCall(runtime, json) {
  if (!json || runtime.profile.capabilities.parallel_tool_calls) return { json, dropped: 0 };
  const forwarded = clone(json);
  let dropped = 0;
  for (const choice of forwarded.choices || []) {
    const calls = choice.message?.tool_calls;
    if (!Array.isArray(calls) || calls.length <= 1) continue;
    dropped += calls.length - 1;
    choice.message.tool_calls = calls.slice(0, 1);
  }
  return { json: forwarded, dropped };
}

function completionAsSse(json = {}) {
  const choice = json.choices?.[0] || {};
  const message = choice.message || {};
  const base = {
    id: json.id || `gateway-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: json.created || Math.floor(Date.now() / 1000),
    model: json.model || "gateway-model"
  };
  const chunks = [];
  const delta = { role: "assistant" };
  if (message.content != null) delta.content = message.content;
  if (message.reasoning_content != null) delta.reasoning_content = message.reasoning_content;
  if (message.tool_calls) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }));
  chunks.push({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || (message.tool_calls ? "tool_calls" : "stop") }], usage: json.usage });
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function readRequest(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      value += chunk;
      if (Buffer.byteLength(value, "utf8") > maxBytes) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(value));
    req.on("error", reject);
  });
}

async function startModelGateway(runtime) {
  if (runtime.closed) throw new Error("model runtime is closed");
  if (runtime._server) return runtime;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, run_id: runtime.run_id, model_profile: runtime.profile.profile_id }));
      return;
    }
    if (req.method !== "POST" || !["/v1/chat/completions", "/chat/completions"].includes(req.url)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${runtime.local_token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid local gateway token" } }));
      return;
    }
    try {
      const body = applyProfileRequestDefaults(runtime, parseBody(await readRequest(req)));
      const requestedTimeout = Number(req.headers["x-agent-request-timeout-ms"] || runtime.profile.defaults.timeout_ms);
      const { result, error, record } = await dispatchUpstream(runtime, body, { timeoutMs: requestedTimeout });
      const forwarded = enforceSingleToolCall(runtime, result?.json);
      if (record && forwarded.dropped) {
        record.gateway_normalization = {
          parallel_tool_calls: false,
          dropped_tool_calls: forwarded.dropped
        };
      }
      if (body.stream && forwarded.json && (result.status || 500) < 400) {
        res.writeHead(result.status || 200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-agent-error-class": record.error_class,
          "x-agent-attempts": String(record.attempts || 0),
          "x-agent-recovered-after-retry": String(!!record.recovered_after_retry)
        });
        res.end(completionAsSse(forwarded.json));
      }
      else {
        res.writeHead(result?.status || 502, {
          "content-type": "application/json",
          "x-agent-error-class": record.error_class,
          "x-agent-attempts": String(record.attempts || 0),
          "x-agent-recovered-after-retry": String(!!record.recovered_after_retry)
        });
        res.end(JSON.stringify(forwarded.json || { error: { message: error?.message || "upstream request failed" } }));
      }
    }
    catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.keepAliveTimeout = 180000;
  server.headersTimeout = 185000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  runtime._server = server;
  runtime.gateway_port = server.address().port;
  runtime.gateway_url = `http://127.0.0.1:${runtime.gateway_port}/v1`;
  return runtime;
}

function createOpenCodeProviderConfig(runtime) {
  if (!runtime.gateway_url) throw new Error("model gateway must be started before creating OpenCode config");
  return {
    npm: "@ai-sdk/openai-compatible",
    name: `Alamein ${runtime.profile.profile_id}`,
    options: { baseURL: runtime.gateway_url, apiKey: runtime.local_token },
    models: {
      [runtime.profile.model]: {
        name: runtime.profile.model,
        tool_call: runtime.profile.capabilities.tool_calling,
        limit: {
          context: runtime.profile.limits.context,
          input: runtime.profile.limits.context - runtime.profile.limits.output,
          output: runtime.profile.limits.output
        },
        modalities: { input: ["text"], output: ["text"] }
      }
    }
  };
}

function buildChatCompletionsBody(runtime, request = {}) {
  const body = {
    model: runtime.profile.model,
    messages: request.messages || [],
    temperature: Number(request.temperature ?? runtime.profile.defaults.temperature),
    max_tokens: Math.min(Number(request.max_tokens || runtime.profile.limits.output), runtime.profile.limits.output)
  };
  const topP = request.top_p ?? runtime.profile.defaults.top_p;
  const reasoningEffort = request.reasoning_effort ?? runtime.profile.defaults.reasoning_effort;
  if (topP != null) body.top_p = Number(topP);
  if (reasoningEffort != null) body.reasoning_effort = String(reasoningEffort);
  if (request.response_format) body.response_format = request.response_format;
  if (request.tools) body.tools = request.tools;
  if (request.tool_choice) body.tool_choice = request.tool_choice;
  const configuredThinking = request.thinking === undefined
    ? thinkingRequest(runtime)
    : request.thinking;
  if (configuredThinking != null) body.thinking = configuredThinking;
  return body;
}

function applyProfileRequestDefaults(runtime, request = {}) {
  const body = { ...request };
  if (body.temperature == null) body.temperature = runtime.profile.defaults.temperature;
  if (body.max_tokens == null && body.max_completion_tokens == null) body.max_tokens = runtime.profile.limits.output;
  if (body.top_p == null && runtime.profile.defaults.top_p != null) body.top_p = runtime.profile.defaults.top_p;
  if (body.reasoning_effort == null && runtime.profile.defaults.reasoning_effort != null) {
    body.reasoning_effort = runtime.profile.defaults.reasoning_effort;
  }
  if (body.thinking === undefined) {
    const configuredThinking = thinkingRequest(runtime);
    if (configuredThinking != null) body.thinking = configuredThinking;
  }
  return body;
}

function createChatCompletionsClient(runtime) {
  return {
    async complete(request = {}) {
      await startModelGateway(runtime);
      const body = buildChatCompletionsBody(runtime, request);
      const started = Date.now();
      const timeoutMs = Math.max(1, Number(request.timeout_ms || runtime.profile.defaults.timeout_ms));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs + 1000);
      try {
        const response = await fetch(`${runtime.gateway_url}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${runtime.local_token}`,
            "x-agent-request-timeout-ms": String(timeoutMs)
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const json = parseBody(await response.text());
        return {
          ok: response.ok,
          status: response.status,
          error_class: response.headers.get("x-agent-error-class") || classifyTransportFailure({ status: response.status }),
          attempts: Number(response.headers.get("x-agent-attempts") || 1),
          recovered_after_retry: response.headers.get("x-agent-recovered-after-retry") === "true",
          elapsed_ms: Date.now() - started,
          request_body: redactValue(body, [runtime.local_token]),
          response_json: redactValue(json, [runtime.local_token, runtime._credential])
        };
      }
      catch (error) {
        return {
          ok: false,
          status: 0,
          error_class: classifyTransportFailure({ error }),
          elapsed_ms: Date.now() - started,
          request_body: redactValue(body, [runtime.local_token]),
          response_json: { error: { message: error.message } }
        };
      }
      finally {
        clearTimeout(timeout);
      }
    }
  };
}

async function closeModelRuntime(runtime) {
  if (!runtime || runtime.closed) return;
  runtime.closed = true;
  if (runtime._server) await new Promise((resolve) => runtime._server.close(resolve));
  runtime._server = null;
  runtime._credential = "";
  runtime.local_token = "";
}

module.exports = {
  applyProfileRequestDefaults,
  buildChatCompletionsBody,
  closeModelRuntime,
  classifyTransportFailure,
  createChatCompletionsClient,
  createModelRuntime,
  createOpenCodeProviderConfig,
  loadRegistry,
  loadRegistryDocument,
  modelContractConfiguration,
  publicRuntimeMetadata,
  resolveModel,
  startModelGateway,
  thinkingRequest,
  validateCapabilities
};
