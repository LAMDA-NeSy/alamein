#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";

const require = createRequire(import.meta.url);
const { makeReplay } = require("../experiments/ai_replay.js");
const { readConfig } = require("../experiments/external_ai_transcript.js");
const { createRuleBridge } = require("../core/opencode_rule_bridge.js");
const { TOOL_CATALOG_VERSION, resolveToolProfile, toolProfileHash } = require("../core/agent_tools.js");
const { CONTEXT_PROFILE_ID, compactAgentPayload, contextBytes } = require("../core/agent_context.js");
const { createComparisonContract } = require("../core/comparison_contract.js");
const { createHarnessPromptContract, renderHarnessStep } = require("../core/harness_prompt_contract.js");
const { resolveAgentMethod } = require("../core/agent_method_config.js");
const { createPhaseIntentPlanner } = require("../core/phase_intent_runtime.js");
const { LOG_DIR } = require("../core/experiment_log.js");
const { fallbackReasonClass, stepBudget, transportFailureDetails } = require("../core/transport_attribution.js");
const { promptValue } = require("../core/prompt_registry.js");
const { sidePromptRegistryMetadata } = require("../core/prompt_registry.js");
const { PROJECT_ROOT } = require("../core/project_paths.js");
const { resolveControllers } = require("../core/controller_config.js");
const {
  closeModelRuntime,
  createChatCompletionsClient,
  createModelRuntime,
  createOpenCodeProviderConfig,
  publicRuntimeMetadata,
  resolveModel,
  startModelGateway,
  validateCapabilities
} = require("../core/model_runtime.js");

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_ID = "alamein_gateway";
const DISABLED_TOOLS = [
  "bash", "batch", "edit", "glob", "grep", "list", "lsp", "multiedit", "patch", "question",
  "read", "skill", "task", "todo", "todoread", "todowrite", "webfetch", "websearch", "write"
];

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function safeId(values) {
  return values.map((value) => String(value).replace(/[^a-zA-Z0-9_-]+/g, "_")).join("__");
}

function writeTranscript(file, transcript) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(transcript, null, 2));
}

function collectDebugLogs(root, secrets = []) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.log$|log/i.test(entry.name)) files.push(file);
    }
  }
  try { visit(root); }
  catch { return []; }
  return files.slice(-8).map((file) => {
    let text = fs.readFileSync(file, "utf8").slice(-30000);
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
    return { file: path.relative(root, file), text };
  });
}

function unwrap(result, label) {
  if (result?.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  if (result?.data == null) throw new Error(`${label}: OpenCode returned no data`);
  return result.data;
}

function toolsConfig(toolProfile) {
  return Object.fromEntries([
    ["*", false],
    ...DISABLED_TOOLS.map((name) => [name, false]),
    ...toolProfile.tools.map((name) => [name, true])
  ]);
}

export function createHarnessConfig(runtime, pluginUrl, toolProfileInput = "map_and_action", side) {
  const toolProfile = typeof toolProfileInput === "string" ? resolveToolProfile(toolProfileInput) : toolProfileInput;
  const promptContract = createHarnessPromptContract(toolProfile.tools, side);
  const provider = createOpenCodeProviderConfig(runtime);
  provider.options.timeout = runtime.profile.defaults.timeout_ms + 5000;
  const modelRef = `${PROVIDER_ID}/${runtime.profile.model}`;
  const permission = {
    read: "deny", edit: "deny", glob: "deny", grep: "deny", list: "deny", bash: "deny",
    task: "deny", external_directory: "deny", todowrite: "deny", question: "deny",
    webfetch: "deny", websearch: "deny", lsp: "deny", skill: "deny", doom_loop: "deny"
  };
  return {
    $schema: "https://opencode.ai/config.json",
    logLevel: process.env.ALAMEIN_OPENCODE_LOG_LEVEL === "DEBUG" ? "DEBUG" : "WARN",
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    enabled_providers: [PROVIDER_ID],
    model: modelRef,
    small_model: modelRef,
    provider: { [PROVIDER_ID]: provider },
    plugin: [pluginUrl],
    mcp: {},
    formatter: false,
    lsp: false,
    tools: toolsConfig(toolProfile),
    permission,
    compaction: {
      auto: true,
      prune: false,
      reserved: Math.min(runtime.profile.limits.context - 1024, Math.max(16000, runtime.profile.limits.output * 2))
    },
    agent: {
      wargame: {
        description: promptValue("harness.agent_description"),
        mode: "primary",
        model: modelRef,
        temperature: runtime.profile.defaults.temperature,
        steps: 6,
        tools: toolsConfig(toolProfile),
        permission,
        prompt: promptContract.templates.system
      }
    }
  };
}

export async function startIsolatedOpencode(config, bridge, experimentId, side = "axis") {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `alamein-opencode-${experimentId}-`));
  const workspace = path.join(tempRoot, "workspace");
  const home = path.join(tempRoot, "home");
  for (const directory of [workspace, home, path.join(tempRoot, "config"), path.join(tempRoot, "data"), path.join(tempRoot, "cache")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const previousCwd = process.cwd();
  const names = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PATH", "ALAMEIN_RULE_BRIDGE_URL", "ALAMEIN_RULE_BRIDGE_TOKEN", "ALAMEIN_TOOL_PROFILE", "ALAMEIN_ACTIVE_SIDE"];
  const previousEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.chdir(workspace);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(tempRoot, "config");
    process.env.XDG_DATA_HOME = path.join(tempRoot, "data");
    process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
    process.env.PATH = `${path.join(PROJECT_ROOT, "node_modules", ".bin")}${path.delimiter}${previousEnv.PATH || ""}`;
    process.env.ALAMEIN_RULE_BRIDGE_URL = bridge.url;
    process.env.ALAMEIN_RULE_BRIDGE_TOKEN = bridge.token;
    process.env.ALAMEIN_TOOL_PROFILE = bridge.profile.id;
    process.env.ALAMEIN_ACTIVE_SIDE = side;
    const instance = await createOpencode({ hostname: "127.0.0.1", port: 0, timeout: 30000, config });
    // SDK 1.18.13's default Node adapter mutates Request.timeout, which can
    // leave session requests pending. Keep SDK server lifecycle management,
    // but inject a plain standards-compliant fetch adapter for its client.
    const client = createOpencodeClient({ baseUrl: instance.server.url, fetch: (request) => fetch(request) });
    return { ...instance, client, tempRoot, workspace };
  }
  finally {
    process.chdir(previousCwd);
    for (const name of names) {
      if (previousEnv[name] == null) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
  }
}

function visibleToolNames(runtime, startIndex) {
  const names = new Set();
  for (const record of runtime.transport.slice(startIndex)) {
    for (const item of record.request?.tools || []) {
      const name = item.function?.name || item.name;
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

async function promptWithTimeout(client, sessionId, workspace, body, timeoutMs) {
  const prompt = client.session.prompt({ sessionID: sessionId, directory: workspace, ...body });
  let timer;
  try {
    return await Promise.race([
      prompt,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`OpenCode step exceeded ${timeoutMs}ms`)), timeoutMs); })
    ]);
  }
  catch (error) {
    await client.session.abort({ sessionID: sessionId, directory: workspace }).catch(() => {});
    prompt.catch(() => {});
    throw error;
  }
  finally {
    clearTimeout(timer);
  }
}

export async function makeOpenCodeProvider({ config, runtime, bridge, instance, transcript, timeoutMs = 180000, decisionPolicy = "direct", phasePlanner }) {
  const { client, workspace } = instance;
  const promptContract = createHarnessPromptContract(bridge.profile.tools, transcript.external_side);
  const session = unwrap(await client.session.create({
    directory: workspace,
    title: `Alamein ${transcript.experiment_id}`,
    agent: "wargame",
    model: { id: runtime.profile.model, providerID: PROVIDER_ID },
    metadata: { run_id: transcript.experiment_id, model_profile: runtime.profile.profile_id }
  }), "create session");
  transcript.opencode_session_id = session.id;

  const provider = async (input) => {
    const started = Date.now();
    const transportStart = runtime.transport.length;
    const toolStart = bridge.records.length;
    const phasePlanStarted = Date.now();
    const phasePlan = await phasePlanner.plan(input);
    const phasePlanMs = Date.now() - phasePlanStarted;
    const prepareStarted = Date.now();
    const prepared = bridge.prepareStep({ ...input, session_id: session.id, decisionMode: decisionPolicy, phaseIntent: phasePlan.phaseIntent });
    const prepareMs = Date.now() - prepareStarted;
    const harnessPayload = compactAgentPayload(prepared.public_payload);
    const stepRecord = {
      step: input.step,
      controller: "external_ai",
      turn: input.turn,
      phase: input.phase,
      side: input.side,
      context_bytes: prepared.context_bytes,
      harness_context_bytes: contextBytes(harnessPayload),
      phase_plan_ms: phasePlanMs,
      prepare_ms: prepareMs,
      rounds: [],
      action_attempts: [],
      transport_failures: [],
      protocol_failures: [],
      fallback_used: false,
      local_fast_pass: false
    };
    if (phasePlan.record) {
      stepRecord.phase_intent = {
        ...phasePlan.record,
        execution_candidate_count: prepared.public_payload.context.execution_candidate_count || phasePlan.record.execution_candidate_count
      };
    }
    transcript.model_steps.push(stepRecord);

    if (phasePlan.localFastPass || !prepared.has_non_pass) {
      const action = {
        type: "pass",
        reason: phasePlan.localFastPass && phasePlan.phaseIntent?.type === "pass"
          ? "local_fast_pass: phase intent pass without high-priority action"
          : "local_fast_pass: no legal non-pass action"
      };
      stepRecord.local_fast_pass = true;
      stepRecord.final_action = action;
      stepRecord.transport_failures = transportFailureDetails(runtime, transportStart);
      stepRecord.provider_result = {
        provider: runtime.profile.provider,
        model: runtime.profile.model,
        harness: "opencode_harness",
        elapsed_ms: Date.now() - started,
        rounds: 0,
        tool_calls: [],
        fallback_used: false,
        local_fast_pass: true
      };
      writeTranscript(transcript.output_file, transcript);
      return { action, model: stepRecord.provider_result };
    }

    let timedOut = false;
    try {
      const budget = stepBudget(config, started, timeoutMs);
      if (budget.modelBudgetMs <= 0) {
        timedOut = true;
        throw new Error(`OpenCode step exhausted its ${timeoutMs}ms budget before model execution`);
      }
      const response = unwrap(await promptWithTimeout(client, session.id, workspace, {
        agent: "wargame",
        model: { providerID: PROVIDER_ID, modelID: runtime.profile.model },
        tools: Object.fromEntries(bridge.profile.tools.map((name) => [name, true])),
        parts: [{ type: "text", text: renderHarnessStep(promptContract, harnessPayload, input) }]
      }, budget.modelBudgetMs), "prompt session");
      const action = bridge.submittedAction();
      stepRecord.opencode = {
        // Raw model requests/responses are captured by the local gateway.
        // Avoid synchronously reading OpenCode's entire session on every step.
        message_count_before: null,
        response,
        visible_tools: visibleToolNames(runtime, transportStart)
      };
      if (!action) throw new Error(`OpenCode did not produce an accepted action within ${bridge.profile.max_calls_per_step} steps`);
      stepRecord.final_action = action;
    }
    catch (error) {
      stepRecord.fallback_used = true;
      stepRecord.error = error.message;
      timedOut = timedOut || /\b(exceeded|exhausted|timed? out|timeout)\b/i.test(error.message);
      stepRecord.final_action = bridge.fallbackAction();
    }

    const toolCalls = bridge.records.slice(toolStart);
    stepRecord.transport_failures = transportFailureDetails(runtime, transportStart);
    stepRecord.action_attempts = toolCalls
      .filter((record) => record.tool === "act")
      .map((record, index) => ({
        attempt: index + 1,
        action: record.arguments?.action || {},
        accepted: !!record.result?.accepted,
        reason: record.result?.reason || "",
        issues: record.result?.issues || [],
        assessment: record.result?.assessment || null
      }));
    const actToolCalls = toolCalls.filter((record) => record.tool === "act");
    if (stepRecord.fallback_used && !stepRecord.transport_failures.length && stepRecord.error && !actToolCalls.length) {
      stepRecord.protocol_failures.push({ reason: stepRecord.error });
    }
    stepRecord.fallback_reason_class = fallbackReasonClass({
      fallbackUsed: stepRecord.fallback_used,
      timedOut,
      transportFailures: stepRecord.transport_failures,
      protocolFailures: stepRecord.protocol_failures,
      error: stepRecord.error
    });
    const modelRounds = runtime.transport.length - transportStart;
    stepRecord.rounds = toolCalls.map((record, index) => ({ round: index + 1, tool_call: record }));
    stepRecord.model_rounds = modelRounds;
    stepRecord.provider_result = {
      provider: runtime.profile.provider,
      model: runtime.profile.model,
      harness: "opencode_harness",
      elapsed_ms: Date.now() - started,
      context_bytes: prepared.context_bytes,
      harness_context_bytes: stepRecord.harness_context_bytes,
      phase_plan_ms: stepRecord.phase_plan_ms,
      prepare_ms: stepRecord.prepare_ms,
      rounds: modelRounds,
      tool_rounds: toolCalls.length,
      tool_calls: toolCalls.map((record) => ({ tool: record.tool, arguments: record.arguments, result: record.result })),
      visible_tools: visibleToolNames(runtime, transportStart),
      fallback_used: stepRecord.fallback_used,
      fallback_reason_class: stepRecord.fallback_reason_class,
      transport_failures: stepRecord.transport_failures.length,
      protocol_failures: stepRecord.protocol_failures.length,
      error: stepRecord.error || null,
      post_accept_tool_calls: toolCalls.filter((record) => record.after_submission).length,
      final_accepted: !!bridge.submittedAction()
    };
    writeTranscript(transcript.output_file, transcript);
    console.log(`[opencode] step=${input.step} T${input.turn} ${input.phase} action=${stepRecord.final_action.type} tools=${toolCalls.length} fallback=${stepRecord.fallback_used ? "yes" : "no"} elapsed_ms=${stepRecord.provider_result.elapsed_ms}`);
    return { action: stepRecord.final_action, model: stepRecord.provider_result };
  };
  provider.sessionId = session.id;
  return provider;
}

export async function runOpenCodeExperiment(options = {}) {
  const methodConfig = resolveAgentMethod("opencode_harness");
  const scenario = options.scenario || "july";
  const controllers = resolveControllers({
    controllers: options.controllers,
    axisController: options.axisController,
    alliesController: options.alliesController,
    externalSide: options.externalSide
  });
  const externalSide = controllers.external_side;
  const seed = Number(options.seed || 1942);
  const replicate = Number(options.replicate || 1);
  const maxSteps = Number(options.maxSteps || 1000);
  const modelProfile = options.modelProfile || methodConfig.model_profile;
  const decisionPolicy = options.decisionPolicy || methodConfig.decision_policy;
  const toolProfile = resolveToolProfile(options.toolProfile || methodConfig.tool_profile);
  const stepTimeoutMs = Number(options.timeoutMs || methodConfig.step_timeout_ms);
  const experimentId = safeId([scenario, `axis-${controllers.axis}`, `allies-${controllers.allies}`, seed, replicate, "opencode_harness", decisionPolicy, toolProfile.id, modelProfile]);
  const outputFile = path.resolve(options.outFile || path.join(LOG_DIR, `${experimentId}.json`));
  const profile = resolveModel(modelProfile);
  validateCapabilities(profile, { tool_calling: true, min_context: 32000, min_output: 1024 });
  const runtime = createModelRuntime(profile, { run_id: experimentId, mockResponder: options.mockResponder });
  const config = readConfig();
  const bridge = createRuleBridge(config, { toolProfile: toolProfile.id });
  const comparison = createComparisonContract({
    config,
    scenario,
    externalSide,
    controllers,
    seed,
    replicate,
    decisionPolicy,
    toolProfile,
    toolConfigHash: toolProfileHash(toolProfile),
    runtime,
    contextProfile: CONTEXT_PROFILE_ID,
    timeoutMs: stepTimeoutMs
  });
  let instance;
  const transcript = {
    generated_at: new Date().toISOString(),
    partial: true,
    output_file: outputFile,
    experiment_id: experimentId,
    scenario,
    seed,
    replicate,
    external_side: externalSide,
    controllers: { axis: controllers.axis, allies: controllers.allies },
    axis_controller: controllers.axis,
    allies_controller: controllers.allies,
    rules_side: controllers.axis === "rules_ai" && controllers.allies === "external_ai" ? "axis" : controllers.allies === "rules_ai" && controllers.axis === "external_ai" ? "allies" : null,
    decision_mode: decisionPolicy,
    harness: "opencode_harness",
    harness_version: "opencode-1.18.13",
    agent_method: methodConfig.id,
    config_sources: {
      agent_methods: "ai/config/agent_methods.yaml",
      agent_tools: "ai/config/agent_tools.yaml",
      models: "ai/config/ai_models.yaml",
      prompts: "ai/prompt/prompts.yaml",
      side_prompts: `ai/prompt/${externalSide}_prompts.yaml`
    },
    prompt_profile: sidePromptRegistryMetadata(externalSide).profile,
    prompt_profile_hash: sidePromptRegistryMetadata(externalSide).hash,
    model_profile: modelProfile,
    model_runtime: publicRuntimeMetadata(runtime),
    context_profile: CONTEXT_PROFILE_ID,
    prompt_registry_version: comparison.contract.prompt_registry_version,
    prompt_registry_hash: comparison.contract.prompt_registry_hash,
    harness_prompt_version: comparison.contract.harness_prompt_version,
    harness_prompt_hash: comparison.contract.harness_prompt_hash,
    tool_protocol: toolProfile.id === "single_action" ? "single_action" : toolProfile.id,
    tool_profile: toolProfile.id,
    tool_profile_version: toolProfile.version,
    tool_catalog_version: TOOL_CATALOG_VERSION,
    tool_config_hash: toolProfileHash(toolProfile),
    legacy_tool_protocol: toolProfile.id === "legacy_three_tool" ? "three_tool_legacy" : null,
    comparison_contract: comparison.contract,
    comparison_contract_hash: comparison.hash,
    movement_phase_policy: "rule_complete",
    fixed_movement_action_limits: false,
    allowed_tools: [...toolProfile.tools],
    model_transport: runtime.transport,
    transport_health: runtime.transport_health,
    model_usage: runtime.usage,
    model_steps: []
  };
  writeTranscript(outputFile, transcript);
  const started = Date.now();
  try {
    await Promise.all([startModelGateway(runtime), bridge.start()]);
    const pluginUrl = pathToFileURL(path.join(ROOT, "opencode_wargame_plugin.mjs")).href;
    instance = await startIsolatedOpencode(createHarnessConfig(runtime, pluginUrl, toolProfile, externalSide), bridge, experimentId, externalSide);
    const replay = makeReplay(scenario, { seed });
    const phasePlanner = createPhaseIntentPlanner({
      config,
      runtime,
      client: createChatCompletionsClient(runtime),
      decisionPolicy
    });
    const provider = await makeOpenCodeProvider({ config, runtime, bridge, instance, transcript, timeoutMs: stepTimeoutMs, decisionPolicy, phasePlanner });
    const result = await replay.playWithProvider({ maxSteps, controllers, externalAction: provider });
    transcript.partial = false;
    transcript.elapsed_ms = Date.now() - started;
    transcript.status = result.status;
    transcript.summary = replay.summary(result);
    transcript.game_log = result.log;
    transcript.compaction = {
      count: null,
      capture: "OpenCode session messages are not synchronously enumerated; model transport and rule-bridge records are authoritative.",
      context_limit: profile.limits.context,
      reserved_tokens: Math.min(profile.limits.context - 1024, Math.max(16000, profile.limits.output * 2))
    };
    transcript.counts = {
      external_actions: (result.log || []).filter((item) => item.source === "external_model").length,
      rules_actions: (result.log || []).filter((item) => item.controller === "rules_ai").length,
      heuristic_actions: (result.log || []).filter((item) => item.controller === "heuristic_ai").length,
      illegal_actions: (result.log || []).filter((item) => item.result && item.result.legal === false).length,
      fallback_actions: transcript.model_steps.filter((item) => item.fallback_used).length,
      network_fallback_actions: transcript.model_steps.filter((item) => item.fallback_reason_class === "transport_failure").length,
      transport_failures: runtime.transport.filter((item) => item.error_class && item.error_class !== "none").length,
      protocol_failures: transcript.model_steps.reduce((sum, step) => sum + (step.protocol_failures?.length || 0), 0),
      circuit_open_events: runtime.transport_health?.circuit_open_events || 0,
      local_fast_pass_actions: transcript.model_steps.filter((item) => item.local_fast_pass).length,
      model_tool_calls: bridge.records.length,
      map_tool_calls: bridge.records.filter((item) => item.tool === "view_map").length,
      act_calls: bridge.records.filter((item) => item.tool === "act").length,
      accepted_actions: bridge.records.filter((item) => item.tool === "act" && item.result?.accepted).length,
      invalid_action_attempts: bridge.records.filter((item) => item.tool === "act" && !item.result?.accepted).length,
      post_accept_tool_calls: bridge.records.filter((item) => item.after_submission).length,
      retry_attempts: runtime.transport.reduce((sum, item) => sum + Math.max(0, Number(item.attempts || 1) - 1), 0)
    };
    writeTranscript(outputFile, transcript);
    return transcript;
  }
  catch (error) {
    transcript.status = "harness_error";
    transcript.error = error.message;
    transcript.elapsed_ms = Date.now() - started;
    if (instance?.tempRoot) transcript.opencode_debug_logs = collectDebugLogs(instance.tempRoot, [runtime.local_token, bridge.token]);
    writeTranscript(outputFile, transcript);
    throw error;
  }
  finally {
    const localSecrets = [runtime.local_token, bridge.token];
    instance?.server.close();
    await Promise.all([bridge.close(), closeModelRuntime(runtime)]);
    if (instance?.tempRoot) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (transcript.status === "harness_error") {
        transcript.opencode_debug_logs = collectDebugLogs(instance.tempRoot, localSecrets);
      }
      if (process.env.ALAMEIN_KEEP_OPENCODE_TEMP === "1") transcript.opencode_temp_root = instance.tempRoot;
      else fs.rmSync(instance.tempRoot, { recursive: true, force: true });
    }
    writeTranscript(outputFile, transcript);
  }
}

async function main() {
  const transcript = await runOpenCodeExperiment({
    scenario: argValue("--scenario", "july"),
    externalSide: argValue("--external-side", "") || undefined,
    axisController: argValue("--axis-controller", "") || undefined,
    alliesController: argValue("--allies-controller", "") || undefined,
    seed: Number(argValue("--seed", 1942)),
    replicate: Number(argValue("--replicate", 1)),
    maxSteps: Number(argValue("--max-steps", 1000)),
    modelProfile: argValue("--model-profile", "") || undefined,
    decisionPolicy: argValue("--decision-policy", argValue("--decision-mode", "")) || undefined,
    toolProfile: argValue("--tool-profile", "") || undefined,
    outFile: argValue("--out", "") || undefined,
    timeoutMs: argValue("--step-timeout-ms", "") ? Number(argValue("--step-timeout-ms", "")) : undefined
  });
  console.log(JSON.stringify({
    output: transcript.output_file,
    experiment_id: transcript.experiment_id,
    status: transcript.status,
    elapsed_ms: transcript.elapsed_ms,
    model_profile: transcript.model_profile,
    victory: transcript.summary?.victory || null,
    counts: transcript.counts,
    usage: transcript.model_usage
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
