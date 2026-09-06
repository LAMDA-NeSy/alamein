#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ChatOpenAI } from "@langchain/openai";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const require = createRequire(import.meta.url);
const { makeReplay } = require("../experiments/ai_replay.js");
const { readConfig } = require("../experiments/external_ai_transcript.js");
const { createRuleBridge } = require("../core/opencode_rule_bridge.js");
const { TOOL_CATALOG_VERSION, getOpenAiToolDefinitions, resolveToolProfile, toolProfileHash } = require("../core/agent_tools.js");
const { CONTEXT_PROFILE_ID, compactAgentPayload, contextBytes } = require("../core/agent_context.js");
const { createComparisonContract } = require("../core/comparison_contract.js");
const { createHarnessPromptContract, renderHarnessStep } = require("../core/harness_prompt_contract.js");
const { sidePromptRegistryMetadata } = require("../core/prompt_registry.js");
const { resolveAgentMethod } = require("../core/agent_method_config.js");
const { createPhaseIntentPlanner } = require("../core/phase_intent_runtime.js");
const { LOG_DIR } = require("../core/experiment_log.js");
const { fallbackReasonClass, recoveredTransportDetails, stepBudget, transportFailureDetails } = require("../core/transport_attribution.js");
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

export async function invokeWithTimeout(invoke, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutError = new Error(`${label} exceeded ${timeoutMs}ms`);
  let timer;
  let timedOut = false;
  const task = Promise.resolve().then(() => invoke(controller.signal));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, deadline]);
  }
  catch (error) {
    if (timedOut) {
      // Give LangGraph a brief chance to settle after cancellation. The
      // per-step bridge session below prevents any late call from leaking.
      await Promise.race([
        task.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]);
      throw timeoutError;
    }
    throw error;
  }
  finally {
    clearTimeout(timer);
  }
}

export function createLangGraphModel(runtime, toolProfile) {
  const model = new ChatOpenAI({
    model: runtime.profile.model,
    apiKey: runtime.local_token,
    temperature: runtime.profile.defaults.temperature,
    maxTokens: runtime.profile.limits.output,
    // The local model gateway is the single retry owner. Retrying the whole
    // gateway request here multiplies its upstream retry budget and latency.
    maxRetries: 0,
    configuration: { baseURL: runtime.gateway_url, maxRetries: 0 }
  });
  return model.bindTools(getOpenAiToolDefinitions(toolProfile), { parallel_tool_calls: false });
}

const GraphState = Annotation.Root({
  prompt: Annotation(),
  sessionId: Annotation(),
  allowedTools: Annotation(),
  maxToolCalls: Annotation(),
  toolCall: Annotation(),
  toolCalls: Annotation(),
  modelRounds: Annotation(),
  observations: Annotation(),
  actionAttempts: Annotation(),
  accepted: Annotation(),
  finalAction: Annotation(),
  fallbackUsed: Annotation(),
  error: Annotation()
});

export function createLangGraphActionGraph({ model, bridge, toolProfile = bridge.profile, side }) {
  const promptContract = createHarnessPromptContract(toolProfile.tools, side);
  const decide = async (state) => {
    const allowedTools = state.allowedTools || toolProfile?.tools || ["act"];
    const observations = state.observations || [];
    const observationText = observations.length
      ? `\n\nTOOL_RESULTS_FROM_THIS_STEP\n${JSON.stringify(observations)}`
      : "";
    const response = await model.invoke([
      new SystemMessage(promptContract.templates.system),
      new HumanMessage(`${state.prompt}${observationText}`)
    ]);
    const calls = Array.isArray(response.tool_calls) ? response.tool_calls : [];
    if (calls.length !== 1 || !allowedTools.includes(calls[0]?.name)) {
      return {
        modelRounds: Number(state.modelRounds || 0) + 1,
        error: calls.length
          ? `expected one enabled tool call (${allowedTools.join(", ")}), received ${calls.map((call) => call.name).join(",")}`
          : "model returned no tool call"
      };
    }
    return {
      modelRounds: Number(state.modelRounds || 0) + 1,
      toolCall: { name: calls[0].name, arguments: calls[0].args || {}, id: calls[0].id || "" },
      error: null
    };
  };

  const executeTool = async (state) => {
    const call = state.toolCall;
    if (!call) return { error: state.error || "missing tool call" };
    const result = bridge.executeTool(call.name, call.arguments || {}, state.sessionId);
    const toolCalls = Number(state.toolCalls || 0) + 1;
    const observations = [...(state.observations || []), {
      call: toolCalls,
      tool: call.name,
      arguments: call.arguments || {},
      result
    }];
    const actionAttempts = call.name === "act"
      ? [...(state.actionAttempts || []), {
          attempt: (state.actionAttempts || []).length + 1,
          action: call.arguments?.action || {},
          accepted: !!result.accepted,
          reason: result.reason || "",
          issues: result.issues || [],
          assessment: result.assessment || null
        }]
      : [...(state.actionAttempts || [])];
    return {
      toolCalls,
      observations,
      actionAttempts,
      accepted: call.name === "act" && !!result.accepted,
      finalAction: call.name === "act" && result.accepted ? result.action : null,
      toolCall: null,
      error: null
    };
  };

  const fallback = async () => ({
    fallbackUsed: true,
    finalAction: bridge.fallbackAction()
  });

  const routeAfterDecide = (state) => state.error ? "fallback" : "execute_tool";
  const routeAfterTool = (state) => {
    if (state.accepted) return END;
    return Number(state.toolCalls || 0) >= Number(state.maxToolCalls || 6) ? "fallback" : "model_decide";
  };

  return new StateGraph(GraphState)
    .addNode("model_decide", decide)
    .addNode("execute_tool", executeTool)
    .addNode("fallback", fallback)
    .addEdge(START, "model_decide")
    .addConditionalEdges("model_decide", routeAfterDecide, ["execute_tool", "fallback"])
    .addConditionalEdges("execute_tool", routeAfterTool, ["model_decide", "fallback", END])
    .addEdge("fallback", END)
    .compile({ checkpointer: new MemorySaver() });
}

export async function runLangGraphExperiment(options = {}) {
  const methodConfig = resolveAgentMethod("langgraph_harness");
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
  validateExperimentSelection("langgraph_harness", decisionPolicy);
  const toolProfile = resolveToolProfile(options.toolProfile || methodConfig.tool_profile);
  const promptContract = createHarnessPromptContract(toolProfile.tools, externalSide);
  const stepTimeoutMs = Number(options.timeoutMs || methodConfig.step_timeout_ms);
  const experimentId = safeId([scenario, `axis-${controllers.axis}`, `allies-${controllers.allies}`, seed, replicate, "langgraph_harness", decisionPolicy, toolProfile.id, modelProfile]);
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
    harness: "langgraph_harness",
    harness_version: "langgraph-1.4.9",
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
    model_steps: [],
    langgraph: { checkpoint: "MemorySaver", sessions: [] }
  };
  attachRuntimeAccounting(transcript, { agent: runtime });
  writeTranscript(outputFile, transcript);
  const started = Date.now();
  try {
    await Promise.all([startModelGateway(runtime), bridge.start()]);
    const model = createLangGraphModel(runtime, toolProfile);
    const graph = createLangGraphActionGraph({ model, bridge, toolProfile, side: externalSide });
    const phasePlanner = createPhaseIntentPlanner({
      config,
      runtime,
      client: createChatCompletionsClient(runtime),
      decisionPolicy
    });
    const replay = makeReplay(scenario, { seed });
    const sessionId = `langgraph-${crypto.randomUUID()}`;
    transcript.langgraph.sessions.push(sessionId);
    const provider = async (input) => {
      const stepStarted = Date.now();
      const transportStart = runtime.transport.length;
      const recordStart = bridge.records.length;
      const stepSessionId = `${sessionId}:step:${input.step}:${crypto.randomUUID()}`;
      const phasePlanStarted = Date.now();
      const phasePlan = await phasePlanner.plan(input);
      const phasePlanMs = Date.now() - phasePlanStarted;
      const prepareStarted = Date.now();
      const prepared = bridge.prepareStep({ ...input, session_id: stepSessionId, decisionMode: decisionPolicy, phaseIntent: phasePlan.phaseIntent });
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
        stepRecord.provider_result = { harness: "langgraph_harness", elapsed_ms: Date.now() - stepStarted, rounds: 0, tool_calls: [], fallback_used: false, local_fast_pass: true };
        return { action, model: stepRecord.provider_result };
      }
      let graphState;
      let timedOut = false;
      try {
        const budget = stepBudget(config, stepStarted, stepTimeoutMs);
        if (budget.modelBudgetMs <= 0) {
          timedOut = true;
          throw new Error(`LangGraph step exhausted its ${stepTimeoutMs}ms budget before model execution`);
        }
        graphState = await invokeWithTimeout((signal) => graph.invoke({
          prompt: renderHarnessStep(promptContract, harnessPayload, input),
          sessionId: stepSessionId,
          allowedTools: [...toolProfile.tools],
          maxToolCalls: toolProfile.max_calls_per_step,
          toolCalls: 0,
          modelRounds: 0,
          observations: [],
          actionAttempts: [],
          accepted: false,
          fallbackUsed: false,
          finalAction: null,
          error: null
        }, {
          configurable: { thread_id: sessionId, checkpoint_ns: `step:${input.step}` },
          signal
        }), budget.modelBudgetMs, "LangGraph step");
      }
      catch (error) {
        timedOut = timedOut || /\b(exceeded|exhausted|timed? out|timeout)\b/i.test(error.message);
        graphState = { finalAction: bridge.fallbackAction(), fallbackUsed: true, error: error.message, actionAttempts: [] };
      }
      const toolCalls = bridge.records.slice(recordStart);
      stepRecord.action_attempts = graphState.actionAttempts || [];
      stepRecord.fallback_used = !!graphState.fallbackUsed;
      stepRecord.error = graphState.error || null;
      stepRecord.final_action = graphState.finalAction || bridge.fallbackAction();
      stepRecord.transport_failures = transportFailureDetails(runtime, transportStart);
      stepRecord.recovered_transport_failures = recoveredTransportDetails(runtime, transportStart);
      if (stepRecord.fallback_used && !stepRecord.transport_failures.length && stepRecord.error) {
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
      stepRecord.provider_result = {
        provider: runtime.profile.provider,
        model: runtime.profile.model,
        harness: "langgraph_harness",
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
    writeTranscript(outputFile, transcript);
    throw error;
  }
  finally {
    await Promise.all([bridge.close(), closeModelRuntime(runtime)]);
    writeTranscript(outputFile, transcript);
  }
}

async function main() {
  const transcript = await runLangGraphExperiment({
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
