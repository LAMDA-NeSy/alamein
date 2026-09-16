"use strict";

const RulesEngine = require("../../rule_engine.js");
const crypto = require("node:crypto");
const {
  actionEvaluation,
  buildContext,
  candidateSector,
  moveTarget,
  movementActionScore,
  opportunityAssessment,
  phaseKind
} = require("../experiments/external_ai_transcript.js");
const { resolveSidePrompt, promptValue } = require("./prompt_registry.js");
const { createPhaseExecutionLedger } = require("./phase_execution_ledger.js");
const { parseModelObject } = require("./model_json.js");

const ROLES = new Set(["breakthrough", "support", "screen", "flank", "supply", "reserve"]);
const DISPOSITIONS = new Set(["move", "hold", "exit_west"]);
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
  const normalized = parseModelObject(result, (parsed) =>
    parsed.type === "phase_unit_plan" && Array.isArray(parsed.unit_orders)
    || parsed.type === "unit_order_repair" && DISPOSITIONS.has(parsed.disposition), "unit plan");
  if (!normalized.error || normalized.parse_status === "ambiguous") return normalized;
  const message = result?.response_json?.choices?.[0]?.message || {};
  const partials = [];
  for (const source of ["content", "reasoning_content"]) {
    const text = typeof message[source] === "string" ? message[source].trim() : "";
    if (!text) continue;
    if (text.startsWith("[")) continue;
    const candidates = [text, ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1])];
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed?.type === "phase_unit_plan" && Array.isArray(parsed.unit_orders)
          || parsed?.type === "unit_order_repair" && DISPOSITIONS.has(parsed.disposition)) {
          return { ...parsed, response_source: source };
        }
      }
      catch {}
    }
    const partial = recoverPartialPlan(text);
    if (!partial.error) partials.push({ ...partial, response_source: source, parse_status: "partial_recovery" });
  }
  return partials[0] || { error: "model returned no valid unit plan JSON in content or reasoning_content" };
}

function recoverPartialPlan(content) {
  if (!content) return { error: "model returned empty unit plan" };
  try {
    JSON.parse(content);
    return { error: "unit plan must be a phase_unit_plan object with unit_orders" };
  }
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

function planControlFingerprint(input, phaseIntent) {
  const stable = (value) => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  const operation = input.operationState || {};
  const tasks = operation.task_plan?.children || operation.active_tasks || [];
  return crypto.createHash("sha256").update(JSON.stringify(stable({
    phase_intent: phaseIntent,
    strategic_intent: input.strategicIntent || null,
    allocation: input.forceAllocation || null,
    parent: operation.task_plan?.parent?.id || null,
    tasks: tasks.map((task) => ({
      id: task.id, status: task.status, priority: task.priority,
      assigned_units: task.assigned_units, target: task.target,
      target_hex: task.target_hex, blocked_reason: task.blocked_reason
    })).sort((left, right) => String(left.id).localeCompare(String(right.id)))
  }))).digest("hex");
}

function actionHasProgress(result) {
  const evaluation = result?.assessment?.evaluation || result?.assessment || {};
  const impact = evaluation.victory_impact || {};
  return Number(evaluation.progress || 0) > 0
    || Number(impact.projected_vp_delta_from_current_state ?? impact.estimated_vp_delta ?? 0) > 0
    || Number(impact.supply_coverage?.delta || 0) > 0
    || (evaluation.tactical_tags || []).some((tag) => ["objective", "contact", "breakthrough", "supply", "zoc", "mine"].includes(tag));
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

function recommendedRoutes(ctx, unit, target, mode, maxExpansions) {
  const queue = [{ hex: unit.hex, path: [unit.hex], cost: 0 }];
  const routes = new Map();
  const visited = new Map();
  let expanded = 0;
  // This bounded search produces suggestions, never an exhaustive legality
  // claim. Every prefix is checked by the unchanged rules engine.
  while (queue.length && expanded++ < maxExpansions) {
    queue.sort((a, b) => RulesEngine.hexDistance(a.hex, target) * 3 + a.cost
      - RulesEngine.hexDistance(b.hex, target) * 3 - b.cost);
    const current = queue.shift();
    for (const hex of RulesEngine.neighbors(current.hex)) {
      if (current.path.includes(hex)) continue;
      const path = [...current.path, hex];
      const verdict = RulesEngine.checkMove(ctx, unit.id, path, { mode });
      if (!verdict.legal) continue;
      const cost = Number(verdict.details.spent);
      const key = `${hex}:${mode === "road" ? current.hex : ""}:${verdict.details.mine_entry_hex || ""}`;
      if (visited.has(key) && visited.get(key) <= cost) continue;
      visited.set(key, cost);
      if (!routes.has(hex) || routes.get(hex).cost > cost) routes.set(hex, { path, cost });
      queue.push({ hex, path, cost });
    }
  }
  return routes;
}

function unitOptions(built, unit, phaseIntent, history, settings) {
  const ctx = built.ctx;
  const recentPositions = history.get(unit.id) || [unit.hex];
  const options = [];
  const routes = new Map();
  const target = RulesEngine.onMap(phaseIntent.target_hex) ? RulesEngine.normalizeHex(phaseIntent.target_hex) : moveTarget(ctx, unit, built.allUnits);
  const startDistance = RulesEngine.hexDistance(unit.hex, target);
  for (const mode of ["normal", "road"]) {
  const reachable = recommendedRoutes(ctx, unit, target, mode,
    Number(settings.max_recommendation_expansions || Math.min(settings.max_reachable_hexes || 32, 32)));
  for (const [destination, pathInfo] of reachable.entries()) {
    if (destination === unit.hex || !pathInfo.path || pathInfo.path.length <= 1) continue;
    const action = {
      type: "move",
      unit: unit.id,
      path: pathInfo.path,
      mode,
      destination,
      spent: pathInfo.cost
    };
    const progress = startDistance - RulesEngine.hexDistance(destination, target);
    const historyScore = historyAdjustment(ctx, { action, evaluation: { progress } }, recentPositions, settings);
    const cheapScore = progress * 18 - Number(pathInfo.cost || 0)
      - RulesEngine.enemyZocSources(ctx, unit.side, destination).size * 20
      - RulesEngine.enemyMinesAt(ctx, unit.side, destination).length * 30 + historyScore.adjustment;
    const previous = routes.get(destination);
    if (!previous || cheapScore > previous.score) routes.set(destination, { action, score: cheapScore });
  }
  }
  // Only a shortlist needs projected supply and tactical evaluation.
  const shortlist = [...routes.values()].sort((a, b) => b.score - a.score)
    .slice(0, Math.max(Number(settings.max_options_per_unit || 3), Number(settings.max_evaluated_options_per_unit || 12)));
  for (const { action } of shortlist) {
    const destination = action.destination;
    const evaluation = actionEvaluation(ctx, action, built.allUnits);
    const impact = evaluation.victory_impact || {};
    const taskProgress = startDistance - RulesEngine.hexDistance(destination, target);
    const baseScore = settings.execution_ledger
      ? taskProgress * 18 + Number(impact.supply_coverage?.delta || 0) * 45
        + Number(impact.projected_vp_delta_from_current_state ?? impact.estimated_vp_delta ?? 0) * 40 + Number(impact.supply_risk_delta || 0) * 35
        - (unit.side === "allies" ? Number(impact.axis_scoring_threat_delta || 0) * 40 : 0)
        - RulesEngine.enemyZocSources(ctx, unit.side, destination).size * 20
        - RulesEngine.enemyMinesAt(ctx, unit.side, destination).length * 30 - Number(action.spent || 0)
      : movementActionScore(ctx, action, built.allUnits);
    const bonus = intentBonus(ctx, { action, evaluation }, phaseIntent);
    const opportunity = opportunityAssessment(ctx, { action, evaluation, score: baseScore, intent_score: baseScore + bonus }, phaseIntent, built.config);
    if (opportunity.rejected) continue;
    const historyScore = historyAdjustment(ctx, { action, evaluation }, recentPositions, settings);
    options.push({
      destination,
      opportunity_score: Number(((settings.execution_ledger ? baseScore : opportunity.score) + historyScore.adjustment).toFixed(2)),
      verified_benefit: Number(impact.supply_coverage?.delta || 0) > 0 || Number(impact.projected_vp_delta_from_current_state ?? impact.estimated_vp_delta ?? 0) > 0
        || (unit.side === "allies" && Number(impact.axis_scoring_threat_delta || 0) < 0)
        || (phaseIntent.verified_task_target && taskProgress > 0
          && ["supplied", "partially_supplied", "partial"].includes(impact.projected_supply_after_move)),
      progress: Number(evaluation.progress || 0),
      target_distance_progress: startDistance - RulesEngine.hexDistance(destination, target),
      risks: evaluation.risks || [],
      tactical_tags: evaluation.tactical_tags || [],
      history_adjustment: historyScore.adjustment,
      immediate_reversal: historyScore.immediate_reversal,
      repeated_destination_count: historyScore.repeat_count,
      history_exemptions: historyScore.exemptions,
      projected_supply: evaluation.victory_impact?.projected_supply_after_move || null,
      action
    });
  }
  const ranked = options
    .sort((left, right) => right.opportunity_score - left.opportunity_score || String(left.destination).localeCompare(String(right.destination)))
  return [...new Map(ranked.slice().reverse().map((option) => [option.destination, option])).values()]
    .sort((left, right) => right.opportunity_score - left.opportunity_score || String(left.destination).localeCompare(String(right.destination)))
    .slice(0, Number(settings.max_options_per_unit || 3));
}

function buildPlanningSnapshot(config, input, phaseIntent, history, settings) {
  const built = input.builtContext || buildContext(config, {
    state: input.state,
    decisionMode: "unit_plan_hybrid",
    phaseIntent,
    privateCandidates: false,
    includeInitialMap: false,
    ...(input.builtContext ? { baseBuilt: input.builtContext } : {})
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
  const remaining = input.phaseStatus ? new Set(input.phaseStatus.remaining_units) : null;
  const tasks = input.operationState?.task_plan?.children || input.operationState?.active_tasks || [];
  const units = actionableUnits(built, input.side)
    .filter((unit) => !remaining || remaining.has(unit.id))
    .filter((unit) => !settings.focus_units || settings.focus_units.includes(unit.id))
    .filter((unit) => !settings.focus_unit || unit.id === settings.focus_unit).map((unit) => {
    if (!history.has(unit.id)) history.set(unit.id, [unit.hex]);
    if (!supplyNetworks.has(unit.side)) {
      supplyNetworks.set(unit.side, RulesEngine.buildSupplyNetwork(built.ctx, unit.side));
    }
    const requestedTaskTarget = tasks.find((task) => task.status === "active"
      && task.assigned_units?.includes(unit.id) && task.target_hex)?.target_hex;
    const taskTarget = RulesEngine.onMap(requestedTaskTarget) ? RulesEngine.normalizeHex(requestedTaskTarget) : "";
    const target = taskTarget || (RulesEngine.onMap(phaseIntent.target_hex) ? RulesEngine.normalizeHex(phaseIntent.target_hex) : moveTarget(built.ctx, unit, built.allUnits));
    const options = unitOptions(built, unit, { ...phaseIntent, target_hex: target,
      verified_task_target: !!taskTarget || RulesEngine.onMap(phaseIntent.target_hex) }, history, settings);
    return {
      unit: unit.id,
      task_ids: tasks.filter((task) => (task.assigned_units || task.units || []).includes(unit.id)
        && !["completed", "failed", "skipped"].includes(task.status)).map((task) => task.id),
      hex: unit.hex,
      recommendation_target: target,
      recommendation_source: taskTarget ? "task_target" : RulesEngine.onMap(phaseIntent.target_hex) ? "phase_intent" : "local_candidate_search",
      target_corrections: [requestedTaskTarget, phaseIntent.target_hex].filter((hex) => hex && !RulesEngine.onMap(hex))
        .map((hex) => ({ requested: hex, correction: "invalid_recommendation_target_ignored" })),
      kind: unit.kind || "ground",
      attack: Number(unit.attack || 0),
      defense: Number(unit.defense ?? unit.attack ?? 0),
      movement: Number(unit.movement || 0),
      supply: RulesEngine.supplyState(built.ctx, unit.id, supplyNetworks.get(unit.side)),
      legal_exit_west: RulesEngine.checkExitWest(built.ctx, { unit: unit.id }).legal === true,
      forced_stack_repair: forcedByUnit.has(unit.id),
      forced_stack_repair_hex: forcedByUnit.get(unit.id)?.hex || "",
      forced_stack_repair_excess: Number(forcedByUnit.get(unit.id)?.excess || 0),
      recent_destinations: clone(history.get(unit.id) || [unit.hex]),
      feasibility: {
        target_hex: target,
        applicable_phase: input.phase,
        remaining_task_phases_this_turn: RulesEngine.turnSequence(built.ctx).slice(
          Math.max(0, RulesEngine.turnSequence(built.ctx).indexOf(input.phase)))
          .filter((phase) => phase.startsWith(`${input.side}_`) && tasks.some((task) => task.assigned_units?.includes(unit.id)
            && (!task.phase_scope?.length || task.phase_scope.includes(phase) || task.phase_scope.includes(phaseKind(phase))))),
        future_eligibility: "conditional; recheck actual rules state at each phase start",
        dependent_units: tasks.filter((task) => task.assigned_units?.includes(unit.id)).flatMap((task) => task.assigned_units || []),
        routes: options.map((option) => ({ target_hex: option.destination, path: option.action.path,
          movement_cost: option.action.spent, projected_supply: option.projected_supply, risks: option.risks })),
        search: { exhaustive: false, max_expansions_per_mode: Number(settings.max_recommendation_expansions || 32),
          result: options.length ? "legal_suggestions_found" : "no_route_found_in_bounded_search",
          unknown: ["routes_outside_search", "future_phase_enemy_actions"] }
      },
      recommended_actions: options.map((option) => option.action),
      recommended_options: options.map((option) => {
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
      request_capabilities: { tools_callable: false, output: "phase_unit_plan JSON only", execution: "local bridge validates one command per replay step" },
      scenario: built.ctx.state.scenario,
      game: built.publicContext.game,
      scoring: built.publicContext.victory,
      scenario_policy: built.publicContext.protocol?.scenario_policy,
      enemy_units: (built.publicContext.unit_index?.enemy || []).filter((unit) => unit.k !== "mine"),
      enemy_mine_hexes: [...new Set((built.publicContext.unit_index?.enemy || [])
        .filter((unit) => unit.k === "mine").map((unit) => unit.h))],
      strategic_goal: input.strategicIntent?.goal_plan?.primary_goal || input.operationState?.goal_plan?.primary_goal || null,
      last_action_effect: input.operationState?.tactical_summary?.last_action_effect || null,
      tactical_opportunities: input.operationState?.tactical_summary?.tactical_opportunities || [],
      reasoning_memory: input.reasoningMemory || null,
      turn: Number(input.turn),
      phase: input.phase,
      side: input.side,
      active_task_ids: input.operationState?.active_tasks?.map((task) => task.id) || [],
      tasks: tasks.map((task) => ({
        id: task.id, status: task.status, type: task.model_task_type || task.type,
        title: task.title, target_hex: task.target_hex, target: task.target,
        target_column: task.target_column, observation_only: task.observation_only,
        scoring_anchor_state: task.scoring_anchor_state, scoring_anchor_loss_count: task.scoring_anchor_loss_count,
        progress_evidence: task.progress_evidence,
        completion_condition: task.completion_condition, next_action: task.next_action,
        phase_scope: task.phase_scope, progress: task.progress, assigned_units: task.assigned_units
      })),
      phase_intent: phaseIntent,
      movement_phase_policy: "rule_complete",
      eligible_units_at_phase_start: input.phaseStatus?.eligible_units?.length ?? units.length,
      recommendation_scope: "bounded suggestions, not all reachable hexes; local_candidate_search is not an assigned objective; other targets are allowed and revalidated",
      actionable_units: units.map(({ recommended_actions: _routes, ...unit }) => unit)
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
      try {
        targetHex = RulesEngine.normalizeHex(item.target_hex || item.targetHex || "");
        if (!RulesEngine.onMap(targetHex)) throw new Error("target outside map");
      }
      catch {
        status = "needs_repair";
        invalidOrders.push({ unit: item.unit, reason: "invalid target hex" });
      }
    }
    if (disposition === "exit_west" && !eligible.get(item.unit).legal_exit_west) {
      status = "needs_repair";
      invalidOrders.push({ unit: item.unit, reason: "west exit is not currently legal" });
    }
    const role = ROLES.has(item.role) ? item.role : disposition === "hold" ? "reserve" : "support";
    const defaultHoldReason = {
      screen: "hold to screen the flank",
      flank: "hold to protect the flank",
      supply: "hold to protect the supply route",
      reserve: "hold as a reserve for the active task",
      support: "hold to support the active task",
      breakthrough: "hold until the breakthrough route is ready"
    }[role];
    const order = {
      unit: item.unit,
      task_id: eligible.get(item.unit).task_ids?.includes(item.task_id) ? item.task_id
        : eligible.get(item.unit).task_ids?.[0] || null,
      disposition,
      target_hex: targetHex,
      role,
      priority,
      reason: String(item.reason || (disposition === "hold" ? defaultHoldReason : "")).slice(0, 160),
      status,
      source,
      repair_attempts: 0
    };
    if (item.task_id && !eligible.get(item.unit).task_ids?.includes(item.task_id)) {
      invalidOrders.push({ unit: item.unit, reason: "unknown or unassigned task_id", task_id: item.task_id });
    }
    const previous = selected.get(item.unit);
    if (!previous || order.priority < previous.priority) selected.set(item.unit, order);
  }
  const modelCovered = source === "model"
    ? [...selected.keys()].filter((unitId) => !omittedUnits.includes(unitId)).length
    : 0;
  let nextPriority = Math.max(0, ...[...selected.values()].map((order) => order.priority)) + 1;
  for (const unit of snapshot.units) {
    if (selected.has(unit.unit)) continue;
    omittedUnits.push(unit.unit);
    selected.set(unit.unit, {
      unit: unit.unit,
      task_id: unit.task_ids?.[0] || null,
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
    model_covered_units: modelCovered,
    model_unit_plan_coverage: snapshot.units.length ? modelCovered / snapshot.units.length : null,
    coverage: snapshot.units.length ? orders.length / snapshot.units.length : 1
  };
}

function localUnitPlan(snapshot, settings = {}) {
  return {
    type: "phase_unit_plan",
    unit_orders: snapshot.units.map((unit, index) => {
      const best = unit.recommended_options.find((option) => !settings.execution_ledger
        || (option.verified_benefit && option.opportunity_score > 0));
      return unit.legal_exit_west
        ? { unit: unit.unit, disposition: "exit_west", target_hex: "", role: "support", priority: index + 1, reason: "local legal scenario exit" }
        : best
        ? { unit: unit.unit, disposition: "move", target_hex: best.destination, role: unit.kind === "supply" ? "supply" : "support", priority: index + 1, reason: "local highest opportunity option" }
        : { unit: unit.unit, disposition: "hold", target_hex: "", role: "reserve", priority: index + 1, reason: "no useful legal option" };
    })
  };
}

async function requestJson(client, runtime, system, payload, label, timeoutMs, prefix = null) {
  if (timeoutMs < 1000) throw new Error("step deadline exhausted before unit planning request");
  const deadline = Date.now() + timeoutMs;
  const result = await client.complete({
    audit_stage: label === "phase_unit_plan_repair" ? "concentrated_repair" : "unit_plan",
    messages: [{ role: "system", content: system }, ...(prefix ? [{ role: "user", content: prefix }] : []), { role: "user", content: JSON.stringify(payload) }],
    temperature: runtime.profile.defaults.temperature,
    max_tokens: runtime.profile.limits.output,
    response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
    timeout_ms: timeoutMs,
    deadline_ms: deadline
  });
  if (Date.now() >= deadline) return { label, result: { ...result, ok: false, error_class: "step_timeout" },
    parsed: { error: "unit plan response exceeded deadline" } };
  const parsed = result.ok ? parseModelJson(result) : { error: `model API status ${result.status}` };
  if (result.ok && parsed.error) {
    const record = runtime.transport?.find((item) => item.request_id === result.request_id);
    if (record) record.protocol_failure = { stage: label, error: parsed.error };
  }
  return { label, result, parsed };
}

function createUnitPlanRuntime({ config, runtime, client, bridge, sessionId, decisionMode = "unit_plan_hybrid", settings = {} }) {
  const normalizedSettings = {
    planning_timeout_ms: Number(settings.planning_timeout_ms || 120000),
    max_options_per_unit: Number(settings.max_options_per_unit || 3),
    max_repair_attempts_per_order: Number(settings.max_repair_attempts_per_order || 1),
    reversal_history_size: Number(settings.reversal_history_size || 4),
    reversal_penalty: Number(settings.reversal_penalty || 80),
    repeated_destination_penalty: Number(settings.repeated_destination_penalty || 35),
    max_reachable_hexes: Number(config.context?.maxReachableHexesPerCandidateUnit || 160),
    max_evaluated_options_per_unit: Number(settings.max_evaluated_options_per_unit || 12),
    max_recommendation_expansions: Number(settings.max_recommendation_expansions || 32),
    execution_ledger: decisionMode === "hierarchical_sae" && settings.execution_ledger === true,
    phase_repair_timeout_ms: Number(settings.phase_repair_timeout_ms || 30000)
  };
  const plans = new Map();
  const history = new Map();
  let staticPlanningPrefix = null;

  async function createPlan(input, phaseIntent, deadline = null) {
    if (normalizedSettings.execution_ledger && !staticPlanningPrefix && input.staticPlanningContext) staticPlanningPrefix = input.staticPlanningContext;
    const contextStarted = Date.now();
    const snapshot = buildPlanningSnapshot(config, input, phaseIntent, history, normalizedSettings);
    const contextComputationMs = Date.now() - contextStarted;
    let response;
    let parsed;
    let source = "model";
    let requestCount = 0;
    try {
      if (!snapshot.units.length && normalizedSettings.execution_ledger) {
        parsed = { type: "phase_unit_plan", unit_orders: [] };
        source = "local_no_eligible_units";
      }
      else {
      if (deadline != null && deadline - Date.now() < 1000) throw new Error("step deadline exhausted before unit planning request");
      requestCount += 1;
      const request = await requestJson(
        client,
        runtime,
        resolveSidePrompt(input.side, "external.phase_unit_plan_system")
          + (normalizedSettings.execution_ledger ? `\n${promptValue("execution_ledger.planning")}` : ""),
        snapshot.payload,
        "phase_unit_plan",
        deadline == null
          ? normalizedSettings.planning_timeout_ms
          : Math.max(1, Math.min(normalizedSettings.planning_timeout_ms, Number(deadline) - Date.now())),
        staticPlanningPrefix
      );
      response = request.result;
      parsed = request.parsed;
      if (parsed.error) source = "local_fallback";
      }
    }
    catch (error) {
      if (normalizedSettings.execution_ledger && (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError)) throw error;
      parsed = { error: error.message };
      source = "local_fallback";
    }
    const rawPlan = source === "model" ? parsed : localUnitPlan(snapshot, normalizedSettings);
    let normalized = normalizeUnitPlan(rawPlan, snapshot, source);
    const strongestOption = snapshot.units
      .flatMap((unit) => unit.recommended_options.map((option) => ({ unit: unit.unit, option })))
      .sort((left, right) => right.option.opportunity_score - left.option.opportunity_score)[0];
    let guardInjected = false;
    if (!normalizedSettings.execution_ledger && !normalized.orders.some((order) => ["move", "exit_west"].includes(order.disposition))
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
      request_id: response?.request_id || null,
      context_computation_ms: contextComputationMs,
      source,
      phase_intent: clone(phaseIntent),
      eligible_units_at_phase_start: snapshot.units.length,
      actionable_units: snapshot.units,
      unit_orders: normalized.orders,
      omitted_units: normalized.omitted_units,
      invalid_orders: normalized.invalid_orders,
      unit_plan_coverage: normalized.coverage,
      model_covered_units: normalized.model_covered_units,
      model_unit_plan_coverage: normalized.model_unit_plan_coverage,
      control_fingerprint: planControlFingerprint(input, phaseIntent),
      guard_injected: guardInjected,
      api: {
        status: response?.status ?? null,
        elapsed_ms: response?.elapsed_ms ?? null,
        error: parsed?.error || null,
        error_class: source !== "local_fallback" ? "none" : response?.error_class && response.error_class !== "none"
          ? response.error_class : /deadline|timeout/i.test(parsed?.error || "") ? "step_timeout" : "protocol_failure",
        warning: parsed?.parse_warning || ""
      },
      partial_model_plan: !!parsed?.partial_model_plan,
      model_input: response?.request_body || null,
      model_output: response?.response_json || null,
      raw: source === "model" ? parsed : null,
      request_count: requestCount,
      repair_request_count: 0,
      stagnant_actions: 0,
      stagnant_replan_requested: false,
      executions: [],
      created_at: new Date().toISOString()
    };
    plans.set(key, plan);
    return plan;
  }

  function currentPlan(input, phaseIntent) {
    const plan = plans.get(phaseKey(input));
    if (!plan) return null;
    if (plan.stagnant_replan_requested) {
      plans.delete(plan.key);
      return null;
    }
    const currentFingerprint = planControlFingerprint(input, phaseIntent);
    if (plan.control_fingerprint !== currentFingerprint) {
      plans.delete(plan.key);
      return null;
    }
    return plan;
  }

  function focusedOptions(input, phaseIntent, unitId) {
    const snapshot = buildPlanningSnapshot(config, input, phaseIntent, history, { ...normalizedSettings, max_options_per_unit: 5, focus_unit: unitId });
    return snapshot.units.find((unit) => unit.unit === unitId)?.recommended_options || [];
  }

  async function repairOrder(input, plan, order, rejection, deadline = null) {
    if (deadline != null && deadline - Date.now() < 1000) {
      return { disposition: "hold", error: "step deadline exhausted before unit repair", api: null, requested: false };
    }
    const options = focusedOptions(input, plan.phase_intent, order.unit);
    if (!options.length) return { disposition: "hold", error: "no legal repair option", api: null, requested: false };
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
      }, "unit_order_repair", deadline == null
        ? normalizedSettings.planning_timeout_ms
        : Math.max(1, Math.min(normalizedSettings.planning_timeout_ms, Number(deadline) - Date.now())));
      const parsed = request.parsed;
      if (parsed.error || parsed.disposition === "hold") return { disposition: "hold", error: parsed.error || "model chose hold", api: request.result, requested: true };
      let targetHex;
      try { targetHex = RulesEngine.normalizeHex(parsed.target_hex || parsed.targetHex || ""); }
      catch { return { disposition: "hold", error: "invalid repair target", api: request.result, requested: true }; }
      return { disposition: "move", target_hex: targetHex, api: request.result, raw: parsed, requested: true };
    }
    catch (error) {
      return { disposition: "hold", error: error.message, api: null, requested: true };
    }
  }

  function prepare(input, phaseIntent) {
    if (input.preparedStep && bridge.current()?.step === Number(input.step)) return input.preparedStep;
    return bridge.prepareStep({
      ...input,
      session_id: sessionId,
      decisionMode,
      phaseIntent,
      strategicIntent: input.strategicIntent || null,
      forceAllocation: input.forceAllocation || null,
      operationState: input.operationState || null,
      privateCandidates: false
    });
  }

  const ledger = normalizedSettings.execution_ledger ? createPhaseExecutionLedger({
    bridge, sessionId, settings: normalizedSettings, createPlan, prepare, history, rules: RulesEngine,
    buildSnapshot: (input, intent, units) => buildPlanningSnapshot(config, input, intent, history,
      { ...normalizedSettings, focus_units: units, max_options_per_unit: 5 }),
    requestRepair: async (input, plan, orders, snapshot, timeoutMs, requestId) => {
      try {
        const request = await requestJson(client, runtime,
          `${resolveSidePrompt(input.side, "external.phase_unit_plan_system")}\nThis is the only batch repair request in this phase. Return one phase_unit_plan with only the listed failed units. You may select a legal option or hold. No tools can be called in this request.`,
          { planning_request: "phase_unit_plan_repair", request_id: requestId, phase_intent: plan.phase_intent,
            failed_orders: orders.map((order) => ({ unit: order.unit, target_hex: order.target_hex, failure: order.failure })),
            actionable_units: snapshot.payload.actionable_units,
            response_example: { type: "phase_unit_plan", unit_orders: [{ unit: orders[0]?.unit, disposition: "hold", target_hex: "", role: "reserve", priority: 1, reason: "no verified safe gain" }] }
          }, "phase_unit_plan_repair", timeoutMs);
        return { request_id: request.result.request_id || requestId,
          orders: request.parsed.error ? [] : normalizeUnitPlan(request.parsed, snapshot).orders,
          error: request.parsed.error || null,
          error_class: request.result.error_class && request.result.error_class !== "none" ? request.result.error_class
            : request.parsed.error ? "protocol_failure" : null,
          api: { status: request.result.status, elapsed_ms: request.result.elapsed_ms },
          model_input: request.result.request_body, model_output: request.result.response_json };
      }
      catch (error) {
        if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) throw error;
        return { orders: [], error: error.message, requested: !/deadline exhausted before/i.test(error.message),
          error_class: /timeout|deadline/i.test(error.message) ? "step_timeout" : "transport_failure" };
      }
    }
  }) : null;

  async function next(input, phaseIntent, deadline = null) {
    let plan = currentPlan(input, phaseIntent);
    const planCreated = !plan;
    if (!plan) plan = await createPlan(input, phaseIntent, deadline);
    while (true) {
      // Holds are part of the phase plan. Apply them through the same rule
      // bridge before selecting the next move so a planned hold cannot keep a
      // completed movement phase artificially open.
      const executedHolds = new Set(plan.executions
        .filter((execution) => execution.status === "held")
        .map((execution) => execution.unit));
      const holdOrders = plan.unit_orders.filter((item) => item.status === "held"
        && !executedHolds.has(item.unit)
        && !item.forced_stack_repair);
      if (holdOrders.length) {
        const holdResult = bridge.executeTool("hold_units", {
          orders: holdOrders.map((item) => ({
            unit: item.unit,
            reason: item.reason || "phase plan hold"
          }))
        }, sessionId);
        const acceptedUnits = new Set(holdResult.accepted
          ? (holdResult.newly_held || holdOrders.map((item) => item.unit))
          : []);
        // hold_units is atomic. If one order invalidates the batch, retry each
        // order independently so a single stale command cannot hide the
        // remaining units or make the phase appear complete.
        const individualResults = holdResult.accepted ? new Map() : new Map(
          holdOrders.map((item) => [item.unit, bridge.executeTool("hold_unit", {
            unit: item.unit,
            reason: item.reason || "phase plan hold"
          }, sessionId)])
        );
        for (const holdOrder of holdOrders) {
          const individual = individualResults.get(holdOrder.unit);
          if (acceptedUnits.has(holdOrder.unit) || individual?.accepted) {
            plan.executions.push({
              unit: holdOrder.unit,
              requested_target: "",
              status: "held",
              execution_source: holdOrder.source === "local_fallback" ? "local_fallback" : "phase_plan",
              reason: holdOrder.reason || "phase plan hold",
              repair_attempts: 0,
              canonical_action: { type: "hold_unit", unit: holdOrder.unit, reason: holdOrder.reason || "phase plan hold" }
            });
          }
          else {
            // Do not convert a rejected hold into a completed/handled unit.
            // The phase-status guard below will keep the phase open and the
            // fallback will receive a chance to move this unit.
            const replacement = plan.actionable_units.find((unit) => unit.unit === holdOrder.unit)
              ?.recommended_options?.[0];
            if (replacement) {
              holdOrder.status = "pending";
              holdOrder.disposition = "move";
              holdOrder.target_hex = replacement.destination;
              holdOrder.reason = `hold rejected; execute the best legal alternative: ${holdOrder.reason || "phase plan hold"}`.slice(0, 160);
            }
            else holdOrder.status = "hold_failed";
            plan.executions.push({
              unit: holdOrder.unit,
              requested_target: "",
              status: holdOrder.status,
              execution_source: "phase_plan",
              reason: individual?.reason || holdResult.reason || "planned hold rejected",
              repair_attempts: 0
            });
          }
        }
        continue;
      }
      const order = plan.unit_orders.find((item) => ["pending", "needs_repair"].includes(item.status));
      if (!order) {
        const status = typeof bridge.phaseStatus === "function" ? bridge.phaseStatus() : null;
        if (status && !status.can_pass) {
          const prepared = prepare(input, phaseIntent);
          const fallback = bridge.fallbackAction();
          return {
            action: fallback,
            prepared,
            plan: clone(plan),
            execution: { status: "plan_incomplete_fallback", execution_source: "local_fallback", phase_status: status },
            tool_result: { accepted: false, reason: "unit plan ended with unhandled eligible units", phase_status: status },
            plan_created: planCreated
          };
        }
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
      const cachedRoute = plan.actionable_units.find((unit) => unit.unit === order.unit)
        ?.recommended_actions?.find((action) => action.destination === targetHex);
      const reusableRoute = cachedRoute && RulesEngine.checkMove(bridge.current().built.ctx,
        order.unit, cachedRoute.path, { mode: cachedRoute.mode }).legal ? cachedRoute : null;
      let result = order.status === "needs_repair"
        ? { accepted: false, reason: "unit plan target requires repair" }
        : bridge.executeTool("act", { action: order.disposition === "exit_west"
          ? { type: "exit_west", unit: order.unit }
          : reusableRoute || { type: "move_intent", unit: order.unit, destination: targetHex, mode: "auto" } }, sessionId);
      let executionSource = ["local_fallback", "forced_stack_repair", "local_high_priority_guard"].includes(order.source)
        ? "local_fallback" : "phase_plan";
      let repair = null;
      if (!result.accepted && order.repair_attempts < normalizedSettings.max_repair_attempts_per_order) {
        order.repair_attempts += 1;
        repair = await repairOrder(input, plan, order, result.reason || "rule rejection", deadline);
        if (repair.requested) plan.repair_request_count = Number(plan.repair_request_count || 0) + 1;
        if (repair.disposition === "move") {
          targetHex = repair.target_hex;
          result = bridge.executeTool("act", { action: { type: "move_intent", unit: order.unit, destination: targetHex, mode: "auto" } }, sessionId);
          executionSource = "model_repair";
        }
      }
      if (!result.accepted) {
        order.status = "skipped_after_repair";
        const holdResult = order.forced_stack_repair
          ? { accepted: false, reason: "mandatory stack repair could not be completed" }
          : bridge.executeTool("hold_unit", {
            unit: order.unit,
            reason: `skipped after unit repair failed: ${result.reason || repair?.error || "target unavailable"}`
          }, sessionId);
        if (holdResult.accepted) {
          plan.executions.push({
            unit: order.unit,
            requested_target: order.target_hex,
            status: "skipped_after_repair",
            execution_source: "local_fallback",
            reason: holdResult.reason || result.reason || "unit order skipped after repair",
            repair_attempts: order.repair_attempts,
            held: true,
            canonical_action: { type: "hold_unit", unit: order.unit, reason: holdResult.reason || "skipped after repair" }
          });
          continue;
        }
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
        if (order.forced_stack_repair) {
          return {
            action: bridge.fallbackAction(),
            prepared,
            plan: clone(plan),
            execution,
            tool_result: { accepted: false, reason: execution.reason },
            plan_created: planCreated
          };
        }
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
      if (actionHasProgress(result)) plan.stagnant_actions = 0;
      else plan.stagnant_actions = Number(plan.stagnant_actions || 0) + 1;
      if (plan.stagnant_actions >= normalizedSettings.max_stagnant_actions) {
        plan.stagnant_replan_requested = true;
        plan.replan_reason = "unit_plan_stagnation";
        execution.replanning_trigger = "unit_plan_stagnation";
      }
      return { action: result.action, prepared, plan: clone(plan), execution, tool_result: result, plan_created: planCreated };
    }
  }

  return {
    history,
    plans,
    isMovementInput,
    next: ledger ? ledger.next : next,
    ledger,
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
