#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { buildContext, readConfig } = require("./external_ai_transcript.js");
const { summarizeContext } = require("./external_ai_eval.js");

const ROOT = __dirname;
const OUT = path.join(ROOT, "last_external_ai_context_audit.json");

function movementPhase(phase) {
  return ["initial_movement", "mechanized_movement", "supply_movement"].includes(String(phase || "").replace(/^axis_/, "").replace(/^allies_/, ""));
}

function expectedAllowed(context) {
  const kind = context.game?.phase_kind;
  if (kind === "combat") return ["combat", "pass"];
  if (!movementPhase(kind)) return ["pass"];
  const actions = ["move_intent", "move", "pass"];
  if (context.game?.scenario === "october" && context.game?.active_side === "axis" && Number(context.game?.turn || 1) > 10) actions.splice(1, 0, "exit_west");
  return actions;
}

function noOpMove(action = {}) {
  return action.type === "move" && (action.path || []).length <= 1;
}

function auditContext(label, context) {
  const summary = summarizeContext({ context });
  const warnings = [...(summary.warnings || [])];
  const notes = [];
  const failures = [];
  const allowed = context.protocol?.current_phase_allowed_actions || [];
  const allowedFinal = context.protocol?.allowed_final_actions || [];
  const expected = expectedAllowed(context);
  const candidates = context.candidate_actions || [];
  const candidateTypes = [...new Set(candidates.map((item) => item.action?.type).filter(Boolean))];
  const nonPassCandidates = candidates.filter((item) => item.action?.type && item.action.type !== "pass");
  const illegalCandidateTypes = candidateTypes.filter((type) => !allowed.includes(type));
  const candidatesWithVictoryImpact = candidates.filter((item) => item.evaluation?.victory_impact).length;

  if (!summary.ok) failures.push("context summary has missing required fields");
  if (!allowedFinal.includes("move_intent")) failures.push("allowed_final_actions must include move_intent");
  if (expected.join(",") !== allowed.join(",")) failures.push(`allowed actions ${allowed.join(",")} do not match expected ${expected.join(",")}`);
  if (illegalCandidateTypes.length) failures.push(`candidate actions include types not allowed in this phase: ${illegalCandidateTypes.join(",")}`);
  if (candidates.some((item) => !item.evaluation)) failures.push("candidate without evaluation");
  if (candidates.some((item) => !item.evaluation?.victory_impact)) failures.push("candidate without victory_impact");
  if (candidates.some((item) => noOpMove(item.action))) failures.push("candidate list contains no-op move");
  if (!candidates.some((item) => item.action?.type === "pass")) failures.push("candidate list has no pass fallback");
  if (movementPhase(context.game?.phase_kind) && !nonPassCandidates.length) warnings.push("movement phase has no non-pass candidate");
  if (context.game?.phase_kind === "combat" && !nonPassCandidates.length) notes.push("combat phase has no legal combat candidate in this snapshot");
  if (context.game?.phase_kind === "combat" && nonPassCandidates.some((item) => item.action?.type !== "combat")) failures.push("combat phase has non-combat non-pass candidate");
  if (movementPhase(context.game?.phase_kind) && nonPassCandidates.some((item) => !["move", "exit_west"].includes(item.action?.type))) failures.push("movement phase has non-movement non-pass candidate");
  if (allowed.length === 1 && allowed[0] === "pass" && nonPassCandidates.length) failures.push("pass-only phase has non-pass candidate");

  return {
    label,
    ok: failures.length === 0,
    failures,
    warnings,
    notes,
    game: context.game,
    allowed_actions: allowed,
    expected_allowed_actions: expected,
    candidate_count: candidates.length,
    candidates_with_victory_impact: candidatesWithVictoryImpact,
    non_pass_candidate_count: nonPassCandidates.length,
    candidate_types: candidateTypes,
    top_candidate: candidates[0] || null,
    coverage: summary.coverage,
    counts: summary.counts
  };
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function baseCaseMatrix() {
  return [
    { label: "july-default", scenario: "scenarios/july.json" },
    { label: "july-axis-combat", scenario: "scenarios/july.json", phase: "axis_combat", activeSide: "axis" },
    {
      label: "july-synthetic-axis-combat-contact",
      scenario: "scenarios/july.json",
      phase: "axis_combat",
      activeSide: "axis",
      unitPatches: {
        "july-2-10-pzg-01": { hex: "3710", state: "fresh", attacked_this_turn: false, attacked_this_phase: false }
      }
    },
    { label: "july-end-game-turn", scenario: "scenarios/july.json", phase: "end_game_turn", activeSide: "axis" },
    { label: "september-default", scenario: "scenarios/september.json" },
    { label: "september-allies-initial", scenario: "scenarios/september.json", phase: "allies_initial_movement", activeSide: "allies" },
    { label: "september-axis-combat", scenario: "scenarios/september.json", phase: "axis_combat", activeSide: "axis" },
    { label: "october-default", scenario: "scenarios/october.json" },
    { label: "october-axis-combat", scenario: "scenarios/october.json", phase: "axis_combat", activeSide: "axis" },
    { label: "october-axis-withdrawal", scenario: "scenarios/october.json", phase: "axis_supply_movement", activeSide: "axis", turn: 11 },
    { label: "october-end-game-turn", scenario: "scenarios/october.json", phase: "end_game_turn", activeSide: "axis", turn: 20 }
  ];
}

function caseMatrix(options = {}) {
  const full = !!options.full;
  const requestedCase = options.caseLabel || "";
  const fastLabels = new Set([
    "july-default",
    "july-synthetic-axis-combat-contact",
    "july-end-game-turn",
    "september-axis-combat"
  ]);
  let cases = baseCaseMatrix();
  if (!full) cases = cases.filter((item) => fastLabels.has(item.label));
  if (requestedCase) cases = cases.filter((item) => item.label === requestedCase);
  return cases;
}

function main() {
  const config = readConfig();
  const full = process.argv.includes("--full");
  const requestedCase = argValue("--case", "");
  const outFile = path.resolve(argValue("--out", OUT));
  const cases = caseMatrix({ full, caseLabel: requestedCase }).map((item) => {
    const started = Date.now();
    try {
      const { publicContext } = buildContext(config, item);
      return { ...auditContext(item.label, publicContext), elapsed_ms: Date.now() - started };
    }
    catch (error) {
      return {
        label: item.label,
        ok: false,
        failures: [`exception: ${error.message}`],
        warnings: [],
        notes: [],
        elapsed_ms: Date.now() - started,
        game: null,
        allowed_actions: [],
        expected_allowed_actions: [],
        candidate_count: 0,
        non_pass_candidate_count: 0,
        candidate_types: []
      };
    }
  });
  const failures = cases.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`));
  const warnings = cases.flatMap((item) => item.warnings.map((warning) => `${item.label}: ${warning}`));
  const notes = cases.flatMap((item) => (item.notes || []).map((note) => `${item.label}: ${note}`));
  const report = {
    generated_at: new Date().toISOString(),
    mode: full ? "full" : "fast",
    requested_case: requestedCase || null,
    status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
    failures,
    warnings,
    notes,
    cases
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    output: outFile,
    mode: report.mode,
    status: report.status,
    elapsed_ms: cases.reduce((sum, item) => sum + Number(item.elapsed_ms || 0), 0),
    cases: cases.map((item) => ({ label: item.label, elapsed_ms: item.elapsed_ms, status: item.ok ? "ok" : "fail" })),
    failures,
    warnings: warnings.slice(0, 12),
    notes: notes.slice(0, 12)
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { auditContext, baseCaseMatrix, caseMatrix };
