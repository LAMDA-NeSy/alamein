"use strict";

const crypto = require("node:crypto");
const { TOOL_CATALOG_VERSION } = require("./agent_tools.js");
const { promptRegistryMetadata, sidePromptRegistryMetadata } = require("./prompt_registry.js");
const { createHarnessPromptContract } = require("./harness_prompt_contract.js");
const { resolveControllers } = require("./controller_config.js");
const { artifactContractFields, createArtifactManifest } = require("./benchmark_artifacts.js");
const { modelContractConfiguration, resolveModel } = require("./model_runtime.js");

const COMPARISON_CONTRACT_VERSION = "single-action-comparison-v19-typed-task-settlement";

function defaultMaxStepsForScenario(scenario) {
  return { july: 1000, september: 1500, october: 3000 }[scenario] || 1000;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function comparisonContractHash(contract) {
  if (!contract || typeof contract !== "object") return "";
  const contractForHash = structuredClone(contract);
  delete contractForHash.seed;
  delete contractForHash.replicate;
  return crypto.createHash("sha256").update(stableJson(contractForHash)).digest("hex");
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
  maxSteps = defaultMaxStepsForScenario(scenario),
  toolChoice = "auto",
  thinkingMode,
  planningThinkingMode,
  unitPlanSettings = {},
  taskManagement = null,
  taskCheckerProfile = null
}) {
  unitPlanSettings = unitPlanSettings || {};
  const promptRegistry = promptRegistryMetadata();
  const artifactManifest = createArtifactManifest(scenario);
  const resolvedControllers = resolveControllers({ controllers, externalSide });
  const promptSide = resolvedControllers.external_side || externalSide || "axis";
  const promptProfile = sidePromptRegistryMetadata(promptSide);
  const externalPromptSides = ["axis", "allies"]
    .filter((side) => resolvedControllers[side] === "external_ai");
  const taskConfiguration = taskManagement
    ? {
        ...(config.task_management_options || {}),
        ...(taskCheckerProfile ? { checker_model_profile: taskCheckerProfile } : {})
      }
    : null;
  const promptProfiles = Object.fromEntries(
    (externalPromptSides.length ? externalPromptSides : [promptSide])
      .map((side) => {
        const metadata = sidePromptRegistryMetadata(side);
        return [side, { profile: metadata.profile, version: metadata.version, hash: metadata.hash }];
      })
  );
  const harnessPrompt = createHarnessPromptContract(toolProfile.tools, promptProfile.side);
  const contract = {
    version: COMPARISON_CONTRACT_VERSION,
    json_normalization_protocol: "unambiguous-envelope-v1",
    deadline_protocol: "absolute-deadline-post-response-v1",
    task_acceptance_protocol: "independent-condition-evidence-v2",
    tool_argument_contract: "canonical-tool-arguments-v2",
    scenario,
    ...artifactContractFields(artifactManifest),
    artifact_manifest: {
      manifest_schema: artifactManifest.manifest_schema,
      benchmark_version: artifactManifest.benchmark_version,
      scenario: artifactManifest.scenario,
      files: artifactManifest.files
    },
    source_control: artifactManifest.source_control,
    external_side: resolvedControllers.external_side || externalSide || null,
    prompt_profile: promptProfile.profile,
    prompt_profile_hash: promptProfile.hash,
    prompt_profiles: promptProfiles,
    side_goal_protocol: taskManagement ? "side-aware-goal-v2" : null,
    side_task_protocol: taskManagement ? config.task_management_options?.protocol || config.task_management_options?.task_protocol || "side-aware-task-v4" : null,
    controllers: { axis: resolvedControllers.axis, allies: resolvedControllers.allies },
    axis_controller: resolvedControllers.axis,
    allies_controller: resolvedControllers.allies,
    seed: Number(seed),
    replicate: Number(replicate),
    decision_policy: decisionPolicy,
    execution_ledger: decisionPolicy === "hierarchical_sae" && unitPlanSettings.execution_ledger === true,
    phase_repair_policy: unitPlanSettings.repair_policy || "per_order",
    phase_repair_timeout_ms: unitPlanSettings.phase_repair_timeout_ms || null,
    model_tool_budget_scope: unitPlanSettings.execution_ledger ? "model_initiated_only" : "all_bridge_calls",
    unit_plan_execution_version: ["hierarchical_sae", "unit_plan_hybrid"].includes(decisionPolicy)
      ? "scenario-grounded-exit-and-route-reuse-v3" : null,
    unit_plan_search: ["hierarchical_sae", "unit_plan_hybrid"].includes(decisionPolicy) ? {
      kind: "bounded_engine_validated_recommendations",
      max_recommendation_expansions: Number(unitPlanSettings.max_recommendation_expansions || 32),
      max_evaluated_options_per_unit: Number(unitPlanSettings.max_evaluated_options_per_unit || 12)
    } : null,
    tool_profile: toolProfile.id,
    tool_profile_version: toolProfile.version,
    tool_config_hash: toolConfigHash,
    tool_catalog_version: TOOL_CATALOG_VERSION,
    rule_bridge_version: "rolling-unit-bookkeeping-v5-phase-plan",
    scoring_context_version: "scenario-scoring-v4-grounded-metrics",
    opportunity_filter_version: "intent-backfill-v1",
    movement_supply_projection_version: "post-move-supply-v1",
    non_retryable_4xx_policy: "immediate-step-fallback-v1",
    provider_exception_policy: "method-opt-in-classified-recovery-v1",
    task_coordinate_policy: "on-map-targets-only-v1",
    consecutive_transport_failure_round_limit: 2,
    transport_fallback_ranking_policy: "complete-game-method-fallback-v1",
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
    frontier_breakthrough_protocol: taskManagement ? "dynamic-frontier-breakthrough-v2-max-reach" : null,
    axis_breakthrough_checkpoint_policy: taskManagement ? "overshoot-completes-crossed-checkpoints-v1" : null,
    axis_dynamic_spearhead_policy: taskManagement ? "global-rule-verified-top3-v1" : null,
    max_calls_per_step: toolProfile.max_calls_per_step,
    parallel_tool_calls: false,
    execution_tool_choice: String(toolChoice),
    execution_tool_choice_protocol: "application-validated-auto-v1",
    execution_thinking_mode: String(thinkingMode ?? runtime.profile.defaults.thinking),
    planning_thinking_mode: String(planningThinkingMode ?? runtime.profile.defaults.thinking),
    objective_resolution_version: taskManagement ? "objective-resolution-v3-open-goal" : decisionPolicy === "hierarchical_sae" ? "objective-resolution-v2" : null,
    adaptive_replanning_version: taskManagement ? "adaptive-replanning-v2-goal-events" : decisionPolicy === "hierarchical_sae" ? "adaptive-replanning-v1" : null,
    stop_on_accepted: toolProfile.stop_on_accepted,
    movement_phase_policy: "rule_complete",
    combat_phase_policy: "combat_experiment_budget",
    fixed_movement_action_limits: false,
    phase_unit_plan_protocol: ["unit_plan_hybrid", "hierarchical_sae"].includes(decisionPolicy) ? "phase-unit-plan-v2" : null,
    rolling_unit_action_protocol: ["unit_plan_hybrid", "hierarchical_sae"].includes(decisionPolicy) ? "v2" : null,
    rolling_unit_settings: ["unit_plan_hybrid", "hierarchical_sae"].includes(decisionPolicy) ? {
      phase_status_first: true,
      explicit_hold_tool: true,
      phase_status_authoritative_for_pass: true,
      planning_mode: "phase_batch",
      execution_order: "phase_plan_priority",
      revalidate_each_action: true,
      accepted_actions_per_replay_step: 1,
      max_stagnant_actions: Number(unitPlanSettings.max_stagnant_actions || 25)
    } : null,
    hierarchical_strategy_protocol: taskManagement ? "side-aware-goal-v2" : decisionPolicy === "hierarchical_sae" ? "sae-v1" : null,
    strategic_planner_protocol: taskManagement ? "side-aware-goal-v2" : decisionPolicy === "hierarchical_sae" ? "sae-v1" : null,
    goal_management: taskManagement ? "open_grounded" : "disabled",
    goal_protocol: taskManagement ? "side-aware-goal-v2" : null,
    force_allocator_protocol: decisionPolicy === "hierarchical_sae" ? "sae-v1" : null,
    dispatch_protocol: ["unit_plan_hybrid", "hierarchical_sae"].includes(decisionPolicy) ? "rolling-unit-action-v2" : null,
    operation_state_version: taskManagement ? "sae-operation-v2" : decisionPolicy === "hierarchical_sae" ? "sae-operation-v1" : null,
    task_management: taskManagement ? "multi_task" : "disabled",
    task_protocol: taskManagement ? config.task_management_options?.protocol || config.task_management_options?.task_protocol || "side-aware-task-v4" : null,
    task_generation: taskManagement ? String(config.task_management_options?.task_generation || "fixed_skeleton") : null,
    task_dependency_policy: taskManagement ? String(config.task_management_options?.dependency_policy || "hard_soft_conditional_v1") : null,
    task_switching: taskManagement ? String(config.task_management_options?.task_switching || "existing_tasks_only") : null,
    task_progress_version: taskManagement ? "evidence-grounded-model-task-progress-v8-observable-criteria" : null,
    strategic_review_mode: decisionPolicy === "hierarchical_sae" ? "advisory" : null,
    route_feasibility: taskManagement ? {
      budget_ms: Number(config.task_management_options?.route_feasibility_budget_ms || 2000),
      scope: String(config.task_management_options?.route_feasibility_scope || "task_units_only")
    } : null,
    task_action_feedback_version: taskManagement ? "post-action-feedback-v1" : null,
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
    task_configuration: taskConfiguration,
    task_checker_configuration: taskCheckerProfile ? modelContractConfiguration(resolveModel(taskCheckerProfile)) : null,
    step_timeout_ms: Number(timeoutMs),
    max_steps: Number(maxSteps),
    model_profile: runtime.profile.profile_id,
    model_configuration: modelContractConfiguration(runtime.profile),
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
    reasoning_memory_protocol: decisionPolicy === "hierarchical_sae"
      ? "reasoning-memory-v1" : null,
    reasoning_memory_policy: decisionPolicy === "hierarchical_sae"
      ? (config.context?.reasoning_memory || null) : null,
    prompt_registry_version: promptRegistry.version,
    prompt_registry_hash: promptRegistry.hash,
    harness_prompt_version: harnessPrompt.version,
    harness_prompt_hash: harnessPrompt.hash,
    policy_config: {
      api: { maxTokens: config.api?.maxTokens ?? null, maxToolRounds: config.api?.maxToolRounds ?? null },
      context: config.context || {},
      strategy: config.strategy || {},
      performance: config.performance || {}
    }
  };
  // A comparison contract describes the controlled conditions. The sample
  // identity (seed/replicate) remains in the recorded contract, but must not
  // split otherwise identical repeated samples into different contract
  // groups.
  const hash = comparisonContractHash(contract);
  return { contract, hash };
}

module.exports = { COMPARISON_CONTRACT_VERSION, comparisonContractHash, createComparisonContract, stableJson };
