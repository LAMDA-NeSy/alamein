"use strict";

const crypto = require("node:crypto");
const { TOOL_CATALOG_VERSION } = require("./agent_tools.js");
const { promptRegistryMetadata, sidePromptRegistryMetadata } = require("./prompt_registry.js");
const { createHarnessPromptContract } = require("./harness_prompt_contract.js");
const { resolveControllers } = require("./controller_config.js");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function createComparisonContract({
  config,
  scenario,
  externalSide,
  controllers,
  seed,
  replicate = 1,
  decisionPolicy,
  toolProfile,
  toolConfigHash,
  runtime,
  contextProfile = "full_public_payload_v1",
  timeoutMs = 180000,
  toolChoice = "auto",
  thinkingMode = "default",
  planningThinkingMode = "default",
  unitPlanSettings = {},
  taskManagement = null,
  taskCheckerProfile = null
}) {
  const promptRegistry = promptRegistryMetadata();
  const resolvedControllers = resolveControllers({ controllers, externalSide });
  const promptSide = resolvedControllers.external_side || externalSide || "axis";
  const promptProfile = sidePromptRegistryMetadata(promptSide);
  const harnessPrompt = createHarnessPromptContract(toolProfile.tools, promptProfile.side);
  const contract = {
    version: "single-action-comparison-v10-allied-layered-defense",
    tool_argument_contract: "canonical-tool-arguments-v2",
    scenario,
    external_side: resolvedControllers.external_side || externalSide || null,
    prompt_profile: promptProfile.profile,
    prompt_profile_hash: promptProfile.hash,
    side_goal_protocol: taskManagement ? "side-aware-goal-v2" : null,
    side_task_protocol: taskManagement ? "side-aware-task-v2" : null,
    controllers: { axis: resolvedControllers.axis, allies: resolvedControllers.allies },
    axis_controller: resolvedControllers.axis,
    allies_controller: resolvedControllers.allies,
    seed: Number(seed),
    replicate: Number(replicate),
    decision_policy: decisionPolicy,
    tool_profile: toolProfile.id,
    tool_profile_version: toolProfile.version,
    tool_config_hash: toolConfigHash,
    tool_catalog_version: TOOL_CATALOG_VERSION,
    rule_bridge_version: "rolling-unit-bookkeeping-v4-batch-hold",
    scoring_context_version: "scenario-scoring-v3",
    opportunity_filter_version: "intent-backfill-v1",
    movement_supply_projection_version: "post-move-supply-v1",
    non_retryable_4xx_policy: "immediate-step-fallback-v1",
    consecutive_transport_failure_round_limit: 2,
    movement_metrics_version: "movement-patterns-v2",
    strategic_movement_guard_version: taskManagement ? "goal-grounded-movement-v1" : null,
    strategic_combat_guard_version: taskManagement ? "allied-threat-aware-odds-v2" : null,
    voluntary_combat_pass_policy: taskManagement ? "combat-pass-without-unit-holds-v1" : null,
    model_combat_subset_policy: taskManagement ? "rule-validated-open-subset-v1" : null,
    supply_assignment_grounding_version: taskManagement ? "executable-supply-v1" : null,
    supply_coverage_projection_version: taskManagement ? "combat-coverage-delta-v1" : null,
    rejection_feedback_version: taskManagement ? "phase-memory-typed-alternatives-v2" : null,
    repeated_rejection_policy: taskManagement ? "unchanged-state-retry-block-v2" : null,
    movement_memory_size: taskManagement ? 4 : null,
    immediate_reversal_policy: taskManagement ? "reject_without_vp_supply_zoc_or_stack_repair_benefit" : null,
    scoring_frontier_supply_policy: taskManagement ? "spearhead_must_project_scoring_eligible_supply" : null,
    frontier_breakthrough_protocol: taskManagement ? "dynamic-frontier-breakthrough-v1" : null,
    max_calls_per_step: toolProfile.max_calls_per_step,
    parallel_tool_calls: false,
    execution_tool_choice: String(toolChoice),
    execution_tool_choice_protocol: "application-validated-auto-v1",
    execution_thinking_mode: String(thinkingMode),
    planning_thinking_mode: String(planningThinkingMode),
    objective_resolution_version: taskManagement ? "objective-resolution-v3-open-goal" : decisionPolicy === "hierarchical_sae" ? "objective-resolution-v2" : null,
    adaptive_replanning_version: taskManagement ? "adaptive-replanning-v2-goal-events" : decisionPolicy === "hierarchical_sae" ? "adaptive-replanning-v1" : null,
    stop_on_accepted: toolProfile.stop_on_accepted,
    movement_phase_policy: "rule_complete",
    fixed_movement_action_limits: false,
    phase_unit_plan_protocol: null,
    rolling_unit_action_protocol: ["unit_plan_hybrid", "hierarchical_sae"].includes(decisionPolicy) ? "v1" : null,
    rolling_unit_settings: ["unit_plan_hybrid", "hierarchical_sae"].includes(decisionPolicy) ? {
      phase_status_first: true,
      explicit_hold_tool: true,
      phase_status_authoritative_for_pass: true,
      execution_order: "model_tool_call_order",
      accepted_actions_per_replay_step: 1
    } : null,
    hierarchical_strategy_protocol: taskManagement ? "side-aware-goal-v2" : decisionPolicy === "hierarchical_sae" ? "sae-v1" : null,
    strategic_planner_protocol: taskManagement ? "side-aware-goal-v2" : decisionPolicy === "hierarchical_sae" ? "sae-v1" : null,
    goal_management: taskManagement ? "open_grounded" : "disabled",
    goal_protocol: taskManagement ? "side-aware-goal-v2" : null,
    force_allocator_protocol: decisionPolicy === "hierarchical_sae" ? "sae-v1" : null,
    dispatch_protocol: decisionPolicy === "hierarchical_sae" ? "rolling-unit-action-v1" : null,
    operation_state_version: taskManagement ? "sae-operation-v2" : decisionPolicy === "hierarchical_sae" ? "sae-operation-v1" : null,
    task_management: taskManagement ? "multi_task" : "disabled",
    task_protocol: taskManagement ? "side-aware-task-v2" : null,
    task_progress_version: taskManagement ? "combined-goal-task-progress-v5" : null,
    task_checker_timing: taskManagement ? "filtered-next-state-evidence-v2" : null,
    task_replan_policy: taskManagement ? {
      no_progress_threshold: Number(config.task_management_options?.no_progress_replan_threshold || 3),
      blocked_threshold: Number(config.task_management_options?.blocked_replan_threshold || 2),
      supply_worsened_threshold: Number(config.task_management_options?.supply_worsened_replan_threshold || 2),
      low_odds_threshold: Number(config.task_management_options?.low_odds_replan_threshold || 2),
      passive_hold_threshold: Number(config.task_management_options?.passive_hold_replan_threshold || 3),
      cooldown_actions: Number(config.task_management_options?.replan_cooldown_actions || 3)
    } : null,
    task_checker_model_profile: taskCheckerProfile || null,
    step_timeout_ms: Number(timeoutMs),
    model_profile: runtime.profile.profile_id,
    model: runtime.profile.model,
    billing_channel: runtime.profile.access?.billing_channel || "metered_api",
    context_limit: runtime.profile.limits.context,
    output_limit: runtime.profile.limits.output,
    transport_policy: {
      request_timeout_ms: runtime.profile.defaults.timeout_ms,
      retries: runtime.profile.defaults.retries,
      retry_statuses: runtime.profile.defaults.retry_statuses,
      retry_delays_ms: runtime.profile.defaults.retry_delays_ms,
      circuit_breaker_failures: runtime.profile.defaults.circuit_breaker_failures,
      circuit_breaker_cooldown_ms: runtime.profile.defaults.circuit_breaker_cooldown_ms,
      step_fallback_reserve_ms: Math.max(0, Number(config.transport?.stepFallbackReserveMs ?? 0))
    },
    context_profile: contextProfile,
    prompt_registry_version: promptRegistry.version,
    prompt_registry_hash: promptRegistry.hash,
    harness_prompt_version: harnessPrompt.version,
    harness_prompt_hash: harnessPrompt.hash,
    policy_config: {
      context: config.context || {},
      strategy: config.strategy || {}
    }
  };
  const hash = crypto.createHash("sha256").update(stableJson(contract)).digest("hex");
  return { contract, hash };
}

module.exports = { createComparisonContract, stableJson };
