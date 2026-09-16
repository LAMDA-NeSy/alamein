"use strict";

const { fingerprint } = require("./phase_execution_ledger.js");

function summarizeOpportunityEvidence(ledger) {
  if (!ledger) return null;
  const known = ledger.executed != null && ledger.unknown_effects != null ? ledger.executed - ledger.unknown_effects : null;
  return { ...ledger, entries: undefined,
    known_effects: known,
    verified_no_effects: known == null ? null : known - ledger.verified_effects,
    effect_evidence_coverage: ledger.executed > 0 && known != null ? known / ledger.executed : null,
    conversion_rate: ledger.executed > 0 && known === ledger.executed ? ledger.verified_effects / ledger.executed : null,
    known_outcome_conversion_rate: known > 0 ? ledger.verified_effects / known : null,
    conversion_note: "Unknown effects are not failures; known-outcome rate is conditional on evidence availability." };
}

function createOpportunityLedger() {
  const entries = new Map();
  return {
    observeTacticalPayload(input, payload, modelSaw) {
      const found = [];
      function visit(value) {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value.tactical_opportunities)) found.push(...value.tactical_opportunities);
        for (const item of Object.values(value)) if (item && typeof item === "object") visit(item);
      }
      visit(payload);
      const added = [];
      for (const opportunity of found) {
        const action = opportunity.action || opportunity;
        const target = action.target_hex || action.defender_hex || action.defender_hexes?.[0] || action.hex;
        const participants = [...new Set(action.attackers || action.unit_ids || (action.unit ? [action.unit] : []))].sort();
        if (!target || !participants.length) continue;
        const actionType = ["move", "combat", "clear_mine", "exit_west"].includes(action.type) ? action.type
          : action.attackers?.length ? "combat" : opportunity.type;
        const evidence = { scenario: input.state.scenario, side: input.side, turn: input.turn ?? input.state.turn, phase: input.phase, target,
          participants, type: actionType,
          related_state: participants.map((id) => ({ id, unit: input.state.units?.[id] || null })),
          target_state: Object.entries(input.state.units || {}).filter(([, unit]) => unit.hex === target), opportunity };
        const id = fingerprint({ ...evidence, opportunity: undefined });
        if (entries.has(id)) { entries.get(id).model_seen ||= modelSaw; continue; }
        const entry = { opportunity_id: id, ...evidence, discovery_source: "provided_tactical_context", model_seen: modelSaw,
          selected: false, executed: false, effect: null, first_step: input.step, last_step: input.step };
        entries.set(id, entry);
        added.push(structuredClone(entry));
      }
      return added;
    },
    observePlan(input, plan, modelSaw) {
      const scenario = input.state?.scenario;
      const added = [];
      for (const unit of plan.actionable_units || []) {
        const options = [...(unit.recommended_options || []).map((option) => ({ ...option, action_type: "move" })),
          ...(unit.legal_exit_west ? [{ action_type: "exit_west", destination: "west_edge" }] : [])];
        for (const option of options) {
          const evidence = { scenario, side: input.side, turn: input.turn ?? input.state.turn, phase: input.phase, unit: unit.unit, start: unit.hex,
            supply: unit.supply, target: option.destination, type: option.action_type, risks: option.risks,
            projected_supply: option.projected_supply, legal_route: unit.recommended_actions?.find((item) => item.destination === option.destination)?.path };
          const id = fingerprint(evidence);
          const existing = entries.get(id);
          if (existing) { existing.model_seen ||= modelSaw; continue; }
          const entry = { opportunity_id: id, ...evidence, discovery_source: "bounded_rule_validated_options",
            model_seen: modelSaw, selected: false, executed: false, effect: null,
            metric_scope: scenario === "july" ? "supplied_advance_or_denial" : scenario === "september" ? "clearance_route_preparation" : "withdrawal_or_interception",
            first_step: input.step, last_step: input.step };
          entries.set(id, entry);
          added.push(structuredClone(entry));
        }
      }
      return added;
    },
    apply(input, step) {
      const action = step.final_action || {};
      const target = action.type === "exit_west" ? "west_edge" : action.destination || action.path?.at(-1) || action.hex || action.defender_hexes?.[0];
      const entry = [...entries.values()].reverse().find((item) => item.target === target && item.phase === step.phase
        && item.side === input.side && item.scenario === input.state?.scenario
        && item.turn === (input.turn ?? input.state?.turn) && item.type === action.type
        && (item.unit ? item.unit === action.unit && item.start === input.state?.units?.[action.unit]?.hex
          : (action.attackers || [action.unit]).every((id) => item.participants.includes(id))));
      if (!entry) return null;
      entry.selected ||= ["phase_plan", "model_repair"].includes(step.final_action_source)
        || (!step.fallback_used && (step.action_attempts || []).some((attempt) => attempt.accepted && attempt.model_submitted !== false));
      entry.executed = step.action_applied?.applied === true && step.action_applied?.result?.legal !== false;
      entry.execution_source = step.final_action_source;
      entry.last_step = step.step;
      // Route preparation and projected scores are not proof of a scored outcome.
      const clearance = step.action_applied?.result?.details || {};
      entry.effect = !entry.executed ? null : action.type === "exit_west" ? true
        : input.state?.scenario === "september" && action.type === "clear_mine" && typeof clearance.cleared === "boolean" ? clearance.cleared
        : input.state?.scenario === "july" && Number.isFinite(step.action_effect?.actual_vp_delta) && step.action_effect.actual_vp_delta !== 0
          ? (input.side === "axis" ? step.action_effect.actual_vp_delta > 0 : step.action_effect.actual_vp_delta < 0) : null;
      entry.effect_evidence = entry.effect == null ? "unknown_without_observed_scoring_or_route_block_evidence" : "applied_rule_result";
      return structuredClone(entry);
    },
    report() {
      const values = [...entries.values()];
      return { protocol: "scenario-opportunity-ledger-v1", discovery: values.length,
        model_seen: values.filter((item) => item.model_seen).length,
        model_selected: values.filter((item) => item.selected).length,
        executed: values.filter((item) => item.executed).length,
        verified_effects: values.filter((item) => item.effect === true).length,
        unknown_effects: values.filter((item) => item.executed && item.effect == null).length,
        coverage: "provided_movement_and_tactical_options; unseen_alternatives_and_unobserved_effects_not_inferred",
        entries: structuredClone(values) };
    }
  };
}

function capabilityReferenceErrors(value, availableTools) {
  const text = JSON.stringify(value || {});
  const named = new Set([...text.matchAll(/\b([a-z]+_[a-z_]+)\s*\(/g)].map((match) => match[1]));
  for (const name of ["find_path", "evaluate_action", "view_map", "phase_status", "plan_route", "inspect_supply", "check_combat"]) {
    if (text.includes(name)) named.add(name);
  }
  return [...named].filter((name) => !availableTools.includes(name)).map((name) => ({ tool: name,
    error: "capability_reference_not_available_to_executor", raw_output_preserved: true }));
}

module.exports = { createOpportunityLedger, capabilityReferenceErrors, summarizeOpportunityEvidence };
