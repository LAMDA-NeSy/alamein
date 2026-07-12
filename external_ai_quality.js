#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { buildContext, readConfig } = require("./external_ai_transcript.js");
const { baseCaseMatrix, caseMatrix } = require("./external_ai_context_audit.js");
const { summarizeContext } = require("./external_ai_eval.js");

const ROOT = __dirname;
const OUT = path.join(ROOT, "last_external_ai_quality_report.json");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function movementPhase(kind) {
  return ["initial_movement", "mechanized_movement", "supply_movement"].includes(kind);
}

function actionTypes(candidates) {
  return [...new Set(candidates.map((item) => item.action?.type).filter(Boolean))];
}

function candidateMetrics(context, elapsedMs) {
  const candidates = context.candidate_actions || [];
  const nonPass = candidates.filter((item) => item.action?.type !== "pass");
  const passIndex = candidates.findIndex((item) => item.action?.type === "pass");
  const top = candidates[0] || null;
  const topEval = top?.evaluation || {};
  const topAction = top?.action || {};
  const moving = movementPhase(context.game?.phase_kind);
  const combat = context.game?.phase_kind === "combat";
  const passOnly = (context.protocol?.current_phase_allowed_actions || []).length === 1 &&
    context.protocol.current_phase_allowed_actions[0] === "pass";
  return {
    elapsed_ms: elapsedMs,
    context_bytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
    phase_kind: context.game?.phase_kind || "",
    allowed_actions: context.protocol?.current_phase_allowed_actions || [],
    candidate_count: candidates.length,
    non_pass_candidate_count: nonPass.length,
    candidate_types: actionTypes(candidates),
    pass_rank: passIndex >= 0 ? passIndex + 1 : null,
    top: top ? {
      score: top.score,
      type: topAction.type,
      action: topAction,
      summary: topEval.summary || "",
      progress: topEval.progress ?? null,
      distance_after: topEval.distance_after ?? topEval.victory_impact?.distance_to_objective_after ?? null,
      vp_relevance: topEval.victory_impact?.vp_relevance || "",
      risks: topEval.risks || [],
      tactical_tags: topEval.tactical_tags || []
    } : null,
    movement_phase: moving,
    combat_phase: combat,
    pass_only: passOnly,
    candidates_with_victory_impact: candidates.filter((item) => item.evaluation?.victory_impact).length,
    all_candidates_have_evaluation: candidates.every((item) => !!item.evaluation),
    all_candidates_have_victory_impact: candidates.length > 0 && candidates.every((item) => !!item.evaluation?.victory_impact)
  };
}

function assessCase(label, context, elapsedMs, options = {}) {
  const metrics = candidateMetrics(context, elapsedMs);
  const summary = summarizeContext({ context });
  const failures = [];
  const warnings = [...(summary.warnings || [])];
  const notes = [];
  const maxContextBytes = Number(options.maxContextBytes || 110000);
  const maxElapsedMs = Number(options.maxElapsedMs || 15000);
  const strongScore = Number(metrics.top?.score);
  const topDistance = Number(metrics.top?.distance_after);
  const topProgress = Number(metrics.top?.progress);

  if (!summary.ok) failures.push("context summary is not ok");
  if (metrics.context_bytes > maxContextBytes) failures.push(`context too large: ${metrics.context_bytes} bytes > ${maxContextBytes}`);
  if (metrics.elapsed_ms > maxElapsedMs) warnings.push(`context generation slow: ${metrics.elapsed_ms} ms > ${maxElapsedMs}`);
  if (!metrics.candidate_count) failures.push("no candidate actions");
  if (metrics.pass_rank == null) failures.push("pass fallback missing");
  if (metrics.pass_only) {
    if (metrics.candidate_count !== 1 || metrics.top?.type !== "pass") failures.push("pass-only phase should expose exactly one pass candidate");
  }
  else {
    if (metrics.pass_rank !== metrics.candidate_count) failures.push("pass fallback should be the final candidate");
    if (!metrics.non_pass_candidate_count && metrics.movement_phase) warnings.push("movement phase has no useful non-pass candidate");
  }
  if (metrics.movement_phase && metrics.non_pass_candidate_count) {
    if (metrics.top?.type === "pass") failures.push("movement phase top candidate is pass despite non-pass options");
    if (Number.isFinite(topProgress) && topProgress < 1) warnings.push(`movement top candidate has weak progress: ${topProgress}`);
    if (context.game?.active_side === "axis" && context.game?.turns_remaining <= 1 && Number.isFinite(topDistance) && topDistance > 6) {
      warnings.push(`late Axis top move remains far from objective: distance ${topDistance}`);
    }
    if (Number.isFinite(strongScore) && strongScore <= 0) warnings.push(`movement top candidate has non-positive score: ${strongScore}`);
  }
  if (metrics.combat_phase) {
    if (metrics.non_pass_candidate_count && metrics.top?.type !== "combat") failures.push("combat phase with attacks should rank combat first");
    if (!metrics.non_pass_candidate_count) notes.push("combat phase has no legal combat candidate in this snapshot");
  }
  if (!metrics.all_candidates_have_evaluation) failures.push("candidate missing evaluation");
  if (!metrics.all_candidates_have_victory_impact) failures.push("candidate missing victory_impact");
  return {
    label,
    status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
    failures,
    warnings,
    notes,
    metrics,
    coverage: summary.coverage
  };
}

function selectedCases() {
  const full = process.argv.includes("--full");
  const requestedCase = argValue("--case", "");
  const scenario = argValue("--scenario", "");
  const phase = argValue("--phase", "");
  const activeSide = argValue("--active-side", "");
  const turn = argValue("--turn", "");
  if (scenario || phase || activeSide || turn) {
    const item = { label: "custom-request", scenario: scenario || "scenarios/july.json" };
    if (phase) item.phase = phase;
    if (activeSide) item.activeSide = activeSide;
    if (turn) item.turn = turn;
    return [item];
  }
  if (requestedCase === "all") return baseCaseMatrix();
  return caseMatrix({ full, caseLabel: requestedCase });
}

function main() {
  const config = readConfig();
  const outFile = path.resolve(argValue("--out", OUT));
  const maxContextBytes = Number(argValue("--max-context-bytes", 110000));
  const maxElapsedMs = Number(argValue("--max-elapsed-ms", 15000));
  const cases = selectedCases().map((item) => {
    const started = Date.now();
    try {
      const { publicContext } = buildContext(config, item);
      return assessCase(item.label, publicContext, Date.now() - started, { maxContextBytes, maxElapsedMs });
    }
    catch (error) {
      return {
        label: item.label,
        status: "fail",
        failures: [`exception: ${error.message}`],
        warnings: [],
        notes: [],
        metrics: null,
        coverage: {}
      };
    }
  });
  const failures = cases.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`));
  const warnings = cases.flatMap((item) => item.warnings.map((warning) => `${item.label}: ${warning}`));
  const notes = cases.flatMap((item) => item.notes.map((note) => `${item.label}: ${note}`));
  const report = {
    generated_at: new Date().toISOString(),
    mode: process.argv.includes("--full") ? "full" : "fast",
    status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
    thresholds: { max_context_bytes: maxContextBytes, max_elapsed_ms: maxElapsedMs },
    failures,
    warnings,
    notes,
    cases
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    output: outFile,
    status: report.status,
    mode: report.mode,
    failures,
    warnings: warnings.slice(0, 12),
    notes: notes.slice(0, 12),
    cases: cases.map((item) => ({
      label: item.label,
      status: item.status,
      elapsed_ms: item.metrics?.elapsed_ms ?? null,
      context_bytes: item.metrics?.context_bytes ?? null,
      top: item.metrics?.top ? {
        type: item.metrics.top.type,
        score: item.metrics.top.score,
        summary: item.metrics.top.summary
      } : null
    }))
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { assessCase, candidateMetrics };
