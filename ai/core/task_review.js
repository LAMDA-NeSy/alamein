"use strict";

const RulesEngine = require("../../rule_engine.js");

const REVIEW_POLICY = "model_review_wait_v1";

function reviewClock(input = {}) {
  const state = input.state || input.ctx?.state || {};
  return { turn: Number(state.turn ?? input.turn), phase: state.phase || input.phase };
}

function phaseSequence(input) {
  return RulesEngine.turnSequence({ state: input.state || input.ctx?.state || {},
    rules: input.ctx?.rules || RulesEngine.DEFAULT_RULES });
}

function pointValue(point, input) {
  const sequence = phaseSequence(input);
  const index = sequence.indexOf(point?.phase);
  if (!Number.isInteger(point?.turn) || index < 0 || !["start", "end"].includes(point?.boundary)) return null;
  return point.turn * sequence.length * 2 + index * 2 + (point.boundary === "end" ? 1 : 0);
}

function reachedPoint(point, input) {
  const target = pointValue(point, input);
  const current = pointValue({ ...reviewClock(input), boundary: "start" }, input);
  return target != null && current != null && current >= target;
}

function remainingTaskWindows(input, task = {}) {
  const state = input.state || input.ctx?.state || {};
  const finalTurn = RulesEngine.scenarioFinalTurn(state.scenario);
  const side = input.side || state.active_side;
  const scopes = task.phase_scope || [];
  let cursor = { ...state, ...reviewClock(input) };
  const windows = [];
  for (let i = 0; i < phaseSequence(input).length * (finalTurn + 1); i += 1) {
    if (cursor.turn > finalTurn || (cursor.turn === finalTurn && cursor.phase === "end_game_turn")) break;
    const kind = RulesEngine.phaseKind(cursor.phase);
    if (RulesEngine.phaseSide(cursor.phase) === side && (!scopes.length || scopes.includes(cursor.phase) || scopes.includes(kind)
      || (scopes.includes("movement") && ["initial_movement", "mechanized_movement"].includes(kind))
      || (scopes.includes("supply") && kind === "supply_movement"))) {
      windows.push({ turn: cursor.turn, phase: cursor.phase, boundary: "start" });
    }
    const next = RulesEngine.nextPhase({ state: cursor, rules: input.ctx?.rules || RulesEngine.DEFAULT_RULES });
    cursor = { ...cursor, phase: next.phase, turn: cursor.turn + next.turn_increment };
  }
  return { final_turn: finalTurn, remaining_count: windows.length, next: windows[0] || null,
    last: windows.at(-1) || null, windows, meaning: "scheduled task phases, not a guarantee of unit eligibility or route feasibility" };
}

function continuationErrors(result, input, task) {
  if (result.review_decision !== "continue") return [];
  const hasVerifiedCombatUnits = task.activation_policy === "rule_verified_breakthrough_contact"
    && task.status === "active" && task.compatible_units?.length > 0;
  if (!task.observation_only && Array.isArray(task.assigned_units) && !task.assigned_units.length && !hasVerifiedCombatUnits) {
    return ["continue_requires_execution_units"];
  }
  if (task.dependency_status?.hard_ready === false || task.dependency_status?.conditional_ready === false) {
    return ["continue_requires_ready_dependencies"];
  }
  const windows = remainingTaskWindows(input, task);
  if (!windows.remaining_count && task.completion_evidence?.status !== "met") return ["no_remaining_task_action_window"];
  const point = result.next_action_at;
  if (!point) return windows.remaining_count ? ["continue_requires_next_action_window"] : [];
  return windows.windows.some((window) => point.turn === window.turn && point.phase === window.phase && point.boundary === "start")
    ? [] : ["continue_action_window_not_reachable"];
}

function validatePoint(point, input) {
  const errors = [];
  const clock = reviewClock(input);
  const target = pointValue(point, input);
  const current = pointValue({ ...clock, boundary: "start" }, input);
  const state = input.state || input.ctx?.state || {};
  if (target == null) return ["invalid_review_point"];
  if (current == null || target <= current) errors.push("review_point_must_be_in_the_future");
  if (point.turn > RulesEngine.scenarioFinalTurn(state.scenario)) errors.push("review_point_after_game_end");
  if (point.turn === RulesEngine.scenarioFinalTurn(state.scenario) && point.phase === "end_game_turn" && point.boundary === "end") {
    errors.push("review_point_after_game_end");
  }
  // Enumerate real phase transitions so skipped phases and October's order
  // cannot produce a review appointment that the game will never visit.
  let cursor = { ...state, ...clock };
  let found = false;
  for (let i = 0; i < phaseSequence(input).length * (RulesEngine.scenarioFinalTurn(state.scenario) + 1); i += 1) {
    if (cursor.turn === point.turn && cursor.phase === point.phase) { found = true; break; }
    if (cursor.turn > point.turn) break;
    const next = RulesEngine.nextPhase({ state: cursor, rules: input.ctx?.rules || RulesEngine.DEFAULT_RULES });
    cursor = { ...cursor, phase: next.phase, turn: cursor.turn + next.turn_increment };
  }
  if (!found) errors.push("review_phase_not_reachable_in_schedule");
  return errors;
}

function normalizeWait(value, { input, task, plan, evaluate }) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { errors: ["missing_wait_contract"] };
  const reason = String(value.reason || "").trim().slice(0, 300);
  const renewalReason = String(value.renewal_reason || "").trim().slice(0, 300);
  if (!reason) errors.push("wait_reason_required");
  if (task.wait_state?.status === "review_due" && !renewalReason) errors.push("renewed_wait_requires_reassessment_reason");
  errors.push(...validatePoint(value.review_at, input));
  const expectedChange = String(value.expected_change || "").trim().slice(0, 300);
  if (!expectedChange) errors.push("wait_requires_expected_change");
  const windows = remainingTaskWindows(input, task);
  if (!windows.remaining_count && task.completion_evidence?.status !== "met") errors.push("no_remaining_task_action_window");
  if (windows.last && task.completion_evidence?.status !== "met"
    && pointValue(value.review_at, input) > pointValue({ ...windows.last, boundary: "end" }, input)) {
    errors.push("wait_extends_beyond_last_task_window");
  }
  const condition = value.condition;
  let evidence = null;
  if (condition?.kind === "phase_reached") {
    errors.push(...validatePoint(condition, input));
  } else if (condition?.kind === "task_condition_met") {
    const dependency = plan.children.find((item) => item.id === condition.task_id && !item.observation_only);
    if (condition.task_id === task.id || !dependency) {
      errors.push("wait_dependency_must_be_another_existing_task");
    }
    if (dependency?.status === "completed" || dependency?.completion_evidence?.status === "met") errors.push("wait_condition_already_met");
    if (["failed", "skipped"].includes(dependency?.status)) errors.push("wait_dependency_unavailable");
  } else if (condition?.kind === "observable") {
    evidence = evaluate(condition.criteria);
    if (!evidence?.conditions?.length) errors.push("wait_conditions_required");
    errors.push(...(evidence?.validation_errors || []));
    for (const item of evidence?.conditions || []) {
      if (item.evaluation_scope !== "immediate") errors.push("wait_conditions_must_observe_current_state");
      for (const id of [...(item.unit_ids || []), ...(item.beneficiary_unit_ids || [])]) {
        const unit = input.state?.units?.[id];
        if (!unit || unit.side !== (item.subject_side || task.subject_side || plan.side)) errors.push("invalid_wait_unit_reference");
      }
      if (item.target_hex && !RulesEngine.onMap(item.target_hex)) errors.push("invalid_wait_target_hex");
      if (item.target_region?.hexes?.some((hex) => !RulesEngine.onMap(hex))) errors.push("invalid_wait_region");
    }
    if (evidence?.status === "met") errors.push("wait_condition_already_met");
  } else errors.push("unknown_wait_condition");
  return { errors: [...new Set(errors)], wait: { reason, expected_change: expectedChange, renewal_reason: renewalReason || null, condition, review_at: value.review_at }, evidence };
}

module.exports = { REVIEW_POLICY, reviewClock, phaseSequence, reachedPoint, normalizeWait, remainingTaskWindows, continuationErrors };
