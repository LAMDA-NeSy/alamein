"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { readConfig } = require("../experiments/external_ai_transcript.js");
const { resolveToolProfile, toolProfileHash } = require("../core/agent_tools.js");
const { createModelRuntime, closeModelRuntime } = require("../core/model_runtime.js");
const { createComparisonContract } = require("../core/comparison_contract.js");

test("comparison contract is harness-independent but changes when a controlled factor changes", () => {
  const runtime = createModelRuntime("mock_primary", { run_id: "comparison-test" });
  try {
    const toolProfile = resolveToolProfile("single_action");
    const common = {
      config: readConfig(),
      scenario: "july",
      externalSide: "axis",
      seed: 1942,
      replicate: 1,
      decisionPolicy: "direct",
      toolProfile,
      toolConfigHash: toolProfileHash(toolProfile),
      runtime,
      contextProfile: "compact_current_state_v1",
      timeoutMs: 180000,
      toolChoice: "auto",
      thinkingMode: "omitted",
      planningThinkingMode: "disabled"
    };
    const first = createComparisonContract(common);
    const second = createComparisonContract({ ...common });
    const changed = createComparisonContract({ ...common, decisionPolicy: "candidates" });
    const changedContext = createComparisonContract({ ...common, contextProfile: "full_public_payload_v1" });
    const differentSample = createComparisonContract({ ...common, seed: 1943, replicate: 2 });
    assert.equal(first.hash, second.hash);
    assert.equal(first.hash, differentSample.hash);
    assert.notEqual(first.hash, changed.hash);
    assert.notEqual(first.hash, changedContext.hash);
    assert.equal(first.contract.seed, 1942);
    assert.equal(first.contract.replicate, 1);
    assert.equal(differentSample.contract.seed, 1943);
    assert.equal(differentSample.contract.replicate, 2);
    assert.equal(first.contract.context_profile, "compact_current_state_v1");
    assert.equal(first.contract.prompt_registry_version, 1);
    assert.match(first.contract.prompt_registry_hash, /^[a-f0-9]{64}$/);
    assert.equal(first.contract.harness_prompt_version, "harness-prompt-v2-side-aware");
    assert.match(first.contract.harness_prompt_hash, /^[a-f0-9]{64}$/);
    assert.equal(first.contract.version, "single-action-comparison-v14-benchmark-integrity");
    assert.equal(first.contract.scoring_context_version, "scenario-scoring-v3");
    assert.equal(first.contract.opportunity_filter_version, "intent-backfill-v1");
    assert.equal(first.contract.movement_supply_projection_version, "post-move-supply-v1");
    assert.equal(first.contract.non_retryable_4xx_policy, "immediate-step-fallback-v1");
    assert.equal(first.contract.execution_tool_choice, "auto");
    assert.equal(first.contract.execution_thinking_mode, "omitted");
    assert.equal(first.contract.execution_tool_choice_protocol, "application-validated-auto-v1");
    assert.equal(first.contract.movement_phase_policy, "rule_complete");
    assert.equal(first.contract.fixed_movement_action_limits, false);
    assert.equal(first.contract.tool_argument_contract, "canonical-tool-arguments-v2");
    assert.equal(first.contract.rule_bridge_version, "rolling-unit-bookkeeping-v4-batch-hold");
    assert.equal(first.contract.movement_metrics_version, "movement-patterns-v2");
    assert.equal(first.contract.transport_policy.request_timeout_ms, runtime.profile.defaults.timeout_ms);
    assert.equal(first.contract.transport_policy.step_fallback_reserve_ms, 0);
    assert.equal(first.contract.max_steps, 1000);
    assert.ok(first.contract.model_configuration.defaults);
    assert.ok(first.contract.source_control);
    assert.equal(Object.hasOwn(first.contract, "harness"), false);
    const sae = createComparisonContract({ ...common, decisionPolicy: "hierarchical_sae", toolProfile: resolveToolProfile("rolling_unit_tactical"), toolConfigHash: toolProfileHash(resolveToolProfile("rolling_unit_tactical")) });
    assert.equal(sae.contract.version, "single-action-comparison-v14-benchmark-integrity");
    assert.equal(sae.contract.planning_thinking_mode, "disabled");
    assert.equal(sae.contract.objective_resolution_version, "objective-resolution-v2");
    assert.equal(sae.contract.adaptive_replanning_version, "adaptive-replanning-v1");
    assert.equal(sae.contract.hierarchical_strategy_protocol, "sae-v1");
    assert.equal(sae.contract.operation_state_version, "sae-operation-v1");
    const taskSae = createComparisonContract({
      ...common,
      decisionPolicy: "hierarchical_sae",
      toolProfile: resolveToolProfile("rolling_unit_tactical"),
      toolConfigHash: toolProfileHash(resolveToolProfile("rolling_unit_tactical")),
      taskManagement: "side-aware-task-v2",
      taskCheckerProfile: "mock_secondary"
    });
    assert.equal(taskSae.contract.version, "single-action-comparison-v14-benchmark-integrity");
    assert.equal(taskSae.contract.transport_fallback_ranking_policy, "complete-game-method-fallback-v1");
    assert.equal(taskSae.contract.strategic_combat_guard_version, "allied-threat-aware-odds-v2");
    assert.equal(taskSae.contract.supply_assignment_grounding_version, "executable-supply-v1");
    assert.equal(taskSae.contract.task_management, "multi_task");
    assert.equal(taskSae.contract.task_protocol, "side-aware-task-v2");
    assert.equal(taskSae.contract.reasoning_memory_protocol, "reasoning-memory-v1");
    assert.equal(taskSae.contract.reasoning_memory_policy.within_step, "full");
  assert.equal(taskSae.contract.task_checker_model_profile, "mock_secondary");
    assert.equal(taskSae.contract.task_progress_version, "evidence-grounded-model-task-progress-v6");
    assert.equal(taskSae.contract.strategic_movement_guard_version, "goal-grounded-movement-v1");
    assert.equal(taskSae.contract.movement_memory_size, 4);
    assert.equal(taskSae.contract.task_checker_timing, "filtered-next-state-evidence-v2");
    assert.equal(taskSae.contract.frontier_breakthrough_protocol, "dynamic-frontier-breakthrough-v2-max-reach");
    assert.equal(taskSae.contract.axis_breakthrough_checkpoint_policy, "overshoot-completes-crossed-checkpoints-v1");
    assert.equal(taskSae.contract.axis_dynamic_spearhead_policy, "global-rule-verified-top3-v1");
    assert.equal(taskSae.contract.task_replan_policy.no_progress_threshold, 3);
    assert.notEqual(taskSae.hash, sae.hash);
    assert.notEqual(sae.hash, first.hash);
  }
  finally {
    closeModelRuntime(runtime);
  }
});

test("comparison contract records both player controllers", () => {
  const runtime = createModelRuntime("mock_primary", { run_id: "controller-contract-test" });
  try {
    const toolProfile = resolveToolProfile("single_action");
    const result = createComparisonContract({
      config: readConfig(),
      scenario: "july",
      controllers: { axis: "heuristic_ai", allies: "rules_ai" },
      seed: 1942,
      replicate: 1,
      decisionPolicy: "direct",
      toolProfile,
      toolConfigHash: toolProfileHash(toolProfile),
      runtime
    });
    assert.deepEqual(result.contract.controllers, { axis: "heuristic_ai", allies: "rules_ai" });
    assert.equal(result.contract.axis_controller, "heuristic_ai");
    assert.equal(result.contract.allies_controller, "rules_ai");
    assert.equal(result.contract.external_side, null);
  }
  finally {
    closeModelRuntime(runtime);
  }
});
