"use strict";
const { reconstructLegacyPlans } = require("../core/phase_execution_ledger.js");

const RulesEngine = require("../../rule_engine.js");
const { infrastructureStatus } = require("../core/benchmark_comparison.js");
const { rankingEligible, rankingEligibilityReasons } = require("../core/benchmark_comparison.js");
const { summaryStats: benchmarkStats } = require("../core/benchmark_statistics.js");
const { artifactGroupHashes, artifactReproducibility } = require("../core/benchmark_artifacts.js");
const { allocationCorrectionMetrics } = require("../core/experiment_accounting.js");
const { summarizeOpportunityEvidence } = require("../core/opportunity_ledger.js");

const OPPORTUNITY_TYPES = new Set([
  "joint_attack",
  "capture_objective",
  "restore_supply",
  "clear_mine",
  "exploit_breakthrough"
]);

function meanOrNull(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function medianOrNull(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function sampleStddev(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return Math.sqrt(finite.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (finite.length - 1));
}

function summaryStats(values) {
  return benchmarkStats(values);
}

function ratioOrNull(numerator, denominator) {
  if (numerator === null || numerator === undefined || numerator === ""
    || denominator === null || denominator === undefined || denominator === "") return null;
  return Number.isFinite(Number(numerator)) && Number.isFinite(Number(denominator)) && Number(denominator) > 0
    ? Number(numerator) / Number(denominator)
    : null;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countOrNull(value) {
  const number = numericOrNull(value);
  return number == null ? null : number;
}

function sumNumbers(values) {
  return values.reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
}

function breakdownItem(transcript, id) {
  return (transcript.summary?.victory?.breakdown || []).find((item) => item?.id === id) || null;
}

function externalSteps(transcript) {
  const side = transcript.external_side || transcript.comparison_contract?.external_side || "";
  return (transcript.model_steps || []).filter((step) => !side || step.side === side || step.controller === "external_ai");
}

function acceptedStepAction(step) {
  const applied = step.action_applied?.result?.action || step.action_applied?.action;
  if (applied) return applied;
  const accepted = (step.action_attempts || []).filter((attempt) => attempt.accepted).at(-1);
  return accepted?.action || step.final_action?.action || step.final_action || null;
}

function actionWasAccepted(step) {
  if (step.action_applied?.applied === true) return true;
  return (step.action_attempts || []).some((attempt) => attempt.accepted === true);
}

function actionWasRejectedFor(step, patterns) {
  const text = JSON.stringify({
    action: step.final_action,
    attempts: step.action_attempts,
    applied: step.action_applied
  }).toLowerCase();
  return patterns.some((pattern) => text.includes(pattern));
}

function taskEvidenceMetrics(transcript) {
  const observations = (transcript.model_steps || [])
    .map((step) => step.task_observation)
    .filter(Boolean);
  const tasks = new Map();
  const remember = (task, overwrite = true) => {
    if (!task?.id || task.observation_only) return;
    // A task ID is stable across replans. Criteria changes are task history,
    // not new tasks for completion-rate purposes.
    if (overwrite || !tasks.has(task.id)) tasks.set(task.id, task);
  };
  for (const observation of observations) {
    for (const task of observation.plan?.children || []) {
      remember(task);
    }
  }
  const final = transcript.final_task_settlement;
  const settlement = final?.child_statuses
    ? final
    : Object.values(final || {}).find((item) => item?.child_statuses);
  for (const archive of settlement?.archived_task_plans || []) {
    for (const task of archive.children || []) {
      remember(task);
    }
  }
  for (const [id, status] of Object.entries(settlement?.child_statuses || {})) {
    if (tasks.has(id)) tasks.set(id, { ...tasks.get(id), status });
  }
  for (const task of settlement?.children || []) remember(task);
  const taskList = [...tasks.values()];
  const outcomes = {
    replaced_task_count: taskList.filter((task) => task.status === "replaced").length,
    by_source: Object.fromEntries([...new Set(taskList.map((task) => task.source || "unknown"))].map((source) => {
      const group = taskList.filter((task) => (task.source || "unknown") === source);
      return [source, { total: group.length, completed: group.filter((task) => task.status === "completed").length }];
    }))
  };
  const hasCriteria = (task) => {
    const criteria = task.completion_criteria || task.observable_completion_criteria;
    return Array.isArray(criteria) ? criteria.length > 0 : !!criteria && typeof criteria === "object";
  };
  const measurable = taskList.filter((task) => hasCriteria(task) && task.verification_status !== "unverified"
    && task.completion_evidence?.status !== "unknown" && !task.completion_evidence?.validation_errors?.length);
  if (!measurable.length) {
    return { ...outcomes, available: false, evidence_coverage: taskList.length ? 0 : null,
      unverified_task_count: taskList.length,
      task_count: taskList.length, measurable_task_count: 0, progress_count: null, progress_rate: null,
      completion_rate: null, blocking_rate: null, completed_count: null, blocked_count: null };
  }
  const measurableIds = new Set(measurable.map((task) => task.id));
  const progressCount = observations.filter((observation) =>
    (measurableIds.has(observation.progress?.task_id) && observation.progress?.changed === true)
    || observation.progress?.changes?.some((change) => measurableIds.has(change.task_id)
      && (change.delta > 0 || change.status_after === "completed"))).length;
  const completed = measurable.filter((task) => task.status === "completed").length;
  const blocked = measurable.filter((task) => task.status === "blocked").length;
  return { ...outcomes, available: true, evidence_coverage: measurable.length / Math.max(1, taskList.length),
    task_count: taskList.length, measurable_task_count: measurable.length,
    unverified_task_count: taskList.length - measurable.length,
    progress_count: progressCount,
    progress_rate: progressCount / Math.max(1, observations.length),
    completion_rate: completed / measurable.length, blocking_rate: blocked / measurable.length,
    completed_count: completed, blocked_count: blocked };
}

function sumNullable(values) {
  const numeric = values.map(numericOrNull).filter((value) => value != null);
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) : null;
}

function scenarioMetrics(transcript) {
  const scenario = String(transcript.scenario || transcript.summary?.scenario || "").toLowerCase();
  const side = transcript.external_side || "";
  const steps = externalSteps(transcript);
  const taskEvidence = taskEvidenceMetrics(transcript);
  const accepted = steps.filter(actionWasAccepted);
  const actions = accepted.map(acceptedStepAction).filter(Boolean);
  const breakdown = transcript.summary?.victory?.breakdown || [];
  const scoring = breakdownItem(transcript, "july_east_of_3400");
  const mines = breakdownItem(transcript, "september_axis_cleared_mines");
  const supplyExit = breakdownItem(transcript, "october_supply_exited_west");
  const combatExit = breakdownItem(transcript, "october_combat_exited_west");
  const exits = [...(supplyExit?.units || []), ...(combatExit?.units || [])];
  const exitSet = new Set(exits);
  const countByType = (type) => actions.filter((action) => action.type === type).length;
  const legalBefore10 = steps.filter((step) => Number(step.turn || 0) <= 10 && actionWasAccepted(step)).length;
  const attemptedBefore10 = steps.filter((step) => Number(step.turn || 0) <= 10).length;
  const legalAfter10 = steps.filter((step) => Number(step.turn || 0) > 10 && actionWasAccepted(step)).length;
  const attemptedAfter10 = steps.filter((step) => Number(step.turn || 0) > 10).length;
  const eligibleExitUnits = new Set(
    steps.flatMap((step) => Array.isArray(step.movement_phase?.withdrawal_eligible_units)
      ? step.movement_phase.withdrawal_eligible_units : [])
  );
  const exitEligibilityRecorded = steps.some((step) => Array.isArray(step.movement_phase?.withdrawal_eligible_units));
  const clearAttempts = countByType("clear_mine");
  const scoredAxisMines = numericOrNull(mines?.cleared_mines)
    ?? numericOrNull(mines?.count)
    ?? (Array.isArray(mines?.mines) ? mines.mines.length : null)
    ?? (numericOrNull(mines?.points) != null ? Number(mines.points) / 3 : null);
  const clearOutcomes = accepted.filter((step) => acceptedStepAction(step)?.type === "clear_mine").map((step) => {
    const result = step.action_applied?.result;
    if (typeof result?.details?.cleared === "boolean") return result.details.cleared;
    if (typeof result?.mine_clearance?.cleared === "boolean") return result.mine_clearance.cleared;
    return result?.details?.removed?.length > 0 ? true : null;
  });
  const knownClearOutcomes = clearOutcomes.filter((outcome) => outcome !== null);
  const clearSuccesses = knownClearOutcomes.length === clearAttempts ? knownClearOutcomes.filter(Boolean).length : null;
  const exitActionCount = countByType("exit_west");
  const legalExitActionCount = actions.filter((action) => action.type === "exit_west").length;
  const withdrawalIllegal = steps.filter((step) => Number.isFinite(numericOrNull(step.turn)) && Number(step.turn) <= 10)
    .flatMap((step) => step.action_attempts || []).filter((attempt) => attempt.accepted === false
      && attempt.model_submitted !== false && isRuleRejection(attempt)
      && ["move", "move_intent"].includes(attempt.action?.type)
      && /撤退线|withdrawal.line|retreat.line/i.test(String(attempt.reason || attempt.assessment?.reason || ""))).length;
  const mineFrontierMoves = actions.filter((action) => action.type === "move"
    && (action.destination || action.path?.at?.(-1))
    && steps.some((step) => step.action_applied?.result?.action === action
      && (step.task_observation?.progress?.task_type === "clear_blocker"
        || JSON.stringify(step.task_observation || {}).toLowerCase().includes("mine")))).length;
  const base = {
    scenario,
    external_side: side,
    task_progress_rate: taskEvidence.progress_rate,
    task_completion_rate: taskEvidence.completion_rate,
    task_blocking_rate: taskEvidence.blocking_rate,
    task_evidence_available: taskEvidence.available,
    task_evidence_coverage: taskEvidence.evidence_coverage,
    task_count: taskEvidence.task_count,
    measurable_task_count: taskEvidence.measurable_task_count,
    unverified_task_count: taskEvidence.unverified_task_count,
    replaced_task_count: taskEvidence.replaced_task_count,
    task_outcomes_by_source: taskEvidence.by_source,
    axis_task_target_completion_rate: null,
    main_attack_route_progress_rate: null,
    supply_maintenance_rate: null,
    scenario_task_completion_rate: null,
    axis_scoring_threat_reduction: numericOrNull(transcript.counts?.axis_scoring_threat_reduction),
    defense_line_retention_rate: numericOrNull(transcript.counts?.defense_line_retention_rate),
    axis_supply_disruptions: countOrNull(transcript.counts?.axis_supply_disruptions),
    allied_isolation_rate: numericOrNull(transcript.counts?.allied_isolation_rate),
    effective_counterattacks: countOrNull(transcript.counts?.effective_counterattacks),
    defensive_task_completion_rate: numericOrNull(transcript.counts?.defensive_task_completion_rate),
    task_counts: {
      progress: taskEvidence.progress_count,
      completed: taskEvidence.completed_count,
      blocked: taskEvidence.blocked_count,
      triggered: taskEvidence.task_count
    }
  };
  if (scenario === "july") {
    const farthest = numericOrNull(scoring?.farthest_column);
    const target = numericOrNull(transcript.comparison_contract?.policy_config?.strategy?.target_column)
      ?? numericOrNull(scoring?.next_scoring_column);
    const suppliedAdvance = numericOrNull(transcript.counts?.supplied_scoring_advances);
    return {
      ...base,
      scoring_frontier: { reached_column: farthest, next_target_column: target, vp_points: numericOrNull(scoring?.points) },
      effective_scoring_column: side === "axis" ? farthest : null,
      opponent_scoring_column: side === "allies" ? farthest : null,
      next_scoring_column_entry: target == null ? null : farthest != null && farthest >= target,
      supplied_scoring_advance_count: suppliedAdvance,
      supplied_scoring_advance_rate: suppliedAdvance == null ? null : ratioOrNull(suppliedAdvance, actions.filter((action) => action.type === "move").length),
      axis_breakthrough_progress_rate: numericOrNull(transcript.counts?.axis_breakthrough_progress_rate),
      allies_scoring_entry_block_rate: numericOrNull(transcript.counts?.allies_scoring_entry_block_rate),
      july_only: true
    };
  }
  if (scenario === "september") {
    const mainForcePassage = numericOrNull(transcript.counts?.main_force_passage_after_clearance);
    return {
      ...base,
      mine_clear_attempts: clearAttempts,
      mine_clear_successes: clearSuccesses,
      mine_clear_success_rate: ratioOrNull(clearSuccesses, clearAttempts),
      mine_clear_known_successes: knownClearOutcomes.filter(Boolean).length,
      mine_clear_unknown_outcomes: clearAttempts - knownClearOutcomes.length,
      mine_clear_evidence_coverage: ratioOrNull(knownClearOutcomes.length, clearAttempts),
      scored_axis_mines_cleared: side === "axis" ? scoredAxisMines : null,
      opponent_axis_mines_cleared: side === "allies" ? scoredAxisMines : null,
      clearance_to_main_force_passage_rate: mainForcePassage,
      minefield_frontier_unproductive_movement_rate: ratioOrNull(numericOrNull(transcript.counts?.mine_frontier_unproductive_moves), actions.filter((action) => action.type === "move").length),
      engineer_task_completion_rate: numericOrNull(transcript.counts?.engineer_task_completion_rate),
      mine_route_blockages: numericOrNull(transcript.counts?.mine_route_blockages),
      september_only: true
    };
  }
  if (scenario === "october") {
    const eligible = exitEligibilityRecorded ? eligibleExitUnits.size : numericOrNull(transcript.counts?.eligible_withdrawal_units);
    const externalExits = actions.filter((action) => action.type === "exit_west");
    const externalExitUnits = new Set(externalExits.map((action) => action.unit).filter(Boolean));
    const scoredAxisWithdrawalVp = sumNullable([supplyExit?.points, combatExit?.points]);
    return {
      ...base,
      legal_west_exit_count: legalExitActionCount,
      exited_unit_count: externalExitUnits.size,
      withdrawal_vp: side === "axis" ? scoredAxisWithdrawalVp : null,
      scored_axis_withdrawal_vp: side === "axis" ? scoredAxisWithdrawalVp : null,
      scored_axis_exited_unit_count: side === "axis" ? exitSet.size : null,
      opponent_axis_withdrawal_vp: side === "allies" ? scoredAxisWithdrawalVp : null,
      opponent_axis_exited_unit_count: side === "allies" ? exitSet.size : null,
      eligible_withdrawal_unit_count: eligible,
      eligible_unit_action_coverage_rate: ratioOrNull(new Set(actions.filter((action) => action.type === "exit_west").map((action) => action.unit)).size, eligible),
      withdrawal_route_completion_rate: numericOrNull(transcript.counts?.withdrawal_route_completion_rate),
      legal_action_ratio_before_turn_10: ratioOrNull(legalBefore10, attemptedBefore10),
      legal_action_ratio_after_turn_10: ratioOrNull(legalAfter10, attemptedAfter10),
      withdrawal_line_illegal_movement_count: withdrawalIllegal,
      post_turn_10_withdrawal_task_completion_rate: numericOrNull(transcript.counts?.post_turn_10_withdrawal_task_completion_rate),
      october_only: true,
      // Kept as diagnostics for future transcripts; it is intentionally not
      // interpreted as a July scoring-column metric.
      attempted_exit_actions: exitActionCount
    };
  }
  return base;
}

function aggregateScenarioMetric(rows, key) {
  const values = rows.map((row) => {
    const value = row.scenario_metrics?.[key];
    return typeof value === "boolean" ? (value ? 1 : 0) : value;
  }).filter(Number.isFinite);
  return summaryStats(values);
}

function scenarioMetricKeys(rows) {
  return [...new Set(rows.flatMap((row) => Object.entries(row.scenario_metrics || {})
    .filter(([, value]) => typeof value === "boolean" || Number.isFinite(value))
    .map(([key]) => key)))];
}

function aggregateScenarioRows(rows, scenario) {
  const selected = rows.filter((row) => row.scenario === scenario);
  const sides = {};
  for (const side of ["axis", "allies"]) {
    const sideRows = selected.filter((row) => row.external_side === side);
    sides[side] = {
      runs: sideRows.length,
      final_vp: summaryStats(sideRows.map((row) => row.final_vp)),
      vp_delta: summaryStats(sideRows.map((row) => row.vp_delta)),
      side_adjusted_vp_gain: summaryStats(sideRows.map((row) => row.side_adjusted_vp_gain)),
      metrics: Object.fromEntries(scenarioMetricKeys(sideRows).map((key) => [key, aggregateScenarioMetric(sideRows, key)]))
    };
  }
  return {
    runs: selected.length,
    final_vp: summaryStats(selected.map((row) => row.final_vp)),
    vp_delta: summaryStats(selected.map((row) => row.vp_delta)),
    by_side: sides,
    metrics: Object.fromEntries(scenarioMetricKeys(selected).map((key) => [key, aggregateScenarioMetric(selected, key)]))
  };
}

function commonCategoryReport(runs, selector, options = {}) {
  const selected = runs.filter((run) => !selector || selector(run));
  const complete = selected.filter((run) => run.complete_game && Number.isFinite(run.final_vp));
  const clean = complete.filter((run) => run.sample_status === "clean");
  const pureModel = complete.filter((run) => Number(run.fallback_actions || 0) === 0 && Number(run.network_failures || 0) === 0);
  const readPath = (run, path) => path.split(".").reduce((value, part) => value?.[part], run);
  const metric = (key, source = selected) => summaryStats(source.map((run) => readPath(run, key)).filter(Number.isFinite));
  return {
    runs: selected.length,
    complete_games: complete.length,
    end_to_end: { final_vp: metric("final_vp", complete), vp_delta: metric("vp_delta", complete), side_adjusted_vp_gain: metric("side_adjusted_vp_gain", complete) },
    clean: { final_vp: metric("final_vp", clean), vp_delta: metric("vp_delta", clean), side_adjusted_vp_gain: metric("side_adjusted_vp_gain", clean) },
    pure_model: { final_vp: metric("final_vp", pureModel), vp_delta: metric("vp_delta", pureModel), side_adjusted_vp_gain: metric("side_adjusted_vp_gain", pureModel) },
    action_rejection_rate: metric("action_rejection_rate"),
    low_odds_attack_rate: metric("low_odds_attack_rate"),
    fallback_rate: metric("fallback_rate"),
    network_failures: sumNumbers(selected.map((run) => run.network_failures)),
    retries: sumNumbers(selected.map((run) => run.retries)),
    circuit_open_events: sumNumbers(selected.map((run) => run.circuit_open_events)),
    input_tokens: metric("input_tokens"),
    output_tokens: metric("output_tokens"),
    cache_tokens: metric("cache_tokens"),
    cache_hit_rate: metric("cache_hit_rate"),
    requests: metric("requests"),
    effective_action_token_cost: metric("effective_action_token_cost"),
    p50_latency_ms: metric("p50_latency_ms"),
    p95_latency_ms: metric("p95_latency_ms"),
    task_progress_rate: metric("scenario_metrics.task_progress_rate"),
    task_completion_rate: metric("scenario_metrics.task_completion_rate"),
    task_blocking_rate: metric("scenario_metrics.task_blocking_rate")
  };
}

function baselineKey(run) {
  return `${run.scenario}:${run.external_side}:${run.seed}:${run.replicate}`;
}

function buildBaselineComparison(runs, baselineRuns = []) {
  const baselines = new Map();
  for (const baseline of baselineRuns) {
    const row = deterministicRunMetrics(baseline);
    // A baseline must be a rules-vs-rules run. An external-agent transcript
    // is never silently treated as the reference controller.
    const isRulesVsRules = row.axis_controller === "rules_ai" && row.allies_controller === "rules_ai";
    if (isRulesVsRules && row.complete_game && row.artifact_group_hashes && Number.isFinite(row.final_vp)
      && Number(baseline.counts?.illegal_actions || 0) === 0) {
      for (const external_side of row.external_side ? [row.external_side] : ["axis", "allies"]) {
        const key = baselineKey({ ...row, external_side });
        const candidates = baselines.get(key) || [];
        candidates.push(row);
        baselines.set(key, candidates);
      }
    }
  }
  const pairs = runs.map((run) => {
    const candidates = (baselines.get(baselineKey(run)) || []).filter((row) =>
      row.artifact_group_hashes && run.artifact_group_hashes
      && row.benchmark_version === run.benchmark_version
      && row.artifact_group_hashes.rules === run.artifact_group_hashes.rules
      && row.artifact_group_hashes.opponent === run.artifact_group_hashes.opponent);
    const baseline = candidates.length === 1 ? candidates[0] : null;
    return {
      experiment_id: run.experiment_id,
      key: baselineKey(run),
      baseline_experiment_id: baseline?.experiment_id || null,
      matched: Boolean(baseline),
      exclusion_reason: baseline ? null : candidates.length > 1 ? "duplicate_matching_baselines" : "matching_rule_and_opponent_baseline_missing",
      agent_final_vp: run.final_vp,
      baseline_final_vp: baseline?.final_vp ?? null,
      agent_minus_rules_ai_vp: baseline && Number.isFinite(run.final_vp) ? run.final_vp - baseline.final_vp : null,
      side_adjusted_baseline_gain: baseline && Number.isFinite(run.final_vp)
        ? (run.external_side === "allies" ? -1 : 1) * (run.final_vp - baseline.final_vp) : null,
      agent_vp_delta: run.vp_delta,
      baseline_vp_delta: baseline?.vp_delta ?? null,
      agent_minus_rules_ai_vp_delta: baseline && Number.isFinite(run.vp_delta) && Number.isFinite(baseline.vp_delta)
        ? run.vp_delta - baseline.vp_delta : null,
      same_scenario_side_seed_replicate: Boolean(baseline)
    };
  });
  const matched = pairs.filter((pair) => pair.matched);
  return {
    baseline_runs_supplied: baselineRuns.length,
    matched_pairs: matched.length,
    unmatched_runs: pairs.length - matched.length,
    paired_vp_difference: summaryStats(matched.map((pair) => pair.agent_minus_rules_ai_vp)),
    paired_side_adjusted_gain: summaryStats(matched.map((pair) => pair.side_adjusted_baseline_gain)),
    paired_vp_delta_difference: summaryStats(matched.map((pair) => pair.agent_minus_rules_ai_vp_delta)),
    pairs
  };
}

function isCompleteGame(transcript, config = {}) {
  const statuses = new Set(config.statuses || ["final_victory"]);
  if (!statuses.has(transcript.status)) return false;
  return config.require_final_victory_flag === false || transcript.summary?.victory?.final === true;
}

function actionAttempts(transcript) {
  const seen = new Set();
  return (transcript.model_steps || []).flatMap((step) => (step.action_attempts || [])
    .filter((attempt) => {
      if (attempt.model_submitted === false) return false;
      if (attempt.event_id && seen.has(attempt.event_id)) return false;
      if (attempt.event_id) seen.add(attempt.event_id);
      return true;
    }).map((attempt) => ({ step, attempt })));
}

function isRuleRejection(attempt) {
  if (attempt?.accepted !== false) return false;
  // New transcripts classify policy/advisory outcomes explicitly. Legacy
  // transcripts without a class are treated as rule rejections for backward
  // compatibility.
  return !["strategy", "policy", "advisory"].includes(String(attempt.rejection_type || "").toLowerCase());
}

function actionType(record) {
  return record.attempt?.action?.type
    || record.attempt?.assessment?.action?.type
    || "";
}

function combatOdds(record) {
  return record.attempt?.assessment?.evaluation?.odds_column
    || record.attempt?.assessment?.action?.verdict?.details?.odds_column
    || record.attempt?.action?.verdict?.details?.odds_column
    || "";
}

function oddsBelowTwoToOne(value) {
  const match = String(value || "").match(/^(\d+)\s*[-:]\s*(\d+)$/);
  return !!match && Number(match[2]) > 0 && Number(match[1]) / Number(match[2]) < 2;
}

function deterministicRunMetrics(transcript, config = {}) {
  const attempts = actionAttempts(transcript);
  const hasExecutionLedger = !!transcript.execution_ledger_summary
    || (transcript.model_steps || []).some((step) => step.execution_ledger);
  // Phase ledgers cover movement, while combat uses direct tool submissions.
  // The submitted events span both; local bridge calls must not enter this denominator.
  const hasAttemptEvents = (transcript.model_steps || []).some((step) => Array.isArray(step.action_attempts));
  const ledgerSubmitted = numericOrNull(transcript.execution_ledger_summary?.model_submitted_actions);
  const submittedActions = hasExecutionLedger && hasAttemptEvents ? attempts.length
    : hasExecutionLedger && Number.isFinite(ledgerSubmitted) ? ledgerSubmitted
    : hasExecutionLedger ? attempts.length : Number(transcript.counts?.act_calls ?? attempts.length);
  const ledgerRejected = numericOrNull(transcript.execution_ledger_summary?.model_rule_rejections);
  const rejectedActions = hasExecutionLedger && hasAttemptEvents ? attempts.filter(({ attempt }) => isRuleRejection(attempt)).length
    : hasExecutionLedger && Number.isFinite(ledgerRejected) ? ledgerRejected
    : hasExecutionLedger ? attempts.filter(({ attempt }) => isRuleRejection(attempt)).length
    : Number(transcript.counts?.rule_invalid_action_attempts
      ?? transcript.counts?.invalid_action_attempts
      ?? attempts.filter(({ attempt }) => !attempt.accepted).length);
  const policyRejectedActions = hasExecutionLedger
    ? attempts.filter(({ attempt }) => attempt.accepted === false && !isRuleRejection(attempt)).length
    : 0;
  const autonomousAttacks = attempts.filter((record) => (
    record.attempt.accepted
    && !record.step.fallback_used
    && actionType(record) === "combat"
  ));
  const lowOddsAttacks = autonomousAttacks.filter((record) => oddsBelowTwoToOne(combatOdds(record))).length;
  const complete = isCompleteGame(transcript, config.complete_game || config);
  const victoryPoints = numericOrNull(transcript.summary?.victory?.victory_points);
  const scenario = transcript.scenario || transcript.summary?.scenario || "";
  const externalSide = transcript.external_side || "";
  const axisController = transcript.axis_controller || transcript.controllers?.axis || (externalSide === "axis" ? "external_ai" : "rules_ai");
  const alliesController = transcript.allies_controller || transcript.controllers?.allies || (externalSide === "allies" ? "external_ai" : "rules_ai");
  const harness = transcript.harness || "legacy";
  const decisionPolicy = transcript.decision_mode || "legacy";
  const modelProfile = transcript.model_profile || transcript.model?.model || "legacy";
  const recordedBaseline = numericOrNull(transcript.summary?.victory?.breakdown
    ?.find((item) => item.id === "scenario_start")?.points);
  const vpBaseline = Number.isFinite(recordedBaseline)
    ? recordedBaseline
    : RulesEngine.scenarioStartingVp(scenario, 0);
  const vpDelta = complete && Number.isFinite(victoryPoints) ? victoryPoints - vpBaseline : null;
  const sideAdjustedVpGain = Number.isFinite(vpDelta)
    ? externalSide === "allies" ? -vpDelta : vpDelta
    : null;
  const inputTokens = Number(transcript.model_usage?.input_tokens || 0);
  const cacheTokens = Number(transcript.model_usage?.cache_tokens || 0);
  const componentTransports = Object.values(transcript.model_transport_by_component || {});
  const transportRecords = componentTransports.length ? componentTransports.flat() : transcript.model_transport || [];
  const requests = componentTransports.length
    ? componentTransports.reduce((sum, records) => sum + (Array.isArray(records) ? records.length : 0), 0)
    : (transcript.model_transport || []).length + (transcript.task_checker_transport || []).length
      || Number(transcript.counts?.model_requests || 0);
  const fallbackActions = Number(transcript.counts?.fallback_actions || 0);
  const networkFailures = Number(transcript.counts?.transport_failures || 0);
  const scenarioRunMetrics = scenarioMetrics(transcript);
  const manifest = { ...(transcript.artifact_manifest || transcript.comparison_contract?.artifact_manifest),
    artifact_manifest_hash: transcript.artifact_manifest_hash || transcript.comparison_contract?.artifact_manifest_hash };
  return {
    experiment_id: transcript.experiment_id || "",
    scenario,
    external_side: externalSide,
    axis_controller: axisController,
    allies_controller: alliesController,
    controllers: { axis: axisController, allies: alliesController },
    seed: transcript.seed ?? null,
    replicate: transcript.replicate ?? 1,
    harness,
    decision_policy: decisionPolicy,
    model_profile: modelProfile,
    scenario_side: `${scenario}:${externalSide}`,
    comparison_cell: `${scenario}:axis-${axisController}:allies-${alliesController}:${harness}:${decisionPolicy}:${modelProfile}`,
    comparison_contract_hash: transcript.comparison_contract_hash || "",
    benchmark_version: transcript.benchmark_version || transcript.comparison_contract?.benchmark_version || "",
    artifact_manifest_hash: transcript.artifact_manifest_hash || transcript.comparison_contract?.artifact_manifest_hash || "",
    artifact_group_hashes: artifactGroupHashes(manifest),
    reproducibility: artifactReproducibility(manifest),
    allocation_metrics: allocationCorrectionMetrics(transcript.model_steps),
    complete_game: complete,
    sample_status: infrastructureStatus(transcript),
    ranking_eligible: rankingEligible(transcript),
    ranking_eligibility_reasons: rankingEligibilityReasons(transcript),
    final_vp: complete && Number.isFinite(victoryPoints) ? victoryPoints : null,
    vp_baseline: vpBaseline,
    vp_delta: vpDelta,
    side_adjusted_vp_gain: sideAdjustedVpGain,
    submitted_actions: submittedActions,
    rejected_actions: rejectedActions,
    action_attempt_evidence_source: hasExecutionLedger
      ? hasAttemptEvents ? "deduplicated_model_submission_events_all_phases" : "movement_ledger_only"
      : "legacy_recorded_counts",
    policy_rejected_actions: policyRejectedActions,
    action_rejection_rate: ratioOrNull(rejectedActions, submittedActions),
    autonomous_attacks: autonomousAttacks.length,
    low_odds_attacks: lowOddsAttacks,
    low_odds_attack_rate: ratioOrNull(lowOddsAttacks, autonomousAttacks.length),
    fallback_rate: ratioOrNull(fallbackActions, Number(transcript.model_steps?.length || 0)),
    fallback_actions: fallbackActions,
    network_failures: networkFailures,
    retries: Number(transcript.counts?.retry_attempts || 0),
    circuit_open_events: Number(transcript.counts?.circuit_open_events ?? transcript.transport_health?.circuit_open_events ?? 0),
    input_tokens: inputTokens,
    output_tokens: Number(transcript.model_usage?.output_tokens || 0),
    cache_tokens: cacheTokens,
    cache_hit_rate: ratioOrNull(cacheTokens, inputTokens),
    requests,
    request_wall_latency_ms: {
      all: summaryStats(transportRecords.map((record) => numericOrNull(record.elapsed_ms))),
      clean: summaryStats(transportRecords.filter((record) => !record.environment_pauses?.length
        && record.clean_latency_eligible !== false && (!record.error_class || record.error_class === "none"))
        .map((record) => numericOrNull(record.elapsed_ms))),
      environment_pause_requests: transportRecords.filter((record) => record.environment_pauses?.length).length,
      definition: "client_wall_clock; not_server_reasoning_time"
    },
    effective_action_token_cost: ratioOrNull(inputTokens + Number(transcript.model_usage?.output_tokens || 0), Number(transcript.counts?.accepted_actions || submittedActions)),
    p50_latency_ms: medianOrNull((transcript.model_steps || []).map((step) => numericOrNull(step.provider_result?.elapsed_ms)).filter(Number.isFinite)),
    p95_latency_ms: (() => {
      const values = (transcript.model_steps || []).map((step) => numericOrNull(step.provider_result?.elapsed_ms)).filter(Number.isFinite).sort((a, b) => a - b);
      return values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * 0.95))] : null;
    })(),
    scenario_metrics: scenarioRunMetrics,
    execution_ledger: transcript.execution_ledger_summary ? Object.fromEntries(Object.entries(transcript.execution_ledger_summary)
      .filter(([key]) => !["plans", "events"].includes(key))) : reconstructLegacyPlans(transcript.model_steps || []),
    opportunity_ledger: summarizeOpportunityEvidence(transcript.opportunity_ledger),
    request_attribution: transcript.model_requests_by_stage || null,
    goal_evaluations: transcript.final_task_settlements || transcript.final_task_settlement || null,
    judge: null
  };
}

function compactAction(action = {}) {
  return {
    type: action.type || "",
    unit: action.unit || "",
    destination: action.destination || action.path?.at?.(-1) || "",
    attackers: action.attackers || [],
    defender_hexes: action.defender_hexes || [],
    reason: String(action.reason || "").slice(0, 160)
  };
}

function compactTaskContext(step = {}) {
  const observation = step.task_observation;
  const plan = observation?.plan || step.operation_state?.task_plan;
  if (!observation && !plan) return null;
  return {
    parent: plan?.parent ? {
      id: plan.parent.id || "",
      objective: plan.parent.objective || "",
      state: plan.parent.state || "",
      completion_condition: plan.parent.completion_condition || "",
      failure_condition: plan.parent.failure_condition || ""
    } : null,
    active_tasks: (plan?.children || [])
      .filter((task) => task.status === "active")
      .map((task) => ({
        id: task.id,
        type: task.type,
        title: task.title,
        priority: task.priority,
        assigned_units: task.assigned_units || [],
        progress: task.progress || 0,
        next_action: task.next_action || ""
      })),
    events: observation?.events || [],
    progress: observation?.progress || null,
    checker: observation?.check?.result || null
  };
}

function compactStep(step, gameLogItem) {
  const accepted = (step.action_attempts || []).filter((attempt) => attempt.accepted).at(-1);
  return {
    step: Number(step.step),
    phase: step.phase || "",
    phase_intent: step.phase_intent?.value || step.phase_intent || null,
    task_context: compactTaskContext(step),
    planned_orders: (step.phase_unit_plan?.unit_orders || []).map((order) => ({
      unit: order.unit,
      disposition: order.disposition,
      target_hex: order.target_hex,
      role: order.role,
      priority: order.priority
    })),
    chosen_action: compactAction(accepted?.action || step.final_action || {}),
    accepted_assessment: accepted?.assessment ? {
      score: accepted.assessment.score ?? null,
      odds_column: accepted.assessment.evaluation?.odds_column || accepted.assessment.action?.verdict?.details?.odds_column || "",
      summary: accepted.assessment.evaluation?.summary || "",
      tactical_tags: accepted.assessment.evaluation?.tactical_tags || [],
      risks: accepted.assessment.evaluation?.risks || []
    } : null,
    rejected_proposals: (step.action_attempts || []).filter((attempt) => !attempt.accepted).map((attempt) => ({
      action: compactAction(attempt.action),
      reason: String(attempt.reason || attempt.issues?.[0] || "").slice(0, 180)
    })),
    candidates: (step.candidates || []).slice(0, 6),
    fallback_used: !!step.fallback_used,
    local_fast_pass: !!step.local_fast_pass,
    game_result: gameLogItem?.result || null
  };
}

function buildActionWindows(transcript) {
  const gameLog = new Map((transcript.game_log || [])
    .filter((item) => Number.isInteger(Number(item.step)))
    .map((item) => [Number(item.step), item]));
  const groups = new Map();
  for (const step of transcript.model_steps || []) {
    const turn = Number(step.turn || gameLog.get(Number(step.step))?.turn || 0);
    const side = step.side || transcript.external_side || "unknown";
    const key = `${turn}:${side}`;
    if (!groups.has(key)) groups.set(key, { turn, side, steps: [] });
    groups.get(key).steps.push(compactStep(step, gameLog.get(Number(step.step))));
  }
  return [...groups.values()]
    .sort((left, right) => left.turn - right.turn || left.side.localeCompare(right.side))
    .map((group) => ({
      window_id: `${transcript.experiment_id || "run"}:turn-${group.turn}:${group.side}`,
      experiment_id: transcript.experiment_id || "",
      scenario: transcript.scenario || transcript.summary?.scenario || "",
      side: group.side,
      turn: group.turn,
      victory_conditions: transcript.comparison_contract?.policy_config?.strategy?.phaseObjectives || null,
      actions: group.steps.sort((left, right) => left.step - right.step)
    }));
}

function validateJudgeResult(raw, window) {
  const value = raw?.type === "research_metric_judgment" ? raw : raw?.judgment || raw;
  if (!value || typeof value !== "object") throw new Error("judge result must be an object");
  const decisions = [];
  const seen = new Set();
  const seenEvidence = new Set();
  for (const [index, item] of (Array.isArray(value.opportunity_decisions) ? value.opportunity_decisions : []).entries()) {
    if (!OPPORTUNITY_TYPES.has(item?.opportunity_type)) throw new Error(`invalid opportunity_type ${item?.opportunity_type || "<missing>"}`);
    const abstain = item?.abstain === true || item?.opportunity_status === "uncertain";
    const severity = item.severity == null ? null : Number(item.severity);
    if (!abstain && (!Number.isInteger(severity) || severity < 0 || severity > 3)) {
      throw new Error("opportunity severity must be an integer from 0 to 3");
    }
    if (abstain && severity !== null && (!Number.isInteger(severity) || severity !== 0)) {
      throw new Error("abstained opportunity severity must be null or 0");
    }
    const confidence = item.confidence == null ? 1 : Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("opportunity confidence must be from 0 to 1");
    const step = Number(item.step);
    if (!window.actions.some((action) => action.step === step)) throw new Error(`opportunity step ${step} is outside the action window`);
    const decisionId = String(item.decision_id || `${window.window_id}:opportunity-${index + 1}`);
    if (seen.has(decisionId)) throw new Error(`duplicate opportunity decision_id ${decisionId}`);
    seen.add(decisionId);
    const rawEvidenceRefs = Array.isArray(item.evidence_refs) ? item.evidence_refs : [];
    if (!abstain && rawEvidenceRefs.length === 0) {
      throw new Error("confirmed opportunity requires evidence_refs");
    }
    const evidenceRefs = rawEvidenceRefs.map((ref) => {
      const refStep = Number(ref?.step ?? step);
      if (!window.actions.some((action) => action.step === refStep)) throw new Error(`evidence step ${refStep} is outside the action window`);
      return {
        step: refStep,
        unit_ids: Array.isArray(ref?.unit_ids) ? ref.unit_ids.map(String).slice(0, 12) : [],
        target_hexes: Array.isArray(ref?.target_hexes) ? ref.target_hexes.map(String).slice(0, 12) : []
      };
    });
    if (!abstain) {
      const evidenceKey = JSON.stringify({
        opportunity_type: item.opportunity_type,
        evidence_refs: evidenceRefs.map((ref) => ({
          step: ref.step,
          unit_ids: [...new Set(ref.unit_ids)].sort(),
          target_hexes: [...new Set(ref.target_hexes)].sort()
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      });
      if (seenEvidence.has(evidenceKey)) throw new Error("duplicate opportunity evidence");
      seenEvidence.add(evidenceKey);
    }
    decisions.push({
      decision_id: decisionId,
      step,
      opportunity_type: item.opportunity_type,
      severity,
      opportunity_status: abstain
        ? "uncertain"
        : item.opportunity_status === "converted" || severity === 0 ? "converted" : "missed",
      confidence,
      abstain,
      evidence_refs: evidenceRefs,
      opportunity_evidence: String(item.opportunity_evidence || "").slice(0, 500),
      chosen_action_evidence: String(item.chosen_action_evidence || "").slice(0, 500),
      rationale: String(item.rationale || "").slice(0, 500)
    });
  }
  const coherence = value.plan_coherence;
  const coherenceAbstain = coherence?.abstain === true;
  const score = coherence?.score == null ? null : Number(coherence.score);
  if (!coherenceAbstain && (!Number.isInteger(score) || score < 1 || score > 5)) throw new Error("plan coherence score must be an integer from 1 to 5");
  const coherenceEvidence = String(coherence?.evidence || "").trim();
  if (!coherenceAbstain && !coherenceEvidence) throw new Error("plan coherence requires evidence");
  const coherenceConfidence = coherence?.confidence == null ? 1 : Number(coherence.confidence);
  if (!Number.isFinite(coherenceConfidence) || coherenceConfidence < 0 || coherenceConfidence > 1) throw new Error("plan coherence confidence must be from 0 to 1");
  return {
    type: "research_metric_judgment",
    window_id: window.window_id,
    opportunity_decisions: decisions,
    plan_coherence: {
      score,
      abstain: coherenceAbstain,
      confidence: coherenceConfidence,
      evidence: coherenceEvidence.slice(0, 800),
      rationale: String(coherence.rationale || "").slice(0, 500)
    }
  };
}

function attachJudgeResults(run, windows, results) {
  const valid = results.filter((item) => item?.judgment);
  const opportunities = valid.flatMap((item) => item.judgment.opportunity_decisions)
    .filter((item) => !item.abstain && item.opportunity_status !== "uncertain");
  const opportunityAbstentions = valid.flatMap((item) => item.judgment.opportunity_decisions)
    .filter((item) => item.abstain || item.opportunity_status === "uncertain");
  const convertedOpportunities = opportunities.filter((item) => item.opportunity_status === "converted" || item.severity === 0);
  const missedOpportunities = opportunities.filter((item) => item.opportunity_status === "missed" || item.severity > 0);
  const coherence = valid.map((item) => item.judgment.plan_coherence).filter((item) => !item.abstain && Number.isFinite(item.score));
  run.judge = {
    expected_windows: windows.length,
    judged_windows: valid.length,
    judge_coverage: ratioOrNull(valid.length, windows.length),
    opportunity_decision_points: opportunities.length,
    missed_opportunity_severity_sum: opportunities.reduce((sum, item) => sum + item.severity, 0),
    missed_opportunity_severity: meanOrNull(opportunities.map((item) => item.severity)),
    conditional_missed_opportunity_severity: meanOrNull(missedOpportunities.map((item) => item.severity)),
    missed_opportunity_count: missedOpportunities.length,
    converted_opportunity_count: convertedOpportunities.length,
    opportunity_conversion_rate: ratioOrNull(convertedOpportunities.length, opportunities.length),
    opportunity_abstentions: opportunityAbstentions.length,
    opportunity_confidence: meanOrNull(opportunities.map((item) => item.confidence)),
    action_windows: coherence.length,
    multi_step_plan_coherence: meanOrNull(coherence.map((item) => item.score)),
    plan_coherence_confidence: meanOrNull(coherence.map((item) => item.confidence)),
    plan_coherence_abstentions: valid.filter((item) => item.judgment.plan_coherence.abstain).length,
    windows: results
  };
  return run;
}

function aggregateRuns(runs, key) {
  const groups = new Map();
  for (const run of runs) {
    const value = run[key] || "<missing>";
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(run);
  }
  return [...groups.entries()].map(([value, rows]) => {
    const complete = rows.filter((row) => row.complete_game && Number.isFinite(row.final_vp));
    const ranked = complete.filter((row) => row.ranking_eligible);
    const scenarios = [...new Set(rows.map((row) => row.scenario))];
    const externalSides = [...new Set(rows.map((row) => row.external_side))];
    const controllerPairs = [...new Set(rows.map((row) => `axis-${row.axis_controller}:allies-${row.allies_controller}`))];
    const submitted = rows.reduce((sum, row) => sum + row.submitted_actions, 0);
    const rejected = rows.reduce((sum, row) => sum + row.rejected_actions, 0);
    const attacks = rows.reduce((sum, row) => sum + row.autonomous_attacks, 0);
    const lowOdds = rows.reduce((sum, row) => sum + row.low_odds_attacks, 0);
    const opportunityPoints = rows.reduce((sum, row) => sum + Number(row.judge?.opportunity_decision_points || 0), 0);
    const opportunitySeverity = rows.reduce((sum, row) => sum + Number(row.judge?.missed_opportunity_severity_sum || 0), 0);
    const missedOpportunityCount = rows.reduce((sum, row) => sum + Number(row.judge?.missed_opportunity_count || 0), 0);
    const convertedOpportunityCount = rows.reduce((sum, row) => sum + Number(row.judge?.converted_opportunity_count || 0), 0);
    const opportunityAbstentions = rows.reduce((sum, row) => sum + Number(row.judge?.opportunity_abstentions || 0), 0);
    const opportunityConfidences = rows.flatMap((row) => (row.judge?.windows || [])
      .flatMap((window) => window.judgment?.opportunity_decisions || [])
      .filter((item) => !item.abstain && item.opportunity_status !== "uncertain" && Number.isFinite(item.confidence))
      .map((item) => item.confidence));
    const coherenceScores = rows.flatMap((row) => (row.judge?.windows || [])
      .filter((window) => window.judgment && !window.judgment.plan_coherence?.abstain)
      .map((window) => window.judgment.plan_coherence.score));
    const coherenceConfidences = rows.flatMap((row) => (row.judge?.windows || [])
      .map((window) => window.judgment?.plan_coherence)
      .filter((item) => item && !item.abstain && Number.isFinite(item.confidence))
      .map((item) => item.confidence));
    const coherenceAbstentions = rows.reduce((sum, row) => sum + Number(row.judge?.plan_coherence_abstentions || 0), 0);
    const expectedWindows = rows.reduce((sum, row) => sum + Number(row.judge?.expected_windows || 0), 0);
    const judgedWindows = rows.reduce((sum, row) => sum + Number(row.judge?.judged_windows || 0), 0);
    return {
      [key]: value,
      runs: rows.length,
      scenarios,
      external_sides: externalSides,
      controller_pairs: controllerPairs,
      comparable_game_condition: scenarios.length === 1 && externalSides.length <= 1 && controllerPairs.length === 1,
      comparison_warnings: [
        ...(scenarios.length > 1 ? [`mixed scenarios: ${scenarios.join(", ")}`] : []),
        ...(externalSides.length > 1 ? [`mixed external sides: ${externalSides.join(", ")}`] : []),
        ...(controllerPairs.length > 1 ? [`mixed controller pairs: ${controllerPairs.join(", ")}`] : [])
      ],
      complete_games: complete.length,
      ranking_eligible_games: ranked.length,
      sample_statuses: [...new Set(rows.map((row) => row.sample_status))],
      raw_vp_stats: summaryStats(complete.map((row) => row.final_vp)),
      vp_stats: summaryStats(ranked.map((row) => row.final_vp)),
      average_vp: meanOrNull(ranked.map((row) => row.final_vp)),
      raw_final_vp_sum: complete.reduce((sum, row) => sum + row.final_vp, 0),
      ranking_final_vp_sum: ranked.reduce((sum, row) => sum + row.final_vp, 0),
      final_vp_sum: ranked.reduce((sum, row) => sum + row.final_vp, 0),
      raw_average_vp: meanOrNull(complete.map((row) => row.final_vp)),
      average_vp_delta: meanOrNull(ranked.map((row) => row.vp_delta)),
      raw_vp_delta_sum: complete.reduce((sum, row) => sum + (Number.isFinite(row.vp_delta) ? row.vp_delta : 0), 0),
      ranking_vp_delta_sum: ranked.reduce((sum, row) => sum + (Number.isFinite(row.vp_delta) ? row.vp_delta : 0), 0),
      vp_delta_sum: ranked.reduce((sum, row) => sum + (Number.isFinite(row.vp_delta) ? row.vp_delta : 0), 0),
      average_side_adjusted_vp_gain: meanOrNull(ranked.map((row) => row.side_adjusted_vp_gain)),
      submitted_actions: submitted,
      rejected_actions: rejected,
      action_rejection_rate: ratioOrNull(rejected, submitted),
      autonomous_attacks: attacks,
      low_odds_attacks: lowOdds,
      low_odds_attack_rate: ratioOrNull(lowOdds, attacks),
      opportunity_decision_points: opportunityPoints,
      missed_opportunity_severity_sum: opportunitySeverity,
      missed_opportunity_severity: ratioOrNull(opportunitySeverity, opportunityPoints),
      conditional_missed_opportunity_severity: ratioOrNull(opportunitySeverity, missedOpportunityCount),
      missed_opportunity_count: missedOpportunityCount,
      converted_opportunity_count: convertedOpportunityCount,
      opportunity_conversion_rate: ratioOrNull(convertedOpportunityCount, opportunityPoints),
      opportunity_abstentions: opportunityAbstentions,
      opportunity_confidence: meanOrNull(opportunityConfidences),
      action_windows: coherenceScores.length,
      multi_step_plan_coherence: meanOrNull(coherenceScores),
      plan_coherence_confidence: meanOrNull(coherenceConfidences),
      plan_coherence_abstentions: coherenceAbstentions,
      judge_expected_windows: expectedWindows,
      judge_completed_windows: judgedWindows,
      judge_coverage: ratioOrNull(judgedWindows, expectedWindows)
    };
  });
}

function buildResearchReport(runs, metadata = {}) {
  const baselineRuns = metadata.baseline_runs || [];
  const reportMetadata = { ...metadata };
  delete reportMetadata.baseline_runs;
  delete reportMetadata.category_selector;
  const rankingEligibleRuns = runs.filter((run) => run.ranking_eligible);
  const cleanRuns = rankingEligibleRuns.filter((run) => run.sample_status === "clean");
  const categorySelector = metadata.category_selector;
  const scenarioMetrics = {
    july: aggregateScenarioRows(runs, "july"),
    september: aggregateScenarioRows(runs, "september"),
    october: aggregateScenarioRows(runs, "october")
  };
  const resultMetrics = commonCategoryReport(runs, categorySelector);
  const tacticalMetrics = {
    all: resultMetrics,
    by_scenario: Object.fromEntries(["july", "september", "october"].map((scenario) => [
      scenario,
      commonCategoryReport(runs.filter((run) => run.scenario === scenario), categorySelector)
    ])),
    by_scenario_side: Object.fromEntries(runs.map((run) => [`${run.scenario}:${run.external_side}`, null]).filter(([, value], index, array) => array.findIndex((item) => item[0] === array[index][0]) === index).map(([key]) => {
      const [scenario, side] = key.split(":");
      return [key, commonCategoryReport(runs.filter((run) => run.scenario === scenario && run.external_side === side), categorySelector)];
    }))
  };
  const tacticalOpportunityRuns = runs.filter((run) => run.judge);
  const judgeMetrics = {
    runs: tacticalOpportunityRuns.length,
    opportunity_decision_points: summaryStats(tacticalOpportunityRuns.map((run) => run.judge?.opportunity_decision_points)),
    missed_opportunity_severity: summaryStats(tacticalOpportunityRuns.map((run) => run.judge?.missed_opportunity_severity)),
    opportunity_conversion_rate: summaryStats(tacticalOpportunityRuns.map((run) => run.judge?.opportunity_conversion_rate)),
    multi_step_plan_coherence: summaryStats(tacticalOpportunityRuns.map((run) => run.judge?.multi_step_plan_coherence)),
    judge_coverage: summaryStats(tacticalOpportunityRuns.map((run) => run.judge?.judge_coverage))
  };
  return {
    generated_at: new Date().toISOString(),
    metric_version: "wargame-research-metrics-v7-latest-task-evidence",
    definitions: {
      average_vp: "Sum of final VP from complete games divided by the number of complete games.",
      vp_delta: "Final VP minus the scenario starting VP. Positive values favor Axis; negative values favor Allies.",
      side_adjusted_vp_gain: "VP delta from the evaluated side's perspective. Positive values always mean improvement for the evaluated Agent.",
      action_rejection_rate: "Rule-engine-rejected model actions divided by all model-submitted actions.",
      low_odds_attack_rate: "Autonomous model attacks below 2:1 odds divided by all autonomous model attacks.",
      missed_opportunity_severity: "Sum of Judge severity scores from 0 to 3 divided by the number of opportunity decision points. Lower is better.",
      conditional_missed_opportunity_severity: "Sum of severity scores for missed opportunities divided by the number of missed opportunities. Lower is better.",
      opportunity_conversion_rate: "Opportunities with outcome converted divided by all confirmed opportunity decision points. Higher is better.",
      opportunity_abstentions: "Opportunities that the Judge could not confirm from the supplied evidence.",
      opportunity_confidence: "Mean Judge confidence for confirmed opportunity decisions. Higher indicates stronger evidence, not better gameplay.",
      multi_step_plan_coherence: "Sum of Judge coherence scores from 1 to 5 divided by the number of fixed action windows. Higher is better.",
      plan_coherence_confidence: "Mean Judge confidence for non-abstained plan coherence judgments. Higher indicates stronger evidence, not better gameplay.",
      plan_coherence_abstentions: "Action windows for which the Judge abstained from scoring plan coherence.",
      ranking_eligibility: "A complete game with a benchmark artifact manifest. Declared method fallback remains part of end-to-end performance; infrastructure status is reported separately.",
      vp_stats: "Mean, median, sample standard deviation, and 95% confidence-interval half-width over ranking-eligible games.",
      raw_final_vp_sum: "Final VP sum over all complete games.",
      ranking_final_vp_sum: "Final VP sum over complete games with a benchmark artifact manifest, including declared method fallbacks.",
      raw_vp_delta_sum: "VP delta sum over all complete games; diagnostic only.",
      ranking_vp_delta_sum: "VP delta sum over complete games with a benchmark artifact manifest, including declared method fallbacks."
    },
    ...reportMetadata,
    result_metrics: resultMetrics,
    tactical_metrics: tacticalMetrics,
    execution_ledger_metrics: runs.map((run) => ({ scenario: run.scenario, side: run.external_side, model: run.model_profile,
      execution: run.execution_ledger, opportunities: run.opportunity_ledger, goal_evaluations: run.goal_evaluations })),
    reliability_metrics: {
      all_runs: commonCategoryReport(runs),
      fallback_actions: sumNumbers(runs.map((run) => run.fallback_actions)),
      network_failures: sumNumbers(runs.map((run) => run.network_failures)),
      retries: sumNumbers(runs.map((run) => run.retries)),
      circuit_open_events: sumNumbers(runs.map((run) => run.circuit_open_events)),
      sample_statuses: [...new Set(runs.map((run) => run.sample_status))]
    },
    efficiency_metrics: {
      input_tokens: summaryStats(runs.map((run) => run.input_tokens)),
      output_tokens: summaryStats(runs.map((run) => run.output_tokens)),
      cache_tokens: summaryStats(runs.map((run) => run.cache_tokens)),
      cache_hit_rate: summaryStats(runs.map((run) => run.cache_hit_rate)),
      requests: summaryStats(runs.map((run) => run.requests)),
      effective_action_token_cost: summaryStats(runs.map((run) => run.effective_action_token_cost)),
      p50_latency_ms: summaryStats(runs.map((run) => run.p50_latency_ms)),
      p95_latency_ms: summaryStats(runs.map((run) => run.p95_latency_ms))
    },
    judge_metrics: judgeMetrics,
    baseline_comparison: buildBaselineComparison(runs, baselineRuns),
    scenario_metrics: scenarioMetrics,
    ranking_eligibility: {
      total_runs: runs.length,
      complete_games: runs.filter((run) => run.complete_game).length,
      ranking_eligible_games: rankingEligibleRuns.length,
      clean_ranking_eligible_games: cleanRuns.length,
      infrastructure_affected_games: runs.filter((run) => run.sample_status === "infrastructure_affected").length,
      excluded_games: runs.length - rankingEligibleRuns.length,
      exclusion_reasons: Object.fromEntries([...new Set(runs.flatMap((run) => run.ranking_eligibility_reasons || []))]
        .map((reason) => [reason, runs.filter((run) => (run.ranking_eligibility_reasons || []).includes(reason)).length])),
      method_fallbacks_remain_in_end_to_end: true,
      clean_subset_excludes_infrastructure_affected: true
    },
    runs,
    by_decision_policy: aggregateRuns(runs, "decision_policy"),
    by_harness: aggregateRuns(runs, "harness"),
    by_model_profile: aggregateRuns(runs, "model_profile"),
    by_scenario_side: aggregateRuns(runs, "scenario_side"),
    by_comparison_cell: aggregateRuns(runs, "comparison_cell"),
    by_comparison_contract: aggregateRuns(runs, "comparison_contract_hash")
  };
}

module.exports = {
  OPPORTUNITY_TYPES,
  actionAttempts,
  aggregateRuns,
  attachJudgeResults,
  buildActionWindows,
  buildBaselineComparison,
  buildResearchReport,
  deterministicRunMetrics,
  isCompleteGame,
  meanOrNull,
  oddsBelowTwoToOne,
  ratioOrNull,
  scenarioMetrics,
  validateJudgeResult
};
