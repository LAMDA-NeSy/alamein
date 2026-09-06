"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { oddsBelowTwoToOne, summarizeTranscripts } = require("../experiments/summarize_ai_experiments.js");
const { createArtifactManifest } = require("../core/benchmark_artifacts.js");

const TEST_MANIFEST = createArtifactManifest("july", { includeGitMetadata: false });

function transcript(harness, harnessPromptHash) {
  return {
    experiment_id: `${harness}-test`,
    scenario: "july",
    external_side: "axis",
    controllers: { axis: "external_ai", allies: "rules_ai" },
    seed: 1942,
    replicate: 1,
    harness,
    decision_mode: "direct",
    model_profile: "mock_primary",
    benchmark_version: "alamein-benchmark-v1",
    artifact_manifest_hash: TEST_MANIFEST.artifact_manifest_hash,
    artifact_manifest: TEST_MANIFEST,
    tool_profile: "map_and_action",
    tool_config_hash: "tools-v1",
    comparison_contract_hash: "shared-contract",
    prompt_profile_hash: harnessPromptHash,
    comparison_contract: {
      version: "single-action-comparison-v14-benchmark-integrity",
      scenario: "july",
      external_side: "axis",
      controllers: { axis: "external_ai", allies: "rules_ai" },
      artifact_manifest: TEST_MANIFEST,
      model_configuration: { identity: { profile_id: "mock_primary" }, defaults: { thinking: "disabled" } },
      max_steps: 1000,
      max_calls_per_step: 6,
      step_timeout_ms: 180000,
      model_profile: "mock_primary",
      tool_profile: "map_and_action",
      tool_config_hash: "tools-v1",
      context_profile: "compact_current_state_v1",
      prompt_profile_hash: harnessPromptHash,
      harness_prompt_hash: harnessPromptHash
    },
    harness_prompt_hash: harnessPromptHash,
    context_profile: "compact_current_state_v1",
    status: "final_victory",
    summary: { victory: { final: true, victory_points: 25 } },
    model_steps: [],
    counts: {}
  };
}

test("summary allows harness comparison only with one shared prompt hash", () => {
  const summary = summarizeTranscripts([
    transcript("opencode", "prompt-v1"),
    transcript("langgraph", "prompt-v1")
  ]);
  const [group] = summary.comparison_groups;
  assert.equal(group.comparable_harnesses, true);
  assert.deepEqual(group.comparison_warnings, []);
});

test("summary rejects harness comparison when prompt hashes differ or are missing", () => {
  const mismatched = summarizeTranscripts([
    transcript("opencode", "legacy-prompt"),
    transcript("langgraph", "prompt-v1")
  ]).comparison_groups[0];
  assert.equal(mismatched.comparable_harnesses, false);
  assert.deepEqual(mismatched.comparison_warnings, ["harness prompt hash is missing or differs"]);

  const missing = summarizeTranscripts([
    transcript("opencode", "prompt-v1"),
    transcript("langgraph", "")
  ]).comparison_groups[0];
  assert.equal(missing.comparable_harnesses, false);
  assert.deepEqual(missing.comparison_warnings, ["harness prompt hash is missing or differs"]);
});

test("summary computes pooled rejection, combat, and strategy rates", () => {
  const first = transcript("pydanticai", "prompt-v1");
  first.decision_mode = "strategy_execute";
  first.counts = { act_calls: 4, invalid_action_attempts: 1 };
  first.model_steps = [
    {
      phase_intent: { source: "model", reused: false },
      action_attempts: [{
        accepted: true,
        action: { type: "combat" },
        assessment: { evaluation: { odds_column: "1-1" } }
      }]
    }
  ];
  const second = transcript("pydanticai", "prompt-v1");
  second.decision_mode = "strategy_execute";
  second.counts = { act_calls: 6, invalid_action_attempts: 2 };
  second.model_steps = [
    {
      phase_intent: { source: "local_default", reused: false },
      action_attempts: [{
        accepted: true,
        action: { type: "combat" },
        assessment: { evaluation: { odds_column: "2-1" } }
      }]
    }
  ];
  const summary = summarizeTranscripts([first, second]);
  const group = summary.by_decision_policy.find((item) => item.decision_policy === "strategy_execute");
  assert.equal(group.action_rejection_rate, 0.3);
  assert.equal(group.low_odds_attack_rate, 0.5);
  assert.equal(group.phase_strategy_success_rate, 0.5);
});

test("odds threshold treats anything below two-to-one as low odds", () => {
  assert.equal(oddsBelowTwoToOne("1-2"), true);
  assert.equal(oddsBelowTwoToOne("1-1"), true);
  assert.equal(oddsBelowTwoToOne("2-1"), false);
  assert.equal(oddsBelowTwoToOne("3-1"), false);
});

test("summary separates network fallbacks while including complete fallback games in ranking", () => {
  const clean = transcript("langgraph", "prompt-v1");
  clean.summary = { victory: { final: true, victory_points: 30, level: "Draw" } };
  clean.counts = { fallback_actions: 0, transport_failures: 0 };

  const degraded = transcript("opencode", "prompt-v1");
  degraded.summary = { victory: { final: true, victory_points: 10, level: "Allied Victory" } };
  degraded.counts = { fallback_actions: 1, network_fallback_actions: 1, transport_failures: 1 };
  degraded.model_steps = [{
    fallback_used: true,
    fallback_reason_class: "transport_failure",
    transport_failures: [{ error_class: "upstream_unavailable" }]
  }];

  const summary = summarizeTranscripts([clean, degraded]);
  const [group] = summary.comparison_groups;
  assert.equal(group.network_fallback_actions, 1);
  assert.equal(group.strategy_fallback_actions, 0);
  assert.equal(group.infrastructure_affected_runs, 1);
  assert.equal(group.tactical_comparison_runs, 2);
  assert.equal(group.raw_avg_victory_points, 20);
  assert.equal(group.avg_victory_points, 20);
});


test("a transport error recovered by retry remains eligible for ranking", () => {
  const recovered = transcript("manual_single_action", "prompt-v1");
  recovered.summary = { victory: { final: true, victory_points: 30, level: "Draw" } };
  recovered.counts = {
    fallback_actions: 0,
    transport_failures: 0,
    recovered_transport_failures: 1,
    retry_attempts: 1
  };
  recovered.model_transport = [{
    status: 200,
    error_class: "none",
    attempts: 2,
    recovered_after_retry: true,
    retryable_failures: [{ status: 502, error_class: "upstream_unavailable" }]
  }];

  const [group] = summarizeTranscripts([recovered]).comparison_groups;
  assert.equal(group.tactical_comparison_runs, 1);
  assert.equal(group.infrastructure_affected_runs, 0);
  assert.equal(group.recovered_transport_failures, 1);
  assert.equal(group.avg_victory_points, 30);
});
