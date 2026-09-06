"use strict";

const DEFAULTS = Object.freeze({
  enabled: true,
  within_step: "full",
  cross_step: "summary_plus_excerpt",
  max_recent_entries: 4,
  max_excerpt_tokens: 800,
  max_summary_tokens: 1200,
  max_stored_entries: 24,
  retain_rejected_options: true,
  reset_on_phase_change: true,
  reset_on_replanning: true
});

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeReasoningMemoryConfig(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const withinStep = ["full", "none"].includes(input.within_step)
    ? input.within_step : DEFAULTS.within_step;
  const crossStep = ["none", "summary_only", "summary_plus_excerpt"].includes(input.cross_step)
    ? input.cross_step : DEFAULTS.cross_step;
  return Object.freeze({
    enabled: input.enabled !== false,
    within_step: withinStep,
    cross_step: crossStep,
    max_recent_entries: clampInteger(input.max_recent_entries, 1, 8, DEFAULTS.max_recent_entries),
    max_excerpt_tokens: clampInteger(input.max_excerpt_tokens, 0, 1600, DEFAULTS.max_excerpt_tokens),
    max_summary_tokens: clampInteger(input.max_summary_tokens, 100, 2400, DEFAULTS.max_summary_tokens),
    max_stored_entries: clampInteger(input.max_stored_entries, 4, 48, DEFAULTS.max_stored_entries),
    retain_rejected_options: input.retain_rejected_options !== false,
    reset_on_phase_change: input.reset_on_phase_change !== false,
    reset_on_replanning: input.reset_on_replanning !== false
  });
}

function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value || ""), "utf8") / 4);
}

function clipText(value, maxTokens, position = "tail") {
  const text = String(value || "").trim();
  const limit = Math.max(0, Number(maxTokens || 0)) * 4;
  if (!text || limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const marker = "...[truncated]...";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentBytes = Math.max(0, limit - markerBytes);
  if (position === "head") {
    return `${Buffer.from(text).subarray(0, contentBytes).toString("utf8")}${marker}`;
  }
  return `${marker}${Buffer.from(text).subarray(-contentBytes).toString("utf8")}`;
}

function responseMessageFromResult(result, options = {}) {
  const message = result?.response_json?.choices?.[0]?.message;
  if (!message || typeof message !== "object") return null;
  const output = { role: "assistant" };
  if (message.content !== undefined) output.content = message.content;
  if (options.includeReasoning !== false && message.reasoning_content !== undefined) {
    output.reasoning_content = message.reasoning_content;
  }
  if (Array.isArray(message.tool_calls)) output.tool_calls = clone(message.tool_calls);
  if (message.refusal !== undefined) output.refusal = message.refusal;
  return output;
}

function toolMessageFromRecord(record, content = null) {
  const message = {
    role: "tool",
    content: content == null ? JSON.stringify(record?.result || {}) : String(content)
  };
  const callId = record?.tool_call_id || record?.call_id || "";
  if (callId) message.tool_call_id = callId;
  if (record?.tool) message.name = record.tool;
  return message;
}

function phaseKey(input = {}) {
  return `${Number(input.turn ?? 0)}:${input.side || ""}:${input.phase || ""}`;
}

function compactToolFeedback(record) {
  const result = record?.result || {};
  return {
    tool: record?.tool || "",
    accepted: result.accepted,
    reason: result.reason || result.error || "",
    stop: result.stop,
    outcome: result.outcome || result.details?.outcome || "",
    instruction: result.instruction || result.recommended_recovery || ""
  };
}

function compactActionEffect(effect) {
  if (!effect || typeof effect !== "object") return null;
  return {
    accepted: effect.accepted,
    action_type: effect.action_type || "",
    unit_ids: Array.isArray(effect.unit_ids) ? effect.unit_ids.slice(0, 8) : [],
    self_vp_delta: Number(effect.self_vp_delta || 0),
    opponent_vp_delta: Number(effect.opponent_vp_delta || 0),
    supply_risk_delta: Number(effect.supply_risk_delta || 0),
    force_preservation_risk: effect.force_preservation_risk || "none",
    combat_opportunities_gained: Array.isArray(effect.combat_opportunities_gained)
      ? effect.combat_opportunities_gained.slice(0, 4) : [],
    combat_opportunities_lost: Array.isArray(effect.combat_opportunities_lost)
      ? effect.combat_opportunities_lost.slice(0, 4) : [],
    applied_result: effect.applied_result || null
  };
}

function extractActionPurpose(stepRecord = {}) {
  const action = stepRecord.final_action || {};
  if (action.reason) return String(action.reason).slice(0, 400);
  const attempts = Array.isArray(stepRecord.action_attempts) ? stepRecord.action_attempts : [];
  const accepted = [...attempts].reverse().find((item) => item.accepted && item.action?.reason);
  if (accepted) return String(accepted.action.reason).slice(0, 400);
  if (stepRecord.next_intent?.purpose) return String(stepRecord.next_intent.purpose).slice(0, 400);
  return "";
}

function responseRecords(stepRecord = {}) {
  return (stepRecord.rounds || [])
    .map((round, index) => ({ round: index + 1, message: responseMessageFromResult({ response_json: round.model_output }) }))
    .filter((item) => item.message);
}

function makeEntry(stepRecord = {}, input = {}, config) {
  const responses = responseRecords(stepRecord);
  const reasoningParts = responses
    .filter((item) => typeof item.message.reasoning_content === "string" && item.message.reasoning_content.trim())
    .map((item) => `[round ${item.round}]\n${item.message.reasoning_content.trim()}`);
  const tools = (stepRecord.rounds || [])
    .filter((round) => round.tool_result)
    .map((round) => compactToolFeedback(round.tool_result));
  const rejected = (stepRecord.action_attempts || [])
    .filter((item) => !item.accepted)
    .map((item) => ({
      action: item.action || null,
      reason: String(item.reason || "").slice(0, 240)
    }))
    .slice(-3);
  const phase = input.phase || stepRecord.phase || "";
  const action = clone(stepRecord.final_action || null);
  const purpose = extractActionPurpose(stepRecord);
  const actionType = action?.type || "pass";
  const summary = [
    `Selected ${actionType}.`,
    purpose ? `Purpose: ${purpose}.` : "",
    tools.length ? `Tool feedback: ${tools.at(-1).reason || tools.at(-1).outcome || "received"}.` : "",
    stepRecord.fallback_used ? "The local fallback selected the final action." : ""
  ].filter(Boolean).join(" ");
  const entry = {
    id: `${Number(input.step ?? stepRecord.step ?? 0)}:${Number(input.turn ?? stepRecord.turn ?? 0)}:${input.side || stepRecord.side || ""}:${phase}`,
    step: Number(input.step ?? stepRecord.step ?? 0),
    turn: Number(input.turn ?? stepRecord.turn ?? 0),
    side: input.side || stepRecord.side || "",
    phase,
    phase_key: phaseKey({ ...input, phase }),
    status: stepRecord.fallback_used ? "fallback" : "active",
    action,
    action_purpose: purpose,
    summary: clipText(summary, config.max_summary_tokens, "head"),
    reasoning_excerpt: config.cross_step === "summary_plus_excerpt"
      ? clipText(reasoningParts.join("\n\n"), config.max_excerpt_tokens) : "",
    reasoning_rounds: reasoningParts.length,
    reasoning_tokens: reasoningParts.reduce((sum, value) => sum + estimateTokens(value), 0),
    response_sources: responses.map((item) => item.message.reasoning_content ? "reasoning_content" : "content"),
    tool_feedback: tools.slice(-6),
    rejected_options: config.retain_rejected_options ? rejected : [],
    next_intent: clone(stepRecord.next_intent || null),
    action_effect: compactActionEffect(stepRecord.action_effect),
    task_progress_delta: clone(stepRecord.task_progress_delta || {}),
    replanning_trigger: stepRecord.sae_replan_pending ? "pending" : null,
    created_at: new Date().toISOString()
  };
  return entry;
}

function promptEntry(entry, config, currentPhaseKey) {
  const samePhase = entry.phase_key === currentPhaseKey;
  return {
    step: entry.step,
    turn: entry.turn,
    phase: entry.phase,
    status: entry.status,
    action: clone(entry.action),
    purpose: entry.action_purpose || "",
    summary: clipText(entry.summary, config.max_summary_tokens, "head"),
    ...(config.cross_step === "summary_plus_excerpt" && samePhase && entry.reasoning_excerpt
      ? { reasoning_excerpt: clipText(entry.reasoning_excerpt, config.max_excerpt_tokens) } : {}),
    tool_feedback: (entry.tool_feedback || []).slice(-3),
    rejected_options: config.retain_rejected_options ? (entry.rejected_options || []).slice(-2) : [],
    action_effect: entry.action_effect || null,
    task_progress_delta: entry.task_progress_delta || {},
    next_intent: entry.next_intent || null
  };
}

function createReasoningMemory(options = {}) {
  const config = normalizeReasoningMemoryConfig(options.config || options);
  const initial = options.initial && typeof options.initial === "object" ? options.initial : {};
  const initialEntries = Array.isArray(initial.entries)
    ? initial.entries
    : Array.isArray(initial.recent_decisions) ? initial.recent_decisions : [];
  const state = {
    version: "reasoning-memory-v1",
    entries: initialEntries.filter((entry) => entry && typeof entry === "object").map(clone).slice(-config.max_stored_entries),
    last_phase_key: initial.last_phase_key || null,
    last_replan: initial.last_replan || null,
    current_entry_id: null,
    stats: {
      recorded_steps: 0,
      reasoning_steps: 0,
      reasoning_tokens: 0,
      invalidated_entries: 0
    }
  };

  function begin(input = {}, options = {}) {
    const current = phaseKey(input);
    const phaseChanged = !!state.last_phase_key && state.last_phase_key !== current;
    if (phaseChanged && config.reset_on_phase_change) {
      const side = input.side || "";
      for (const entry of state.entries) {
        if (entry.side === side && entry.status === "active") {
          entry.status = "archived";
          entry.reasoning_excerpt = "";
        }
      }
    }
    if (options.replanned && config.reset_on_replanning) markReplanned(input, options.reason || "strategic_replan");
    state.last_phase_key = current;
    return { phase_changed: phaseChanged, phase_key: current };
  }

  function markReplanned(input = {}, reason = "strategic_replan") {
    if (!config.reset_on_replanning) return;
    const side = input.side || "";
    for (const entry of state.entries) {
      if (entry.side === side && entry.status !== "superseded") {
        entry.status = "superseded";
        entry.invalidated_by = reason;
        entry.reasoning_excerpt = "";
        state.stats.invalidated_entries += 1;
      }
    }
    state.last_replan = { turn: input.turn ?? null, phase: input.phase || "", side, reason };
    state.current_entry_id = null;
  }

  function recordStep(stepRecord = {}, input = {}) {
    if (!config.enabled) return null;
    const entry = makeEntry(stepRecord, input, config);
    state.entries = state.entries.filter((item) => item.id !== entry.id);
    state.entries.push(entry);
    state.entries = state.entries.slice(-config.max_stored_entries);
    state.current_entry_id = entry.id;
    state.stats.recorded_steps += 1;
    state.stats.reasoning_steps += entry.reasoning_rounds > 0 ? 1 : 0;
    state.stats.reasoning_tokens += entry.reasoning_tokens;
    return clone(entry);
  }

  function recordActionEffect(stepRecord = {}, input = {}) {
    if (!config.enabled) return null;
    const id = state.current_entry_id
      || `${Number(input.step ?? stepRecord.step ?? 0)}:${Number(input.turn ?? stepRecord.turn ?? 0)}:${input.side || stepRecord.side || ""}:${input.phase || stepRecord.phase || ""}`;
    const entry = state.entries.find((item) => item.id === id);
    if (!entry) return recordStep(stepRecord, input);
    entry.action_effect = compactActionEffect(stepRecord.action_effect);
    entry.task_progress_delta = clone(stepRecord.task_progress_delta || entry.task_progress_delta || {});
    entry.next_intent = clone(stepRecord.next_intent || entry.next_intent || null);
    if (entry.action_effect) {
      const effect = entry.action_effect;
      entry.summary = clipText([
        entry.summary,
        `Applied: ${effect.accepted ? "accepted" : "not accepted"}.`,
        effect.self_vp_delta ? `Self VP change: ${effect.self_vp_delta}.` : "",
        effect.supply_risk_delta ? `Supply risk change: ${effect.supply_risk_delta}.` : ""
      ].filter(Boolean).join(" "), config.max_summary_tokens, "head");
    }
    return clone(entry);
  }

  function forPrompt(input = {}) {
    if (!config.enabled || config.cross_step === "none") return null;
    const current = phaseKey(input);
    const side = input.side || "";
    const valid = state.entries.filter((entry) => entry.side === side && entry.status !== "superseded");
    const currentEntries = valid.filter((entry) => entry.phase_key === current).slice(-config.max_recent_entries);
    const previous = valid.filter((entry) => entry.phase_key !== current).at(-1) || null;
    return {
      protocol: "reasoning-memory-v1",
      policy: {
        within_step: config.within_step,
        cross_step: config.cross_step,
        must_revalidate: true
      },
      current: {
        turn: Number(input.turn ?? 0),
        phase: input.phase || "",
        side
      },
      recent_decisions: currentEntries.map((entry) => promptEntry(entry, config, current)),
      previous_phase_decision: previous ? promptEntry(previous, config, current) : null,
      last_replan: state.last_replan,
      instructions: [
        "This is memory, not authoritative game state.",
        "Revalidate every remembered assumption against the current state and tool results.",
        "Do not repeat a rejected action unless the state or task objective has materially changed."
      ]
    };
  }

  function exportState() {
    return {
      version: state.version,
      entries: clone(state.entries),
      last_phase_key: state.last_phase_key,
      last_replan: clone(state.last_replan),
      stats: clone(state.stats)
    };
  }

  function stats() {
    return {
      ...clone(state.stats),
      enabled: config.enabled,
      policy: {
        within_step: config.within_step,
        cross_step: config.cross_step,
        max_recent_entries: config.max_recent_entries,
        max_excerpt_tokens: config.max_excerpt_tokens
      },
      stored_entries: state.entries.length,
      current_entry_id: state.current_entry_id
    };
  }

  return {
    begin,
    config,
    export: exportState,
    forPrompt,
    markReplanned,
    recordActionEffect,
    recordStep,
    stats,
    latest: () => clone(state.entries.at(-1) || null)
  };
}

module.exports = {
  DEFAULT_REASONING_MEMORY_CONFIG: DEFAULTS,
  createReasoningMemory,
  estimateTokens,
  normalizeReasoningMemoryConfig,
  responseMessageFromResult,
  toolMessageFromRecord,
  clipText
};
