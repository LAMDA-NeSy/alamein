#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { makeReplay } = require("./ai_replay.js");
const {
  closeModelRuntime,
  createChatCompletionsClient,
  createModelRuntime,
  publicRuntimeMetadata,
  resolveModel,
  thinkingRequest,
  validateCapabilities
} = require("../core/model_runtime.js");
const {
  buildContext,
  evaluateProbeAction,
  finalActionReview,
  publicPayload,
  readConfig,
  runTool,
  systemPrompt
} = require("./external_ai_transcript.js");
const { createRuleBridge } = require("../core/opencode_rule_bridge.js");
const { TOOL_CATALOG_VERSION, getOpenAiToolDefinitions, resolveToolProfile, toolProfileHash } = require("../core/agent_tools.js");
const { createComparisonContract } = require("../core/comparison_contract.js");
const {
  CONTEXT_PROFILE_ID,
  compactAgentPayload,
  compactToolFeedback,
  contextBytes
} = require("../core/agent_context.js");
const { agentMethodDefaults, resolveAgentMethod } = require("../core/agent_method_config.js");
const { LOG_DIR } = require("../core/experiment_log.js");
const { createContextStore, sha256 } = require("../core/context_store.js");
const {
  createReasoningMemory,
  responseMessageFromResult,
  toolMessageFromRecord
} = require("../core/reasoning_memory.js");
const { createPhaseIntentPlanner } = require("../core/phase_intent_runtime.js");
const { createSaeRuntime, deriveActionEffect } = require("../core/sae_runtime.js");
const { createTaskCheckerRuntime } = require("../core/task_checker_runtime.js");
const { fallbackReasonClass, isNonRetryableRequestStatus } = require("../core/transport_attribution.js");
const { resolveSidePrompt, renderSidePrompt, sidePromptRegistryMetadata, sideStrategyConfig } = require("../core/prompt_registry.js");
const { toolPromptReference } = require("../core/agent_tools.js");
const { PROJECT_ROOT } = require("../core/project_paths.js");
const { resolveControllers } = require("../core/controller_config.js");
const { infrastructureStatus } = require("../core/benchmark_comparison.js");
const { attachRuntimeAccounting, refreshRuntimeAccounting } = require("../core/experiment_accounting.js");
const { validateExperimentSelection } = require("../core/experiment_selection.js");

const ROOT = PROJECT_ROOT;
// DeepSeek rejects `required` and function-specific tool_choice in its default
// thinking mode. The application-level parser below still requires exactly
// one enabled tool call, so the provider can use its compatible `auto` mode.
const EXECUTION_TOOL_CHOICE = "auto";
const CONTEXT_POLICY = "stable_static_prefix_plus_compact_current_state_with_reasoning_memory_v4";
const TOOL_FEEDBACK_PROFILE = "compact_tool_feedback_v1";
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function messageText(result) {
  return result.response_json?.choices?.[0]?.message?.content || "";
}

function reasoningText(result) {
  return result.response_json?.choices?.[0]?.message?.reasoning_content || "";
}

function parseJsonFromResult(result) {
  const content = messageText(result);
  if (!content && reasoningText(result)) {
    return { parse_error: "empty content with reasoning_content", content: reasoningText(result) };
  }
  if (!content) return { parse_error: "model returned empty JSON", content: "" };
  try {
    return JSON.parse(content);
  }
  catch (error) {
    return { parse_error: error.message, content };
  }
}

async function callModel(config, runtime, client, messages, label, options = {}) {
  const result = await client.complete({
    // The execution loop mutates its in-step message chain after each response.
    // Clone here so transport records and test clients capture the exact request
    // that was sent rather than a later version of the same array.
    messages: clone(messages),
    temperature: Number(runtime.profile.defaults.temperature ?? config.api.temperature ?? 0.25),
    max_tokens: Math.min(Number(options.maxTokens || config.api.maxTokens || 3600), runtime.profile.limits.output),
    response_format: !options.tools && runtime.profile.capabilities.structured_output
      ? config.api.responseFormat || { type: "json_object" }
      : undefined,
    tools: options.tools,
    tool_choice: options.toolChoice,
    // Thinking is opt-in. In particular, execution requests must omit it so
    // provider-specific thinking/tool-choice combinations cannot leak into
    // the action protocol.
    thinking: options.thinking === undefined ? thinkingRequest(runtime) : options.thinking,
    timeout_ms: options.timeoutMs
  });
  return { label, ...result };
}

function parseProfileToolCall(result, toolProfile) {
  const calls = result.response_json?.choices?.[0]?.message?.tool_calls || [];
  const name = calls[0]?.function?.name;
  if (calls.length !== 1 || !toolProfile.tools.includes(name)) {
    return {
      error: calls.length
        ? `expected one enabled tool call (${toolProfile.tools.join(", ")}), received ${calls.map((call) => call.function?.name || "unknown").join(",")}`
        : "model returned no tool call"
    };
  }
  try {
    return {
      tool: name,
      call_id: calls[0].id || "",
      arguments: JSON.parse(calls[0].function.arguments || "{}")
    };
  }
  catch (error) {
    return { error: `invalid ${name} arguments: ${error.message}` };
  }
}

function compactCandidate(item) {
  if (!item) return null;
  return {
    score: item.score,
    type: item.action?.type || "",
    unit: item.action?.unit || item.action?.attackers?.join(",") || "",
    destination: item.action?.destination || item.action?.path?.at?.(-1) || "",
    summary: item.evaluation?.summary || "",
    risks: item.evaluation?.risks || []
  };
}

function compactToolResult(record) {
  return {
    tool: record.tool,
    arguments: record.arguments,
    legal: record.result?.legal ?? null,
    reason: record.result?.reason || ""
  };
}

function classifyActionRejection(attempt = {}) {
  if (attempt.accepted) return "";
  const text = [attempt.reason, ...(attempt.issues || [])].join(" ").toLowerCase();
  if (text.includes("transcript probe")
    || text.includes("candidate rank")
    || text.includes("non-candidate final action")
    || text.includes("candidate action")) {
    return "transcript_probe_rejection";
  }
  if (attempt.assessment?.legal === false) return "rule_engine_rejection";
  return "policy_rejection";
}

function summarizeRollingMovementPhases(steps = []) {
  const phases = new Map();
  for (const step of steps) {
    if (!step.rolling_movement || !step.movement_phase) continue;
    const key = `${step.turn}:${step.phase}:${step.side}`;
    const value = step.movement_phase;
    const previous = phases.get(key) || {
      eligible: 0,
      acted: 0,
      held: 0,
      unavailable: 0,
      completion_rate: 0
    };
    phases.set(key, {
      eligible: Math.max(previous.eligible, Number(value.eligible_units_at_phase_start || 0)),
      acted: Math.max(previous.acted, Number(value.acted_units || 0)),
      held: Math.max(previous.held, Number(value.held_units || 0)),
      unavailable: Math.max(previous.unavailable, Number(value.unavailable_units || 0)),
      completion_rate: Math.max(previous.completion_rate, Number(value.movement_phase_completion_rate || 0))
    });
  }
  const values = [...phases.values()];
  return {
    phases: values.length,
    eligible: values.reduce((sum, phase) => sum + phase.eligible, 0),
    acted: values.reduce((sum, phase) => sum + phase.acted, 0),
    held: values.reduce((sum, phase) => sum + phase.held, 0),
    unavailable: values.reduce((sum, phase) => sum + phase.unavailable, 0),
    completion_rate: values.length
      ? values.reduce((sum, phase) => sum + phase.completion_rate, 0) / values.length
      : 0
  };
}

function summarizeMovementPatterns(gameLog = [], source = "external_model", modelSteps = []) {
  const histories = new Map();
  const destinationCounts = new Map();
  const stepsById = new Map(modelSteps.map((step) => [Number(step.step), step]));
  let moves = 0;
  let immediateReversals = 0;
  let repeatedDestinationActions = 0;
  for (const entry of gameLog) {
    const step = stepsById.get(Number(entry.step));
    const acceptedToolAction = step?.rounds
      ?.map((round) => round.tool_result)
      .findLast?.((tool) => tool?.tool === "act" && tool.result?.accepted)
      ?.result?.canonical_action;
    const detailedAction = step?.final_action
      || step?.rolling_unit_action?.selected_action
      || acceptedToolAction;
    const action = entry.action?.type === "move" && !entry.action.path?.length && detailedAction?.type === "move"
      ? detailedAction
      : entry.action;
    if (entry.source !== source || !action || typeof action !== "object" || action.type !== "move") continue;
    const start = action.path?.[0];
    const destination = action.destination || action.path?.at?.(-1);
    if (!action.unit || !start || !destination) continue;
    const history = histories.get(action.unit) || [start];
    if (history.includes(destination)) repeatedDestinationActions += 1;
    if (history.length >= 2 && history.at(-2) === destination) immediateReversals += 1;
    history.push(destination);
    histories.set(action.unit, history);
    destinationCounts.set(destination, Number(destinationCounts.get(destination) || 0) + 1);
    moves += 1;
  }
  const topDestinations = [...destinationCounts.entries()]
    .map(([hex, count]) => ({ hex, count }))
    .sort((left, right) => right.count - left.count || left.hex.localeCompare(right.hex));
  const topThreeMoves = topDestinations.slice(0, 3).reduce((sum, item) => sum + item.count, 0);
  return {
    moves,
    immediate_reversals: immediateReversals,
    repeated_destination_actions: repeatedDestinationActions,
    top_destination_hexes: topDestinations.slice(0, 5),
    top_three_destination_share: moves ? topThreeMoves / moves : 0
  };
}

function fallbackActionFromContext(context) {
  const best = context.candidate_actions?.find((item) => item.action?.type !== "pass") || context.candidate_actions?.[0];
  return best?.action || { type: "pass", reason: "fallback after model error" };
}

const transcriptWriteState = new WeakMap();
const TRANSCRIPT_CHECKPOINT_INTERVAL_MS = 30000;

function writeTranscript(outFile, transcript, { force = false } = {}) {
  if (!outFile) return;
  const now = Date.now();
  const state = transcriptWriteState.get(transcript) || { lastWriteAt: 0 };
  if (!force && state.lastWriteAt && now - state.lastWriteAt < TRANSCRIPT_CHECKPOINT_INTERVAL_MS) return;
  state.lastWriteAt = now;
  transcriptWriteState.set(transcript, state);
  refreshRuntimeAccounting(transcript);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(transcript, null, 2));
}

function progressLine(stepRecord, result) {
  const action = result.action || stepRecord.final_action || {};
  const destination = action.destination || action.path?.at?.(-1) || "";
  const target = action.type === "move"
    ? `${action.unit}->${destination}`
    : action.type === "combat"
      ? `${(action.attackers || []).join("+")}=>${(action.defender_hexes || []).join("+")}`
      : action.type || "unknown";
  return [
    `[external-ai] step=${stepRecord.step}`,
    `T${stepRecord.turn}`,
    stepRecord.phase,
    `action=${target}`,
    `rounds=${stepRecord.rounds.length}`,
    `fallback=${stepRecord.fallback_used ? "yes" : "no"}`,
    `elapsed_ms=${result.model.elapsed_ms}`
  ].join(" ");
}

function makeExternalProvider(config, runtime, transcript, options = {}) {
  const maxRounds = Number(options.maxToolRounds ?? config.api.maxToolRounds ?? 4);
  const maxCallRetries = Number(options.maxCallRetries ?? 2);
  const fallbackAfterModelError = options.fallbackAfterModelError !== false;
  const decisionMode = ["candidates", "intent", "hybrid"].includes(options.decisionMode) ? options.decisionMode : "candidates";
  const phaseIntentCache = new Map();
  const outFile = options.outFile || "";
  const progress = options.progress !== false;
  const client = options.client || createChatCompletionsClient(runtime);

  function finishStep(stepRecord, result) {
    stepRecord.provider_result = result.model;
    writeTranscript(outFile, transcript);
    if (progress) console.log(progressLine(stepRecord, result));
    return result;
  }

  return async function externalAction({ state, step, side, phase, turn }) {
    const started = Date.now();
    let built = buildContext(config, { state, decisionMode, includeInitialMap: step === 1 });
    let context = built.publicContext;
    let toolEnv = { ctx: built.ctx, allUnits: built.allUnits };
    const toolResults = [];
    const stepRecord = {
      step,
      side,
      phase,
      turn,
      context_bytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
      rounds: [],
      fallback_used: false
    };
    transcript.model_steps.push(stepRecord);

    if (decisionMode === "hybrid") {
      if (!(built.candidatePool || []).some((item) => item.action?.type !== "pass")) {
        const pass = { type: "pass", reason: "local_fast_pass: no legal non-pass execution candidate" };
        const assessment = evaluateProbeAction(context, pass, built.ctx);
        const review = finalActionReview(context, pass, assessment);
        stepRecord.local_fast_pass = true;
        stepRecord.phase_intent = { source: "local_fast_pass", cache_key: `${turn}:${phase}:${side}`, candidate_pool_size: built.candidatePool?.length || 0, execution_candidate_count: 1 };
        stepRecord.final_action = pass;
        stepRecord.final_review = review;
        return finishStep(stepRecord, makeProviderResult(config, context, stepRecord, pass, assessment, review, [], started));
      }
      const phaseKey = `${turn}:${phase}:${side}`;
      let phaseIntent = phaseIntentCache.get(phaseKey);
      if (!phaseIntent) {
        let intentResult;
        let parsedIntent = null;
        try {
          intentResult = await callModel(config, runtime, client, [
            { role: "system", content: systemPrompt(config, "hybrid_intent", side) },
            { role: "user", content: JSON.stringify(publicPayload(config, context, [])) }
          ], `step_${step}_phase_intent`, { maxTokens: Number(config.api.intentMaxTokens || runtime.profile.limits.output) });
          parsedIntent = intentResult.ok ? parseJsonFromResult(intentResult) : null;
        }
        catch (error) {
          intentResult = { ok: false, status: null, elapsed_ms: Date.now() - started, error: error.message };
          parsedIntent = { parse_error: error.message, content: "" };
        }
        phaseIntent = parsedIntent?.type === "phase_intent" ? parsedIntent.intent || parsedIntent : {};
        phaseIntentCache.set(phaseKey, phaseIntent);
        stepRecord.phase_intent = {
          source: parsedIntent?.type === "phase_intent" ? "model" : "local_default",
          raw: parsedIntent || null,
          api: { status: intentResult.status, elapsed_ms: intentResult.elapsed_ms, error: intentResult.error || null }
        };
      }
      built = buildContext(config, { state, decisionMode, phaseIntent, includeInitialMap: step === 1 });
      context = built.publicContext;
      toolEnv = { ctx: built.ctx, allUnits: built.allUnits };
      stepRecord.phase_intent = { ...(stepRecord.phase_intent || {}), value: context.phase_intent, cache_key: phaseKey, candidate_pool_size: built.candidatePool.length, execution_candidate_count: context.execution_candidate_count || 0 };
      stepRecord.context_bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
      if ((context.candidate_actions || []).every((item) => item.action?.type === "pass")) {
        const pass = { type: "pass", reason: "local_fast_pass: no legal non-pass execution candidate" };
        const assessment = evaluateProbeAction(context, pass, built.ctx);
        const review = finalActionReview(context, pass, assessment);
        stepRecord.local_fast_pass = true;
        stepRecord.final_action = pass;
        stepRecord.final_review = review;
        return finishStep(stepRecord, makeProviderResult(config, context, stepRecord, pass, assessment, review, [], started));
      }
    }

    let finalReviewUsed = false;
    for (let round = 0; round <= maxRounds; round += 1) {
      const messages = [
        { role: "system", content: systemPrompt(config, context.decision_mode, side) },
        { role: "user", content: JSON.stringify(publicPayload(config, context, toolResults)) }
      ];
      let parsed = null;
      let lastResult = null;
      const attempts = [];
      for (let attempt = 0; attempt <= maxCallRetries; attempt += 1) {
        const label = `step_${step}_round_${round}_try_${attempt}`;
        try {
          lastResult = await callModel(config, runtime, client, messages, label);
          parsed = parseJsonFromResult(lastResult);
          attempts.push({
            attempt,
            ok: lastResult.ok,
            status: lastResult.status,
            elapsed_ms: lastResult.elapsed_ms,
            response_id: lastResult.response_json?.id || null,
            parsed_output: parsed,
            model_output: lastResult.response_json
          });
          if (lastResult.ok && parsed && !parsed.parse_error) break;
        }
        catch (error) {
          attempts.push({
            attempt,
            ok: false,
            status: null,
            elapsed_ms: lastResult?.elapsed_ms || 0,
            error: error.message
          });
          parsed = { parse_error: error.message, content: "" };
        }
      }

      const roundRecord = {
        round,
        model_input: {
          model: config.api.model,
          messages,
          temperature: Number(config.api.temperature ?? 0.25),
          max_tokens: Math.min(Number(config.api.maxTokens || 3600), runtime.profile.limits.output),
          response_format: config.api.responseFormat || { type: "json_object" }
        },
        attempts,
        parsed_output: parsed
      };
      stepRecord.rounds.push(roundRecord);

      if (!lastResult?.ok || !parsed || parsed.parse_error) {
        if (!fallbackAfterModelError) throw new Error(parsed?.parse_error || `model API status ${lastResult?.status}`);
        const fallback = fallbackActionFromContext(context);
        const assessment = evaluateProbeAction(context, fallback, built.ctx);
        const review = finalActionReview(context, fallback, assessment);
        roundRecord.fallback_action = fallback;
        roundRecord.assessment = assessment;
        roundRecord.final_action_review = review;
        stepRecord.fallback_used = true;
        stepRecord.error = parsed?.parse_error || `model API status ${lastResult?.status}`;
        stepRecord.final_action = assessment.action || fallback;
        stepRecord.final_review = review;
        return finishStep(stepRecord, makeProviderResult(config, context, stepRecord, assessment.action || fallback, assessment, review, toolResults, started));
      }

      if (parsed.type === "tool_call") {
        const toolResult = runTool(toolEnv, context, parsed.tool, parsed.arguments || {});
        const record = { tool: parsed.tool, arguments: parsed.arguments || {}, result: toolResult };
        toolResults.push(record);
        roundRecord.tool_result = record;
        continue;
      }

      const finalAction = parsed.type === "final_action" ? parsed.action : parsed.action || parsed;
      const assessment = evaluateProbeAction(context, finalAction, built.ctx);
      const review = finalActionReview(context, finalAction, assessment);
      roundRecord.assessment = assessment;
      roundRecord.final_action_review = review;
      if (!review.accept && !finalReviewUsed && round < maxRounds) {
        finalReviewUsed = true;
        toolResults.push({ tool: "final_action_review", arguments: { action: finalAction }, result: review });
        continue;
      }
      stepRecord.final_action = assessment.action || finalAction;
      stepRecord.final_review = review;
      return finishStep(stepRecord, makeProviderResult(config, context, stepRecord, assessment.action || finalAction, assessment, review, toolResults, started));
    }

    const fallback = fallbackActionFromContext(context);
    const assessment = evaluateProbeAction(context, fallback, built.ctx);
    const review = finalActionReview(context, fallback, assessment);
    stepRecord.fallback_used = true;
    stepRecord.error = "model did not produce a final action within tool round limit";
    stepRecord.final_action = assessment.action || fallback;
    stepRecord.final_review = review;
    return finishStep(stepRecord, makeProviderResult(config, context, stepRecord, assessment.action || fallback, assessment, review, toolResults, started));
  };
}

function singleActionPrompt(config, decisionPolicy, toolProfile, side) {
  const includesCandidates = ["candidates", "hybrid", "opportunity_aware_hybrid"].includes(decisionPolicy);
  const hierarchical = decisionPolicy === "hierarchical_sae";
  const strategy = sideStrategyConfig(side);
  return renderSidePrompt(side, "manual.system", {
    doctrine: strategy.doctrine,
    priorities: (strategy.priorities || []).map((item) => `Priority: ${item}`).join("\n"),
    context_instruction: `${resolveSidePrompt(side, includesCandidates ? "manual.context_with_candidates" : "manual.context_without_candidates")}\n${hierarchical ? resolveSidePrompt(side, "external.context_hierarchical") : ""}`,
    tool_names: toolProfile.tools.join(", "),
    tool_reference: toolPromptReference(toolProfile),
    tool_instruction: `${resolveSidePrompt(side,
      toolProfile.tools.includes("plan_route")
        ? "tool_route_tactical"
        : toolProfile.tools.includes("hold_unit") || toolProfile.tools.includes("hold_units")
        ? "manual.tool_rolling"
        : toolProfile.tools.includes("check_combat")
        || toolProfile.tools.includes("inspect_supply")
        || toolProfile.tools.includes("phase_status")
        ? "manual.tool_tactical"
        : toolProfile.tools.includes("view_map")
          ? "manual.tool_with_map"
          : "manual.tool_act"
    )}\n${hierarchical ? resolveSidePrompt(side, "external.review_hierarchical") : ""}`
  });
}

function makeSingleActionProvider(config, runtime, transcript, options = {}) {
  const decisionPolicy = ["direct", "candidates", "intent", "hybrid", "opportunity_aware_hybrid", "unit_plan_hybrid", "hierarchical_sae", "strategy_execute"].includes(options.decisionPolicy) ? options.decisionPolicy : "direct";
  const methodConfig = resolveAgentMethod(decisionPolicy);
  const toolProfile = resolveToolProfile(options.toolProfile || methodConfig.tool_profile);
  const bridge = options.bridge || createRuleBridge(config, { toolProfile: toolProfile.id });
  const client = options.client || createChatCompletionsClient(runtime);
  const outFile = options.outFile || "";
  const progress = options.progress !== false;
  const modelTools = getOpenAiToolDefinitions(toolProfile);
  const sessionId = options.sessionId || `manual-${runtime.run_id}`;
  const stepTimeoutMs = Number(options.timeoutMs || methodConfig.step_timeout_ms);
  const contextStore = options.contextStore || null;
  const reasoningMemory = options.reasoningMemory || createReasoningMemory({
    config: options.reasoningMemoryConfig || config.context?.reasoning_memory || {},
    initial: contextStore?.memory?.().reasoning_memory || null
  });
  let openingContextMessage = null;
  const phasePlanner = createPhaseIntentPlanner({ config, runtime, client, decisionPolicy });
  const saeRuntime = decisionPolicy === "hierarchical_sae"
    ? createSaeRuntime({
      config,
      runtime,
      client,
      taskChecker: options.taskChecker,
      decisionPolicy,
      reasoningMemory
    })
    : null;
  const pendingApplications = new Map();

  function staticMapContext(payload) {
    const context = payload?.context || {};
    const overview = context.game_overview || {};
    return {
      protocol: "stable-opening-context-v2",
      map_reference_hash: options.contextManifest?.hashes?.map_reference_hash || null,
      provider: payload?.provider,
      model: payload?.model,
      rules_summary: payload?.rules_summary,
      action_protocol: context.protocol || null,
      mission: context.mission || null,
      game_overview: {
        title: overview.title,
        game_type: overview.game_type,
        current_scenario: overview.current_scenario,
        objective: overview.objective,
        player_goal_summary: overview.player_goal_summary,
        scoring_rules: overview.scoring_rules,
        decision_order: overview.decision_order,
        information_boundaries: overview.information_boundaries
      },
      allowed_tools: (context.tools || []).map((tool) => tool?.name).filter(Boolean),
      initial_map_reference_2d: context.game_overview?.initial_map_reference_2d || null,
      map_topology: context.map_topology || null
    };
  }

  async function finish(stepRecord, action, started, input) {
    if (stepRecord.rolling_movement && typeof bridge.phaseStatus === "function") {
      const status = bridge.phaseStatus();
      const predictedActed = new Set(status?.acted_units || []);
      const predictedRemaining = new Set(status?.remaining_units || []);
      if (["move", "exit_west"].includes(action?.type) && action.unit) {
        predictedActed.add(action.unit);
        predictedRemaining.delete(action.unit);
      }
      const eligibleCount = Number(status?.counts?.eligible || status?.eligible_units?.length || 0);
      const heldCount = Number(status?.counts?.held || status?.held_units?.length || 0);
      const handledCount = predictedActed.size + heldCount + Number(status?.counts?.unavailable || 0);
      stepRecord.rolling_unit_action = {
        protocol: "rolling-unit-action-v1",
        phase_intent: stepRecord.phase_intent?.value || null,
        selected_action: clone(action),
        held_this_step: stepRecord.rounds.flatMap((round) => {
          if (!round.tool_result?.result?.accepted) return [];
          if (round.tool_result.tool === "hold_unit") {
            return [{ unit: round.tool_result.result.unit, reason: round.tool_result.arguments?.reason || "" }];
          }
          if (round.tool_result.tool === "hold_units") {
            const reasons = new Map((round.tool_result.arguments?.orders || []).map((order) => [order.unit, order.reason || ""]));
            return (round.tool_result.result.newly_held || []).map((unit) => ({ unit, reason: reasons.get(unit) || "" }));
          }
          return [];
        }),
        phase_status_before_apply: status
      };
      stepRecord.movement_phase = {
        movement_phase_policy: "rule_complete",
        eligible_units_at_phase_start: eligibleCount,
        acted_units: predictedActed.size,
        held_units: heldCount,
        remaining_eligible_units: predictedRemaining.size,
        unavailable_units: Number(status?.counts?.unavailable || 0),
        mandatory_actions: Number(status?.counts?.mandatory || 0),
        movement_phase_completion_rate: eligibleCount ? Math.min(1, handledCount / eligibleCount) : 1,
        advance_reason: action?.type === "pass" ? status?.advance_reason || "rolling_unit_plan_complete" : ""
      };
    }
    if (typeof bridge.submittedNextIntent === "function") {
      stepRecord.next_intent = bridge.submittedNextIntent();
    }
    stepRecord.reasoning = {
      policy: reasoningMemory.config,
      response_rounds: (stepRecord.rounds || []).filter((round) => round.model_output).length,
      reasoning_rounds: (stepRecord.rounds || []).filter((round) => {
        const message = responseMessageFromResult({ response_json: round.model_output });
        return typeof message?.reasoning_content === "string" && message.reasoning_content.trim();
      }).length
    };
    stepRecord.reasoning_memory_entry = reasoningMemory.recordStep(stepRecord, input);
    stepRecord.reasoning_memory_stats = reasoningMemory.stats();
    stepRecord.provider_result = {
      provider: runtime.profile.provider,
      model: runtime.profile.model,
      harness: "manual_single_action",
      elapsed_ms: Date.now() - started,
      context_bytes: stepRecord.context_bytes,
      raw_context_bytes: stepRecord.raw_context_bytes,
      static_context_bytes: stepRecord.static_context_bytes,
      effective_context_bytes: stepRecord.effective_context_bytes,
      context_profile: stepRecord.context_profile,
      phase_plan_ms: stepRecord.phase_plan_ms,
      prepare_ms: stepRecord.prepare_ms,
      rounds: stepRecord.rounds.length,
      tool_rounds: stepRecord.rounds.filter((round) => round.tool_result).length,
      tool_calls: stepRecord.rounds.filter((round) => round.tool_result).map((round) => round.tool_result),
      visible_tools: [...toolProfile.tools],
      fallback_used: stepRecord.fallback_used,
      fallback_reason_class: stepRecord.fallback_reason_class || "",
      transport_failures: stepRecord.transport_failures.length,
      recovered_transport_failures: stepRecord.recovered_transport_failures.length,
      protocol_failures: stepRecord.protocol_failures.length,
      error: stepRecord.error || null,
      final_accepted: !stepRecord.fallback_used
    };
    if (stepRecord.movement_phase) stepRecord.provider_result.movement_phase = stepRecord.movement_phase;
    if (options.taskChecker?.metadata) transcript.task_checker = options.taskChecker.metadata();
    // The replay owns mutation. Persisting the model step is deferred until the
    // replay reports the post-application snapshot through onActionApplied.
    pendingApplications.set(Number(stepRecord.step), { stepRecord, input });
    writeTranscript(outFile, transcript);
    if (progress) console.log(progressLine(stepRecord, { action, model: stepRecord.provider_result }));
    return { action, candidates: stepRecord.candidates || [], model: stepRecord.provider_result };
  }

  async function onActionApplied(event = {}) {
    const step = Number(event.step);
    const pending = pendingApplications.get(step);
    if (!pending) return { ok: false, ignored: true, reason: "no pending model step for applied action" };
    pendingApplications.delete(step);
    const { stepRecord } = pending;
    const afterState = event.state;
    stepRecord.action_applied = {
      applied: event.applied !== false,
      phase_before: event.phase || stepRecord.phase,
      phase_after: event.to_phase || afterState?.phase || stepRecord.phase,
      action: clone(event.action || stepRecord.final_action || {}),
      result: clone(event.result || null)
    };
    if (afterState && pending.input?.state) {
      try {
        const effectBuilt = buildContext(config, {
          state: pending.input.state,
          decisionMode: stepRecord.decision_mode || "hierarchical_sae",
          privateCandidates: false,
          includeInitialMap: false
        });
        stepRecord.action_effect = deriveActionEffect(
          pending.input.state,
          afterState,
          stepRecord,
          { ctx: effectBuilt.ctx, side: stepRecord.side }
        );
      }
      catch (error) {
        stepRecord.action_effect = {
          protocol: "sae-action-effect-v1",
          accepted: false,
          unavailable: true,
          error: error.message
        };
      }
    }
    if (afterState) {
      stepRecord.state_hash_after = sha256(afterState);
      stepRecord.post_action_state = {
        turn: afterState.turn,
        phase: afterState.phase,
        active_side: afterState.active_side
      };
    }
    if (saeRuntime && afterState) {
      await saeRuntime.observe({
        turn: stepRecord.turn,
        side: stepRecord.side,
        phase: stepRecord.phase,
        step: stepRecord.step,
        state: afterState
      }, stepRecord);
      stepRecord.task_progress_delta = stepRecord.task_observation?.task_progress_delta || {};
      stepRecord.sae_replan_pending = !!saeRuntime.replanReasons?.get(`${Number(stepRecord.turn)}:${stepRecord.side}`);
      if (stepRecord.task_observation) transcript.task_observations = (transcript.task_observations || []).concat([{
        step: stepRecord.step,
        turn: stepRecord.turn,
        phase: stepRecord.phase,
        ...clone(stepRecord.task_observation)
      }]);
    }
    reasoningMemory.recordActionEffect(stepRecord, pending.input || {});
    stepRecord.reasoning_memory_entry = reasoningMemory.latest();
    stepRecord.reasoning_memory_state = reasoningMemory.export();
    stepRecord.reasoning_memory_stats = reasoningMemory.stats();
    if (options.taskChecker?.metadata) transcript.task_checker = options.taskChecker.metadata();
    if (contextStore && afterState) contextStore.recordModelStep(stepRecord, pending.input?.state || null, {
      context_policy: CONTEXT_POLICY,
      map_reference_hash: options.contextManifest?.hashes?.map_reference_hash || null,
      stateAfter: afterState
    });
    writeTranscript(outFile, transcript);
    return { ok: true, state_hash_after: stepRecord.state_hash_after || null };
  }

  const provider = async function externalAction(input) {
    const started = Date.now();
    const stepDeadline = started + stepTimeoutMs;
    const phasePlanStarted = Date.now();
    const phasePlan = decisionPolicy === "hierarchical_sae"
      ? { phaseIntent: null, record: null, localFastPass: false }
      : await phasePlanner.plan(input, { deadline: stepDeadline });
    const saePlan = saeRuntime ? await saeRuntime.plan(input, { deadline: stepDeadline }) : null;
    if (!saeRuntime) reasoningMemory.begin(input);
    const phasePlanMs = Date.now() - phasePlanStarted;
    const phaseIntent = saePlan?.phaseIntent || phasePlan.phaseIntent;

    const prepareStarted = Date.now();
    const movementPhase = /_(initial_movement|mechanized_movement|supply_movement)$/.test(input.phase);
    const executionPolicy = decisionPolicy;
    const rollingMovement = ["unit_plan_hybrid", "hierarchical_sae"].includes(decisionPolicy) && movementPhase;
    const prepared = bridge.prepareStep({
      ...input,
      session_id: sessionId,
      decisionMode: executionPolicy,
      phaseIntent,
      strategicIntent: saePlan?.strategic_intent,
      forceAllocation: saePlan?.force_allocation,
      operationState: saePlan?.operation_state,
      builtContext: saeRuntime?.contextFor(input) || undefined,
      privateCandidates: rollingMovement ? false : undefined,
      // Rolling SAE execution already receives authoritative phase_status and
      // task dispatch. Building the full verified movement candidate pool here
      // repeats expensive path and supply projections without adding model
      // information; route checks remain available through tools and fallback.
      exposeVerifiedActions: false
    });
    const prepareMs = Date.now() - prepareStarted;
    const context = prepared.public_payload.context;
    const durableMemory = contextStore?.memory?.() || null;
    context.context_persistence = {
      policy: CONTEXT_POLICY,
      map_reference: {
        persisted: true,
        available_in_opening_context: true,
        hash: options.contextManifest?.hashes?.map_reference_hash || null,
        later_lookup: "Use view_map for current local geometry; the saved opening map is an audit artifact."
      },
      durable_memory_available: !!durableMemory
    };
    if (durableMemory && (durableMemory.strategic_intent || durableMemory.goal_plan || durableMemory.operation_state || durableMemory.task_plan)) {
      context.durable_memory = {
        strategic_intent: durableMemory.strategic_intent,
        goal_plan: durableMemory.goal_plan,
        force_allocation: durableMemory.force_allocation,
        operation_state: durableMemory.operation_state,
        task_plan: durableMemory.task_plan,
        supply_risks: durableMemory.supply_risks,
        recent_strategic_events: durableMemory.recent_strategic_events
      };
    }
    const reasoningMemoryPayload = reasoningMemory.forPrompt(input);
    if (reasoningMemoryPayload) context.reasoning_memory = reasoningMemoryPayload;
    if (!openingContextMessage) {
      openingContextMessage = JSON.stringify(staticMapContext(prepared.public_payload));
    }
    const projectedPayload = compactAgentPayload(prepared.public_payload, {
      includeInitialMap: false,
      includeStableContext: false
    });
    const systemMessage = singleActionPrompt(config, executionPolicy, toolProfile, input.side);
    const openingMessage = `OPENING_STATIC_CONTEXT\n${openingContextMessage}\n\nThe opening map is a fixed reference. CURRENT_STATE below is authoritative when facts changed.`;
    const rawContextBytes = contextBytes(prepared.public_payload);
    const projectedContextBytes = contextBytes(projectedPayload);
    const staticContextBytes = Buffer.byteLength(openingMessage, "utf8");
    const systemContextBytes = Buffer.byteLength(systemMessage, "utf8");
    const stepRecord = {
      step: input.step,
      controller: "external_ai",
      side: input.side,
      phase: input.phase,
      turn: input.turn,
      raw_context_bytes: rawContextBytes,
      context_bytes: projectedContextBytes,
      static_context_bytes: staticContextBytes,
      system_context_bytes: systemContextBytes,
      effective_context_bytes: systemContextBytes + staticContextBytes + projectedContextBytes,
      context_profile: CONTEXT_PROFILE_ID,
      context_policy: CONTEXT_POLICY,
      tool_feedback_profile: TOOL_FEEDBACK_PROFILE,
      reasoning_memory: reasoningMemoryPayload,
      phase_plan_ms: phasePlanMs,
      prepare_ms: prepareMs,
      rounds: [],
      action_attempts: [],
      transport_failures: [],
      recovered_transport_failures: [],
      protocol_failures: [],
      fallback_used: false,
      local_fast_pass: false,
      rolling_movement: rollingMovement,
      candidates: (context.candidate_actions || []).slice(0, 5).map(compactCandidate)
    };
    if (phasePlan.record) {
      stepRecord.phase_intent = { ...phasePlan.record, execution_candidate_count: prepared.public_payload.context.execution_candidate_count || phasePlan.record.execution_candidate_count };
    }
    if (saePlan) {
      stepRecord.sae_plan = saePlan.record;
      stepRecord.strategic_intent = saePlan.strategic_intent;
      stepRecord.goal_plan = saePlan.goal_plan;
      stepRecord.force_allocation = saePlan.force_allocation;
      stepRecord.operation_state = saePlan.operation_state;
      stepRecord.tactical_summary = saePlan.operation_state?.tactical_summary || null;
      stepRecord.phase_intent = {
        source: saePlan.record.source,
        value: phaseIntent,
        cache_key: `${input.turn}:${input.side}`,
        reused: !!saePlan.reused,
        strategic: saePlan.record.strategic,
        allocation: saePlan.record.allocation
      };
    }
    transcript.model_steps.push(stepRecord);
    const rollingStatus = stepRecord.rolling_movement && typeof bridge.phaseStatus === "function"
      ? bridge.phaseStatus()
      : null;
    const canLocallyEnd = rollingStatus ? rollingStatus.can_pass : !prepared.has_non_pass;
    const intentFastPassAllowed = phasePlan.localFastPass && !(stepRecord.rolling_movement && rollingStatus);
    if (intentFastPassAllowed || canLocallyEnd) {
      const action = {
        type: "pass",
        reason: phasePlan.localFastPass && phaseIntent?.type === "pass"
          ? "local_fast_pass: phase intent pass without high-priority action"
          : "local_fast_pass: no legal non-pass action"
      };
      stepRecord.local_fast_pass = true;
      stepRecord.final_action = action;
      return await finish(stepRecord, action, started, input);
    }

    const toolResults = [];
    const stepConversation = [
      { role: "system", content: systemMessage },
      ...(openingContextMessage ? [{ role: "user", content: openingMessage }] : []),
      {
        role: "user",
        content: `CURRENT_STATE\n${JSON.stringify(projectedPayload)}\n\nTOOL_RESULTS_FROM_THIS_STEP\n[]`
      }
    ];
    let timedOut = false;
    const fallbackReserveMs = Math.max(0, Number(config.transport?.stepFallbackReserveMs ?? 0));
    const deadline = stepDeadline;
    let consecutiveTransportFailureRounds = 0;
    for (let attempt = 0; attempt < toolProfile.max_calls_per_step; attempt += 1) {
      const remainingStepMs = deadline - Date.now();
      if (remainingStepMs <= fallbackReserveMs) {
        timedOut = true;
        break;
      }
      let result;
      let parsed;
      try {
        const feedbackText = JSON.stringify(toolResults.map(compactToolFeedback));
        const currentEffectiveBytes = systemContextBytes
          + staticContextBytes
          + Buffer.byteLength(JSON.stringify(stepConversation), "utf8");
        stepRecord.tool_feedback_bytes = Buffer.byteLength(feedbackText, "utf8");
        stepRecord.effective_context_bytes = Math.max(stepRecord.effective_context_bytes, currentEffectiveBytes);
        const requestOptions = {
          tools: modelTools,
          toolChoice: EXECUTION_TOOL_CHOICE,
          timeoutMs: Math.min(runtime.profile.defaults.timeout_ms, Math.max(1, remainingStepMs - fallbackReserveMs))
        };
        result = await callModel(config, runtime, client, stepConversation,
          `step_${input.step}_act_${attempt}`, requestOptions);
        if (result.ok && result.recovered_after_retry) {
          stepRecord.recovered_transport_failures.push({
            attempts: result.attempts,
            retryable_failures: result.retryable_failures || []
          });
        }
        parsed = result.ok
          ? parseProfileToolCall(result, toolProfile)
          : { error: `model API status ${result.status}`, failure_type: "transport", error_class: result.error_class || "network_error" };
      }
      catch (error) {
        parsed = { error: error.message, failure_type: "transport", error_class: "network_error" };
      }
      const round = {
        round: attempt + 1,
        model_input: result?.request_body || null,
        model_output: result?.response_json || null,
        parsed_output: parsed
      };
      stepRecord.rounds.push(round);
      const assistantMessage = result?.ok
        ? responseMessageFromResult(result, {
          includeReasoning: reasoningMemory.config.enabled && reasoningMemory.config.within_step === "full"
        })
        : null;
      if (assistantMessage) stepConversation.push(assistantMessage);
      if (parsed.error) {
        if (parsed.failure_type === "transport") {
          consecutiveTransportFailureRounds += 1;
          stepRecord.transport_failures.push({
            round: attempt + 1,
            status: result?.status ?? 0,
            error_class: parsed.error_class || "network_error",
            reason: parsed.error
          });
        }
        else {
          stepRecord.protocol_failures.push({ round: attempt + 1, reason: parsed.error });
        }
        if (assistantMessage) {
          stepConversation.push({
            role: "user",
            content: `The previous response was not executable: ${parsed.error}. Return exactly one enabled tool call.`
          });
        }
        if (deadline - Date.now() <= fallbackReserveMs) {
          timedOut = true;
          break;
        }
        if (parsed.failure_type === "transport" && isNonRetryableRequestStatus(result?.status)) {
          stepRecord.non_retryable_transport_error = true;
          break;
        }
        if (parsed.failure_type === "transport" && consecutiveTransportFailureRounds >= 2) {
          stepRecord.transport_failure_round_limit = true;
          break;
        }
        continue;
      }
      if (stepRecord.transport_failures.length) {
        stepRecord.continued_after_transport_failure = true;
      }
      consecutiveTransportFailureRounds = 0;
      const toolResult = bridge.executeTool(parsed.tool, parsed.arguments, sessionId);
      round.tool_result = {
        tool: parsed.tool,
        tool_call_id: parsed.call_id,
        arguments: parsed.arguments,
        result: toolResult
      };
      toolResults.push(round.tool_result);
      stepConversation.push(toolMessageFromRecord(
        round.tool_result,
        JSON.stringify(compactToolFeedback(round.tool_result))
      ));
      if (parsed.tool !== "act") continue;
      const actionAttempt = {
        attempt: stepRecord.action_attempts.length + 1,
        action: parsed.arguments?.action || {},
        accepted: !!toolResult.accepted,
        retryable: toolResult.retryable !== false,
        reason: toolResult.reason || "",
        rejection_type: toolResult.rejection_type || "",
        issues: toolResult.issues || [],
        assessment: toolResult.assessment || null,
        strategic_review: toolResult.strategic_review || null,
        strategic_warnings: toolResult.strategic_review?.warnings || [],
        alternatives: toolResult.alternatives || toolResult.assessment?.alternatives || [],
        recommended_recovery: toolResult.assessment?.recommended_recovery || ""
      };
      actionAttempt.rejection_class = classifyActionRejection(actionAttempt);
      stepRecord.action_attempts.push(actionAttempt);
      if (toolResult.accepted) {
        stepRecord.final_action = toolResult.action;
        return await finish(stepRecord, toolResult.action, started, input);
      }
      if (toolResult.retryable === false) {
        stepRecord.non_retryable_action_rejection = true;
        break;
      }
      if (Date.now() - started >= stepTimeoutMs) {
        timedOut = true;
        break;
      }
    }
    stepRecord.fallback_used = true;
    stepRecord.fallback_reason_class = fallbackReasonClass({
      fallbackUsed: true,
      timedOut,
      transportFailures: stepRecord.transport_failures,
      protocolFailures: stepRecord.protocol_failures
    });
    stepRecord.error = timedOut
      ? `manual single-action step exceeded ${stepTimeoutMs}ms`
      : stepRecord.non_retryable_transport_error
        ? "model returned a non-retryable request error"
      : stepRecord.transport_failure_round_limit
        ? "model transport failed in two consecutive tool rounds"
      : stepRecord.non_retryable_action_rejection
        ? "model repeated the same rejected action and reason"
      : "model did not produce an accepted action within tool call limit";
    stepRecord.final_action = bridge.fallbackAction();
    return await finish(stepRecord, stepRecord.final_action, started, input);
  };
  provider.onActionApplied = onActionApplied;
  provider.finalize = async (input = {}) => saeRuntime?.finalize(input) || null;
  return provider;
}

function makeProviderResult(config, context, stepRecord, action, assessment, review, toolResults, started) {
  return {
    action,
    candidates: (context.candidate_actions || []).slice(0, 5).map(compactCandidate),
    model: {
      provider: config.provider,
      model: config.api.model,
      elapsed_ms: Date.now() - started,
      context_bytes: stepRecord.context_bytes,
      rounds: stepRecord.rounds.length,
      retry_attempts: stepRecord.rounds.reduce((sum, round) => sum + Math.max(0, (round.attempts?.length || 1) - 1), 0),
      fallback_used: stepRecord.fallback_used,
      error: stepRecord.error || null,
      tool_calls: toolResults.filter((item) => item.tool !== "final_action_review").map(compactToolResult),
      final_accepted: review.accept,
      final_issues: review.issues || [],
      candidate_rank: assessment.candidate_match?.candidate_rank || null,
      exact_candidate: !!assessment.candidate_match?.exact_candidate,
      score: assessment.score ?? null,
      top_candidate: compactCandidate(context.candidate_actions?.[0])
    }
  };
}

async function main() {
  const legacyConfig = readConfig();
  const methodDefaults = agentMethodDefaults();
  const scenario = argValue("--scenario", "july");
  const legacyExternalSide = argValue("--external-side", "");
  const controllers = resolveControllers({
    externalSide: legacyExternalSide,
    axisController: argValue("--axis-controller", "") || undefined,
    alliesController: argValue("--allies-controller", "") || undefined
  });
  const externalSide = controllers.external_side;
  const externalSides = ["axis", "allies"].filter((side) => controllers[side] === "external_ai");
  const metadataPromptSide = externalSide || externalSides[0] || "axis";
  const requestedMode = argValue("--decision-policy", argValue("--decision-mode", methodDefaults.decision_policy));
  const decisionMode = requestedMode;
  const methodConfig = validateExperimentSelection("manual_single_action", decisionMode);
  const maxSteps = Number(argValue("--max-steps", 1000));
  const seed = Number(argValue("--seed", 1942));
  const replicate = Number(argValue("--replicate", 1));
  const requestedModelProfile = argValue("--model-profile", "") || "";
  const modelProfile = requestedModelProfile || (externalSides.length ? methodConfig.model_profile : "mock_primary");
  const toolProfile = resolveToolProfile(argValue("--tool-profile", "") || methodConfig.tool_profile);
  const stepTimeoutMs = Number(argValue("--step-timeout-ms", "") || methodConfig.step_timeout_ms);
  // Explicit disabled mode retains the historical SAE without task management.
  const taskManagement = decisionMode === "hierarchical_sae"
    && argValue("--task-management", methodConfig.task_management?.mode || "disabled") === "multi_task"
    ? methodConfig.task_management || {
      mode: "multi_task",
      protocol: "side-aware-task-v2",
      max_child_tasks: 6,
      max_active_child_tasks: 3,
      checker_enabled: true,
      checker_model_profile: "mock_secondary",
      checker_timeout_ms: 60000,
      checker_max_calls_per_turn: 4
    }
    : null;
  const taskCheckerProfile = argValue("--task-checker-model-profile", "") || taskManagement?.checker_model_profile || "";
  const experimentId = [scenario, `axis-${controllers.axis}`, `allies-${controllers.allies}`, seed, replicate, "manual_single_action", decisionMode, toolProfile.id, modelProfile, taskManagement ? taskCheckerProfile : "no_tasks"]
    .map((value) => String(value).replace(/[^a-zA-Z0-9_-]+/g, "_"))
    .join("__");
  const outFile = path.resolve(argValue("--out", path.join(LOG_DIR, `${experimentId}.json`)));
  const profile = resolveModel(modelProfile);
  if (profile.adapter !== "mock" && taskManagement?.checker_enabled && !argValue("--task-checker-model-profile", "")) {
    throw new Error("real multi-task experiments require an explicit --task-checker-model-profile");
  }
  validateCapabilities(profile, { tool_calling: true, min_context: 32000 });
  const runtime = createModelRuntime(profile, { run_id: experimentId });
  const runtimeBySide = Object.fromEntries(
    externalSides.map((side) => [side, side === externalSides[0]
      ? runtime
      : createModelRuntime(profile, { run_id: `${experimentId}__${side}` })])
  );
  const taskCheckerRuntimes = Object.fromEntries(
    externalSides
      .filter(() => taskManagement?.checker_enabled)
      .map((side) => [side, createModelRuntime(taskCheckerProfile, { run_id: `${experimentId}__${side}__task_checker` })])
  );
  for (const checkerRuntime of Object.values(taskCheckerRuntimes)) {
    validateCapabilities(checkerRuntime.profile, { structured_output: true, min_context: 16000 });
  }
  const taskCheckers = Object.fromEntries(Object.entries(taskCheckerRuntimes).map(([side, checkerRuntime]) => [side,
    createTaskCheckerRuntime({
      client: createChatCompletionsClient(checkerRuntime),
      runtime: checkerRuntime,
      timeoutMs: taskManagement.checker_timeout_ms,
      maxCallsPerTurn: taskManagement.checker_max_calls_per_turn
    })
  ]));
  const taskChecker = taskCheckers[externalSide] || taskCheckers[externalSides[0]] || null;
  const config = {
    ...legacyConfig,
    provider: profile.provider,
    api: {
      ...legacyConfig.api,
      model: profile.model,
      temperature: profile.defaults.temperature,
      maxTokens: Math.min(Number(legacyConfig.api.maxTokens || profile.limits.output), profile.limits.output),
      timeoutSeconds: profile.defaults.timeout_ms / 1000
    },
    task_management: taskManagement ? "multi_task" : "disabled",
    task_management_options: taskManagement || {}
  };
  const promptProfile = sidePromptRegistryMetadata(metadataPromptSide);
  const promptProfiles = Object.fromEntries(
    (externalSides.length ? externalSides : [metadataPromptSide]).map((side) => {
      const metadata = sidePromptRegistryMetadata(side);
      return [side, metadata];
    })
  );
  const comparison = createComparisonContract({
    config,
    scenario,
    externalSide,
    controllers,
    seed,
    replicate,
    decisionPolicy: decisionMode,
    toolProfile,
    toolConfigHash: toolProfileHash(toolProfile),
    runtime,
    contextProfile: CONTEXT_PROFILE_ID,
    timeoutMs: stepTimeoutMs,
    maxSteps,
    unitPlanSettings: methodConfig.rolling_unit,
    toolChoice: EXECUTION_TOOL_CHOICE,
    thinkingMode: runtime.profile.defaults.thinking,
    planningThinkingMode: runtime.profile.defaults.thinking,
    taskManagement: taskManagement ? taskManagement.protocol : null,
    taskCheckerProfile: taskCheckerProfile || null
  });
  const contextStoreDirectory = path.join(path.dirname(outFile), path.basename(outFile, path.extname(outFile)));
  const initialContext = buildContext(config, {
    scenario,
    phase: `${metadataPromptSide}_initial_movement`,
    activeSide: metadataPromptSide,
    decisionMode: "direct",
    includeInitialMap: true
  });
  const contextSides = externalSides.length ? externalSides : [metadataPromptSide];
  const contextStores = Object.fromEntries(contextSides.map((side) => [side, createContextStore({
    runId: `${experimentId}__${side}`,
    outFile,
    directory: path.join(contextStoreDirectory, side)
  })]));
  const contextStore = contextStores[externalSide] || contextStores[externalSides[0]] || null;
  const contextStoreErrors = [];
  const hashFile = (file) => {
    try { return sha256(fs.readFileSync(file, "utf8")); }
    catch { return null; }
  };
  const contextManifest = contextStore?.initialize({
    scenario,
    external_side: externalSide || metadataPromptSide,
    controllers: { axis: controllers.axis, allies: controllers.allies },
    seed,
    replicate,
    decision_policy: decisionMode,
    harness: "manual_single_action",
    model_profile: modelProfile,
    tool_profile: toolProfile.id,
    comparison_contract_hash: comparison.hash,
    prompt_registry_hash: comparison.contract.prompt_registry_hash,
    rules_source: "rules_el_alamein.json",
    context_policy: CONTEXT_POLICY,
    hashes: {
      rules_hash: hashFile(path.join(ROOT, "rules_el_alamein.json")),
      config_hash: sha256(config),
      agent_methods_hash: hashFile(path.join(ROOT, "ai/config/agent_methods.yaml")),
      agent_tools_hash: hashFile(path.join(ROOT, "ai/config/agent_tools.yaml")),
      models_hash: hashFile(path.join(ROOT, "ai/config/ai_models.yaml")),
      prompts_hash: hashFile(path.join(ROOT, "ai/prompt/prompts.yaml")),
      comparison_contract_hash: comparison.hash,
      prompt_registry_hash: comparison.contract.prompt_registry_hash
    }
  }, initialContext.publicContext.game_overview.initial_map_reference_2d);
  const contextManifests = Object.fromEntries(contextSides.map((side) => {
    if (side === (externalSide || externalSides[0])) return [side, contextManifest];
    const store = contextStores[side];
    return [side, store.initialize({
      scenario,
      external_side: side,
      controllers: { axis: controllers.axis, allies: controllers.allies },
      seed,
      replicate,
      decision_policy: decisionMode,
      harness: "manual_single_action",
      model_profile: modelProfile,
      tool_profile: toolProfile.id,
      comparison_contract_hash: comparison.hash,
      prompt_registry_hash: comparison.contract.prompt_registry_hash,
      rules_source: "rules_el_alamein.json",
      context_policy: CONTEXT_POLICY,
      hashes: {
        rules_hash: hashFile(path.join(ROOT, "rules_el_alamein.json")),
        config_hash: sha256(config),
        agent_methods_hash: hashFile(path.join(ROOT, "ai/config/agent_methods.yaml")),
        agent_tools_hash: hashFile(path.join(ROOT, "ai/config/agent_tools.yaml")),
        models_hash: hashFile(path.join(ROOT, "ai/config/ai_models.yaml")),
        prompts_hash: hashFile(path.join(ROOT, "ai/prompt/prompts.yaml")),
        comparison_contract_hash: comparison.hash,
        prompt_registry_hash: comparison.contract.prompt_registry_hash
      }
    }, buildContext(config, {
      scenario,
      phase: `${side}_initial_movement`,
      activeSide: side,
      decisionMode: "direct",
      includeInitialMap: true
    }).publicContext.game_overview.initial_map_reference_2d)];
  }));
  const replay = makeReplay(scenario, {
    seed,
    onStateChangeFilter: (event) => externalSides.includes(event.side),
    onStateChange: (event) => {
      // Rule-AI actions can be numerous and do not need an external-agent
      // recovery checkpoint. Persisting every full state for both controllers
      // makes JSONL serialization dominate long runs before the model acts.
      const changedSide = event.side || event.state?.active_side;
      if (!externalSides.includes(changedSide)) return;
      for (const store of Object.values(contextStores)) {
        store.snapshot({
          stage: event.stage,
          step: event.step,
          state: event.state,
          turn: event.turn,
          phase: event.phase,
          side: event.side || event.state?.active_side
        });
      }
    },
    onStateChangeError: (error, event) => {
      contextStoreErrors.push({ stage: event.stage || "state_change", step: event.step ?? null, error: error.message });
    }
  });
  const transcript = {
    generated_at: new Date().toISOString(),
    partial: true,
    experiment_id: experimentId,
    scenario,
    seed,
    replicate,
    external_side: externalSide,
    controllers: { axis: controllers.axis, allies: controllers.allies },
    axis_controller: controllers.axis,
    allies_controller: controllers.allies,
    rules_side: controllers.axis === "rules_ai" && controllers.allies === "external_ai" ? "axis" : controllers.allies === "rules_ai" && controllers.axis === "external_ai" ? "allies" : null,
    decision_mode: decisionMode,
    harness: "manual_single_action",
    harness_version: "manual-single-action-v1",
    agent_method: methodConfig.id,
    config_sources: {
      agent_methods: "ai/config/agent_methods.yaml",
      agent_tools: "ai/config/agent_tools.yaml",
      models: "ai/config/ai_models.yaml",
      prompts: "ai/prompt/prompts.yaml",
      side_prompts: Object.fromEntries(Object.keys(promptProfiles).map((side) => [side, `ai/prompt/${side}_prompts.yaml`]))
    },
    prompt_profile: promptProfile.profile,
    prompt_profile_hash: promptProfile.hash,
    prompt_profiles: Object.fromEntries(Object.entries(promptProfiles).map(([side, metadata]) => [side, {
      profile: metadata.profile,
      version: metadata.version,
      hash: metadata.hash
    }])),
    model_profile: modelProfile,
    model_runtime: publicRuntimeMetadata(runtime),
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
    context_profile: CONTEXT_PROFILE_ID,
    context_policy: CONTEXT_POLICY,
    tool_feedback_profile: TOOL_FEEDBACK_PROFILE,
    movement_phase_policy: "rule_complete",
    fixed_movement_action_limits: false,
    phase_unit_plan_protocol: null,
    rolling_unit_action_protocol: ["unit_plan_hybrid", "hierarchical_sae"].includes(decisionMode) ? "v1" : null,
    hierarchical_strategy_protocol: taskManagement ? "side-aware-goal-v2" : decisionMode === "hierarchical_sae" ? "sae-v1" : null,
    objective_resolution_version: taskManagement ? "objective-resolution-v3-open-goal" : decisionMode === "hierarchical_sae" ? "objective-resolution-v2" : null,
    adaptive_replanning_version: taskManagement ? "adaptive-replanning-v2-goal-events" : decisionMode === "hierarchical_sae" ? "adaptive-replanning-v1" : null,
    goal_management: taskManagement ? "open_grounded" : "disabled",
    goal_protocol: taskManagement ? "side-aware-goal-v2" : null,
    task_management: taskManagement ? "multi_task" : "disabled",
    task_protocol: taskManagement ? "side-aware-task-v2" : null,
    task_dependency_policy: taskManagement ? "hard_soft_conditional_v1" : null,
    task_switching: taskManagement ? "existing_tasks_only" : null,
    task_progress_version: taskManagement ? "evidence-grounded-model-task-progress-v6" : null,
    task_action_feedback_version: taskManagement ? "post-action-feedback-v1" : null,
    task_checker_model_profile: taskCheckerProfile || null,
    task_checker_runtime: taskChecker ? publicRuntimeMetadata(taskCheckerRuntimes[externalSide] || taskCheckerRuntimes[externalSides[0]]) : null,
    task_checker_runtimes: Object.fromEntries(Object.entries(taskCheckerRuntimes).map(([side, checkerRuntime]) => [side, publicRuntimeMetadata(checkerRuntime)])),
    strategic_planner_protocol: taskManagement ? "side-aware-goal-v2" : decisionMode === "hierarchical_sae" ? "sae-v1" : null,
    force_allocator_protocol: decisionMode === "hierarchical_sae" ? "sae-v1" : null,
    dispatch_protocol: decisionMode === "hierarchical_sae" ? "rolling-unit-action-v1" : null,
    movement_metrics_version: "movement-patterns-v2",
    prompt_registry_version: comparison.contract.prompt_registry_version,
    prompt_registry_hash: comparison.contract.prompt_registry_hash,
    harness_prompt_version: comparison.contract.harness_prompt_version,
    harness_prompt_hash: comparison.contract.harness_prompt_hash,
    allowed_tools: [...toolProfile.tools],
    model: {
      provider: profile.provider,
      model: profile.model,
      temperature: profile.defaults.temperature,
      max_tool_rounds: config.api.maxToolRounds,
      execution_tool_choice: EXECUTION_TOOL_CHOICE,
      execution_thinking_mode: runtime.profile.defaults.thinking,
      planning_thinking_mode: runtime.profile.defaults.thinking
    },
    model_transport: runtime.transport,
    model_transports: Object.fromEntries(Object.entries(runtimeBySide).map(([side, sideRuntime]) => [side, sideRuntime.transport])),
    task_checker_transport: taskChecker?.records || [],
    context_store: {
      directory: contextStore.directory,
      files: contextStore.files,
      manifest_hash: contextStore.hash(contextManifest),
      map_reference_hash: contextManifest.hashes.map_reference_hash,
      recovery_policy: "verify_manifest_map_rules_and_state_hashes_before_resume"
    },
    context_stores: Object.fromEntries(Object.entries(contextStores).map(([side, store]) => [side, {
      directory: store.directory,
      files: store.files,
      manifest_hash: store.hash(contextManifests[side]),
      map_reference_hash: contextManifests[side].hashes.map_reference_hash
    }])),
    context_store_errors: contextStoreErrors,
    transport_health: runtime.transport_health,
    model_usage: runtime.usage,
    model_steps: []
  };
  attachRuntimeAccounting(transcript, {
    ...Object.fromEntries(Object.entries(runtimeBySide).map(([side, value]) => [`${side}.agent`, value])),
    ...Object.fromEntries(Object.entries(taskCheckerRuntimes).map(([side, value]) => [`${side}.task_checker`, value]))
  });
  writeTranscript(outFile, transcript);
  const started = Date.now();
  try {
    const providerOptions = (side) => ({
      outFile,
      progress: true,
      decisionPolicy: decisionMode,
      toolProfile: toolProfile.id,
      timeoutMs: stepTimeoutMs,
      sessionId: `manual-${experimentId}-${side}`,
      bridge: createRuleBridge(config, { toolProfile: toolProfile.id }),
      taskChecker: taskCheckers[side] || null,
      contextStore: contextStores[side] || contextStore,
      contextManifest: contextManifests[side] || contextManifest,
      reasoningMemoryConfig: methodConfig.reasoning_memory || undefined
    });
    const externalProviders = Object.fromEntries(
      externalSides.map((side) => [side, makeSingleActionProvider(config, runtimeBySide[side] || runtime, transcript, providerOptions(side))])
    );
    // Keep one external provider for the legacy single-side path. With two
    // external controllers, the replay selects the provider by active side.
    const externalProvider = externalProviders[externalSide] || externalProviders[externalSides[0]] || null;
    const result = await replay.playWithProvider({
      maxSteps,
      controllers,
      externalAction: externalProvider,
      externalActions: externalProviders
    });
    transcript.elapsed_ms = Date.now() - started;
    transcript.partial = false;
    transcript.status = result.status;
    transcript.summary = replay.summary(result);
    const finalTaskSettlements = {};
    for (const [side, provider] of Object.entries(externalProviders)) {
      const finalTaskPlan = await provider.finalize({
        state: replay.state,
        turn: replay.state.turn,
        phase: replay.state.phase,
        side,
        step: result.steps,
        status: result.status,
        victory: result.victory || null
      });
      if (finalTaskPlan) {
        finalTaskSettlements[side] = {
          applied: true,
          protocol: finalTaskPlan.protocol,
          turn: replay.state.turn,
          phase: replay.state.phase,
          parent_state: finalTaskPlan.parent?.state || null,
          child_statuses: Object.fromEntries((finalTaskPlan.children || []).map((task) => [task.id, task.status]))
        };
      }
    }
    if (Object.keys(finalTaskSettlements).length) {
      transcript.final_task_settlement = externalSides.length > 1
        ? finalTaskSettlements
        : finalTaskSettlements[externalSides[0]];
    }
    const taskObservations = transcript.model_steps
      .filter((step) => step.task_observation)
      .map((step) => step.task_observation);
    const actionAttempts = transcript.model_steps.flatMap((step) => step.action_attempts || []);
    const rollingMovement = summarizeRollingMovementPhases(transcript.model_steps);
    const movementPatterns = summarizeMovementPatterns(result.log || [], "external_model", transcript.model_steps);
    const taskSwitches = [...new Map(taskObservations
      .flatMap((observation) => observation.plan?.task_switches || [])
      .map((item) => [`${item.from}:${item.to}:${item.step}:${item.reason}`, item])).values()];
    const taskChecks = taskObservations.map((observation) => observation.check?.result).filter(Boolean);
    const rollingMoveSteps = transcript.model_steps.filter((step) =>
      step.rolling_movement
      && ["move", "move_intent", "exit_west"].includes(step.rolling_unit_action?.selected_action?.type));
    transcript.counts = {
      external_actions: (result.log || []).filter((item) => item.source === "external_model").length,
      rules_actions: (result.log || []).filter((item) => item.controller === "rules_ai").length,
      heuristic_actions: (result.log || []).filter((item) => item.controller === "heuristic_ai").length,
      controller_actions: (result.log || []).reduce((counts, item) => {
        if (item.controller) counts[item.controller] = (counts[item.controller] || 0) + 1;
        return counts;
      }, {}),
      illegal_actions: (result.log || []).filter((item) => item.result && item.result.legal === false).length,
      fallback_actions: transcript.model_steps.filter((item) => item.fallback_used).length,
      network_fallback_actions: transcript.model_steps.filter((item) => item.fallback_reason_class === "transport_failure").length,
      transport_failures: transcript.model_steps.reduce((sum, step) => sum + (step.transport_failures?.length || 0), 0),
      recovered_transport_failures: transcript.model_steps.reduce((sum, step) => sum + (step.recovered_transport_failures?.length || 0), 0),
      protocol_failures: transcript.model_steps.reduce((sum, step) => sum + (step.protocol_failures?.length || 0), 0),
      circuit_open_events: runtime.transport_health?.circuit_open_events || 0,
      retry_attempts: runtime.transport.reduce((sum, item) => sum + Math.max(0, Number(item.attempts || 1) - 1), 0)
        + transcript.model_steps.reduce((sum, step) => sum + step.rounds.reduce((roundSum, round) => roundSum + Math.max(0, (round.attempts?.length || 1) - 1), 0), 0),
      model_tool_calls: transcript.model_steps.reduce((sum, step) => sum + step.rounds.filter((round) => round.tool_result).length, 0),
      sae_plan_calls: transcript.model_steps.reduce((sum, step) => sum + (step.sae_plan && !step.sae_plan.reused ? 2 : 0), 0),
      sae_plan_fallbacks: transcript.model_steps.reduce((sum, step) => sum + (step.sae_plan && !step.sae_plan.reused ? Number(step.sae_plan.strategic_fallback) + Number(step.sae_plan.allocation_fallback) : 0), 0),
      sae_replans: transcript.model_steps.filter((step) => step.sae_plan?.replanned && !step.sae_plan.reused).length,
      replan_reasons: transcript.model_steps.reduce((counts, step) => {
        const reason = step.sae_plan?.reused ? "" : step.sae_plan?.replan_reason;
        if (reason) counts[reason] = (counts[reason] || 0) + 1;
        return counts;
      }, {}),
      route_failure_attempts: transcript.model_steps.reduce((sum, step) => sum + step.action_attempts.filter((item) => /no legal path found/.test(item.reason || "")).length, 0),
      alternative_route_feedback: transcript.model_steps.reduce((sum, step) => sum + step.action_attempts.filter((item) => item.alternatives?.length).length, 0),
      map_tool_calls: transcript.model_steps.reduce((sum, step) => sum + step.rounds.filter((round) => round.tool_result?.tool === "view_map").length, 0),
      act_calls: transcript.model_steps.reduce((sum, step) => sum + step.action_attempts.length, 0),
      accepted_actions: transcript.model_steps.filter((step) => !step.fallback_used && !step.local_fast_pass).length,
      invalid_action_attempts: actionAttempts.filter((item) => !item.accepted).length,
      rule_invalid_action_attempts: actionAttempts.filter((item) => item.rejection_class === "rule_engine_rejection").length,
      transcript_probe_rejections: actionAttempts.filter((item) => item.rejection_class === "transcript_probe_rejection").length,
      policy_rejections: actionAttempts.filter((item) => item.rejection_class === "policy_rejection").length,
      strategic_warning_actions: actionAttempts.filter((item) => item.strategic_warnings?.length).length,
      supply_risk_warning_actions: actionAttempts.filter((item) => (item.strategic_warnings || []).some((warning) => String(warning).startsWith("supply_worsened:"))).length,
      cross_task_dispatch_actions: actionAttempts.filter((item) => (item.strategic_warnings || []).some((warning) => String(warning).startsWith("cross_task_dispatch"))).length,
      post_accept_tool_calls: 0,
      local_fast_pass_actions: transcript.model_steps.filter((step) => step.local_fast_pass).length,
      phase_status_calls: transcript.model_steps.reduce((sum, step) => sum + step.rounds.filter((round) => round.tool_result?.tool === "phase_status").length, 0),
      hold_unit_calls: transcript.model_steps.reduce((sum, step) => sum + step.rounds.filter((round) => round.tool_result?.tool === "hold_unit").length, 0),
      hold_units_calls: transcript.model_steps.reduce((sum, step) => sum + step.rounds.filter((round) => round.tool_result?.tool === "hold_units").length, 0),
      rolling_movement_phases: rollingMovement.phases,
      eligible_units_at_phase_start: rollingMovement.eligible,
      acted_units: rollingMovement.acted,
      held_units: rollingMovement.held,
      unavailable_units: rollingMovement.unavailable,
      omitted_units: 0,
      repaired_orders: 0,
      skipped_orders: 0,
      planned_actions_executed: rollingMoveSteps.length,
      planned_move_orders: rollingMoveSteps.length,
      rolling_actions: transcript.model_steps.filter((step) => step.rolling_movement && step.rolling_unit_action?.selected_action?.type !== "pass").length,
      movement_phase_completion_rate: rollingMovement.completion_rate,
      immediate_reversals: movementPatterns.immediate_reversals,
      repeated_destination_actions: movementPatterns.repeated_destination_actions,
      top_destination_hexes: movementPatterns.top_destination_hexes,
      top_three_destination_share: movementPatterns.top_three_destination_share,
      task_checker_calls: taskObservations.filter((item) => item.check && item.check.skipped !== true).length,
      task_checker_fallbacks: taskObservations.filter((item) => item.check?.fallback).length,
      task_checker_abstentions: taskObservations.filter((item) => item.check?.result?.abstain).length,
      task_checker_low_confidence: taskObservations.filter((item) => item.check?.result && Number(item.check.result.confidence || 0) < 0.5).length,
      task_checker_consistency_warnings: taskObservations.filter((item) => item.check?.consistency_warning).length,
      task_switches: taskSwitches.length,
      task_pause_requests: taskChecks.filter((check) => check.task_control === "pause").length,
      task_cancel_requests: taskChecks.filter((check) => check.task_control === "cancel").length,
      task_switch_requests: taskChecks.filter((check) => check.task_control === "switch" || check.switch_to).length,
      task_trigger_events: taskObservations.reduce((sum, item) => sum + (item.events?.length || 0), 0),
      task_blocked_events: taskObservations.filter((item) => item.events?.includes("route_blocked") || item.check?.result?.task_status === "blocked").length,
      task_completed_events: taskObservations.filter((item) => item.events?.includes("task_completed") || (item.check?.result?.task_status === "completed" && !item.check.result.abstain) || item.progress?.parent_completed).length,
      task_progress_observations: taskObservations.filter((item) => item.progress?.changed).length,
      task_action_feedback_records: taskObservations.filter((item) => item.action_feedback?.accepted).length,
      action_effect_records: transcript.model_steps.filter((step) => step.action_effect).length,
      meaningful_action_records: transcript.model_steps.filter((step) => step.action_effect?.accepted && (
        step.action_effect?.units && Object.values(step.action_effect.units).some((unit) => unit.position_changed || unit.supply_changed)
        || (step.action_effect?.combat_opportunities_gained || []).length
        || (step.action_effect?.applied_result?.eliminated || []).length
      )).length,
      tactical_opportunities_seen: transcript.model_steps.reduce((sum, step) => sum + (step.tactical_summary?.tactical_opportunities?.length || 0), 0),
      tactical_opportunities_selected: transcript.model_steps.filter((step) => step.action_effect?.combat_opportunities_gained?.length || step.task_observation?.events?.includes("combat_target_threat_reduced")).length,
      allocation_corrections: transcript.model_steps.reduce((sum, step) => sum + (step.force_allocation?.allocation_corrections?.length || 0), 0),
      next_intent_records: transcript.model_steps.filter((step) => step.next_intent).length,
      task_progress_rate: taskObservations.length
        ? Number((taskObservations.filter((item) => item.progress?.changed).length / taskObservations.length).toFixed(3)) : 0,
      task_blocked_rate: taskObservations.length
        ? Number((taskObservations.filter((item) => item.events?.includes("route_blocked") || item.check?.result?.task_status === "blocked").length / taskObservations.length).toFixed(3)) : 0,
      task_observations: taskObservations.length,
      task_replan_reasons: transcript.model_steps.reduce((counts, step) => {
        const reason = step.sae_plan?.replan_reason || "";
        if (reason.startsWith("task_")) counts[reason] = (counts[reason] || 0) + 1;
        return counts;
      }, {})
    };
    refreshRuntimeAccounting(transcript);
    transcript.sample_status = infrastructureStatus(transcript);
    if (decisionMode === "hierarchical_sae") {
      transcript.strategic_intent = transcript.model_steps.find((step) => step.strategic_intent)?.strategic_intent || null;
      transcript.goal_plan = [...transcript.model_steps].reverse().find((step) => step.goal_plan)?.goal_plan || null;
      transcript.goal_history = transcript.model_steps
        .filter((step) => step.goal_plan && step.sae_plan && !step.sae_plan.reused)
        .map((step) => ({ step: step.step, turn: step.turn, phase: step.phase, replan_reason: step.sae_plan.replan_reason || "initial", goal_plan: step.goal_plan }));
      transcript.force_allocation = transcript.model_steps.find((step) => step.force_allocation)?.force_allocation || null;
      const latestOperationState = [...transcript.model_steps].reverse().find((step) => step.operation_state)?.operation_state || null;
      const latestTaskSettlement = transcript.final_task_settlement;
      transcript.operation_state = latestOperationState;
      transcript.task_plan = [...transcript.model_steps].reverse().find((step) => step.sae_plan?.task_plan)?.sae_plan.task_plan
        || (latestTaskSettlement && externalSides.length === 1 ? latestTaskSettlement : null);
      transcript.sae_plan_calls = transcript.counts.sae_plan_calls;
      transcript.sae_plan_fallbacks = transcript.counts.sae_plan_fallbacks;
    }
    transcript.game_log = result.log;
    for (const store of Object.values(contextStores)) {
      store.snapshot({
        stage: "final",
        step: result.steps,
        state: replay.state,
        turn: replay.state.turn,
        phase: replay.state.phase,
        side: replay.state.active_side
      });
      store.updateMemory({
        recent_strategic_events: [{
          stage: "final",
          status: transcript.status,
          victory: transcript.summary?.victory || null
        }]
      });
    }
    writeTranscript(outFile, transcript, { force: true });
    console.log(JSON.stringify({
      output: outFile,
      experiment_id: experimentId,
      status: transcript.status,
      elapsed_ms: transcript.elapsed_ms,
      scenario,
      seed,
      external_side: externalSide,
      controllers: { axis: controllers.axis, allies: controllers.allies },
      decision_mode: decisionMode,
      model_profile: modelProfile,
      model: transcript.model.model,
      victory: transcript.summary.victory,
      counts: transcript.counts,
      usage: runtime.usage,
      usage_by_side: Object.fromEntries(Object.entries(runtimeBySide).map(([side, sideRuntime]) => [side, sideRuntime.usage])),
      tail: transcript.summary.tail
    }, null, 2));
    return transcript;
  }
  finally {
    if (typeof replay !== "undefined" && replay?.state) {
      for (const store of Object.values(contextStores)) {
        store.snapshot({ stage: "shutdown", step: transcript.model_steps.length, state: replay.state });
      }
    }
    for (const sideRuntime of new Set(Object.values(runtimeBySide))) await closeModelRuntime(sideRuntime);
    for (const checkerRuntime of Object.values(taskCheckerRuntimes)) await closeModelRuntime(checkerRuntime);
    writeTranscript(outFile, transcript, { force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  EXECUTION_TOOL_CHOICE,
  callModel,
  main,
  makeExternalProvider: makeSingleActionProvider,
  makeSingleActionProvider,
  summarizeMovementPatterns,
  summarizeRollingMovementPhases
};
