#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function topCounts(counts, limit = 5) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function load(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function summarize(transcript) {
  const steps = transcript.model_steps || [];
  const executions = steps.flatMap((step) => step.rounds || []);
  const executionAttempts = executions.flatMap((round) => round.attempts || []);
  const intentCalls = steps.filter((step) => step.phase_intent?.api);
  const intentsFromModel = steps.filter((step) => step.phase_intent?.source === "model").length;
  const fastPasses = steps.filter((step) => step.local_fast_pass);
  const moves = (transcript.game_log || []).filter((entry) => (
    entry.source === "external_model" && entry.action?.type === "move"
  ));
  const unitMoves = countBy(moves.map((entry) => entry.action.unit));
  const destinations = countBy(moves.map((entry) => entry.action.destination));
  const elapsed = steps.map((step) => Number(step.provider_result?.elapsed_ms || 0));
  const contexts = steps.map((step) => Number(step.context_bytes || 0));
  const apiAttempts = executionAttempts.length + intentCalls.length;
  const apiSuccesses = executionAttempts.filter((attempt) => attempt.ok).length
    + intentCalls.filter((step) => Number(step.phase_intent.api.status) >= 200 && Number(step.phase_intent.api.status) < 300).length;

  return {
    completed: transcript.partial === false,
    decision_mode: transcript.decision_mode,
    victory_points: transcript.summary?.victory?.victory_points ?? null,
    victory_level: transcript.summary?.victory?.level || "",
    elapsed_ms: transcript.elapsed_ms || 0,
    external_actions: transcript.counts?.external_actions ?? steps.length,
    illegal_actions: transcript.counts?.illegal_actions ?? 0,
    fallback_actions: transcript.counts?.fallback_actions ?? 0,
    fallback_rate: steps.length ? (transcript.counts?.fallback_actions ?? 0) / steps.length : 0,
    retry_attempts: transcript.counts?.retry_attempts ?? 0,
    tool_calls: transcript.counts?.model_tool_calls ?? 0,
    local_fast_pass_actions: fastPasses.length,
    local_fast_pass_elapsed_ms: fastPasses.reduce((sum, step) => sum + Number(step.provider_result?.elapsed_ms || 0), 0),
    phase_intent_model_calls: intentsFromModel,
    api_calls: apiAttempts,
    api_successes: apiSuccesses,
    api_success_rate: apiAttempts ? apiSuccesses / apiAttempts : 1,
    execution_rounds: executions.length,
    avg_tool_rounds_per_action: average(steps.map((step) => (step.rounds || []).length)),
    avg_step_elapsed_ms: average(elapsed),
    max_step_elapsed_ms: Math.max(0, ...elapsed),
    avg_context_bytes: average(contexts),
    max_context_bytes: Math.max(0, ...contexts),
    move_actions: moves.length,
    repeat_move_actions: moves.length - Object.keys(unitMoves).length,
    repeat_move_rate: moves.length ? (moves.length - Object.keys(unitMoves).length) / moves.length : 0,
    top_destinations: topCounts(destinations),
    top_moved_units: topCounts(unitMoves),
    top_destination_share: moves.length ? Math.max(0, ...Object.values(destinations)) / moves.length : 0
  };
}

function delta(baseline, hybrid, field) {
  return hybrid[field] - baseline[field];
}

function main() {
  const baseline = summarize(load(process.argv[2]));
  const hybrid = summarize(load(process.argv[3]));
  const report = {
    generated_at: new Date().toISOString(),
    experiment: "July Axis external DeepSeek A vs Hybrid",
    baseline,
    hybrid,
    delta_hybrid_minus_baseline: {
      victory_points: delta(baseline, hybrid, "victory_points"),
      elapsed_ms: delta(baseline, hybrid, "elapsed_ms"),
      fallback_actions: delta(baseline, hybrid, "fallback_actions"),
      retry_attempts: delta(baseline, hybrid, "retry_attempts"),
      api_calls: delta(baseline, hybrid, "api_calls"),
      avg_step_elapsed_ms: delta(baseline, hybrid, "avg_step_elapsed_ms"),
      avg_context_bytes: delta(baseline, hybrid, "avg_context_bytes"),
      repeat_move_actions: delta(baseline, hybrid, "repeat_move_actions"),
      repeat_move_rate: delta(baseline, hybrid, "repeat_move_rate"),
      top_destination_share: delta(baseline, hybrid, "top_destination_share")
    }
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
