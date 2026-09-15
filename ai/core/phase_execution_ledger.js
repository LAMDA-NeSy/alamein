"use strict";

const crypto = require("node:crypto");
const clone = (value) => structuredClone(value);
const TERMINAL = new Set(["executed", "held", "skipped_after_repair", "unavailable", "replaced"]);

function fingerprint(value) {
  const stable = (item) => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])])) : item;
  return crypto.createHash("sha256").update(JSON.stringify(stable(value ?? null))).digest("hex");
}

function failureClass(result = {}) {
  if (result.error_class && result.error_class !== "none") return result.error_class;
  if (result.rejection_type === "strategy" || result.rejection_class === "policy_rejection") return "policy_rejection";
  if (/deadline|timeout/i.test(result.reason || result.error || "")) return "step_timeout";
  if (/tool call limit/i.test(result.reason || "")) return "tool_budget_exhausted";
  if (/path|route|target/i.test(result.reason || "")) return "path_unavailable";
  return "rule_rejection";
}

function createPhaseExecutionLedger({ bridge, sessionId, settings, createPlan, prepare, buildSnapshot, requestRepair, history, rules }) {
  const phases = new Map();
  const versions = new Map();
  function emit(phase, plan, order, data, step) {
    const event = { phase_id: phase.id, plan_id: plan?.plan_id || null, order_id: order?.order_id || null,
      event_id: `${phase.id}:e${phase.events.length + 1}`, step: Number(step), unit: order?.unit || null,
      task_id: order?.task_id || null, ...clone(data) };
    phase.events.push(event);
    if (plan) plan.executions.push(event);
    return event;
  }
  function terminal(phase, plan, order, status, data, step) {
    order.status = status;
    phase.terminal.set(order.unit, { status, order_id: order.order_id });
    return emit(phase, plan, order, { status, ...data }, step);
  }
  const local = (tool, args) => bridge.executeLocalTool(tool, args, sessionId);

  async function next(input, intent, deadline) {
    const phaseId = `${Number(input.turn)}:${input.phase}:${input.side}`;
    const prepared = prepare(input, intent);
    const status = bridge.phaseStatus();
    let phase = phases.get(phaseId);
    if (!phase) {
      phase = { id: phaseId, eligible: [...status.eligible_units], terminal: new Map(), repaired: new Set(),
        batch_attempted: false, versions: [], events: [], requests: [], plan: null };
      phases.set(phaseId, phase);
    }
    const eventStart = phase.events.length;
    const requestStart = phase.requests.length;
    const goal = input.strategicIntent?.goal_plan?.primary_goal || input.operationState?.goal_plan?.primary_goal
      || input.strategicIntent?.operation || intent;
    const goalFingerprint = fingerprint(Object.fromEntries(Object.entries(goal || {}).filter(([key]) =>
      !["progress", "status", "title", "reason", "rationale", "name", "next_action"].includes(key))));
    let plan = phase.plan;
    const keyLoss = plan?.actionable_units.some((unit) => !phase.terminal.has(unit.unit)
      && plan.key_unit_ids?.includes(unit.unit)
      && (!input.state.units?.[unit.unit] || input.state.units[unit.unit].eliminated));
    const replace = plan && (plan.goal_fingerprint !== goalFingerprint || keyLoss);
    const planCreated = !plan || !!replace;
    if (replace) {
      for (const order of plan.unit_orders.filter((item) => !phase.terminal.has(item.unit) && item.status !== "replaced")) {
        order.status = "replaced";
        emit(phase, plan, order, { status: "replaced", reason: keyLoss ? "key_unit_lost" : "goal_revision" }, input.step);
      }
    }
    if (planCreated) {
      const remaining = status.remaining_units.filter((id) => !phase.terminal.has(id));
      plan = await createPlan({ ...input, phaseStatus: { ...status, remaining_units: remaining } }, intent, deadline);
      plan.plan_id = `${phaseId}:p${phase.versions.length + 1}`;
      plan.phase_id = phaseId;
      plan.replaces_plan_id = phase.plan?.plan_id || null;
      plan.goal_fingerprint = goalFingerprint;
      plan.key_unit_ids = (input.forceAllocation?.spearhead || []).map((item) => item.unit || item);
      plan.eligible_units_at_phase_start = phase.eligible.length;
      plan.remaining_units_at_plan_creation = remaining.length;
      plan.unit_orders.forEach((order, index) => {
        order.order_id = `${plan.plan_id}:o${index + 1}`;
        order.original_command = { disposition: order.disposition, target_hex: order.target_hex, priority: order.priority,
          reason: order.reason, source: order.source };
        order.repair_attempts = phase.repaired.has(order.unit) ? 1 : 0;
        if (order.status === "held") order.status = "pending_hold";
      });
      if (phase.plan) phase.plan.replaced_by_plan_id = plan.plan_id;
      phase.plan = plan;
      phase.versions.push(plan.plan_id);
      versions.set(plan.plan_id, plan);
      if (plan.request_count) phase.requests.push({ request_id: plan.request_id || `${plan.plan_id}:request`,
        plan_id: plan.plan_id, stage: "unit_plan", api: plan.api });
      emit(phase, plan, null, { status: "plan_created", replaces_plan_id: plan.replaces_plan_id }, input.step);
    }
    const response = (action, execution, toolResult) => ({ action, prepared, plan: clone(plan), execution,
      tool_result: toolResult, plan_created: planCreated,
      ledger: { protocol: "phase-execution-ledger-v1", phase_id: phaseId, plan_id: plan.plan_id,
        eligible_units: phase.eligible, repaired_units: [...phase.repaired], batch_repair_attempted: phase.batch_attempted,
        terminal_units: Object.fromEntries(phase.terminal), events: clone(phase.events.slice(eventStart)),
        requests: clone(phase.requests.slice(requestStart)),
        plan_versions: planCreated ? clone(phase.versions.map((id) => versions.get(id))) : [] } });
    const settle = () => {
      const finalStatus = bridge.phaseStatus();
      for (const unit of phase.eligible) {
        if (!phase.terminal.has(unit)) {
          const order = plan.unit_orders.find((item) => item.unit === unit);
          const status = finalStatus.held_units.includes(unit) ? "held"
            : finalStatus.acted_units.includes(unit) ? "executed" : "unavailable";
          phase.terminal.set(unit, { status, order_id: order?.order_id || null });
          emit(phase, plan, order, { unit, status, held: status === "held", execution_source: "local_bookkeeping",
            reason: status === "unavailable" ? "no_legal_action_at_phase_end" : "reconciled_shared_bridge_bookkeeping" }, input.step);
        }
        const hex = input.state.units?.[unit]?.hex;
        if (hex) history.set(unit, [...(history.get(unit) || []), hex].slice(-settings.reversal_history_size));
      }
    };
    const held = (orders, reasonClass = null) => {
      if (!orders.length) return;
      const result = local("hold_units", { orders: orders.map((order) => ({ unit: order.unit, reason: order.reason || "model hold" })) });
      for (const order of orders) {
        const one = result.accepted ? result : local("hold_unit", { unit: order.unit, reason: order.reason || "model hold" });
        if (!one.accepted) {
          order.status = "failed_pending";
          order.failure = { reason: one.reason, error_class: failureClass(one) };
          emit(phase, plan, order, { status: "hold_rejected", ...order.failure }, input.step);
          continue;
        }
        terminal(phase, plan, order, reasonClass ? "skipped_after_repair" : "held", {
          held: true, execution_source: reasonClass ? "local_fallback" : order.repaired ? "model_repair" : order.source === "model" ? "phase_plan" : "local_fallback",
          reason: order.reason, failure_class: reasonClass || (order.source === "local_normalization" ? "plan_incomplete" : null),
          warnings: one.warnings || [], repair_attempts: order.repair_attempts,
          canonical_action: { type: "hold_unit", unit: order.unit, reason: order.reason }
        }, input.step);
      }
    };
    // Every iteration either terminates an order, fails a new order, performs the
    // single batch repair, or returns one accepted action. The bound is a bug guard.
    for (let iteration = 0; iteration < plan.unit_orders.length * 4 + 12; iteration += 1) {
      const live = bridge.phaseStatus();
      const mandatory = new Set((live.mandatory_actions || []).flatMap((item) => item.units || []));
      for (const order of plan.unit_orders) {
        if (!TERMINAL.has(order.status) && !live.remaining_units.includes(order.unit) && !mandatory.has(order.unit)) {
          terminal(phase, plan, order, "unavailable", { reason: "no legal action remains in current rule state", execution_source: "local_bookkeeping" }, input.step);
        }
      }
      if (!mandatory.size) held(plan.unit_orders.filter((order) => order.status === "pending_hold"));
      const order = plan.unit_orders.find((item) => ["pending", "needs_repair"].includes(item.status)
        && (!mandatory.size || mandatory.has(item.unit)));
      if (order) {
        const route = plan.actionable_units.find((unit) => unit.unit === order.unit)?.recommended_actions
          ?.find((action) => action.destination === order.target_hex);
        const reusable = route && rules.checkMove(bridge.current().built.ctx, order.unit, route.path, { mode: route.mode }).legal;
        const action = order.disposition === "exit_west" ? { type: "exit_west", unit: order.unit }
          : reusable ? route : { type: "move_intent", unit: order.unit, destination: order.target_hex, mode: "auto", reason: order.reason };
        const expired = deadline != null && Date.now() >= deadline;
        const result = expired ? { accepted: false, retryable: false, error_class: "step_timeout", reason: "step deadline reached" }
          : order.status === "needs_repair" ? { accepted: false, reason: "invalid target in submitted order", error_class: "protocol_failure", rejection_type: "protocol" }
          : local("act", { action });
        const source = order.repaired ? "model_repair" : order.source === "model" ? "phase_plan" : "local_fallback";
        emit(phase, plan, order, { status: expired ? "execution_stopped" : "attempt", action, accepted: !!result.accepted, execution_source: source,
          model_submitted: source !== "local_fallback", request_id: order.repair_request_id || plan.request_id,
          rejection_type: result.rejection_type || "", failure_class: result.accepted ? null : failureClass(result),
          reason: result.reason || "validated", assessment: result.assessment || null }, input.step);
        if (result.accepted) {
          const destination = result.action?.destination || result.action?.path?.at(-1) || "";
          const positions = history.get(order.unit) || [input.state.units?.[order.unit]?.hex].filter(Boolean);
          const execution = terminal(phase, plan, order, "executed", { execution_source: source,
            requested_target: order.target_hex, executed_target: destination, repair_attempts: order.repair_attempts,
            immediate_reversal: !!destination && positions.at(-2) === destination,
            repeated_destination_count: destination ? positions.filter((hex) => hex === destination).length : 0,
            canonical_action: result.action, application_pending: true }, input.step);
          return response(result.action, execution, result);
        }
        order.status = "failed_pending";
        order.failure = { reason: result.reason, error_class: failureClass(result),
          route_evidence: result.assessment?.route_evidence || null,
          alternatives: result.alternatives || [], state_step: input.step,
          preceding_executed_orders: plan.unit_orders.filter((item) => item.status === "executed").map((item) => item.order_id || item.unit) };
        order.non_retryable = result.retryable === false || expired;
        continue;
      }
      const failed = plan.unit_orders.filter((item) => item.status === "failed_pending");
      const repairable = failed.filter((item) => !phase.repaired.has(item.unit) && !item.non_retryable);
      const remainingMs = deadline == null ? settings.phase_repair_timeout_ms : deadline - Date.now();
      const stopped = bridge.current().submitted || bridge.current().tool_calls >= bridge.profile.max_calls_per_step;
      if (repairable.length && !phase.batch_attempted && remainingMs >= 1000 && !stopped) {
        phase.batch_attempted = true;
        repairable.forEach((item) => { phase.repaired.add(item.unit); item.repair_attempts = 1; });
        const snapshot = buildSnapshot(input, plan.phase_intent, repairable.map((item) => item.unit));
        const requestId = `${phaseId}:batch-repair`;
        const timeoutMs = Math.max(1, Math.min(30000, settings.phase_repair_timeout_ms,
          deadline == null ? remainingMs : deadline - Date.now()));
        const repair = await requestRepair(input, plan, repairable, snapshot, timeoutMs, requestId);
        if (repair.requested !== false) {
          plan.repair_request_count += 1;
          phase.requests.push({ request_id: repair.request_id || requestId, plan_id: plan.plan_id, stage: "concentrated_repair",
            timeout_ms: timeoutMs, ...clone(repair) });
        }
        for (const failedOrder of repairable) {
          const replacement = repair.orders?.find((item) => item.unit === failedOrder.unit);
          if (replacement && ["move", "exit_west"].includes(replacement.disposition) && replacement.status === "pending") {
            Object.assign(failedOrder, { disposition: replacement.disposition, target_hex: replacement.target_hex,
              reason: replacement.reason, status: "pending", repaired: true, repair_request_id: repair.request_id || requestId });
            failedOrder.repair_command = clone(replacement);
          }
          else if (replacement?.disposition === "hold" && replacement.source !== "local_normalization" && !repair.error) {
            Object.assign(failedOrder, { disposition: "hold", target_hex: "", status: "pending_hold", reason: replacement.reason,
              repaired: true, repair_request_id: repair.request_id || requestId, repair_command: clone(replacement) });
          }
          else {
            failedOrder.reason = repair.error || replacement?.reason || "omitted_by_batch_repair";
            failedOrder.failure = { reason: failedOrder.reason, error_class: repair.error_class || "repair_failed" };
          }
          emit(phase, plan, failedOrder, { status: "repair_result", request_id: repair.request_id || requestId,
            disposition: replacement?.disposition || "hold", target_hex: replacement?.target_hex || "",
            failure_class: repair.error_class || null, repair_attempts: 1 }, input.step);
        }
        continue;
      }
      const canHoldFailures = failed.filter((item) => !mandatory.has(item.unit));
      for (const item of canHoldFailures) {
        item.reason = `${item.failure?.error_class || "repair_failed"}: ${item.failure?.reason || "no executable command"}`;
        const cause = item.failure?.error_class || "repair_failed";
        held([item], phase.repaired.has(item.unit) && ["path_unavailable", "policy_rejection", "rule_rejection"].includes(cause)
          ? "repair_failed" : cause);
      }
      if (mandatory.size || !bridge.phaseStatus().can_pass) {
        const action = bridge.fallbackAction();
        const result = local("act", { action });
        if (!result.accepted) throw new Error(`mandatory/local execution guard failed: ${result.reason}`);
        if (result.action.type === "pass") {
          settle();
          const execution = emit(phase, plan, null, { status: "plan_complete", execution_source: "system_phase_end",
            advance_reason: "local_fallback_phase_complete" }, input.step);
          return response(result.action, execution, result);
        }
        const fallbackOrder = plan.unit_orders.find((item) => item.unit === action.unit);
        const execution = fallbackOrder
          ? terminal(phase, plan, fallbackOrder, "executed", { execution_source: "local_fallback", canonical_action: result.action,
            reason: "mandatory_rule_repair", application_pending: true }, input.step)
          : emit(phase, plan, null, { status: "executed", unit: action.unit, execution_source: "local_fallback", canonical_action: result.action }, input.step);
        return response(result.action, execution, result);
      }
      settle();
      const action = { type: "pass", reason: "unit_plan_complete" };
      const checked = local("act", { action });
      if (!checked.accepted) throw new Error(`completed phase failed shared validation: ${checked.reason}`);
      const execution = emit(phase, plan, null, { status: "plan_complete", execution_source: "system_phase_end",
        advance_reason: "unit_plan_complete" }, input.step);
      return response(checked.action, execution, checked);
    }
    throw new Error("phase execution ledger made no progress within its finite order bound");
  }
  return { phases, versions, next };
}

function summarizeExecutionLedger(steps = []) {
  const events = new Map();
  const requests = new Map();
  const plans = new Map();
  const phases = new Map();
  for (const step of steps) {
    const ledger = step.execution_ledger;
    if (!ledger) continue;
    phases.set(ledger.phase_id, ledger);
    for (const event of ledger.events || []) events.set(event.event_id, event);
    for (const request of ledger.requests || []) requests.set(request.request_id, request);
    for (const plan of ledger.plan_versions || []) plans.set(plan.plan_id, plan);
    if (step.phase_unit_plan?.plan_id) plans.set(step.phase_unit_plan.plan_id,
      { ...plans.get(step.phase_unit_plan.plan_id), ...step.phase_unit_plan });
  }
  const all = [...events.values()];
  const attempts = all.filter((item) => item.status === "attempt" && item.model_submitted);
  const coverage = [...phases.values()].map((phase) => {
    const modelUnits = new Set([...plans.values()].filter((plan) => plan.phase_id === phase.phase_id)
      .flatMap((plan) => (plan.unit_orders || []).filter((order) => (order.original_command?.source || order.source) === "model").map((order) => order.unit)));
    const states = Object.values(phase.terminal_units);
    return { phase_id: phase.phase_id, initial_eligible: phase.eligible_units.length,
      model_covered: phase.eligible_units.filter((unit) => modelUnits.has(unit)).length,
      remaining: phase.eligible_units.filter((unit) => !phase.terminal_units[unit]).length,
      executed: states.filter((item) => item.status === "executed").length,
      held: states.filter((item) => item.status === "held").length,
      failed_and_held: states.filter((item) => item.status === "skipped_after_repair").length,
      unavailable: states.filter((item) => item.status === "unavailable").length };
  });
  return { protocol: "phase-execution-ledger-v1", evidence_source: "recorded_events", phases: phases.size,
    plan_versions: plans.size, requests: requests.size,
    model_submitted_actions: attempts.length,
    model_rejected_actions: attempts.filter((item) => !item.accepted).length,
    model_rule_rejections: attempts.filter((item) => !item.accepted && item.rejection_type === "rules").length,
    executed: all.filter((item) => item.status === "executed" && item.applied !== false).length,
    application_failures: all.filter((item) => item.status === "executed" && item.applied === false).length,
    held: all.filter((item) => item.status === "held").length,
    failed: all.filter((item) => item.status === "skipped_after_repair").length,
    replaced: all.filter((item) => item.status === "replaced").length,
    repaired_units: [...phases.values()].reduce((sum, phase) => sum + phase.repaired_units.length, 0),
    batch_repair_requests: [...requests.values()].filter((item) => item.stage === "concentrated_repair").length,
    fallback_events_by_reason: all.filter((item) => item.execution_source === "local_fallback").reduce((counts, item) => {
      const reason = item.failure_class || (item.status === "held" ? "plan_incomplete" : "policy_fallback");
      counts[reason] = Number(counts[reason] || 0) + 1;
      return counts;
    }, {}),
    initial_eligible: [...phases.values()].reduce((sum, phase) => sum + phase.eligible_units.length, 0),
    closed_phases: [...phases.values()].filter((phase) => phase.eligible_units.every((unit) => phase.terminal_units[unit])).length,
    coverage_by_phase: coverage,
    plans: [...plans.values()], events: all };
}

function reconstructLegacyPlans(steps = []) {
  const active = new Map();
  const plans = [];
  for (const step of steps) {
    const snapshot = step.phase_unit_plan;
    if (!snapshot) continue;
    const phase = `${step.turn}:${step.phase}:${step.side}`;
    if (!active.has(phase) || snapshot.plan_created) {
      const version = { phase_id: phase, reconstructed_plan_id: `legacy-plan-${plans.length + 1}`, first_step: step.step,
        source: snapshot.source, unit_orders: [], request_count: null, repair_request_count: null };
      active.set(phase, version);
      plans.push(version);
    }
    const version = active.get(phase);
    version.last_step = step.step;
    version.unit_orders = clone(snapshot.unit_orders || []);
    version.request_count = snapshot.request_count ?? null;
    version.repair_request_count = snapshot.repair_request_count ?? null;
  }
  return { protocol: null, evidence_source: "offline_reconstruction_from_plan_created_and_snapshots",
    comparable_to_v16: false, plan_versions: plans.length, reconstructed_plans: plans,
    event_deduplication: null, unique_model_submissions: null, original_order_lineage: null,
    missing: ["stable_event_ids", "cross_version_repair_identity", "original_vs_repair_submission_provenance"] };
}

module.exports = { createPhaseExecutionLedger, summarizeExecutionLedger, reconstructLegacyPlans, fingerprint, failureClass };
