"use strict";

const RulesEngine = require("../../rule_engine.js");
const {
  actionEvaluation,
  buildContext,
  candidateSector,
  movementActionScore,
  opportunityAssessment,
  phaseKind
} = require("../experiments/external_ai_transcript.js");
const { resolveSidePrompt } = require("./prompt_registry.js");

const ROLES = new Set(["breakthrough", "support", "screen", "flank", "supply", "reserve"]);
const DISPOSITIONS = new Set(["move", "hold"]);
const MOVEMENT_PHASES = new Set(["initial_movement", "mechanized_movement", "supply_movement"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function phaseKey(input) {
  return `${Number(input.turn)}:${input.phase}:${input.side}`;
}

function isMovementInput(input) {
  return MOVEMENT_PHASES.has(phaseKind(input.phase));
}

function parseModelJson(result) {
  const content = result?.response_json?.choices?.[0]?.message?.content || "";
  if (!content) return { error: "model returned empty unit plan" };
  try { return JSON.parse(content); }
  catch (error) {
    const marker = content.indexOf('"unit_orders"');
    const arrayStart = marker >= 0 ? content.indexOf("[", marker) : -1;
    const orders = [];
    if (arrayStart >= 0 && content.includes('"phase_unit_plan"')) {
      let depth = 0;
      let start = -1;
      let inString = false;
      let escaped = false;
      for (let index = arrayStart + 1; index < content.length; index += 1) {
        const char = content[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") {
          if (depth === 0) start = index;
          depth += 1;
        }
        else if (char === "}") {
          depth -= 1;
          if (depth === 0 && start >= 0) {
            try { orders.push(JSON.parse(content.slice(start, index + 1))); }
            catch {}
            start = -1;
          }
        }
      }
    }
    if (orders.length) {
      return {
        type: "phase_unit_plan",
        unit_orders: orders,
        partial_model_plan: true,
        parse_warning: `truncated unit plan recovered ${orders.length} complete orders: ${error.message}`
      };
    }
    return { error: `invalid unit plan JSON: ${error.message}` };
  }
}

function actionableUnits(built, side) {
  const kind = phaseKind(built.ctx.state.phase);
  return built.allUnits
    .filter((unit) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .filter((unit) => unit.state === "fresh" && Number(unit.movement || 0) > 0)
    .filter((unit) => RulesEngine.canMoveInCurrentPhase(built.ctx, unit))
    .filter((unit) => kind !== "supply_movement" || RulesEngine.isSupplyUnit(unit))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function intentBonus(ctx, item, intent) {
  const action = item.action || {};
  let bonus = 0;
  if (intent.sector && candidateSector(ctx, action) === intent.sector) bonus += 35;
  if (intent.target_hex && action.destination === intent.target_hex) bonus += 55;
  if ((intent.priority_units || []).includes(action.unit)) bonus += 25;
  if (intent.type === "pressure" && item.evaluation?.tactical_tags?.includes("contact")) bonus += 20;
  if (intent.type === "consolidate" && !(item.evaluation?.risks || []).length) bonus += 15;
  if (["supply", "extend_supply", "protect_supply"].includes(intent.type)
    && RulesEngine.isSupplyUnit({ id: action.unit, ...(ctx.state.units[action.unit] || {}) })) bonus += 40;
  return bonus;
}

function historyAdjustment(ctx, item, recentPositions, settings) {
  const destination = item.action?.destination || "";
  const priorPosition = recentPositions.at(-2) || "";
  const repeats = recentPositions.filter((hex) => hex === destination).length;
  const exemptions = [];
  const unit = ctx.state.units?.[item.action?.unit] || {};
  const start = unit.hex || "";
  const startZoc = start ? RulesEngine.enemyZocSources(ctx, unit.side, start).size : 0;
  const destinationZoc = destination ? RulesEngine.enemyZocSources(ctx, unit.side, destination).size : 0;
  const startMines = start ? RulesEngine.enemyMinesAt(ctx, unit.side, start).length : 0;
  const destinationMines = destination ? RulesEngine.enemyMinesAt(ctx, unit.side, destination).length : 0;
  if (startZoc > destinationZoc) exemptions.push("leaves enemy ZOC pressure");
  if (startMines > destinationMines) exemptions.push("leaves a mined hex");
  if (["primary_objective", "direct"].includes(item.evaluation?.victory_impact?.vp_relevance)) exemptions.push("direct VP relevance");
  if (RulesEngine.isSupplyUnit({ id: item.action?.unit, ...unit }) && Number(item.evaluation?.progress || 0) > 0) {
    exemptions.push("advances a supply unit");
  }
  if (exemptions.length) return { adjustment: 0, immediate_reversal: false, repeat_count: repeats, exemptions };
  let adjustment = 0;
  const immediateReversal = !!priorPosition && destination === priorPosition && destination !== recentPositions.at(-1);
  if (immediateReversal) adjustment -= Number(settings.reversal_penalty || 80);
  if (repeats) adjustment -= repeats * Number(settings.repeated_destination_penalty || 35);
  return { adjustment, immediate_reversal: immediateReversal, repeat_count: repeats, exemptions: [] };
}

function unitOptions(built, unit, phaseIntent, history, settings) {
  const ctx = built.ctx;
  const maxHexes = Number(settings.max_reachable_hexes || 160);
  const reachable = RulesEngine.reachableHexes(ctx, unit.id, { mode: "normal", maxHexes });
  const recentPositions = history.get(unit.id) || [unit.hex];
  const options = [];
  for (const [destination, pathInfo] of reachable.entries()) {
    if (destination === unit.hex || !pathInfo.path || pathInfo.path.length <= 1) continue;
    const action = {
      type: "move",
      unit: unit.id,
      path: pathInfo.path,
      mode: "normal",
      destination,
      spent: pathInfo.cost
    };
    const evaluation = actionEvaluation(ctx, action, built.allUnits);
    const baseScore = movementActionScore(ctx, action, built.allUnits);
    const bonus = intentBonus(ctx, { action, evaluation }, phaseIntent);
    const opportunity = opportunityAssessment(ctx, { action, evaluation, score: baseScore, intent_score: baseScore + bonus }, phaseIntent, built.config);
    if (opportunity.rejected) continue;
    const historyScore = historyAdjustment(ctx, { action, evaluation }, recentPositions, settings);
    options.push({
      destination,
      opportunity_score: Number((opportunity.score + historyScore.adjustment).toFixed(2)),
      progress: Number(evaluation.progress || 0),
      risks: evaluation.risks || [],
      tactical_tags: evaluation.tactical_tags || [],
      history_adjustment: historyScore.adjustment,
      immediate_reversal: historyScore.immediate_reversal,
      repeated_destination_count: historyScore.repeat_count,
      history_exemptions: historyScore.exemptions,
      action
    });
  }
  return options
    .sort((left, right) => right.opportunity_score - left.opportunity_score || String(left.destination).localeCompare(String(right.destination)))
    .slice(0, Number(settings.max_options_per_unit || 3));
}

function buildPlanningSnapshot(config, input, phaseIntent, history, settings) {
  const built = buildContext(config, {
    state: input.state,
    decisionMode: "unit_plan_hybrid",
    phaseIntent
  });
  built.config = config;
  const forcedGroups = RulesEngine.temporaryOverstackGroups(built.ctx, input.side);
  const forcedByUnit = new Map();
  const supplyNetworks = new Map();
  for (const group of forcedGroups) {
    for (const unitId of group.removable_unit_ids) {
      forcedByUnit.set(unitId, { hex: group.hex, excess: group.excess });
    }
  }
  const units = actionableUnits(built, input.side).map((unit) => {
    if (!history.has(unit.id)) history.set(unit.id, [unit.hex]);
    if (!supplyNetworks.has(unit.side)) {
      supplyNetworks.set(unit.side, RulesEngine.buildSupplyNetwork(built.ctx, unit.side));
    }
    return {
      unit: unit.id,
      hex: unit.hex,
      kind: unit.kind || "ground",
      attack: Number(unit.attack || 0),
      defense: Number(unit.defense ?? unit.attack ?? 0),
      movement: Number(unit.movement || 0),
      supply: RulesEngine.supplyState(built.ctx, unit.id, supplyNetworks.get(unit.side)),
      forced_stack_repair: forcedByUnit.has(unit.id),
      forced_stack_repair_hex: forcedByUnit.get(unit.id)?.hex || "",
      forced_stack_repair_excess: Number(forcedByUnit.get(unit.id)?.excess || 0),
      recent_destinations: clone(history.get(unit.id) || [unit.hex]),
      recommended_options: unitOptions(built, unit, phaseIntent, history, settings).map((option) => {
        const { action: _action, ...publicOption } = option;
        return publicOption;
      })
    };
  });
  return {
    built,
    units,
    payload: {
      planning_request: "phase_unit_plan",
      turn: Number(input.turn),
      phase: input.phase,
      side: input.side,
      phase_intent: phaseIntent,
      movement_phase_policy: "rule_complete",
      eligible_units_at_phase_start: units.length,
      actionable_units: units
    }
  };
}

function normalizeUnitPlan(raw, snapshot, source = "model") {
  const value = raw?.type === "phase_unit_plan" ? raw : raw?.plan || raw || {};
  const eligible = new Map(snapshot.units.map((unit) => [unit.unit, unit]));
  const selected = new Map();
  const omittedUnits = [];
  const invalidOrders = [];
  for (const [index, item] of (Array.isArray(value.unit_orders) ? value.unit_orders : []).entries()) {
    if (!eligible.has(item?.unit)) {
      invalidOrders.push({ unit: item?.unit || "", reason: "unknown or ineligible unit" });
      continue;
    }
    const disposition = DISPOSITIONS.has(item.disposition) ? item.disposition : "hold";
    const priority = Number.isInteger(Number(item.priority)) && Number(item.priority) > 0 ? Number(item.priority) : index + 1;
    let targetHex = "";
    let status = disposition === "hold" ? "held" : "pending";
    if (disposition === "move") {
      try { targetHex = RulesEngine.normalizeHex(item.target_hex || item.targetHex || ""); }
      catch {
        status = "needs_repair";
        invalidOrders.push({ unit: item.unit, reason: "invalid target hex" });
      }
    }
    const order = {
      unit: item.unit,
      disposition,
      target_hex: targetHex,
      role: ROLES.has(item.role) ? item.role : disposition === "hold" ? "reserve" : "support",
      priority,
      reason: String(item.reason || "").slice(0, 160),
      status,
      source,
      repair_attempts: 0
    };
    const previous = selected.get(item.unit);
    if (!previous || order.priority < previous.priority) selected.set(item.unit, order);
  }
  let nextPriority = Math.max(0, ...[...selected.values()].map((order) => order.priority)) + 1;
  for (const unit of snapshot.units) {
    if (selected.has(unit.unit)) continue;
    omittedUnits.push(unit.unit);
    selected.set(unit.unit, {
      unit: unit.unit,
      disposition: "hold",
      target_hex: "",
      role: "reserve",
      priority: nextPriority++,
      reason: "omitted_by_model",
      status: "held",
      source: "local_normalization",
      repair_attempts: 0
    });
  }
  const forcedGroups = new Map();
  for (const unit of snapshot.units.filter((item) => item.forced_stack_repair)) {
    if (!forcedGroups.has(unit.forced_stack_repair_hex)) forcedGroups.set(unit.forced_stack_repair_hex, []);
    forcedGroups.get(unit.forced_stack_repair_hex).push(unit);
  }
  for (const units of forcedGroups.values()) {
    const hasRepairMove = units.some((unit) => selected.get(unit.unit)?.disposition === "move");
    if (hasRepairMove) continue;
    const repairUnit = units.find((unit) => unit.recommended_options.length);
    if (!repairUnit) continue;
    const order = selected.get(repairUnit.unit);
    order.disposition = "move";
    order.target_hex = repairUnit.recommended_options[0].destination;
    order.status = "pending";
    order.source = "forced_stack_repair";
    order.reason = "mandatory temporary overstack repair";
  }
  for (const order of selected.values()) {
    const unit = eligible.get(order.unit);
    order.forced_stack_repair = !!unit?.forced_stack_repair && order.disposition === "move";
  }
  const orders = [...selected.values()].sort((left, right) => (
    Number(right.forced_stack_repair) - Number(left.forced_stack_repair)
    || left.priority - right.priority
    || left.unit.localeCompare(right.unit)
  ));
  return {
    orders,
    omitted_units: omittedUnits,
    invalid_orders: invalidOrders,
    coverage: snapshot.units.length ? orders.length / snapshot.units.length : 1
  };
}

function localUnitPlan(snapshot) {
  return {
    type: "phase_unit_plan",
    unit_orders: snapshot.units.map((unit, index) => {
      const best = unit.recommended_options[0];
      return best
        ? { unit: unit.unit, disposition: "move", target_hex: best.destination, role: unit.kind === "supply" ? "supply" : "support", priority: index + 1, reason: "local highest opportunity option" }
        : { unit: unit.unit, disposition: "hold", target_hex: "", role: "reserve", priority: index + 1, reason: "no useful legal option" };
    })
  };
}

async function requestJson(client, runtime, system, payload, label, timeoutMs) {
  const result = await client.complete({
    messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }],
    temperature: runtime.profile.defaults.temperature,
    max_tokens: runtime.profile.limits.output,
    response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
    timeout_ms: timeoutMs
  });
  return { label, result, parsed: result.ok ? parseModelJson(result) : { error: `model API status ${result.status}` } };
}

function createUnitPlanRuntime({ config, runtime, client, bridge, sessionId, settings = {} }) {
  const normalizedSettings = {
    planning_timeout_ms: Number(settings.planning_timeout_ms || 120000),
    max_options_per_unit: Number(settings.max_options_per_unit || 3),
    max_repair_attempts_per_order: Number(settings.max_repair_attempts_per_order || 1),
    reversal_history_size: Number(settings.reversal_history_size || 4),
    reversal_penalty: Number(settings.reversal_penalty || 80),
    repeated_destination_penalty: Number(settings.repeated_destination_penalty || 35),
    max_reachable_hexes: Number(config.context?.maxReachableHexesPerCandidateUnit || 160)
  };
  const plans = new Map();
  const history = new Map();

  async function createPlan(input, phaseIntent) {
    const snapshot = buildPlanningSnapshot(config, input, phaseIntent, history, normalizedSettings);
    let response;
    let parsed;
    let source = "model";
    try {
      const request = await requestJson(
        client,
        runtime,
        resolveSidePrompt(input.side, "external.phase_unit_plan_system"),
        snapshot.payload,
        "phase_unit_plan",
        normalizedSettings.planning_timeout_ms
      );
      response = request.result;
      parsed = request.parsed;
      if (parsed.error) source = "local_fallback";
    }
    catch (error) {
      parsed = { error: error.message };
      source = "local_fallback";
    }
    const rawPlan = source === "model" ? parsed : localUnitPlan(snapshot);
    let normalized = normalizeUnitPlan(rawPlan, snapshot, source);
    const strongestOption = snapshot.units
      .flatMap((unit) => unit.recommended_options.map((option) => ({ unit: unit.unit, option })))
      .sort((left, right) => right.option.opportunity_score - left.option.opportunity_score)[0];
    let guardInjected = false;
    if (!normalized.orders.some((order) => order.disposition === "move")
      && strongestOption && strongestOption.option.opportunity_score >= 120) {
      const order = normalized.orders.find((item) => item.unit === strongestOption.unit);
      order.disposition = "move";
      order.target_hex = strongestOption.option.destination;
      order.status = "pending";
      order.source = "local_high_priority_guard";
      order.reason = "model held all units despite a high-priority move";
      guardInjected = true;
    }
    const key = phaseKey(input);
    const plan = {
      key,
      source,
      phase_intent: clone(phaseIntent),
      eligible_units_at_phase_start: snapshot.units.length,
      actionable_units: snapshot.units,
      unit_orders: normalized.orders,
      omitted_units: normalized.omitted_units,
      invalid_orders: normalized.invalid_orders,
      unit_plan_coverage: normalized.coverage,
      guard_injected: guardInjected,
      api: {
        status: response?.status ?? null,
        elapsed_ms: response?.elapsed_ms ?? null,
        error: parsed?.error || null,
        error_class: response?.error_class || "",
        warning: parsed?.parse_warning || ""
      },
      partial_model_plan: !!parsed?.partial_model_plan,
      model_input: response?.request_body || null,
      model_output: response?.response_json || null,
      raw: source === "model" ? parsed : null,
      executions: [],
      created_at: new Date().toISOString()
    };
    plans.set(key, plan);
    return plan;
  }

  function currentPlan(input) {
    return plans.get(phaseKey(input));
  }

  function focusedOptions(input, phaseIntent, unitId) {
    const snapshot = buildPlanningSnapshot(config, input, phaseIntent, history, { ...normalizedSettings, max_options_per_unit: 5 });
    return snapshot.units.find((unit) => unit.unit === unitId)?.recommended_options || [];
  }

  async function repairOrder(input, plan, order, rejection) {
    const options = focusedOptions(input, plan.phase_intent, order.unit);
    if (!options.length) return { disposition: "hold", error: "no legal repair option", api: null };
    try {
      const request = await requestJson(client, runtime, resolveSidePrompt(input.side, "external.unit_order_repair_system"), {
        planning_request: "unit_order_repair",
        turn: input.turn,
        phase: input.phase,
        side: input.side,
        phase_intent: plan.phase_intent,
        failed_order: order,
        rejection,
        legal_options: options,
        allowed_response: { type: "unit_order_repair", disposition: "move|hold", target_hex: "hex or empty" }
      }, "unit_order_repair", normalizedSettings.planning_timeout_ms);
      const parsed = request.parsed;
      if (parsed.error || parsed.disposition === "hold") return { disposition: "hold", error: parsed.error || "model chose hold", api: request.result };
      let targetHex;
      try { targetHex = RulesEngine.normalizeHex(parsed.target_hex || parsed.targetHex || ""); }
      catch { return { disposition: "hold", error: "invalid repair target", api: request.result }; }
      return { disposition: "move", target_hex: targetHex, api: request.result, raw: parsed };
    }
    catch (error) {
      return { disposition: "hold", error: error.message, api: null };
    }
  }

  function prepare(input, phaseIntent) {
    return bridge.prepareStep({
      ...input,
      session_id: sessionId,
      decisionMode: "direct",
      phaseIntent,
      privateCandidates: false
    });
  }

  async function next(input, phaseIntent) {
    let plan = currentPlan(input);
    const planCreated = !plan;
    if (!plan) plan = await createPlan(input, phaseIntent);
    while (true) {
      const order = plan.unit_orders.find((item) => ["pending", "needs_repair"].includes(item.status));
      if (!order) {
        for (const item of plan.unit_orders.filter((candidate) => candidate.status !== "executed")) {
          const currentHex = input.state.units?.[item.unit]?.hex;
          if (!currentHex) continue;
          const unitHistory = history.get(item.unit) || [];
          unitHistory.push(currentHex);
          history.set(item.unit, unitHistory.slice(-normalizedSettings.reversal_history_size));
        }
        const prepared = prepare(input, phaseIntent);
        return {
          action: { type: "pass", reason: "unit_plan_complete" },
          prepared,
          plan: clone(plan),
          execution: { status: "plan_complete", execution_source: plan.source },
          plan_created: planCreated
        };
      }
      const prepared = prepare(input, phaseIntent);
      let targetHex = order.target_hex;
      let result = order.status === "needs_repair"
        ? { accepted: false, reason: "unit plan target requires repair" }
        : bridge.executeTool("act", { action: { type: "move_intent", unit: order.unit, destination: targetHex, mode: "auto" } }, sessionId);
      let executionSource = order.source === "local_fallback" ? "local_fallback" : "phase_plan";
      let repair = null;
      if (!result.accepted && order.repair_attempts < normalizedSettings.max_repair_attempts_per_order) {
        order.repair_attempts += 1;
        repair = await repairOrder(input, plan, order, result.reason || "rule rejection");
        if (repair.disposition === "move") {
          targetHex = repair.target_hex;
          result = bridge.executeTool("act", { action: { type: "move_intent", unit: order.unit, destination: targetHex, mode: "auto" } }, sessionId);
          executionSource = "model_repair";
        }
      }
      if (!result.accepted) {
        order.status = "skipped_after_repair";
        const execution = {
          unit: order.unit,
          requested_target: order.target_hex,
          status: order.status,
          execution_source: executionSource,
          reason: result.reason || repair?.error || "unit order rejected",
          repair_attempts: order.repair_attempts,
          repair: repair ? {
            raw: repair.raw || null,
            error: repair.error || null,
            api: repair.api ? {
              status: repair.api.status ?? null,
              elapsed_ms: repair.api.elapsed_ms ?? null,
              model_input: repair.api.request_body || null,
              model_output: repair.api.response_json || null
            } : null
          } : null
        };
        plan.executions.push(execution);
        continue;
      }
      order.status = "executed";
      order.executed_target = result.action?.destination || result.action?.path?.at(-1) || targetHex;
      const unitHistory = history.get(order.unit) || [input.state.units?.[order.unit]?.hex].filter(Boolean);
      const selectedOption = plan.actionable_units
        .find((unit) => unit.unit === order.unit)
        ?.recommended_options.find((option) => option.destination === order.executed_target);
      const executedHistory = selectedOption || historyAdjustment(
        bridge.current().built.ctx,
        { action: result.action, evaluation: result.assessment?.evaluation || result.assessment },
        unitHistory,
        normalizedSettings
      );
      unitHistory.push(order.executed_target);
      history.set(order.unit, unitHistory.slice(-normalizedSettings.reversal_history_size));
      const execution = {
        unit: order.unit,
        requested_target: order.target_hex,
        executed_target: order.executed_target,
        status: "executed",
        execution_source: executionSource,
        repair_attempts: order.repair_attempts,
        immediate_reversal: !!executedHistory.immediate_reversal,
        repeated_destination_count: Number(executedHistory.repeated_destination_count ?? executedHistory.repeat_count ?? 0),
        history_exemptions: clone(executedHistory.history_exemptions ?? executedHistory.exemptions ?? []),
        repair: repair ? {
          raw: repair.raw || null,
          error: repair.error || null,
          api: repair.api ? {
            status: repair.api.status ?? null,
            elapsed_ms: repair.api.elapsed_ms ?? null,
            model_input: repair.api.request_body || null,
            model_output: repair.api.response_json || null
          } : null
        } : null,
        canonical_action: clone(result.action)
      };
      plan.executions.push(execution);
      return { action: result.action, prepared, plan: clone(plan), execution, tool_result: result, plan_created: planCreated };
    }
  }

  return {
    history,
    plans,
    isMovementInput,
    next,
    settings: normalizedSettings
  };
}

module.exports = {
  actionableUnits,
  buildPlanningSnapshot,
  createUnitPlanRuntime,
  historyAdjustment,
  isMovementInput,
  localUnitPlan,
  normalizeUnitPlan,
  parseModelJson,
  phaseKey
};
