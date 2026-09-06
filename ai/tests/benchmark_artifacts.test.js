"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BENCHMARK_VERSION,
  compareArtifactManifests,
  createArtifactManifest,
  validateArtifactManifest
} = require("../core/benchmark_artifacts.js");
const {
  buildPairedResults,
  comparisonCellId,
  infrastructureStatus,
  validateComparisonRows
} = require("../core/benchmark_comparison.js");

function row(overrides = {}) {
  const manifest = createArtifactManifest("july", { includeGitMetadata: false });
  const contract = {
    version: "single-action-comparison-v14-benchmark-integrity",
    scenario: "july",
    external_side: "axis",
    controllers: { axis: "external_ai", allies: "rules_ai" },
    artifact_manifest: manifest,
    model_configuration: { identity: { profile_id: "mock_primary" }, defaults: { thinking: "disabled" } },
    max_steps: 1000,
    max_calls_per_step: 6,
    step_timeout_ms: 180000
  };
  return {
    experiment_id: "run",
    benchmark_version: BENCHMARK_VERSION,
    artifact_manifest_hash: manifest.artifact_manifest_hash,
    artifact_manifest: manifest,
    comparison_contract: contract,
    scenario: "july",
    external_side: "axis",
    controllers: { axis: "external_ai", allies: "rules_ai" },
    seed: 1942,
    replicate: 1,
    model_profile: "mock_primary",
    harness: "manual_single_action",
    decision_policy: "direct",
    tool_profile: "map_and_action",
    tool_config_hash: "tools-v1",
    context_profile: "compact-v1",
    prompt_profile_hash: "prompt-v1",
    harness_prompt_hash: "harness-v1",
    max_calls_per_step: 6,
    step_timeout_ms: 180000,
    task_management: "disabled",
    task_checker_model_profile: "",
    status: "final_victory",
    partial: false,
    summary: { victory: { final: true, victory_points: 25 } },
    ...overrides
  };
}

test("artifact manifest covers the fixed rules and scenario inputs", () => {
  const manifest = createArtifactManifest("july", { includeGitMetadata: false });
  assert.equal(manifest.benchmark_version, BENCHMARK_VERSION);
  assert.match(manifest.artifact_manifest_hash, /^[a-f0-9]{64}$/);
  assert.match(manifest.files.rule_engine.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.files.scenario.path, "scenarios/july.json");
  assert.equal(compareArtifactManifests([manifest, structuredClone(manifest)]).comparable, true);
  const changed = structuredClone(manifest);
  changed.artifact_manifest_hash = "different";
  assert.equal(compareArtifactManifests([manifest, changed]).comparable, false);
  assert.equal(validateArtifactManifest(manifest, manifest.artifact_manifest_hash), true);
  const tampered = structuredClone(manifest);
  tampered.files.replay.sha256 = "0".repeat(64);
  assert.equal(validateArtifactManifest(tampered, tampered.artifact_manifest_hash), false);
});

test("comparison validator accepts complete paired variants that used declared fallback", () => {
  const direct = row({ decision_policy: "direct" });
  const hybrid = row({ decision_policy: "hybrid", experiment_id: "hybrid" });
  assert.equal(validateComparisonRows([direct, hybrid], "method").valid, true);
  assert.equal(comparisonCellId(direct, "method"), comparisonCellId(hybrid, "method"));
  const affected = row({ decision_policy: "hybrid", sample_status: "infrastructure_affected" });
  const validation = validateComparisonRows([direct, affected], "method");
  assert.equal(validation.valid, true);
  assert.equal(validation.infrastructure_affected_rows, 1);
  assert.equal(validation.ranking_eligible_rows, 2);
  assert.equal(infrastructureStatus({ status: "harness_error" }), "harness_error");
  assert.equal(infrastructureStatus({ status: "step_limit", partial: true }), "partial");
});

test("comparison validator rejects missing artifacts and unpaired replicates", () => {
  const direct = row({ decision_policy: "direct" });
  const hybrid = row({ decision_policy: "hybrid", experiment_id: "hybrid", artifact_manifest_hash: "" });
  const result = validateComparisonRows([direct, hybrid], "method");
  assert.equal(result.valid, false);
  assert.match(result.reasons.join(";"), /artifact manifest/);
});

test("paired comparison reports seed/replicate VP differences and excludes degraded pairs", () => {
  const direct = row({ decision_policy: "direct", experiment_id: "direct-1942" });
  direct.final_vp = 20;
  direct.ranking_eligible = true;
  const hybrid = row({ decision_policy: "hybrid", experiment_id: "hybrid-1942" });
  hybrid.final_vp = 25;
  hybrid.ranking_eligible = true;
  const [pair] = buildPairedResults([direct, hybrid], "method");
  assert.equal(pair.baseline_variant, "direct");
  assert.equal(pair.comparisons[0].vp_difference, 5);
  assert.equal(pair.comparisons[0].ranking_eligible, true);

  hybrid.ranking_eligible = false;
  const [degradedPair] = buildPairedResults([direct, hybrid], "method");
  assert.equal(degradedPair.comparisons[0].vp_difference, null);
  assert.equal(degradedPair.comparisons[0].ranking_eligible, false);
  assert.match(degradedPair.comparisons[0].exclusion_reason, /ranking requirements|not ranking-eligible|not complete/);
});

test("paired comparison marks duplicate variant rows as unusable", () => {
  const direct = row({ decision_policy: "direct" });
  direct.final_vp = 20;
  const duplicate = row({ decision_policy: "direct", experiment_id: "duplicate" });
  duplicate.final_vp = 22;
  const hybrid = row({ decision_policy: "hybrid" });
  hybrid.final_vp = 25;
  const [pair] = buildPairedResults([direct, duplicate, hybrid], "method");
  assert.equal(pair.comparisons[0].vp_difference, null);
  assert.match(pair.comparisons[0].exclusion_reason, /duplicate/);
});

test("ranking rejects configuration drift and application-layer illegal actions", () => {
  const direct = row({ decision_policy: "direct", final_vp: 20 });
  const hybrid = row({ decision_policy: "hybrid", final_vp: 25, experiment_id: "hybrid" });
  hybrid.comparison_contract.model_configuration.defaults.thinking = "enabled";
  const validation = validateComparisonRows([direct, hybrid], "method");
  assert.equal(validation.valid, false);
  const [pair] = buildPairedResults([direct, hybrid], "method");
  assert.equal(pair.comparisons[0].vp_difference, null);
  assert.equal(validateComparisonRows([row({ counts: { illegal_actions: 1 } }), row({ decision_policy: "hybrid" })], "method").valid, false);
});
