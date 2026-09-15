#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { defaultLogFile, prepareOutputFile } = require("../core/experiment_log.js");

const ROOT = __dirname;
const DEFAULT_CONTEXT = defaultLogFile("last_external_ai_context.json");
const DEFAULT_TRANSCRIPT = defaultLogFile("last_external_ai_transcript.json");
const DEFAULT_OUT = defaultLogFile("last_external_ai_eval.json");
const REQUIRED_TOOLS = ["list_legal_actions", "check_move", "find_path", "check_combat", "inspect_unit", "inspect_hex", "trace_supply", "evaluate_action"];

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function readJson(file) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, "utf8")) };
  }
  catch (error) {
    return { ok: false, error: error.message };
  }
}

function parsePayloadFromRequestBody(requestBody = {}) {
  const content = requestBody.messages?.find((message) => message.role === "user")?.content;
  if (!content) return { ok: false, error: "request body has no user message content" };
  try {
    return { ok: true, payload: JSON.parse(content) };
  }
  catch (error) {
    return { ok: false, error: `cannot parse user payload JSON: ${error.message}` };
  }
}

function parseContextEnvelope(envelope = {}) {
  if (envelope.context) return { ok: true, request_body: null, payload: envelope, context: envelope.context };
  if (envelope.request_body) {
    const parsed = parsePayloadFromRequestBody(envelope.request_body);
    if (!parsed.ok) return parsed;
    return { ok: true, request_body: envelope.request_body, payload: parsed.payload, context: parsed.payload.context || {} };
  }
  return { ok: false, error: "no context or request_body found" };
}

function sameAction(left = {}, right = {}) {
  if (!left || !right) return false;
  if (left.type === "move_intent" && right.type === "move") {
    return left.unit === right.unit && String(left.destination || left.target || left.hex || "") === String(right.destination || (right.path || []).at(-1) || "");
  }
  if (right.type === "move_intent" && left.type === "move") {
    return sameAction(right, left);
  }
  if (left.type !== right.type) return false;
  if (left.type === "pass") return true;
  if (left.type === "exit_west") return left.unit === right.unit;
  if (left.type === "move") {
    return left.unit === right.unit &&
      (left.mode || "normal") === (right.mode || "normal") &&
      (left.path || []).join("-") === (right.path || []).join("-");
  }
  if (left.type === "combat") {
    return [...(left.attackers || [])].sort().join(",") === [...(right.attackers || [])].sort().join(",") &&
      [...(left.defender_hexes || [])].sort().join(",") === [...(right.defender_hexes || [])].sort().join(",");
  }
  return false;
}

function candidateMatch(action = {}, candidates = []) {
  const index = candidates.findIndex((candidate) => sameAction(action, candidate.action || candidate));
  const best = candidates[0] || null;
  const matched = index >= 0 ? candidates[index] : null;
  return {
    exact_candidate: index >= 0,
    candidate_rank: index >= 0 ? index + 1 : null,
    candidate_score: matched?.score ?? null,
    best_score: best?.score ?? null,
    score_delta_from_best: matched && best && Number.isFinite(Number(matched.score)) && Number.isFinite(Number(best.score))
      ? Number((Number(matched.score) - Number(best.score)).toFixed(2))
      : null,
    best_action: best?.action || null,
    evaluation: matched?.evaluation || null
  };
}

function finalActionFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.type === "final_action") return parsed.action || null;
  if (["move_intent", "move", "combat", "clear_mine", "exit_west", "pass"].includes(parsed.type)) return parsed;
  if (parsed.action && ["move_intent", "move", "combat", "clear_mine", "exit_west", "pass"].includes(parsed.action.type)) return parsed.action;
  return null;
}

function summarizeContext(envelope) {
  const warnings = [];
  const parsed = parseContextEnvelope(envelope);
  if (!parsed.ok) {
    return { present: false, ok: false, warnings: [parsed.error] };
  }
  const context = parsed.context || {};
  const activeUnits = context.forces?.active?.sample_units || [];
  const enemyUnits = context.forces?.enemy?.sample_units || [];
  const activeIndex = context.unit_index?.active || [];
  const enemyIndex = context.unit_index?.enemy || [];
  const candidates = context.candidate_actions || [];
  const decision = context.decision_brief || {};
  const keyHexes = context.map_intel?.key_hexes || [];
  const frontline = context.map_intel?.frontline || [];
  const battlefield = context.battlefield_summary || {};
  const toolNames = (context.tools || []).map((tool) => tool.name).filter(Boolean);
  const required = [
    "protocol",
    "game",
    "decision_brief",
    "mission",
    "rules_brief",
    "victory",
    "strategy",
    "objectives",
    "forces",
    "unit_index",
    "battlefield_summary",
    "map_intel",
    "candidate_actions",
    "tools"
  ];
  const missing = required.filter((key) => context[key] == null);
  if (missing.length) warnings.push(`missing context sections: ${missing.join(", ")}`);
  if (!context.mission?.identity) warnings.push("mission.identity is missing");
  if (!context.protocol?.current_phase_allowed_actions?.length) warnings.push("current phase allowed actions are missing");
  if (!Array.isArray(context.protocol?.allowed_final_actions) || !context.protocol.allowed_final_actions.includes("move_intent")) warnings.push("protocol.allowed_final_actions does not include move_intent");
  if (["initial_movement", "mechanized_movement", "supply_movement"].includes(context.game?.phase_kind) &&
      !context.protocol?.current_phase_allowed_actions?.includes("move_intent")) {
    warnings.push("movement phase current_phase_allowed_actions does not include move_intent");
  }
  const unitIndexFields = context.protocol?.compressed_fields?.unit_index || {};
  const requiredUnitIndexFields = ["h", "k", "a", "d", "m", "s", "sup", "area"];
  const missingUnitIndexFields = requiredUnitIndexFields.filter((key) => !unitIndexFields[key]);
  if (missingUnitIndexFields.length) warnings.push(`unit_index compressed field legend missing: ${missingUnitIndexFields.join(", ")}`);
  if (!activeUnits.length) warnings.push("active force sample is empty");
  if (!enemyUnits.length) warnings.push("enemy force sample is empty");
  const forceStats = ["total_units", "fresh_units", "combat_units", "supply_units", "omitted_units"];
  const missingActiveForceStats = forceStats.filter((key) => context.forces?.active?.[key] == null);
  const missingEnemyForceStats = forceStats.filter((key) => context.forces?.enemy?.[key] == null);
  if (missingActiveForceStats.length) warnings.push(`active force summary missing: ${missingActiveForceStats.join(", ")}`);
  if (missingEnemyForceStats.length) warnings.push(`enemy force summary missing: ${missingEnemyForceStats.join(", ")}`);
  if (!activeIndex.length) warnings.push("unit_index.active is empty");
  if (!enemyIndex.length) warnings.push("unit_index.enemy is empty");
  if (activeIndex.length && !activeIndex.some((unit) => Object.hasOwn(unit, "area"))) warnings.push("unit_index.active does not expose area code");
  if (enemyIndex.length && !enemyIndex.some((unit) => Object.hasOwn(unit, "area"))) warnings.push("unit_index.enemy does not expose area code");
  if (context.forces?.active?.total_units != null && activeIndex.length < context.forces.active.total_units) warnings.push("unit_index.active does not cover all active units");
  if (context.forces?.enemy?.total_units != null && enemyIndex.length < context.forces.enemy.total_units) warnings.push("unit_index.enemy does not cover all enemy units");
  if (!decision.read_first) warnings.push("decision_brief.read_first is missing");
  if (!Array.isArray(decision.allowed) || !decision.allowed.length) warnings.push("decision_brief.allowed is missing");
  if (!decision.candidate_policy) warnings.push("decision_brief.candidate_policy is missing");
  if (!decision.tool_policy) warnings.push("decision_brief.tool_policy is missing");
  if (!keyHexes.length) warnings.push("map_intel.key_hexes is empty");
  if (!battlefield.objective_zone) warnings.push("battlefield_summary.objective_zone is missing");
  if (!Array.isArray(battlefield.regional_balance) || !battlefield.regional_balance.length) warnings.push("battlefield_summary.regional_balance is empty");
  if (!Array.isArray(battlefield.closest_active_to_objective) || !battlefield.closest_active_to_objective.length) warnings.push("battlefield_summary.closest_active_to_objective is empty");
  if (!Array.isArray(battlefield.closest_enemy_to_objective) || !battlefield.closest_enemy_to_objective.length) warnings.push("battlefield_summary.closest_enemy_to_objective is empty");
  if (!candidates.length) warnings.push("candidate_actions is empty");
  if (candidates.some((item) => !item.evaluation)) warnings.push("some candidate actions have no evaluation");
  if (!activeUnits.some((unit) => Array.isArray(unit.map_area))) warnings.push("active units do not expose map_area");
  if (!activeUnits.some((unit) => Object.hasOwn(unit, "can_move_now") && Object.hasOwn(unit, "can_attack_now"))) warnings.push("active units do not expose current action capability flags");
  if (!keyHexes.some((hex) => Array.isArray(hex.map_area))) warnings.push("key hexes do not expose map_area");
  const missingTools = REQUIRED_TOOLS.filter((tool) => !toolNames.includes(tool));
  if (missingTools.length) warnings.push(`missing tools: ${missingTools.join(", ")}`);
  return {
    present: true,
    ok: warnings.length === 0,
    model: parsed.request_body?.model || parsed.payload?.model || null,
    message_count: parsed.request_body?.messages?.length ?? null,
    context_keys: Object.keys(context),
    counts: {
      active_units: activeUnits.length,
      enemy_units: enemyUnits.length,
      active_unit_index: activeIndex.length,
      enemy_unit_index: enemyIndex.length,
      candidate_actions: candidates.length,
      key_hexes: keyHexes.length,
      frontline_units: frontline.length,
      regional_balance_areas: battlefield.regional_balance?.length || 0,
      tools: context.tools?.length || 0
    },
    coverage: {
      has_game_agent_mission: context.mission?.identity === "game_agent",
      has_decision_brief: !!decision.read_first && !!decision.candidate_policy && !!decision.tool_policy,
      has_rules_brief: !!context.rules_brief,
      has_victory_brief: !!context.victory,
      has_forces: !!activeUnits.length && !!enemyUnits.length,
      has_force_counts: !missingActiveForceStats.length && !missingEnemyForceStats.length,
      has_unit_index: !!activeIndex.length && !!enemyIndex.length,
      has_unit_index_legend: missingUnitIndexFields.length === 0,
      has_unit_index_area: activeIndex.some((unit) => Object.hasOwn(unit, "area")) && enemyIndex.some((unit) => Object.hasOwn(unit, "area")),
      has_battlefield_summary: !!battlefield.objective_zone && !!battlefield.regional_balance?.length,
      has_unit_action_flags: activeUnits.some((unit) => Object.hasOwn(unit, "can_move_now") && Object.hasOwn(unit, "can_attack_now")),
      has_map_intel: !!context.map_intel,
      has_map_area: activeUnits.some((unit) => Array.isArray(unit.map_area)) && keyHexes.some((hex) => Array.isArray(hex.map_area)),
      has_candidate_evaluations: candidates.length > 0 && candidates.every((item) => !!item.evaluation),
      has_victory_impact: candidates.length > 0 && candidates.every((item) => !!item.evaluation?.victory_impact),
      has_current_phase_contract: !!context.protocol?.current_phase_allowed_actions?.length,
      has_move_intent_contract: Array.isArray(context.protocol?.allowed_final_actions) &&
        context.protocol.allowed_final_actions.includes("move_intent") &&
        (!["initial_movement", "mechanized_movement", "supply_movement"].includes(context.game?.phase_kind) ||
          context.protocol.current_phase_allowed_actions?.includes("move_intent")),
      has_evaluate_action_tool: toolNames.includes("evaluate_action"),
      has_full_toolset: missingTools.length === 0
    },
    warnings
  };
}

function requestContextFromRound(round = {}) {
  const body = round.model_input || round.request_body;
  if (!body) return null;
  const parsed = parsePayloadFromRequestBody(body);
  return parsed.ok ? parsed.payload.context : null;
}

function summarizeTranscript(transcriptEnvelope) {
  if (!transcriptEnvelope || typeof transcriptEnvelope !== "object") {
    return { present: false, ok: false, warnings: ["transcript file is missing or invalid"] };
  }
  const warnings = [];
  const rounds = transcriptEnvelope.rounds || [];
  if (!rounds.length) warnings.push("no transcript rounds found");
  const finalRound = [...rounds].reverse().find((round) => round.parsed_output);
  const finalParsed = transcriptEnvelope.final?.parsed_output || finalRound?.parsed_output || transcriptEnvelope.final;
  const finalAction = finalActionFromParsed(finalParsed);
  const context = requestContextFromRound(finalRound || rounds.at(-1) || {}) || {};
  const contextSummary = summarizeContext(context?.protocol ? { context } : {});
  if (contextSummary.warnings?.length) warnings.push(...contextSummary.warnings.map((item) => `transcript context: ${item}`));
  const candidates = context.candidate_actions || [];
  const match = finalAction ? candidateMatch(finalAction, candidates) : null;
  const finalAssessment = transcriptEnvelope.final_assessment || finalRound?.assessment || null;
  const reviewRounds = rounds.filter((round) => round.final_action_review);
  const rejectedReviews = reviewRounds.filter((round) => round.final_action_review && !round.final_action_review.accept);
  const finalReview = transcriptEnvelope.final_action_review || finalRound?.final_action_review || null;
  const legalFinalAction = finalAssessment?.legal ?? (finalAction?.type === "pass" || !!match?.exact_candidate);
  if (!finalAction) warnings.push("no final action could be parsed from transcript");
  if (finalAction && !legalFinalAction) warnings.push("final action is not proven legal by assessment or candidate match");
  if (finalReview && !finalReview.accept) warnings.push("final action review rejected the final action");
  if (finalAction?.type === "move" && (finalAction.path || []).length <= 1) warnings.push("final action is a no-op move");
  if (match?.candidate_rank && match.candidate_rank > 3) warnings.push(`final action is candidate rank ${match.candidate_rank}, below top 3`);
  if (Number.isFinite(match?.score_delta_from_best) && match.score_delta_from_best < -20) warnings.push(`final action score is ${Math.abs(match.score_delta_from_best)} below best candidate`);
  if (!finalAssessment) warnings.push("final_assessment is missing; legality falls back to exact candidate/pass matching");
  if (!contextSummary.coverage?.has_game_agent_mission) warnings.push("transcript was generated with old context shape: no game_agent mission");
  if (!contextSummary.coverage?.has_candidate_evaluations) warnings.push("transcript candidate actions have no evaluation");
  if (!contextSummary.coverage?.has_map_area) warnings.push("transcript context has no map_area");
  const toolCalls = rounds.filter((round) => round.parsed_output?.type === "tool_call").map((round) => ({
    tool: round.parsed_output.tool,
    arguments: round.parsed_output.arguments || {},
    legal: round.tool_result?.legal ?? null
  }));
  return {
    present: true,
    ok: warnings.length === 0,
    generated_at: transcriptEnvelope.generated_at || null,
    mode: transcriptEnvelope.mode || "unknown",
    real_model: (transcriptEnvelope.mode || "unknown") === "api",
    rounds: rounds.length,
    response_ok_rounds: rounds.filter((round) => round.ok).length,
    tool_calls: toolCalls,
    final_action: finalAction,
    legal_final_action: !!legalFinalAction,
    candidate_match: match,
    final_action_review: {
      used: reviewRounds.length > 0,
      rejected_count: rejectedReviews.length,
      final_accept: finalReview?.accept ?? null,
      final_issues: finalReview?.issues || []
    },
    final_assessment_source: finalAssessment ? "transcript" : "candidate_fallback",
    final_assessment: finalAssessment || (finalAction ? {
      legal: !!legalFinalAction,
      score: match?.candidate_score ?? (finalAction.type === "pass" ? -999 : null),
      candidate_match: match,
      reason: match?.exact_candidate ? "matches provided candidate action" : "fallback validates exact candidate actions or pass only"
    } : null),
    context_coverage: contextSummary.coverage || {},
    warnings
  };
}

function statusFromWarnings(contextSummary, transcriptSummary, options = {}) {
  const hardFailures = [];
  const warnings = [];
  if (!contextSummary.present || !contextSummary.ok) warnings.push(...(contextSummary.warnings || []));
  if (!transcriptSummary.present) warnings.push(...(transcriptSummary.warnings || []));
  else {
    warnings.push(...(transcriptSummary.warnings || []));
    if (transcriptSummary.final_action && !transcriptSummary.legal_final_action) hardFailures.push("transcript final action is not legal");
  }
  if (!contextSummary.coverage?.has_game_agent_mission) hardFailures.push("latest context is missing game_agent mission");
  if (!contextSummary.coverage?.has_candidate_evaluations) hardFailures.push("latest context is missing candidate evaluations");
  if (!contextSummary.coverage?.has_victory_impact) hardFailures.push("latest context is missing candidate victory_impact");
  if (!contextSummary.coverage?.has_force_counts) hardFailures.push("latest context is missing force summary counts");
  if (!contextSummary.coverage?.has_unit_action_flags) hardFailures.push("latest context is missing unit action capability flags");
  if (!contextSummary.coverage?.has_map_area) hardFailures.push("latest context is missing map_area");
  if (!contextSummary.coverage?.has_full_toolset) hardFailures.push("latest context is missing one or more required tools");
  if (options.requireApi && transcriptSummary.present && !transcriptSummary.real_model) hardFailures.push("transcript is not from a real API model");
  if (hardFailures.length) return { status: "fail", hard_failures: hardFailures, warnings };
  if (warnings.length) return { status: "warn", hard_failures: [], warnings };
  return { status: "pass", hard_failures: [], warnings: [] };
}

function main() {
  const contextFile = path.resolve(argValue("--context", DEFAULT_CONTEXT));
  const transcriptFile = path.resolve(argValue("--transcript", DEFAULT_TRANSCRIPT));
  const outFile = prepareOutputFile(argValue("--out", DEFAULT_OUT));
  const requireApi = process.argv.includes("--require-api");
  const contextRead = readJson(contextFile);
  const transcriptRead = readJson(transcriptFile);
  const contextSummary = contextRead.ok
    ? summarizeContext(contextRead.data)
    : { present: false, ok: false, warnings: [`cannot read context: ${contextRead.error}`] };
  const transcriptSummary = transcriptRead.ok
    ? summarizeTranscript(transcriptRead.data)
    : { present: false, ok: false, warnings: [`cannot read transcript: ${transcriptRead.error}`] };
  const status = statusFromWarnings(contextSummary, transcriptSummary, { requireApi });
  const report = {
    generated_at: new Date().toISOString(),
    files: {
      context: contextFile,
      transcript: transcriptFile,
      output: outFile
    },
    require_api: requireApi,
    status: status.status,
    hard_failures: status.hard_failures,
    warnings: status.warnings,
    context: contextSummary,
    transcript: transcriptSummary
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    output: outFile,
    status: report.status,
    transcript_mode: report.transcript.mode,
    real_model: report.transcript.real_model,
    hard_failures: report.hard_failures,
    warnings: report.warnings.slice(0, 12)
  }, null, 2));
  if (report.status === "fail") process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  candidateMatch,
  finalActionFromParsed,
  parseContextEnvelope,
  summarizeContext,
  summarizeTranscript
};
