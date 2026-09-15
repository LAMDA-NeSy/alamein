"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { auditTranscript } = require("../experiments/audit_experiment_logs.js");
const { createArtifactManifest } = require("../core/benchmark_artifacts.js");
const { comparisonContractHash, COMPARISON_CONTRACT_VERSION } = require("../core/comparison_contract.js");

function makeTranscript() {
  const artifact = createArtifactManifest("july", { includeGitMetadata: false });
  const contract = {
    version: COMPARISON_CONTRACT_VERSION, benchmark_version: artifact.benchmark_version,
    scenario: "july", external_side: "axis", controllers: { axis: "external_ai", allies: "rules_ai" },
    artifact_manifest_hash: artifact.artifact_manifest_hash,
    model_configuration: { identity: { profile_id: "mock_primary" }, defaults: { thinking: "omitted" } },
    max_steps: 1000, max_calls_per_step: 6, step_timeout_ms: 180000,
    model_profile: "mock_primary", tool_profile: "map_and_action", tool_config_hash: "tools-v1",
    context_profile: "compact_current_state_v1", prompt_profile_hash: "prompt-v1", harness_prompt_hash: "prompt-v1"
  };
  return {
    experiment_id: "audit", scenario: "july", external_side: "axis", seed: 1942, replicate: 1,
    status: "final_victory", summary: { victory: { final: true, victory_points: 30 } },
    controllers: { axis: "external_ai", allies: "rules_ai" }, axis_controller: "external_ai", allies_controller: "rules_ai",
    harness: "manual_single_action", decision_mode: "direct", model_profile: "mock_primary",
    tool_profile: "map_and_action", tool_config_hash: "tools-v1", context_profile: "compact_current_state_v1",
    prompt_profile_hash: "prompt-v1", harness_prompt_hash: "prompt-v1", benchmark_version: artifact.benchmark_version,
    artifact_manifest: artifact, artifact_manifest_hash: artifact.artifact_manifest_hash,
    comparison_contract: contract, comparison_contract_hash: comparisonContractHash(contract),
    counts: { accounting_protocol: "action-ledger-v2", external_actions: 1, rules_actions: 0, illegal_actions: 0, fallback_actions: 0,
      model_submitted_actions: 1, model_accepted_actions: 1, model_rejected_actions: 0, act_calls: 0, accepted_actions: 1 },
    model_steps: [{ step: 1, action_attempts: [{ event_id: "a1", model_submitted: true,
      accepted: true, action: { type: "move" } }] }],
    game_log: [{ source: "external_model", controller: "external_ai", action: { type: "move" }, result: { legal: true } }]
  };
}

test("log audit derives scoring counts and separates ranking status", () => {
  const result = auditTranscript(makeTranscript());
  assert.equal(result.usable_for_scoring, true);
  assert.equal(result.final_vp, 30);
  assert.equal(result.derived.model_submitted_actions, 1);
  assert.equal(result.ranking_eligible, true);
});

test("log audit catches a recorded count mismatch", () => {
  const run = makeTranscript();
  run.counts.accepted_actions = 9;
  const result = auditTranscript(run);
  assert.equal(result.usable_for_scoring, false);
  assert.ok(result.issues.some((item) => item.code === "count_mismatch" && item.detail.field === "accepted_actions"));
});
