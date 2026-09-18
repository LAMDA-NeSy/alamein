"use strict";

const { resolveSidePrompt } = require("./prompt_registry.js");
const { thinkingRequest } = require("./model_runtime.js");
const { compactToolFeedback } = require("./agent_context.js");
const { parseModelObject } = require("./model_json.js");
const { REVIEW_POLICY, reviewClock, phaseSequence, remainingTaskWindows, continuationErrors } = require("./task_review.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJson(result) {
  const parsed = parseModelObject(result, (value) => value.type === "task_check" || !!value.task_check, "task checker");
  return parsed.error ? null : parsed;
}

function normalizeCheck(raw, taskPlan) {
  const value = raw?.task_check || raw || {};
  const known = new Set((taskPlan?.children || []).map((task) => task.id));
  const taskId = known.has(value.task_id) ? value.task_id : (taskPlan?.children || []).find((task) => task.status === "active")?.id || "";
  const status = ["continue", "completed", "blocked", "failed"].includes(value.task_status) ? value.task_status : "continue";
  const confidence = Math.max(0, Math.min(1, Number(value.confidence) || 0));
  const abstain = value.abstain === true || !known.has(value.task_id);
  const outcomeValues = new Set(["on_track", "at_risk", "blocked", "achieved", "failed", "unknown"]);
  return {
    type: "task_check",
    task_id: taskId,
    task_status: status,
    action_assessment: ["weak", "neutral", "good"].includes(value.action_assessment) ? value.action_assessment : "neutral",
    task_progress: Math.max(0, Math.min(1, Number(value.task_progress) || 0)),
    supply_preserved: value.supply_preserved == null ? null : !!value.supply_preserved,
    risk_level: ["low", "medium", "high"].includes(value.risk_level) ? value.risk_level : "medium",
    next_task: known.has(value.next_task) ? value.next_task : "",
    task_control: ["continue", "pause", "switch", "cancel"].includes(value.task_control)
      ? value.task_control : "continue",
    switch_to: known.has(value.switch_to) ? value.switch_to : "",
    confidence,
    abstain,
    local_task_outcome: outcomeValues.has(value.local_task_outcome) ? value.local_task_outcome : "unknown",
    campaign_outcome: outcomeValues.has(value.campaign_outcome) ? value.campaign_outcome : "unknown",
    evidence: {
      step: Number(value.evidence?.step || value.step || 0),
      unit_ids: Array.isArray(value.evidence?.unit_ids) ? value.evidence.unit_ids.map(String).slice(0, 12) : [],
      hexes: Array.isArray(value.evidence?.hexes) ? value.evidence.hexes.map(String).slice(0, 12) : [],
      state_change: String(value.evidence?.state_change || "").slice(0, 300)
    },
    reason: String(value.reason || "").slice(0, 300),
    source: "model",
    review_id: typeof value.review_id === "string" ? value.review_id : "",
    review_decision: typeof value.review_decision === "string" ? value.review_decision : "",
    next_action_at: value.next_action_at && typeof value.next_action_at === "object" ? clone(value.next_action_at) : null,
    wait: value.wait && typeof value.wait === "object" ? clone(value.wait) : null
  };
}

function compactTask(task) {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status,
    progress: Number(task.progress || 0),
    priority: Number(task.priority || 0),
    model_task_type: task.model_task_type || "",
    observation_only: task.observation_only,
    scoring_anchor_state: task.scoring_anchor_state,
    scoring_anchor_loss_count: task.scoring_anchor_loss_count,
    assigned_units: (task.assigned_units || []).slice(0, 12),
    compatible_units: (task.compatible_units || []).slice(0, 12),
    candidate_blockers: (task.candidate_blockers || []).slice(0, 6),
    activation_policy: task.activation_policy || null,
    completion_evaluator: task.completion_evaluator || null,
    blocker_resolution: task.blocker_resolution || null,
    dependency_status: task.dependency_status || null,
    phase_scope: task.phase_scope || [],
    completion_condition: task.completion_condition || "",
    completion_criteria: task.completion_criteria || null,
    completion_evidence: task.completion_evidence || null,
    acceptance_diagnostics: task.acceptance_diagnostics || null,
    failure_condition: task.failure_condition || "",
    current_metrics: task.current_metrics || null,
    progress_evidence: task.progress_evidence || "",
    last_blocked_reason: task.last_blocked_reason || "",
    wait_state: task.wait_state || null,
    review_request: task.review_request || null,
    stagnant_windows: task.stagnant_windows || 0,
    review_window: task.review_window || null,
    recent_reviews: (task.review_history || []).slice(-3)
  };
}

function checkerPayload({ input, taskPlan, stepRecord, events, reviewRequests = [] }) {
  const activeTasks = (taskPlan?.children || []).filter((task) => task.status === "active").map(compactTask);
  const reviewedTasks = (taskPlan?.children || []).filter((task) => reviewRequests.some((request) => request.task_id === task.id)).map(compactTask);
  const accepted = [...(stepRecord?.action_attempts || [])].reverse().find((item) => item.accepted) || null;
  const action = stepRecord?.final_action || null;
  const compactAccepted = accepted
    ? compactToolFeedback({
      tool: "act",
      arguments: { action },
      result: {
        accepted: true,
        assessment: accepted.assessment,
        strategic_review: accepted.strategic_review
      }
    }).result
    : null;
  const referencedUnits = new Set([
    ...(action?.unit ? [action.unit] : []),
    ...(action?.attackers || []),
    ...[...activeTasks, ...reviewedTasks].flatMap((task) => [...task.assigned_units,
      ...(task.activation_policy === "rule_verified_breakthrough_contact" ? task.compatible_units : []),
      ...(task.wait_state?.watched_unit_ids || []),
      ...Object.values(task.completion_criteria || {}).flat().flatMap((condition) =>
        [...(condition.unit_ids || []), ...(condition.beneficiary_unit_ids || [])])])
  ]);
  const unitEvidence = Object.fromEntries([...referencedUnits].slice(0, 30).map((id) => {
    const unit = input?.state?.units?.[id];
    return [id, unit ? {
      side: unit.side,
      hex: unit.hex || "",
      state: unit.state || "",
      eliminated: !!unit.eliminated,
      supply: unit.supply_state || unit.supply || "unknown",
      isolated: unit.supply_state === "isolated" || unit.supply === "isolated" || !!unit.isolated
    } : { missing: true }];
  }));
  return {
    protocol: taskPlan?.review_policy === REVIEW_POLICY ? "task-check-review-v4-action-windows" : "task-check-evidence-v2",
    turn: input?.turn,
    step: input?.step,
    phase: input?.phase,
    side: input?.side,
    trigger_events: events,
    current_clock: reviewClock(input),
    phase_sequence: phaseSequence(input),
    task_action_windows: Object.fromEntries([...activeTasks, ...reviewedTasks].map((task) => {
      const { windows, ...summary } = remainingTaskWindows(input, task);
      return [task.id, summary];
    })),
    action_origin: stepRecord ? { step: stepRecord.step, turn: stepRecord.turn, phase: stepRecord.phase } : null,
    review_requests: reviewRequests,
    selected_review: reviewRequests[0] || null,
    review_tasks: reviewedTasks,
    scoring_recovery: taskPlan?.scoring_recovery || null,
    breakthrough_planning: taskPlan?.breakthrough_planning || null,
    existing_tasks: (taskPlan?.children || []).map((task) => ({ id: task.id, status: task.status,
      dependency_status: task.dependency_status, phase_scope: task.phase_scope })),
    parent: {
      id: taskPlan?.parent?.id || "",
      state: taskPlan?.parent?.state || "",
      objective: taskPlan?.parent?.objective || "",
      completion_condition: taskPlan?.parent?.completion_condition || "",
      local_goal_evidence: taskPlan?.parent?.goal_progress_evidence || taskPlan?.parent?.goal_completion_evidence || [],
      campaign_goal: taskPlan?.goal_plan?.campaign_goal || null,
      primary_goal: taskPlan?.goal_plan?.primary_goal || null,
      defensive_posture: taskPlan?.defensive_posture || null,
      authority: "Report local-task and campaign risk separately. Local rules alone decide completion and failure."
    },
    active_tasks: activeTasks,
    accepted_action: action,
    action_evidence: accepted ? {
      evaluation: compactAccepted?.assessment?.evaluation || null,
      strategic_review: compactAccepted?.strategic_review || null
    } : null,
    applied_result: stepRecord?.action_applied?.result || null,
    rule_grounded_unit_state: unitEvidence,
    required_response: {
      type: "task_check",
      task_id: reviewRequests.length ? "task_id of the selected review_request" : "exact id from active_tasks",
      task_status: "continue|completed|blocked|failed",
      action_assessment: "weak|neutral|good",
      task_progress: "number from 0 to 1",
      supply_preserved: "boolean or null",
      risk_level: "low|medium|high",
      next_task: "exact existing task id or empty string",
      task_control: "continue|pause|switch|cancel; control existing tasks only",
      switch_to: "exact existing task id when task_control=switch, otherwise empty string",
      confidence: "number from 0 to 1",
      abstain: "boolean",
      local_task_outcome: "on_track|at_risk|blocked|achieved|failed|unknown",
      campaign_outcome: "on_track|at_risk|blocked|achieved|failed|unknown",
      evidence: { step: "current step", unit_ids: [], hexes: [], state_change: "observed before/after change" },
      reason: "short grounded explanation",
      ...(reviewRequests.length ? {
        review_id: "exact pending review request id; task_id must match this request",
        review_decision: "continue|wait|switch|replan",
        next_action_at: "For continue, select a reachable applicable {turn,phase,boundary:start} from task_action_windows. Null for other decisions. If no action window remains and evidence is unmet, choose switch/replan, not a fictional future turn.",
        wait: "null unless waiting; then {reason, expected_change, renewal_reason (required when renewing), condition, review_at:{turn,phase,boundary:start|end}}. expected_change explains what improves or settles during the wait. condition.kind is phase_reached (turn,phase,boundary), task_condition_met (task_id), or observable (criteria with immediate typed all/any predicates)."
      } : {})
    },
    control_rules: "Assess selected_review first and copy its short id exactly. Do not replace it with an unrelated satisfied task. An execution task without assigned units cannot continue; consider switching or strategic allocation repair through replan. The local rule_verified_breakthrough_contact task may instead use its current rule-verified compatible_units; this does not reassign them. Candidate combat legality does not prove route blockage or successful clearance. Assess facts without changing task status. Waiting is advisory, not a hold order. Due reviews never automatically fail or replace a task. Replan requires evidence that local adjustment cannot repair the operation. Distinguish action_origin from current_clock. Evidence may explicitly state nothing changed. Never create a task, reassign units, or execute an action."
  };
}

function createTaskCheckerRuntime({ client, runtime, timeoutMs = 60000, maxCallsPerTurn = 4, cooldownActions = 0 } = {}) {
  let callsThisTurn = 0;
  let currentTurn = null;
  const records = [];
  const recentEvents = new Map();
  async function check({ input, taskPlan, stepRecord, events = [], reviewRequests = [], timeoutMs: timeoutOverride } = {}) {
    if (!client || !runtime || !events.length) return { skipped: true, reason: "no_trigger" };
    if (currentTurn !== input?.turn) {
      currentTurn = input?.turn;
      callsThisTurn = 0;
    }
    if (callsThisTurn >= maxCallsPerTurn) return { skipped: true, reason: "turn_check_limit" };
    const eventKey = JSON.stringify([input?.turn, input?.phase, input?.side,
      (taskPlan?.children || []).filter((task) => task.status === "active").map((task) => task.id).sort(), [...events].sort(), reviewRequests.map((request) => request.id)]);
    const previousStep = recentEvents.get(eventKey);
    if (cooldownActions > 0 && previousStep != null && Number(input?.step || 0) - previousStep < cooldownActions) {
      return { skipped: true, reason: "event_cooldown", event_key: eventKey };
    }
    recentEvents.set(eventKey, Number(input?.step || 0));
    callsThisTurn += 1;
    const started = Date.now();
    const requestTimeoutMs = Math.max(1, Number(timeoutOverride ?? timeoutMs));
    const payload = checkerPayload({ input, taskPlan, stepRecord, events, reviewRequests });
    let result;
    try {
      result = await client.complete({
        audit_stage: "checker",
        messages: [
          { role: "system", content: resolveSidePrompt(input?.side || taskPlan?.side || "axis", "external.task_checker_system") },
          { role: "user", content: JSON.stringify(payload) }
        ],
        temperature: Number(runtime.profile.defaults.temperature ?? 0.1),
        max_tokens: Math.min(900, Number(runtime.profile.limits.output || 900)),
        response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
        thinking: thinkingRequest(runtime),
        timeout_ms: requestTimeoutMs,
        deadline_ms: started + requestTimeoutMs
      });
      if (Date.now() >= started + requestTimeoutMs) throw new Error("task checker response exceeded deadline");
      if (!result.ok) throw new Error(`task checker model status ${result.status}`);
      const parsed = parseJson(result);
      if (!parsed) throw new Error("task checker returned invalid JSON");
      const checkResult = normalizeCheck(parsed, taskPlan);
      if (reviewRequests.length && !checkResult.abstain && (!reviewRequests.some((request) =>
        request.id === checkResult.review_id && request.task_id === checkResult.task_id)
        || !["continue", "wait", "switch", "replan"].includes(checkResult.review_decision)
        || checkResult.evidence.step !== Number(input.step))) {
        throw new Error("task checker returned a stale or invalid review decision");
      }
      if (!checkResult.abstain && !checkResult.evidence.state_change) {
        throw new Error("task checker omitted state-change evidence");
      }
      if (reviewRequests.length && !checkResult.abstain) {
        const task = taskPlan.children.find((item) => item.id === checkResult.task_id);
        const errors = continuationErrors(checkResult, input, task);
        if (errors.length) throw new Error(`task checker invalid continuation: ${errors.join(", ")}`);
      }
      const record = { ok: true, events, review_requests: clone(reviewRequests), result: checkResult, request_id: result.request_id,
        raw_output: result.response_json, elapsed_ms: Date.now() - started, status: result.status ?? 200 };
      records.push(record);
      return record;
    }
    catch (error) {
      if (error instanceof TypeError || error instanceof ReferenceError) throw error;
      if (result?.ok && !/deadline/i.test(error.message)) {
        const requestRecord = runtime.transport?.find((item) => item.request_id === result.request_id);
        if (requestRecord) requestRecord.protocol_failure = { stage: "checker", error: error.message };
      }
      const record = { ok: false, events, review_requests: clone(reviewRequests), fallback: true, reason: error.message, request_id: result?.request_id,
        raw_output: result?.response_json || null, elapsed_ms: Date.now() - started, status: result?.status ?? 0 };
      records.push(record);
      return record;
    }
  }
  return {
    check,
    get timeoutMs() { return timeoutMs; },
    records,
    resetTurn() { callsThisTurn = 0; },
    metadata() { return { calls_this_turn: callsThisTurn, max_calls_per_turn: maxCallsPerTurn, records: clone(records.slice(-12)) }; }
  };
}

module.exports = { checkerPayload, createTaskCheckerRuntime, normalizeCheck, parseJson };
