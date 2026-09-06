"use strict";

const RulesEngine = require("../../rule_engine.js");
const { infrastructureStatus } = require("../core/benchmark_comparison.js");
const { rankingEligible } = require("../core/benchmark_comparison.js");
const { summaryStats: benchmarkStats } = require("../core/benchmark_statistics.js");

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
  return denominator > 0 ? numerator / denominator : null;
}

function isCompleteGame(transcript, config = {}) {
  const statuses = new Set(config.statuses || ["final_victory"]);
  if (!statuses.has(transcript.status)) return false;
  return config.require_final_victory_flag === false || transcript.summary?.victory?.final === true;
}

function actionAttempts(transcript) {
  return (transcript.model_steps || []).flatMap((step) => (step.action_attempts || []).map((attempt) => ({ step, attempt })));
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
  const submittedActions = Number(transcript.counts?.act_calls ?? attempts.length);
  const rejectedActions = Number(transcript.counts?.rule_invalid_action_attempts
    ?? transcript.counts?.invalid_action_attempts
    ?? attempts.filter(({ attempt }) => !attempt.accepted).length);
  const autonomousAttacks = attempts.filter((record) => (
    record.attempt.accepted
    && !record.step.fallback_used
    && actionType(record) === "combat"
  ));
  const lowOddsAttacks = autonomousAttacks.filter((record) => oddsBelowTwoToOne(combatOdds(record))).length;
  const complete = isCompleteGame(transcript, config.complete_game || config);
  const victoryPoints = Number(transcript.summary?.victory?.victory_points);
  const scenario = transcript.scenario || transcript.summary?.scenario || "";
  const externalSide = transcript.external_side || "";
  const axisController = transcript.axis_controller || transcript.controllers?.axis || (externalSide === "axis" ? "external_ai" : "rules_ai");
  const alliesController = transcript.allies_controller || transcript.controllers?.allies || (externalSide === "allies" ? "external_ai" : "rules_ai");
  const harness = transcript.harness || "legacy";
  const decisionPolicy = transcript.decision_mode || "legacy";
  const modelProfile = transcript.model_profile || transcript.model?.model || "legacy";
  const recordedBaseline = Number(transcript.summary?.victory?.breakdown
    ?.find((item) => item.id === "scenario_start")?.points);
  const vpBaseline = Number.isFinite(recordedBaseline)
    ? recordedBaseline
    : RulesEngine.scenarioStartingVp(scenario, 0);
  const vpDelta = complete && Number.isFinite(victoryPoints) ? victoryPoints - vpBaseline : null;
  const sideAdjustedVpGain = Number.isFinite(vpDelta)
    ? externalSide === "allies" ? -vpDelta : vpDelta
    : null;
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
    complete_game: complete,
    sample_status: infrastructureStatus(transcript),
    ranking_eligible: transcript.comparison_contract
      ? rankingEligible(transcript)
      : complete && Boolean(transcript.artifact_manifest_hash || transcript.comparison_contract?.artifact_manifest_hash),
    final_vp: complete && Number.isFinite(victoryPoints) ? victoryPoints : null,
    vp_baseline: vpBaseline,
    vp_delta: vpDelta,
    side_adjusted_vp_gain: sideAdjustedVpGain,
    submitted_actions: submittedActions,
    rejected_actions: rejectedActions,
    action_rejection_rate: ratioOrNull(rejectedActions, submittedActions),
    autonomous_attacks: autonomousAttacks.length,
    low_odds_attacks: lowOddsAttacks,
    low_odds_attack_rate: ratioOrNull(lowOddsAttacks, autonomousAttacks.length),
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
  return {
    generated_at: new Date().toISOString(),
    metric_version: "wargame-research-metrics-v2",
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
    ...metadata,
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
  buildResearchReport,
  deterministicRunMetrics,
  isCompleteGame,
  meanOrNull,
  oddsBelowTwoToOne,
  ratioOrNull,
  validateJudgeResult
};
