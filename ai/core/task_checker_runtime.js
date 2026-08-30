"use strict";

const { resolveSidePrompt } = require("./prompt_registry.js");
const { thinkingRequest } = require("./model_runtime.js");
const { compactToolFeedback } = require("./agent_context.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJson(result) {
  const message = result?.response_json?.choices?.[0]?.message || {};
  const values = [message.content, message.reasoning_content].filter((value) => typeof value === "string" && value.trim());
  for (const value of values) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
    catch {
      const match = value.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); }
        catch {}
      }
    }
  }
  return null;
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
    source: "model"
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
    assigned_units: (task.assigned_units || []).slice(0, 12),
    completion_condition: task.completion_condition || "",
    failure_condition: task.failure_condition || "",
    current_metrics: task.current_metrics || null,
    progress_evidence: task.progress_evidence || "",
    last_blocked_reason: task.last_blocked_reason || ""
  };
}

function checkerPayload({ input, taskPlan, stepRecord, events }) {
  const activeTasks = (taskPlan?.children || []).filter((task) => task.status === "active").map(compactTask);
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
    ...activeTasks.flatMap((task) => task.assigned_units)
  ]);
  const unitEvidence = Object.fromEntries([...referencedUnits].slice(0, 30).map((id) => {
    const unit = input?.state?.units?.[id];
    return [id, unit ? {
      side: unit.side,
      hex: unit.hex || "",
      state: unit.state || "",
      eliminated: !!unit.eliminated,
      isolated: !!unit.isolated
    } : { missing: true }];
  }));
  return {
    protocol: "task-check-evidence-v2",
    turn: input?.turn,
    step: input?.step,
    phase: input?.phase,
    side: input?.side,
    trigger_events: events,
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
      task_id: "exact id from active_tasks",
      task_status: "continue|completed|blocked|failed",
      action_assessment: "weak|neutral|good",
      task_progress: "number from 0 to 1",
      supply_preserved: "boolean or null",
      risk_level: "low|medium|high",
      next_task: "exact existing task id or empty string",
      confidence: "number from 0 to 1",
      abstain: "boolean",
      local_task_outcome: "on_track|at_risk|blocked|achieved|failed|unknown",
      campaign_outcome: "on_track|at_risk|blocked|achieved|failed|unknown",
      evidence: { step: "current step", unit_ids: [], hexes: [], state_change: "observed before/after change" },
      reason: "short grounded explanation"
    }
  };
}

function createTaskCheckerRuntime({ client, runtime, timeoutMs = 60000, maxCallsPerTurn = 4 } = {}) {
  let callsThisTurn = 0;
  let currentTurn = null;
  const records = [];
  async function check({ input, taskPlan, stepRecord, events = [] } = {}) {
    if (!client || !runtime || !events.length) return { skipped: true, reason: "no_trigger" };
    if (currentTurn !== input?.turn) {
      currentTurn = input?.turn;
      callsThisTurn = 0;
    }
    if (callsThisTurn >= maxCallsPerTurn) return { skipped: true, reason: "turn_check_limit" };
    callsThisTurn += 1;
    const started = Date.now();
    const payload = checkerPayload({ input, taskPlan, stepRecord, events });
    let result;
    try {
      result = await client.complete({
        messages: [
          { role: "system", content: resolveSidePrompt(input?.side || taskPlan?.side || "axis", "external.task_checker_system") },
          { role: "user", content: JSON.stringify(payload) }
        ],
        temperature: Number(runtime.profile.defaults.temperature ?? 0.1),
        max_tokens: Math.min(900, Number(runtime.profile.limits.output || 900)),
        response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
        thinking: thinkingRequest(runtime),
        timeout_ms: timeoutMs
      });
      if (!result.ok) throw new Error(`task checker model status ${result.status}`);
      const parsed = parseJson(result);
      if (!parsed) throw new Error("task checker returned invalid JSON");
      const checkResult = normalizeCheck(parsed, taskPlan);
      if (!checkResult.abstain && !checkResult.evidence.state_change) {
        throw new Error("task checker omitted state-change evidence");
      }
      const record = { ok: true, events, result: checkResult, elapsed_ms: Date.now() - started, status: result.status ?? 200 };
      records.push(record);
      return record;
    }
    catch (error) {
      const record = { ok: false, events, fallback: true, reason: error.message, elapsed_ms: Date.now() - started, status: result?.status ?? 0 };
      records.push(record);
      return record;
    }
  }
  return {
    check,
    records,
    resetTurn() { callsThisTurn = 0; },
    metadata() { return { calls_this_turn: callsThisTurn, max_calls_per_turn: maxCallsPerTurn, records: clone(records.slice(-12)) }; }
  };
}

module.exports = { checkerPayload, createTaskCheckerRuntime, normalizeCheck, parseJson };
