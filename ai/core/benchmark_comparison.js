"use strict";

const { COMPARISON_CONTRACT_VERSION, comparisonContractHash, stableJson } = require("./comparison_contract.js");
const { validateArtifactManifest } = require("./benchmark_artifacts.js");
const { pairedStatistics } = require("./benchmark_statistics.js");

const COMPARISON_DIMENSIONS = new Set(["method", "harness", "model", "system"]);

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? "")))];
}

function controllerKey(row) {
  const controllers = row.controllers || {};
  return `axis=${controllers.axis || row.axis_controller || ""},allies=${controllers.allies || row.allies_controller || ""}`;
}

function artifactHash(row) {
  return row.artifact_manifest_hash || row.comparison_contract?.artifact_manifest_hash || "";
}

function infrastructureStatus(transcript) {
  if (transcript.status === "harness_error") return "harness_error";
  if (transcript.partial === true || (transcript.status && transcript.status !== "final_victory")) return "partial";
  if (["harness_error", "partial", "infrastructure_affected"].includes(transcript.sample_status)) return transcript.sample_status;
  const transportFailures = Number(transcript.counts?.transport_failures
    ?? (transcript.model_transport || []).filter((item) => item.error_class && item.error_class !== "none").length
    ?? 0);
  const circuitEvents = Number(transcript.counts?.circuit_open_events
    ?? transcript.transport_health?.circuit_open_events
    ?? 0);
  const transports = transcript.model_transport_by_component
    ? Object.values(transcript.model_transport_by_component).flat() : transcript.model_transport || [];
  if (transports.some((record) => record.environment_pauses?.length || record.clean_latency_eligible === false)) return "infrastructure_affected";
  if (transportFailures > 0 || circuitEvents > 0) return "infrastructure_affected";
  return "clean";
}

function comparisonCondition(row, dimension) {
  if (!COMPARISON_DIMENSIONS.has(dimension)) throw new Error(`unknown comparison dimension ${dimension}`);
  const contract = structuredClone(row.comparison_contract || {});
  for (const key of ["seed", "replicate", "source_control", "artifact_manifest", "artifact_hashes"]) delete contract[key];
  if (dimension === "method") {
    for (const key of [
      "decision_policy", "objective_resolution_version", "adaptive_replanning_version",
      "hierarchical_strategy_protocol", "strategic_planner_protocol", "force_allocator_protocol",
      "dispatch_protocol", "operation_state_version", "goal_management", "goal_protocol",
      "task_management", "task_protocol", "task_generation", "task_dependency_policy",
      "task_switching", "task_progress_version", "task_action_feedback_version", "task_checker_timing",
      "task_replan_policy", "task_checker_model_profile", "task_configuration", "task_checker_configuration",
      "strategic_movement_guard_version", "strategic_combat_guard_version", "voluntary_combat_pass_policy",
      "model_combat_subset_policy", "supply_assignment_grounding_version", "supply_coverage_projection_version",
      "rejection_feedback_version", "repeated_rejection_policy", "movement_memory_size",
      "immediate_reversal_policy", "scoring_frontier_supply_policy", "frontier_breakthrough_protocol",
      "axis_breakthrough_checkpoint_policy", "axis_dynamic_spearhead_policy", "rolling_unit_action_protocol",
      "rolling_unit_settings", "phase_unit_plan_protocol"
    ]) delete contract[key];
  }
  if (dimension === "model") {
    for (const key of ["model_profile", "model", "billing_channel", "model_configuration"]) delete contract[key];
  }
  const condition = {
    benchmark_version: row.benchmark_version || row.comparison_contract?.benchmark_version || "",
    artifact_manifest_hash: artifactHash(row),
    scenario: row.scenario || contract.scenario || "",
    external_side: row.external_side || contract.external_side || "",
    controllers: controllerKey(row),
    model_profile: row.model_profile || "",
    harness: row.harness || "",
    decision_policy: row.decision_policy || row.decision_mode || "",
    tool_profile: row.tool_profile || row.tool_protocol || "",
    tool_config_hash: row.tool_config_hash || "",
    context_profile: row.context_profile || "",
    prompt_profile_hash: row.prompt_profile_hash || "",
    harness_prompt_hash: row.harness_prompt_hash || "",
    max_calls_per_step: row.max_calls_per_step ?? row.comparison_contract?.max_calls_per_step ?? "",
    step_timeout_ms: row.step_timeout_ms ?? row.comparison_contract?.step_timeout_ms ?? "",
    task_management: row.task_management || row.comparison_contract?.task_management || "",
    task_checker_model_profile: row.task_checker_model_profile || row.comparison_contract?.task_checker_model_profile || "",
    effective_contract: contract
  };
  if (dimension === "system") {
    return {
      benchmark_version: condition.benchmark_version,
      artifact_manifest_hash: condition.artifact_manifest_hash,
      scenario: condition.scenario,
      external_side: condition.external_side,
      controllers: condition.controllers,
      contract_version: contract.version,
      model_configuration: contract.model_configuration,
      max_calls_per_step: condition.max_calls_per_step,
      step_timeout_ms: condition.step_timeout_ms,
      max_steps: contract.max_steps,
      transport_policy: contract.transport_policy,
      execution_thinking_mode: contract.execution_thinking_mode
    };
  }
  delete condition[dimension === "method" ? "decision_policy" : dimension === "harness" ? "harness" : "model_profile"];
  return condition;
}

function comparisonCellId(row, dimension) {
  return `${dimension}:${stableJson(comparisonCondition(row, dimension))}`;
}

function comparisonVariant(row, dimension) {
  if (dimension === "system") return `${row.harness || ""}:${row.decision_policy || row.decision_mode || ""}`;
  if (dimension === "method") return row.decision_policy || row.decision_mode || "";
  if (dimension === "harness") return row.harness || "";
  return row.model_profile || "";
}

function pairId(row) {
  return `${row.seed ?? "<missing-seed>"}:${row.replicate ?? "<missing-replicate>"}`;
}

function defaultBaselineVariant(variants, dimension) {
  const preferred = dimension === "method"
    ? ["direct", "hybrid", "hierarchical_sae"]
    : dimension === "harness"
      ? ["manual_single_action", "opencode_harness", "langgraph_harness", "pydanticai_harness"]
      : ["mock_primary", "deepseek_flash", "glm_flash", "qwen"];
  return preferred.find((candidate) => variants.includes(candidate)) || [...variants].sort()[0] || null;
}

function rankingEligible(row) {
  return rankingEligibilityReasons(row).length === 0;
}

function rankingEligibilityReasons(row) {
  const reasons = [];
  if (row == null) return ["missing_row"];
  if (row.ranking_eligible === false) reasons.push("explicitly_marked_ineligible");
  if (row.eligible_for_tactical_comparison === false) reasons.push("explicitly_excluded_from_tactical_comparison");
  if (row.partial || ["harness_error", "partial"].includes(infrastructureStatus(row))) reasons.push("incomplete_or_harness_error");
  if (Number(row.counts?.illegal_actions ?? row.illegal_actions ?? 0) !== 0) reasons.push("application_layer_illegal_actions");
  const complete = row.status === "final_victory" && (row.complete_game === true || row.summary?.victory?.final === true);
  if (!complete) reasons.push("game_not_final_victory");
  const contract = row.comparison_contract;
  const manifest = row.artifact_manifest || contract?.artifact_manifest;
  const vp = row.final_vp ?? row.victory_points ?? row.summary?.victory?.victory_points;
  const contractHashMatches = Boolean(contract)
    && /^[a-f0-9]{64}$/.test(row.comparison_contract_hash || "")
    && comparisonContractHash(contract) === row.comparison_contract_hash;
  if (!Number.isFinite(vp)) reasons.push("missing_final_vp");
  if (!validateArtifactManifest(manifest, artifactHash(row))) reasons.push("artifact_manifest_invalid");
  // The contract carries source_control because artifact_manifest is a
  // serialized file-only object. Read both locations for old and new logs.
  const sourceControl = manifest?.source_control || contract?.source_control || row.source_control;
  if (sourceControl?.working_tree_dirty === true) reasons.push("working_tree_dirty");
  if (contract?.version !== COMPARISON_CONTRACT_VERSION) reasons.push("comparison_contract_version_mismatch");
  if (!contractHashMatches) reasons.push("comparison_contract_hash_mismatch");
  if (!Boolean(contract.model_configuration?.identity && contract.model_configuration?.defaults)) reasons.push("model_configuration_missing");
  if (!Boolean(row.scenario && row.external_side && row.harness && row.model_profile && row.tool_config_hash && row.context_profile && row.prompt_profile_hash && row.harness_prompt_hash)) reasons.push("required_identity_fields_missing");
  if (contract.model_profile && row.model_profile !== contract.model_profile) reasons.push("model_profile_mismatch");
  if (contract.tool_profile && row.tool_profile !== contract.tool_profile) reasons.push("tool_profile_mismatch");
  if (contract.tool_config_hash && row.tool_config_hash !== contract.tool_config_hash) reasons.push("tool_config_hash_mismatch");
  if (contract.context_profile && row.context_profile !== contract.context_profile) reasons.push("context_profile_mismatch");
  if (contract.prompt_profile_hash && row.prompt_profile_hash !== contract.prompt_profile_hash) reasons.push("prompt_profile_hash_mismatch");
  if (contract.harness_prompt_hash && row.harness_prompt_hash !== contract.harness_prompt_hash) reasons.push("harness_prompt_hash_mismatch");
  if (!Number.isInteger(row.seed) || !Number.isInteger(row.replicate) || row.replicate <= 0) reasons.push("seed_or_replicate_missing");
  if (!Number.isInteger(contract.max_steps) || contract.max_steps <= 0) reasons.push("max_steps_missing");
  if (!Number.isInteger(contract.max_calls_per_step) || contract.max_calls_per_step <= 0) reasons.push("max_calls_per_step_missing");
  if (!Number.isFinite(contract.step_timeout_ms) || contract.step_timeout_ms <= 0) reasons.push("step_timeout_missing");
  if (!manifest || row.scenario !== manifest.scenario) reasons.push("scenario_manifest_mismatch");
  if (!contract || row.scenario !== contract.scenario) reasons.push("scenario_contract_mismatch");
  if (!contract || row.external_side !== contract.external_side) reasons.push("external_side_contract_mismatch");
  if (!contract || stableJson(row.controllers) !== stableJson(contract.controllers)) reasons.push("controller_contract_mismatch");
  return [...new Set(reasons)];
}

function cleanRankingEligible(row) {
  return rankingEligible(row) && infrastructureStatus(row) === "clean";
}

function buildPairedResults(rows, dimension, baselineVariant = null) {
  if (!COMPARISON_DIMENSIONS.has(dimension)) throw new Error(`unknown comparison dimension ${dimension}`);
  const variants = unique((rows || []).map((row) => comparisonVariant(row, dimension)).filter(Boolean));
  const baseline = baselineVariant || defaultBaselineVariant(variants, dimension);
  const validation = validateComparisonRows(rows, dimension);
  if (baseline && !variants.includes(baseline)) {
    throw new Error(`baseline variant ${baseline} is not present in ${dimension} comparison`);
  }
  const byPair = new Map();
  for (const row of rows || []) {
    const id = pairId(row);
    if (!byPair.has(id)) byPair.set(id, new Map());
    const variant = comparisonVariant(row, dimension);
    const existing = byPair.get(id).get(variant);
    if (existing) {
      // Duplicate seed/replicate/variant rows cannot be paired deterministically.
      byPair.get(id).set(variant, { duplicate: true, rows: [existing, row].flatMap((item) => item.rows || [item]) });
    }
    else byPair.get(id).set(variant, { row, rows: [row] });
  }
  return [...byPair.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })).map(([id, values]) => {
    const baselineEntry = values.get(baseline);
    const baselineRow = baselineEntry && !baselineEntry.duplicate ? baselineEntry.row : null;
    const comparisons = variants.filter((variant) => variant !== baseline).map((variant) => {
      const entry = values.get(variant);
      const row = entry && !entry.duplicate ? entry.row : null;
      const eligible = validation.valid && rankingEligible(baselineRow) && rankingEligible(row);
      return {
        seed: row?.seed ?? baselineRow?.seed ?? null,
        replicate: row?.replicate ?? baselineRow?.replicate ?? null,
        baseline_variant: baseline,
        compared_variant: variant,
        baseline_vp: Number.isFinite(baselineRow?.final_vp ?? baselineRow?.victory_points) ? (baselineRow.final_vp ?? baselineRow.victory_points) : null,
        compared_vp: Number.isFinite(row?.final_vp ?? row?.victory_points) ? (row.final_vp ?? row.victory_points) : null,
        vp_difference: eligible
          && Number.isFinite(baselineRow?.final_vp ?? baselineRow?.victory_points)
          && Number.isFinite(row?.final_vp ?? row?.victory_points)
          ? (row.final_vp ?? row.victory_points) - (baselineRow.final_vp ?? baselineRow.victory_points)
          : null,
        ranking_eligible: eligible,
        clean_ranking_eligible: eligible && cleanRankingEligible(baselineRow) && cleanRankingEligible(row),
        baseline_sample_status: baselineRow ? infrastructureStatus(baselineRow) : null,
        compared_sample_status: row ? infrastructureStatus(row) : null,
        exclusion_reason: eligible ? null : entry?.duplicate || baselineEntry?.duplicate
          ? "duplicate seed/replicate/variant"
          : !baselineEntry || !baselineRow
            ? "baseline variant is missing or not ranking-eligible"
            : !entry || !row
              ? "compared variant is missing or not ranking-eligible"
              : validation.reasons.join("; ") || "one or both runs are not complete games with benchmark artifacts"
      };
    });
    return {
      pair_id: id,
      seed: baselineRow?.seed ?? null,
      replicate: baselineRow?.replicate ?? null,
      baseline_variant: baseline,
      comparisons
    };
  });
}

function validateComparisonRows(rows, dimension = "method") {
  const items = rows || [];
  const reasons = [];
  if (!items.length) reasons.push("no experiment rows");
  const missingArtifacts = items.filter((row) => !artifactHash(row));
  if (missingArtifacts.length) reasons.push(`${missingArtifacts.length} row(s) missing artifact manifest`);
  const ineligible = items.filter((row) => !rankingEligible(row));
  if (ineligible.length) reasons.push(`${ineligible.length} run(s) are incomplete, failed, or missing ranking requirements`);
  const conditions = unique(items.map((row) => stableJson(comparisonCondition(row, dimension))));
  if (conditions.length > 1) reasons.push("controlled experiment conditions differ");
  const variants = unique(items.map((row) => comparisonVariant(row, dimension)));
  if (variants.length < 2) reasons.push(`at least two ${dimension} variants are required`);
  const pairKeys = new Map();
  const samples = new Set();
  for (const row of items) {
    const pair = `${row.seed ?? ""}:${row.replicate ?? ""}`;
    if (!pairKeys.has(pair)) pairKeys.set(pair, new Set());
    const variant = comparisonVariant(row, dimension);
    const sample = `${pair}:${variant}`;
    if (samples.has(sample)) reasons.push(`duplicate seed/replicate/variant: ${sample}`);
    samples.add(sample);
    if (!Number.isInteger(row.seed) || !Number.isInteger(row.replicate) || row.replicate < 1) reasons.push("seed and positive replicate must be explicitly recorded integers");
    pairKeys.get(pair).add(variant);
  }
  const incompletePairs = [...pairKeys.entries()].filter(([, values]) => values.size !== variants.length);
  if (incompletePairs.length) reasons.push(`${incompletePairs.length} seed/replicate pair(s) do not contain every variant`);
  return {
    valid: reasons.length === 0,
    dimension,
    reasons,
    variants,
    rows: items.length,
    valid_for_ranking: reasons.length === 0 && items.every(rankingEligible),
    clean_rows: items.filter((row) => infrastructureStatus(row) === "clean").length,
    infrastructure_affected_rows: items.filter((row) => infrastructureStatus(row) === "infrastructure_affected").length,
    ranking_eligible_rows: items.filter(rankingEligible).length,
    clean_ranking_eligible_rows: items.filter(cleanRankingEligible).length,
    comparison_cell_id: items.length ? comparisonCellId(items[0], dimension) : null
  };
}

function rankingGroupEligible(rows, dimension = null) {
  if (!rows.length || rows.some((row) => !rankingEligible(row))) return false;
  const conditions = rows.map((row) => stableJson({
    ...comparisonCondition(row, dimension || "method"),
    ...(dimension ? {} : { decision_policy: row.decision_policy || row.decision_mode })
  }));
  const samples = rows.map((row) => `${pairId(row)}:${dimension ? comparisonVariant(row, dimension) : "run"}`);
  return new Set(conditions).size === 1 && new Set(samples).size === rows.length;
}

function buildComparisonCells(rows, dimension) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = comparisonCellId(row, dimension);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([comparison_cell_id, items]) => {
    const pairs = buildPairedResults(items, dimension);
    return ({
    comparison_cell_id,
    validation: validateComparisonRows(items, dimension),
    variants: unique(items.map((row) => comparisonVariant(row, dimension))),
    runs: items.map((row) => row.experiment_id || ""),
    paired_results: pairs,
    paired_statistics: pairedStatistics(pairs),
    clean_paired_statistics: pairedStatistics(pairs.map((pair) => ({
      ...pair,
      comparisons: pair.comparisons.map((comparison) => ({
        ...comparison,
        ranking_eligible: comparison.clean_ranking_eligible,
        vp_difference: comparison.clean_ranking_eligible ? comparison.vp_difference : null
      }))
    })))
  }); });
}

module.exports = {
  COMPARISON_DIMENSIONS,
  buildComparisonCells,
  buildPairedResults,
  comparisonCellId,
  comparisonCondition,
  infrastructureStatus,
  rankingEligible,
  cleanRankingEligible,
  rankingEligibilityReasons,
  rankingGroupEligible,
  validateComparisonRows
};
