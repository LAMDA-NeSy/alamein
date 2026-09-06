#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  buildComparisonCells,
  comparisonCellId,
  infrastructureStatus,
  rankingEligible
} = require("../core/benchmark_comparison.js");
const { summaryStats: benchmarkStats } = require("../core/benchmark_statistics.js");

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(values) {
  return benchmarkStats(values);
}

function acceptedCombatAttempts(steps) {
  return steps.flatMap((step) => step.fallback_used
    ? []
    : (step.action_attempts || []).filter((attempt) => attempt.accepted && attempt.action?.type === "combat"));
}

function oddsBelowTwoToOne(value) {
  const match = String(value || "").match(/^(\d+)-(\d+)$/);
  if (!match) return false;
  return Number(match[1]) / Number(match[2]) < 2;
}

function metrics(transcript) {
  const steps = transcript.model_steps || [];
  const elapsed = steps.map((step) => Number(step.provider_result?.elapsed_ms || 0));
  const usesHarnessProjection = steps.some((step) => step.harness_context_bytes != null);
  const effectiveContextBytes = steps.map((step) => Number(step.harness_context_bytes ?? step.context_bytes ?? 0));
  const actCalls = Number(transcript.counts?.act_calls || 0);
  const invalidActionAttempts = Number(transcript.counts?.invalid_action_attempts || 0);
  const combats = acceptedCombatAttempts(steps);
  const lowOddsAttacks = combats.filter((attempt) => oddsBelowTwoToOne(
    attempt.assessment?.evaluation?.odds_column
      || attempt.assessment?.action?.verdict?.details?.odds_column
  )).length;
  const strategyRequests = steps.filter((step) => step.phase_intent && !step.phase_intent.reused && step.phase_intent.source !== "local_fast_pass");
  const modelStrategies = strategyRequests.filter((step) => step.phase_intent.source === "model").length;
  const fallbackReasons = steps.reduce((counts, step) => {
    const reason = step.fallback_reason_class || (step.fallback_used ? "unclassified" : "");
    if (reason) counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
  const transportFailures = Number(transcript.counts?.transport_failures
    ?? (transcript.model_transport || []).filter((item) => item.error_class && item.error_class !== "none").length);
  const recoveredTransportFailures = Number(transcript.counts?.recovered_transport_failures
    ?? (transcript.model_transport || []).filter((item) => item.recovered_after_retry).length);
  const networkFallbackActions = Number(transcript.counts?.network_fallback_actions
    ?? fallbackReasons.transport_failure
    ?? 0);
  const infrastructureAffected = transcript.partial === true
    || transcript.status === "harness_error"
    || transportFailures > 0
    || Number(transcript.counts?.circuit_open_events ?? transcript.transport_health?.circuit_open_events ?? 0) > 0;
  const completeGame = transcript.status === "final_victory" && transcript.summary?.victory?.final === true;
  const sampleStatus = infrastructureStatus(transcript);
  return {
    experiment_id: transcript.experiment_id,
    model_profile: transcript.model_profile || transcript.model?.model || "legacy",
    harness: transcript.harness || transcript.decision_mode || "legacy",
    decision_policy: transcript.decision_mode || "legacy",
    tool_profile: transcript.tool_profile || transcript.tool_protocol || "legacy",
    tool_config_hash: transcript.tool_config_hash || "",
    scenario: transcript.scenario || transcript.comparison_contract?.scenario || "",
    external_side: transcript.external_side || transcript.comparison_contract?.external_side || "",
    prompt_profile_hash: transcript.prompt_profile_hash || transcript.comparison_contract?.prompt_profile_hash || "",
    prompt_profiles: transcript.prompt_profiles || transcript.comparison_contract?.prompt_profiles || {},
    benchmark_version: transcript.benchmark_version || transcript.comparison_contract?.benchmark_version || "",
    artifact_manifest_hash: transcript.artifact_manifest_hash || transcript.comparison_contract?.artifact_manifest_hash || "",
    artifact_manifest: transcript.artifact_manifest || transcript.comparison_contract?.artifact_manifest || null,
    artifact_hashes: transcript.artifact_manifest?.files
      ? Object.fromEntries(Object.entries(transcript.artifact_manifest.files).map(([name, item]) => [name, item.sha256]))
      : transcript.comparison_contract?.artifact_hashes || {},
    controllers: transcript.controllers || {
      axis: transcript.axis_controller || "",
      allies: transcript.allies_controller || ""
    },
    max_calls_per_step: transcript.comparison_contract?.max_calls_per_step ?? null,
    step_timeout_ms: transcript.comparison_contract?.step_timeout_ms ?? null,
    task_management: transcript.task_management || transcript.comparison_contract?.task_management || "",
    task_checker_model_profile: transcript.task_checker_model_profile || transcript.comparison_contract?.task_checker_model_profile || "",
    comparison_contract_hash: transcript.comparison_contract_hash || "",
    comparison_contract: transcript.comparison_contract || null,
    comparison_contract_version: transcript.comparison_contract?.version || "",
    model_configuration: transcript.comparison_contract?.model_configuration || null,
    harness_prompt_hash: transcript.harness_prompt_hash || transcript.comparison_contract?.harness_prompt_hash || "",
    context_profile: transcript.context_profile || (usesHarnessProjection ? "harness_projection" : "full_public_payload"),
    sample_status: sampleStatus,
    complete_game: completeGame,
    replicate: transcript.replicate ?? 1,
    seed: transcript.seed ?? null,
    elapsed_ms: Number(transcript.elapsed_ms || 0),
    victory_points: transcript.summary?.victory?.victory_points ?? null,
    victory_level: transcript.summary?.victory?.level || "",
    illegal_actions: transcript.counts?.illegal_actions || 0,
    fallback_rate: steps.length ? Number(transcript.counts?.fallback_actions || 0) / steps.length : 0,
    network_fallback_actions: networkFallbackActions,
    strategy_fallback_actions: Number(fallbackReasons.tool_call_limit || 0) + Number(fallbackReasons.model_protocol_failure || 0),
    timeout_fallback_actions: Number(fallbackReasons.step_timeout || 0),
    harness_fallback_actions: Number(fallbackReasons.harness_failure || 0),
    unclassified_fallback_actions: Number(fallbackReasons.unclassified || 0),
    transport_failures: transportFailures,
    recovered_transport_failures: recoveredTransportFailures,
    protocol_failures: Number(transcript.counts?.protocol_failures || 0),
    circuit_open_events: Number(transcript.counts?.circuit_open_events ?? transcript.transport_health?.circuit_open_events ?? 0),
    tool_calls: transcript.counts?.model_tool_calls || 0,
    map_tool_calls: transcript.counts?.map_tool_calls || 0,
    act_calls: actCalls,
    invalid_action_attempts: invalidActionAttempts,
    action_rejection_rate: actCalls ? invalidActionAttempts / actCalls : 0,
    combat_actions: combats.length,
    low_odds_attacks: lowOddsAttacks,
    low_odds_attack_rate: combats.length ? lowOddsAttacks / combats.length : 0,
    phase_strategy_requests: strategyRequests.length,
    model_phase_strategies: modelStrategies,
    phase_strategy_success_rate: strategyRequests.length ? modelStrategies / strategyRequests.length : 0,
    accepted_actions: transcript.counts?.accepted_actions || 0,
    post_accept_tool_calls: transcript.counts?.post_accept_tool_calls || 0,
    retry_attempts: transcript.counts?.retry_attempts || 0,
    avg_rounds: average(steps.map((step) => Number(step.provider_result?.rounds || 0))),
    avg_phase_plan_ms: average(steps.map((step) => Number(step.phase_plan_ms ?? step.provider_result?.phase_plan_ms ?? 0))),
    avg_prepare_ms: average(steps.map((step) => Number(step.prepare_ms ?? step.provider_result?.prepare_ms ?? 0))),
    avg_context_bytes: average(steps.map((step) => Number(step.context_bytes || 0))),
    avg_effective_context_bytes: average(effectiveContextBytes),
    p50_latency_ms: percentile(elapsed, 0.5),
    p95_latency_ms: percentile(elapsed, 0.95),
    input_tokens: transcript.model_usage?.input_tokens || 0,
    output_tokens: transcript.model_usage?.output_tokens || 0,
    cache_tokens: transcript.model_usage?.cache_tokens || 0,
    estimated_cost: transcript.model_usage?.estimated_cost ?? null,
    local_fast_pass_actions: transcript.counts?.local_fast_pass_actions || 0,
    eligible_units_at_phase_start: transcript.counts?.eligible_units_at_phase_start || 0,
    acted_units: transcript.counts?.acted_units || 0,
    held_units: transcript.counts?.held_units || 0,
    omitted_units: transcript.counts?.omitted_units || 0,
    repaired_orders: transcript.counts?.repaired_orders || 0,
    skipped_orders: transcript.counts?.skipped_orders || 0,
    unit_plan_coverage: steps.some((step) => step.rolling_movement)
      ? (Number(transcript.counts?.eligible_units_at_phase_start || 0)
        ? (Number(transcript.counts?.acted_units || 0)
          + Number(transcript.counts?.held_units || 0)
          + Number(transcript.counts?.unavailable_units || 0))
          / Number(transcript.counts.eligible_units_at_phase_start)
        : 0)
      : average(steps.filter((step) => step.phase_unit_plan).map((step) => Number(step.phase_unit_plan.unit_plan_coverage || 0))),
    movement_phase_completion_rate: transcript.counts?.movement_phase_completion_rate
      ?? average(steps.filter((step) => step.movement_phase?.advance_reason === "unit_plan_complete")
        .map((step) => Number(step.movement_phase.movement_phase_completion_rate || 0))),
    unit_plan_execution_rate: steps.some((step) => step.rolling_movement)
      ? (Number(transcript.counts?.eligible_units_at_phase_start || 0)
        ? Number(transcript.counts?.acted_units || 0) / Number(transcript.counts.eligible_units_at_phase_start)
        : 0)
      : (Number(transcript.counts?.planned_move_orders || 0)
        ? Number(transcript.counts?.planned_actions_executed || 0) / Number(transcript.counts.planned_move_orders)
        : 0),
    immediate_reversals: transcript.counts?.immediate_reversals || 0,
    repeated_destination_actions: transcript.counts?.repeated_destination_actions || 0,
    compactions: transcript.compaction?.count || 0,
    infrastructure_affected: infrastructureAffected,
    ranking_eligible: transcript.comparison_contract
      ? rankingEligible(transcript)
      : completeGame && Boolean(transcript.artifact_manifest_hash || transcript.comparison_contract?.artifact_manifest_hash),
    eligible_for_tactical_comparison: transcript.comparison_contract
      ? rankingEligible(transcript)
      : completeGame && Boolean(transcript.artifact_manifest_hash || transcript.comparison_contract?.artifact_manifest_hash),
    comparison_cell_ids: {
      method: comparisonCellId({
        ...transcript,
        ...{
          scenario: transcript.scenario,
          external_side: transcript.external_side,
          controllers: transcript.controllers,
          model_profile: transcript.model_profile,
          harness: transcript.harness,
          decision_policy: transcript.decision_mode,
          tool_profile: transcript.tool_profile,
          tool_config_hash: transcript.tool_config_hash,
          context_profile: transcript.context_profile,
          prompt_profile_hash: transcript.prompt_profile_hash,
          harness_prompt_hash: transcript.harness_prompt_hash,
          benchmark_version: transcript.benchmark_version,
          artifact_manifest_hash: transcript.artifact_manifest_hash,
          comparison_contract: transcript.comparison_contract
        }
      }, "method"),
      harness: comparisonCellId({ ...transcript, decision_policy: transcript.decision_mode }, "harness"),
      model: comparisonCellId({ ...transcript, decision_policy: transcript.decision_mode }, "model")
    }
  };
}

function aggregate(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = item[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return [...groups.entries()].map(([value, rows]) => {
    const totalActCalls = rows.reduce((sum, row) => sum + row.act_calls, 0);
    const totalInvalidActions = rows.reduce((sum, row) => sum + row.invalid_action_attempts, 0);
    const totalCombats = rows.reduce((sum, row) => sum + row.combat_actions, 0);
    const totalLowOddsAttacks = rows.reduce((sum, row) => sum + row.low_odds_attacks, 0);
    const totalStrategyRequests = rows.reduce((sum, row) => sum + row.phase_strategy_requests, 0);
    const totalModelStrategies = rows.reduce((sum, row) => sum + row.model_phase_strategies, 0);
    const completeRows = rows.filter((row) => row.complete_game && Number.isFinite(row.victory_points));
    const tacticalRows = completeRows.filter((row) => row.ranking_eligible);
    const vpValues = tacticalRows.map((row) => row.victory_points).filter(Number.isFinite);
    const rawVpValues = completeRows.map((row) => row.victory_points).filter(Number.isFinite);
    return ({
    [key]: value,
    runs: rows.length,
    harnesses: [...new Set(rows.map((row) => row.harness))],
    model_profiles: [...new Set(rows.map((row) => row.model_profile))],
    context_profiles: [...new Set(rows.map((row) => row.context_profile))],
    harness_prompt_hashes: [...new Set(rows.map((row) => row.harness_prompt_hash))],
    avg_victory_points: average(tacticalRows.map((row) => row.victory_points).filter(Number.isFinite)),
    raw_avg_victory_points: average(completeRows.map((row) => row.victory_points)),
    ranking_eligible_runs: tacticalRows.length,
    vp_stats: stats(vpValues),
    raw_vp_stats: stats(rawVpValues),
    tactical_comparison_runs: tacticalRows.length,
    infrastructure_affected_runs: rows.filter((row) => row.infrastructure_affected).length,
    avg_elapsed_ms: average(rows.map((row) => row.elapsed_ms)),
    illegal_actions: rows.reduce((sum, row) => sum + row.illegal_actions, 0),
    avg_fallback_rate: average(rows.map((row) => row.fallback_rate)),
    network_fallback_actions: rows.reduce((sum, row) => sum + row.network_fallback_actions, 0),
    strategy_fallback_actions: rows.reduce((sum, row) => sum + row.strategy_fallback_actions, 0),
    timeout_fallback_actions: rows.reduce((sum, row) => sum + row.timeout_fallback_actions, 0),
    harness_fallback_actions: rows.reduce((sum, row) => sum + row.harness_fallback_actions, 0),
    unclassified_fallback_actions: rows.reduce((sum, row) => sum + row.unclassified_fallback_actions, 0),
    transport_failures: rows.reduce((sum, row) => sum + row.transport_failures, 0),
    recovered_transport_failures: rows.reduce((sum, row) => sum + row.recovered_transport_failures, 0),
    protocol_failures: rows.reduce((sum, row) => sum + row.protocol_failures, 0),
    circuit_open_events: rows.reduce((sum, row) => sum + row.circuit_open_events, 0),
    avg_tool_calls: average(rows.map((row) => row.tool_calls)),
    avg_map_tool_calls: average(rows.map((row) => row.map_tool_calls)),
    avg_act_calls: average(rows.map((row) => row.act_calls)),
    invalid_action_attempts: totalInvalidActions,
    action_rejection_rate: totalActCalls ? totalInvalidActions / totalActCalls : 0,
    combat_actions: totalCombats,
    low_odds_attacks: totalLowOddsAttacks,
    low_odds_attack_rate: totalCombats ? totalLowOddsAttacks / totalCombats : 0,
    phase_strategy_requests: totalStrategyRequests,
    model_phase_strategies: totalModelStrategies,
    phase_strategy_success_rate: totalStrategyRequests ? totalModelStrategies / totalStrategyRequests : 0,
    post_accept_tool_calls: rows.reduce((sum, row) => sum + row.post_accept_tool_calls, 0),
    retry_attempts: rows.reduce((sum, row) => sum + row.retry_attempts, 0),
    avg_rounds: average(rows.map((row) => row.avg_rounds)),
    avg_phase_plan_ms: average(rows.map((row) => row.avg_phase_plan_ms)),
    avg_prepare_ms: average(rows.map((row) => row.avg_prepare_ms)),
    avg_context_bytes: average(rows.map((row) => row.avg_context_bytes)),
    avg_effective_context_bytes: average(rows.map((row) => row.avg_effective_context_bytes)),
    avg_p50_latency_ms: average(rows.map((row) => row.p50_latency_ms)),
    avg_p95_latency_ms: average(rows.map((row) => row.p95_latency_ms)),
    avg_unit_plan_coverage: average(rows.map((row) => row.unit_plan_coverage)),
    avg_movement_phase_completion_rate: average(rows.map((row) => row.movement_phase_completion_rate)),
    avg_unit_plan_execution_rate: average(rows.map((row) => row.unit_plan_execution_rate)),
    repaired_orders: rows.reduce((sum, row) => sum + row.repaired_orders, 0),
    skipped_orders: rows.reduce((sum, row) => sum + row.skipped_orders, 0),
    immediate_reversals: rows.reduce((sum, row) => sum + row.immediate_reversals, 0),
    repeated_destination_actions: rows.reduce((sum, row) => sum + row.repeated_destination_actions, 0),
    total_input_tokens: rows.reduce((sum, row) => sum + row.input_tokens, 0),
    total_output_tokens: rows.reduce((sum, row) => sum + row.output_tokens, 0),
    total_cache_tokens: rows.reduce((sum, row) => sum + row.cache_tokens, 0)
    });
  });
}

function comparisonGroups(items) {
  return aggregate(items.filter((item) => item.comparison_contract_hash), "comparison_contract_hash")
    .map((group) => {
      const artifactManifestHashes = [...new Set(items
        .filter((item) => item.comparison_contract_hash === group.comparison_contract_hash)
        .map((item) => item.artifact_manifest_hash))];
      return ({
      ...group,
      artifact_manifest_hashes: artifactManifestHashes,
      comparable_harnesses: group.harnesses.length > 1
        && group.context_profiles.length === 1
        && group.harness_prompt_hashes.length === 1
        && Boolean(group.harness_prompt_hashes[0])
        && artifactManifestHashes.length === 1
        && Boolean(artifactManifestHashes[0]),
      comparable_models: group.model_profiles.length > 1
        && group.context_profiles.length === 1,
      comparison_warnings: [
        ...(group.context_profiles.length > 1 ? [`context profiles differ: ${group.context_profiles.join(", ")}`] : []),
        ...(group.harness_prompt_hashes.length !== 1 || !group.harness_prompt_hashes[0]
          ? ["harness prompt hash is missing or differs"]
          : []),
        ...(artifactManifestHashes.length !== 1 || !artifactManifestHashes[0]
          ? ["artifact manifest hash is missing or differs"]
          : [])
      ]
      });
    });
}

function summarizeTranscripts(transcripts) {
  const runs = transcripts.map(metrics);
  if (!runs.length) throw new Error("provide one or more experiment transcript files");
  return {
    generated_at: new Date().toISOString(),
    attribution_rule: "Formal ranking requires complete games, a shared benchmark artifact manifest, and matching controlled conditions. Declared method fallbacks remain part of end-to-end performance and are ranking-eligible; partial games and harness errors are excluded. Infrastructure and fallback counts remain visible for diagnosis; paired VP differences are aligned by seed and replicate.",
    runs,
    comparison_groups: comparisonGroups(runs),
    strict_comparison_cells: {
      method: buildComparisonCells(runs, "method"),
      harness: buildComparisonCells(runs, "harness"),
      model: buildComparisonCells(runs, "model")
    },
    by_model_for_harness_comparison: aggregate(runs, "model_profile"),
    by_harness_for_model_comparison: aggregate(runs, "harness"),
    by_decision_policy: aggregate(runs, "decision_policy"),
    by_tool_profile: aggregate(runs, "tool_profile")
  };
}

if (require.main === module) {
  const transcripts = process.argv.slice(2).map((file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
  process.stdout.write(`${JSON.stringify(summarizeTranscripts(transcripts), null, 2)}\n`);
}

module.exports = {
  aggregate,
  acceptedCombatAttempts,
  comparisonGroups,
  metrics,
  oddsBelowTwoToOne,
  summarizeTranscripts
};
