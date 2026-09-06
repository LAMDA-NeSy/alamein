#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { makeReplay } = require("../experiments/ai_replay.js");
const { readConfig } = require("../experiments/external_ai_transcript.js");
const { createRuleBridge } = require("../core/opencode_rule_bridge.js");
const { TOOL_CATALOG_VERSION, resolveToolProfile, toolProfileHash } = require("../core/agent_tools.js");
const { CONTEXT_PROFILE_ID, compactAgentPayload, contextBytes } = require("../core/agent_context.js");
const { createComparisonContract } = require("../core/comparison_contract.js");
const { createHarnessPromptContract, renderHarnessStep } = require("../core/harness_prompt_contract.js");
const { sidePromptRegistryMetadata } = require("../core/prompt_registry.js");
const { resolveAgentMethod } = require("../core/agent_method_config.js");
const { createPhaseIntentPlanner } = require("../core/phase_intent_runtime.js");
const { LOG_DIR } = require("../core/experiment_log.js");
const { fallbackReasonClass, recoveredTransportDetails, stepBudget, transportFailureDetails } = require("../core/transport_attribution.js");
const { CONFIG_DIR } = require("../core/project_paths.js");
const { resolveControllers } = require("../core/controller_config.js");
const { infrastructureStatus } = require("../core/benchmark_comparison.js");
const { attachRuntimeAccounting, refreshRuntimeAccounting } = require("../core/experiment_accounting.js");
const { validateExperimentSelection } = require("../core/experiment_selection.js");
const {
  closeModelRuntime,
  createChatCompletionsClient,
  createModelRuntime,
  publicRuntimeMetadata,
  resolveModel,
  startModelGateway,
  validateCapabilities
} = require("../core/model_runtime.js");

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(ROOT, "pydanticai_runner.py");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function safeId(values) {
  return values.map((value) => String(value).replace(/[^a-zA-Z0-9_-]+/g, "_")).join("__");
}

function writeTranscript(file, transcript) {
  refreshRuntimeAccounting(transcript);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(transcript, null, 2));
}

function redacted(text, secrets = []) {
  let output = String(text || "");
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[REDACTED]");
  return output;
}

function assertPython311(python) {
  const result = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`PydanticAI Python executable is unavailable: ${python}`);
  const version = `${result.stdout || ""}${result.stderr || ""}`.match(/Python\s+(\d+)\.(\d+)/);
  if (!version || Number(version[1]) !== 3 || Number(version[2]) < 11) throw new Error(`PydanticAI requires Python 3.11+, found ${String(result.stdout || result.stderr).trim()}`);
}

function assertPydanticAiDependencies(python) {
  const result = spawnSync(python, [RUNNER,
    "--model", "dependency-check",
    "--gateway-url", "http://127.0.0.1:1/v1",
    "--gateway-token", "dependency-check",
    "--bridge-url", "http://127.0.0.1:1",
    "--bridge-token", "dependency-check",
    "--dependency-check"
  ], { cwd: ROOT, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "unknown dependency error").trim();
    throw new Error(`PydanticAI dependencies are unavailable for ${python}: ${detail}`);
  }
}

class JsonlSidecar {
  constructor(command, args, options = {}) {
    this.pending = [];
    this.stderr = "";
    this.exitDetail = "";
    this.closed = false;
    this.child = spawn(command, args, { cwd: ROOT, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      this.exitDetail = `exit=${code ?? "unknown"}${signal ? ` signal=${signal}` : ""}`;
      if (!this.closed) this.failAll(new Error(`PydanticAI sidecar exited (${code ?? ""}${signal ? `/${signal}` : ""})`));
    });
    this.child.stdin.on("error", (error) => this.failAll(error));
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-30000); });
  }

  receive(line) {
    const pending = this.pending.shift();
    if (!pending) return;
    try { pending.resolve(JSON.parse(line)); }
    catch (error) { pending.reject(new Error(`PydanticAI sidecar returned invalid JSON: ${error.message}`)); }
  }

  failAll(error) {
    while (this.pending.length) this.pending.shift().reject(error);
  }

  request(payload, timeoutMs) {
    if (this.closed) return Promise.reject(new Error("PydanticAI sidecar is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.reject === reject);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error(`PydanticAI step exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.push({
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) this.failAll(error);
      });
    });
  }

  async close() {
    if (this.closed) return;
    try { await this.request({ type: "close" }, 2000); }
    catch {}
    this.closed = true;
    this.child.kill();
  }
}

function sidecarEnvironment() {
  return {
    PATH: process.env.PATH || "",
    PYTHONUNBUFFERED: "1",
    LANG: process.env.LANG || "C"
  };
}

export async function runPydanticAiExperiment(options = {}) {
  const methodConfig = resolveAgentMethod("pydanticai_harness");
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
  validateExperimentSelection("pydanticai_harness", decisionPolicy);
  const toolProfile = resolveToolProfile(options.toolProfile || methodConfig.tool_profile);
  const promptContract = createHarnessPromptContract(toolProfile.tools, externalSide);
  if (toolProfile.tools.some((name) => !["view_map", "act"].includes(name))) {
    throw new Error("pydanticai_harness supports only view_map and act tool profiles");
  }
  // ROOT is ai/harnesses; the uv-managed environment lives at repository root.
  const defaultPython = path.resolve(ROOT, "..", "..", ".venv", "bin", "python");
  const requestedPython = options.python || process.env.PYDANTICAI_PYTHON
    || (fs.existsSync(defaultPython) ? defaultPython : "python3.11");
  const python = path.isAbsolute(requestedPython) || !requestedPython.includes(path.sep)
    ? requestedPython
    : path.resolve(requestedPython);
  assertPython311(python);
  assertPydanticAiDependencies(python);
  const stepTimeoutMs = Number(options.timeoutMs || methodConfig.step_timeout_ms);
  const experimentId = safeId([scenario, `axis-${controllers.axis}`, `allies-${controllers.allies}`, seed, replicate, "pydanticai_harness", decisionPolicy, toolProfile.id, modelProfile]);
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
    timeoutMs: stepTimeoutMs,
    maxSteps
  });
  let sidecar;
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
    harness: "pydanticai_harness",
    harness_version: "pydantic-ai-slim-1.x",
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
    tool_protocol: toolProfile.id,
    tool_profile: toolProfile.id,
    tool_profile_version: toolProfile.version,
    tool_catalog_version: TOOL_CATALOG_VERSION,
    tool_config_hash: toolProfileHash(toolProfile),
    comparison_contract: comparison.contract,
    comparison_contract_hash: comparison.hash,
    benchmark_version: comparison.contract.benchmark_version,
    artifact_manifest: comparison.contract.artifact_manifest,
    artifact_manifest_hash: comparison.contract.artifact_manifest_hash,
    movement_phase_policy: "rule_complete",
    fixed_movement_action_limits: false,
    allowed_tools: [...toolProfile.tools],
    model_transport: runtime.transport,
    transport_health: runtime.transport_health,
    model_usage: runtime.usage,
    model_steps: []
  };
  attachRuntimeAccounting(transcript, { agent: runtime });
  writeTranscript(outputFile, transcript);
  const started = Date.now();
  try {
    await Promise.all([startModelGateway(runtime), bridge.start()]);
    sidecar = new JsonlSidecar(python, [RUNNER,
      "--model", runtime.profile.model,
      "--provider", runtime.profile.provider,
      "--gateway-url", runtime.gateway_url,
      "--gateway-token", runtime.local_token,
      "--bridge-url", bridge.url,
      "--bridge-token", bridge.token,
      "--tool-profile", toolProfile.id,
      "--tool-profile-file", path.join(CONFIG_DIR, "agent_methods.yaml"),
      "--tool-catalog-file", path.join(CONFIG_DIR, "agent_tools.yaml"),
      "--tool-profile-json", JSON.stringify(toolProfile),
      "--agent-instructions", promptContract.templates.system,
      "--max-attempts", String(toolProfile.max_calls_per_step),
      "--temperature", String(runtime.profile.defaults.temperature),
      "--output-limit", String(runtime.profile.limits.output)
    ], { env: sidecarEnvironment() });
    const replay = makeReplay(scenario, { seed });
    const sessionId = `pydanticai-${crypto.randomUUID()}`;
    const phasePlanner = createPhaseIntentPlanner({
      config,
      runtime,
      client: createChatCompletionsClient(runtime),
      decisionPolicy
    });
    const provider = async (input) => {
      const stepStarted = Date.now();
      const transportStart = runtime.transport.length;
      const recordStart = bridge.records.length;
      const phasePlanStarted = Date.now();
      const phasePlan = await phasePlanner.plan(input);
      const phasePlanMs = Date.now() - phasePlanStarted;
      const prepareStarted = Date.now();
      const prepared = bridge.prepareStep({ ...input, session_id: sessionId, decisionMode: decisionPolicy, phaseIntent: phasePlan.phaseIntent });
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
        action_attempts: [],
        transport_failures: [],
        recovered_transport_failures: [],
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
        stepRecord.recovered_transport_failures = recoveredTransportDetails(runtime, transportStart);
        stepRecord.provider_result = { harness: "pydanticai_harness", elapsed_ms: Date.now() - stepStarted, rounds: 0, tool_calls: [], fallback_used: false, local_fast_pass: true };
        return { action, model: stepRecord.provider_result };
      }
      let response;
      let timedOut = false;
      try {
        const budget = stepBudget(config, stepStarted, stepTimeoutMs);
        if (budget.modelBudgetMs <= 0) {
          timedOut = true;
          throw new Error(`PydanticAI step exhausted its ${stepTimeoutMs}ms budget before model execution`);
        }
        response = await sidecar.request({
          type: "step",
          session_id: sessionId,
          step: input.step,
          prompt: renderHarnessStep(promptContract, harnessPayload, input)
        }, budget.modelBudgetMs);
      }
      catch (error) {
        timedOut = timedOut || /\b(exceeded|exhausted|timed? out|timeout)\b/i.test(error.message);
        await new Promise((resolve) => setTimeout(resolve, 25));
        const diagnostic = [error.message, sidecar.exitDetail, sidecar.stderr.trim()].filter(Boolean).join("; ");
        response = {
          accepted: false,
          final_action: null,
          action_attempts: [],
          usage: {},
          error: redacted(diagnostic, [runtime.local_token, bridge.token])
        };
      }
      const toolCalls = bridge.records.slice(recordStart);
      stepRecord.action_attempts = response.action_attempts || [];
      stepRecord.fallback_used = !response.accepted;
      stepRecord.error = response.error || null;
      stepRecord.final_action = response.accepted && response.final_action ? response.final_action : bridge.fallbackAction();
      stepRecord.transport_failures = transportFailureDetails(runtime, transportStart);
      stepRecord.recovered_transport_failures = recoveredTransportDetails(runtime, transportStart);
      if (stepRecord.fallback_used && !stepRecord.transport_failures.length && stepRecord.error
        && !/sidecar|broken pipe|exited|closed/i.test(stepRecord.error)) {
        stepRecord.protocol_failures.push({ reason: stepRecord.error });
      }
      stepRecord.fallback_reason_class = fallbackReasonClass({
        fallbackUsed: stepRecord.fallback_used,
        timedOut,
        transportFailures: stepRecord.transport_failures,
        protocolFailures: stepRecord.protocol_failures,
        error: stepRecord.error
      });
      stepRecord.model_rounds = runtime.transport.length - transportStart;
      stepRecord.rounds = toolCalls.map((tool_call, index) => ({ round: index + 1, tool_call }));
      stepRecord.pydanticai = { usage: response.usage || {}, model_output: response.model_output || "" };
      stepRecord.provider_result = {
        provider: runtime.profile.provider,
        model: runtime.profile.model,
        harness: "pydanticai_harness",
        elapsed_ms: Date.now() - stepStarted,
        context_bytes: prepared.context_bytes,
        harness_context_bytes: stepRecord.harness_context_bytes,
        phase_plan_ms: stepRecord.phase_plan_ms,
        prepare_ms: stepRecord.prepare_ms,
        rounds: stepRecord.model_rounds,
        tool_rounds: toolCalls.length,
        tool_calls: toolCalls.map((item) => ({ tool: item.tool, arguments: item.arguments, result: item.result })),
        visible_tools: [...toolProfile.tools],
        fallback_used: stepRecord.fallback_used,
        fallback_reason_class: stepRecord.fallback_reason_class,
        transport_failures: stepRecord.transport_failures.length,
        recovered_transport_failures: stepRecord.recovered_transport_failures.length,
        protocol_failures: stepRecord.protocol_failures.length,
        error: stepRecord.error,
        final_accepted: !!bridge.submittedAction()
      };
      writeTranscript(outputFile, transcript);
      return { action: stepRecord.final_action, model: stepRecord.provider_result };
    };
    const result = await replay.playWithProvider({ maxSteps, controllers, externalAction: provider });
    transcript.partial = false;
    transcript.elapsed_ms = Date.now() - started;
    transcript.status = result.status;
    transcript.summary = replay.summary(result);
    transcript.game_log = result.log;
    transcript.counts = {
      external_actions: (result.log || []).filter((item) => item.source === "external_model").length,
      rules_actions: (result.log || []).filter((item) => item.controller === "rules_ai").length,
      heuristic_actions: (result.log || []).filter((item) => item.controller === "heuristic_ai").length,
      illegal_actions: (result.log || []).filter((item) => item.result && item.result.legal === false).length,
      fallback_actions: transcript.model_steps.filter((item) => item.fallback_used).length,
      network_fallback_actions: transcript.model_steps.filter((item) => item.fallback_reason_class === "transport_failure").length,
      transport_failures: transcript.model_steps.reduce((sum, step) => sum + (step.transport_failures?.length || 0), 0),
      recovered_transport_failures: transcript.model_steps.reduce((sum, step) => sum + (step.recovered_transport_failures?.length || 0), 0),
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
    transcript.sample_status = infrastructureStatus(transcript);
    writeTranscript(outputFile, transcript);
    return transcript;
  }
  catch (error) {
    transcript.status = "harness_error";
    transcript.error = error.message;
    transcript.elapsed_ms = Date.now() - started;
    transcript.sample_status = infrastructureStatus(transcript);
    if (sidecar) transcript.pydanticai_stderr = redacted(sidecar.stderr, [runtime.local_token, bridge.token]);
    writeTranscript(outputFile, transcript);
    throw error;
  }
  finally {
    if (sidecar) await sidecar.close();
    await Promise.all([bridge.close(), closeModelRuntime(runtime)]);
    writeTranscript(outputFile, transcript);
  }
}

async function main() {
  const transcript = await runPydanticAiExperiment({
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
    python: argValue("--pydanticai-python", process.env.PYDANTICAI_PYTHON || "") || undefined,
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
