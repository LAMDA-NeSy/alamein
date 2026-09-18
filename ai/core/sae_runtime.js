"use strict";

const RulesEngine = require("../../rule_engine.js");
const { buildContext, publicPayload, phaseKind } = require("../experiments/external_ai_transcript.js");
const { resolveSidePrompt, promptValue } = require("./prompt_registry.js");
const { capabilityReferenceErrors } = require("./opportunity_ledger.js");
const { createTaskManager, phaseDispatchTasks, groundedGoalCompleted, taskMonitors, taskExecutionSummary } = require("./task_manager.js");
const { remainingTaskWindows } = require("./task_review.js");
const { createGoalRevisionLedger } = require("./goal_revision_ledger.js");
const { goalIntent, groundGoalPlan, localGoalPlan } = require("./goal_manager.js");
const { thinkingRequest } = require("./model_runtime.js");
const { CONTEXT_PROFILE_ID, compactAgentPayload, contextBytes } = require("./agent_context.js");
const { scenarioPolicy } = require("./scenario_policy.js");
const crypto = require("node:crypto");
const { parseModelObject } = require("./model_json.js");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function remainingDeadlineMs(deadline) {
  if (deadline == null || !Number.isFinite(Number(deadline))) return null;
  return Math.max(0, Number(deadline) - Date.now());
}

function requestTimeoutForDeadline(deadline, fallbackTimeout) {
  const remaining = remainingDeadlineMs(deadline);
  if (remaining == null) return null;
  return Math.max(1, Math.min(Number(fallbackTimeout || remaining), remaining));
}

function phaseKey(input) { return `${Number(input.turn)}:${input.side}`; }

function persistentOperationFromPlan(plan) {
  const candidates = [
    plan?.parent?.persistent_operation,
    plan?.operation_state?.persistent_operation,
    plan?.goal_plan?.persistent_operation,
    plan?.task_plan?.parent?.persistent_operation
  ];
  const value = candidates.find((candidate) => candidate && typeof candidate === "object" && candidate.id);
  return value ? clone(value) : null;
}

function battlefieldFingerprint(input, built = null, options = {}) {
  const state = input?.state || {};
  const side = input?.side || state.active_side || "axis";
  const enemySide = side === "axis" ? "allies" : "axis";
  const enemyUnits = Object.entries(state.units || {})
    .filter(([, unit]) => unit?.side === enemySide)
    .map(([id, unit]) => ({
      id,
      ...(options.includeEnemyPositions === false ? {} : { hex: unit.hex || "" }),
      eliminated: !!unit.eliminated,
      ...(options.includeRoutineUnitState === false ? {} : {
        state: unit.state || "",
        status: unit.status || "",
        supply: unit.supply_state || unit.supply || ""
      })
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const control = options.includeControl === false
    ? []
    : Object.entries(state.control || {})
      .filter(([, owner]) => owner)
      .sort(([left], [right]) => left.localeCompare(right));
  const value = {
    side,
    enemy_side: enemySide,
    enemy_units: enemyUnits,
    control,
    current_vp: options.includeVp === false
      ? null
      : (built?.publicContext?.victory?.current_vp
        ?? state.victory_points
        ?? state.vp
        ?? null)
  };
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function balancedJsonCandidates(text) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    }
    else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function parseJsonText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const candidates = [value];
  const fenced = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  candidates.push(...fenced, ...balancedJsonCandidates(value));
  // Reasoning may contain examples before the final answer; use the last valid object.
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
    catch {
      // Continue searching other balanced objects in the reasoning text.
    }
  }
  return null;
}

function parseJson(result, label) {
  return parseModelObject(result, () => true, label);
}

function parsePlanningResponse(result, expectedType, label) {
  const parsed = parseJson(result, label);
  if (parsed.error) return parsed;
  if (expectedType === "strategic_intent" && parsed.type !== expectedType && !parsed.strategic_intent) {
    return { error: `${label} returned ${parsed.type || "an unknown response"}, expected ${expectedType}` };
  }
  if (expectedType === "force_allocation" && parsed.type !== expectedType && !parsed.force_allocation && !parsed.allocation) {
    return { error: `${label} returned ${parsed.type || "an unknown response"}, expected ${expectedType}` };
  }
  if (expectedType === "goal_plan" && !parsed.goal_plan && !parsed.primary_goal && !parsed.campaign_goal && !["open_goal_plan", "strategic_intent"].includes(parsed.type)) {
    return { error: `${label} returned ${parsed.type || "an unknown response"}, expected goal_plan` };
  }
  return parsed;
}

function eligibleUnits(state, side) {
  return Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map(([id, unit]) => ({
      id,
      hex: unit.hex,
      kind: unit.kind || "ground",
      attack: Number(unit.attack || 0),
      defense: Number(unit.defense ?? unit.attack ?? 0),
      movement: Number(unit.movement || 0),
      state: unit.state || "fresh"
    }));
}

function compactAllocationUnits(index = {}) {
  const project = (unit) => ({
    id: unit.id,
    hex: unit.h || unit.hex || "",
    kind: unit.k || unit.kind || "ground",
    attack: Number(unit.a ?? unit.attack ?? 0),
    defense: Number(unit.d ?? unit.defense ?? 0),
    movement: Number(unit.m ?? unit.movement ?? 0),
    state: unit.s || unit.state || "",
    supply: unit.sup || unit.supply || "",
    area: unit.area || ""
  });
  return {
    active: (index.active || []).map(project),
    enemy: (index.enemy || []).map(project)
  };
}

function scoringEligibleSupply(value) {
  return ["supplied", "partially_supplied", "partial"].includes(String(value || "").toLowerCase());
}

function safeUnitColumn(hex) {
  const column = Number(String(hex || "").slice(0, 2));
  return Number.isFinite(column) ? column : null;
}

function scoringRecoveryEvidence(ctx, side, taskPlan, knownSupply) {
  if (ctx?.state?.scenario !== "july" || side !== "axis") return null;
  const supply = knownSupply || RulesEngine.checkSupply(ctx, side);
  const units = Object.entries(ctx.state.units || {}).filter(([id, unit]) => unit.side === side && unit.hex
    && !unit.eliminated && !unit.off_map && RulesEngine.isVictoryCombatUnit({ id, ...unit }));
  const frontier = Math.max(34, ...units.filter(([id]) => scoringEligibleSupply(supply[id]))
    .map(([, unit]) => safeUnitColumn(unit.hex)));
  const atRisk = units.filter(([id, unit]) => safeUnitColumn(unit.hex) > frontier && !scoringEligibleSupply(supply[id]))
    .sort((a, b) => safeUnitColumn(b[1].hex) - safeUnitColumn(a[1].hex)).slice(0, 4);
  return {
    current_scoring_column: frontier,
    units_without_scoring_supply: atRisk.map(([id, unit]) => ({ unit: id, hex: unit.hex, supply: supply[id],
      isolated_since: unit.isolated_since || null,
      vp_gain_if_resupplied_now: Math.max(0, (safeUnitColumn(unit.hex) - frontier) * 3),
      assigned_task: taskPlan?.children?.find((task) => task.assigned_units?.includes(id))?.id || null,
      nearby_enemy_zoc: RulesEngine.neighbors(unit.hex).filter(RulesEngine.onMap).map((hex) => ({ hex,
        sources: [...RulesEngine.enemyZocSources(ctx, side, hex)].map((enemy) => enemy.id || enemy) }))
        .filter((entry) => entry.sources.length),
      supply_path: supply[id] === "isolated" ? [] : RulesEngine.traceSupplyPath(ctx, id),
      recovery_feasibility: "unknown_until_a_specific_supply_or_blocker_action_is_rule_checked"
    })),
    supply_units: atRisk.length ? Object.entries(ctx.state.units || {}).filter(([id, unit]) => unit.side === side
      && RulesEngine.isSupplyUnit({ id, ...unit })).map(([id, unit]) => ({ unit: id, hex: unit.hex, supply: supply[id] })) : [],
    decision: "Compare restoration of these units, another scoring route, or consolidation. Gains are alternatives, not additive or guaranteed; the model selects and verifies the plan."
  };
}

function buildPhaseUnitFacts(input, built, phaseStatus = {}) {
  const state = input?.state || built?.ctx?.state || {};
  const side = input?.side || state.active_side;
  const kind = phaseKind(input?.phase || state.phase || "");
  const active = built?.publicContext?.unit_index?.active || [];
  const index = new Map(active.map((unit) => [unit.id, unit]));
  const eligible = new Set(phaseStatus.eligible_units || phaseStatus.eligible_units_at_phase_start || []);
  const remaining = new Set(phaseStatus.remaining_units || []);
  const acted = new Set(phaseStatus.acted_units || []);
  const held = new Set(phaseStatus.held_units || []);
  const facts = active.map((indexed) => {
    const unit = state.units?.[indexed.id] || {};
    return {
      id: indexed.id,
      hex: unit.hex || indexed.h || "",
      kind: unit.kind || indexed.k || "ground",
      attack: Number(unit.attack ?? indexed.a ?? 0),
      defense: Number(unit.defense ?? indexed.d ?? unit.attack ?? 0),
      movement: Number(unit.movement ?? indexed.m ?? 0),
      supply: indexed.sup || unit.supply_state || unit.supply || "unknown",
      phase_eligible: eligible.has(indexed.id),
      remaining: remaining.has(indexed.id),
      acted: acted.has(indexed.id),
      held: held.has(indexed.id),
      should_not_act: !eligible.has(indexed.id) || acted.has(indexed.id) || held.has(indexed.id),
      phase_kind: kind,
      can_attack: kind === "combat" && RulesEngine.isCombatUnit({ id: indexed.id, ...unit })
    };
  });
  return { side, kind, facts, index };
}

function legalMoveDirections(ctx, id, limit = 8) {
  const unit = ctx?.state?.units?.[id];
  if (!ctx || !unit?.hex || !RulesEngine.reachableHexes) return [];
  try {
    const reachable = new Map(RulesEngine.neighbors(unit.hex).map((hex) => {
      const path = [unit.hex, hex];
      const verdict = RulesEngine.checkMove(ctx, id, path, { mode: "normal" });
      return [hex, verdict.legal ? { path, cost: verdict.spent ?? verdict.details?.spent ?? 1 } : null];
    }).filter(([, route]) => route));
    return [...reachable.entries()]
      .filter(([hex, item]) => hex !== unit.hex && item?.path?.length > 1)
      .sort((left, right) => (left[1].cost || 99) - (right[1].cost || 99) || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([hex, item]) => ({
        destination: hex,
        path: item.path,
        cost: item.cost ?? item.path.length - 1,
        destination_column: safeUnitColumn(hex),
        enemy_zoc: (() => {
          try { return [...RulesEngine.enemyZocSources(ctx, unit.side, hex)]; }
          catch { return []; }
        })(),
        mines: (() => {
          try { return RulesEngine.enemyMinesAt(ctx, unit.side, hex).map((mine) => mine.id); }
          catch { return []; }
        })()
      }));
  }
  catch {
    return [];
  }
}

function terrainRouteEvidence(ctx, unitId, target) {
  const unit = ctx?.state?.units?.[unitId];
  if (!unit || !target || !RulesEngine.onMap(target)) return [];
  const destination = RulesEngine.normalizeHex(target);
  return RulesEngine.neighbors(destination).flatMap((from) => {
    const result = RulesEngine.stepMovementCost(ctx, { ...unit, id: unitId }, from, destination, { mode: "normal" });
    const tags = RulesEngine.hexTags(ctx, destination);
    const edgeTags = RulesEngine.edgeTags(ctx, RulesEngine.normalizeEdge(from, destination));
    // Never turn an impassable coast edge into a claim about all entries to a hex.
    if (Number.isFinite(result.cost) || ![...tags, ...edgeTags].some((tag) => ["sea", "all_sea", "depression"].includes(tag))) return [];
    return [{ category: "terrain", unit: unitId, from, to: destination, mode: "normal",
      reason: result.reason, hex_tags: tags, edge_tags: edgeTags,
      source: "rule_engine.stepMovementCost", scope: "this_unit_and_edge" }];
  });
}

function combatPreparationEvidence(ctx, side, maxGroups = 6) {
  if (!ctx?.state || !["initial_movement", "mechanized_movement"].includes(RulesEngine.phaseKind(ctx.state.phase))) return null;
  const state = clone(ctx.state);
  state.phase = `${side}_combat`;
  state.active_side = side;
  for (const unit of Object.values(state.units || {})) if (unit.side === side) unit.state = "fresh";
  const projected = RulesEngine.createContext({ state, rules: ctx.rules, terrain: ctx.terrain });
  const groups = new Map();
  const coveredAttackers = new Set();
  for (const unit of RulesEngine.friendlyUnits(projected, side).filter(RulesEngine.canAttackUnit)) {
    if (groups.size >= maxGroups) break;
    if (coveredAttackers.has(unit.id)) continue;
    const attackers = new Set([unit.id]);
    const defenders = new Set();
    let changed = true;
    while (changed) {
      const count = attackers.size + defenders.size;
      for (const hex of RulesEngine.requiredDefenderHexes(projected,
        [...attackers].map((id) => ({ ...state.units[id], id })))) defenders.add(hex);
      if (!defenders.size) break;
      for (const id of RulesEngine.requiredAttackerIds(projected, [...defenders])) attackers.add(id);
      changed = count !== attackers.size + defenders.size;
    }
    if (!defenders.size) continue;
    for (const id of attackers) coveredAttackers.add(id);
    const action = { type: "combat", attackers: [...attackers].sort(), defender_hexes: [...defenders].sort() };
    const verdict = RulesEngine.checkCombat(projected, action);
    const key = JSON.stringify([action.attackers, action.defender_hexes]);
    groups.set(key, { mandatory_attackers: action.attackers, mandatory_defender_hexes: action.defender_hexes,
      legal_under_assumptions: verdict.legal, reason: verdict.reason || null,
      evaluation: verdict.legal ? verdict.details : null });
  }
  return { status: "conditional_estimate", groups: [...groups.values()], limit: maxGroups,
    assumptions: ["positions and supply unchanged", "friendly units refreshed for combat", "other attack restrictions retained"],
    authority: "Mandatory participation relations from shared rules, not selected attacks. The model chooses whether and how to prepare; recheck at execution." };
}

function taskRouteEvidence(ctx, tasks, phase, budgetMs = 2000, deadline = null) {
  if (!ctx?.state || !ctx?.rules || !ctx?.terrain) return [];
  const started = Date.now();
  const limit = Math.max(1, Math.min(2000, Number(budgetMs) || 2000));
  const expired = () => Date.now() - started >= limit
    || (deadline != null && remainingDeadlineMs(deadline) <= 0);
  const routes = [];
  const cache = ctx.task_route_evidence_cache ||= new Map();
  const boardKey = crypto.createHash("sha256").update(JSON.stringify({ state: ctx.state, rules: ctx.rules, terrain: ctx.terrain })).digest("hex");
  if (ctx.task_route_evidence_board_key !== boardKey) {
    cache.clear();
    ctx.task_route_evidence_board_key = boardKey;
  }
  const stateKey = (unitId, target) => JSON.stringify({
    phase, unit: unitId, target,
    unit_state: ctx.state.units?.[unitId],
    active_side: ctx.state.active_side,
    turn: ctx.state.turn,
    scenario: ctx.state.scenario
  });
  const findBoundedPath = (unitId, target) => {
    const unit = ctx.state.units?.[unitId];
    if (!unit?.hex) return { status: "unknown", reason: "unit_not_on_map" };
    let destination;
    try { destination = RulesEngine.normalizeHex(target); }
    catch { return { status: "unknown", reason: "invalid_target_hex" }; }
    const start = RulesEngine.normalizeHex(unit.hex);
    if (start === destination) return { status: "locally_reachable_now", path: [start], movement_cost: 0 };
    const terrain = terrainRouteEvidence(ctx, unitId, destination);
    if (unit.side !== ctx.state.active_side || !RulesEngine.canMoveInCurrentPhase(ctx, { ...unit, id: unitId })) {
      return { status: "not_applicable_now", reason: "unit_phase_ineligible", terrain_obstacles: terrain, searched_hexes: 0 };
    }
    if ((unit.state || "fresh") !== "fresh") return { status: "not_applicable_now", reason: "unit_already_acted", terrain_obstacles: terrain, searched_hexes: 0 };
    const queue = [{ hex: start, path: [start], cost: 0 }];
    const best = new Map([[start, 0]]);
    const blockers = new Set();
    while (queue.length) {
      if (expired()) return { status: "unknown", reason: "route_search_budget_exhausted", searched_hexes: best.size };
      queue.sort((left, right) => left.cost - right.cost);
      const current = queue.shift();
      for (const next of RulesEngine.neighbors(current.hex)) {
        if (expired()) return { status: "unknown", reason: "route_search_budget_exhausted", searched_hexes: best.size };
        const path = [...current.path, next];
        let verdict;
        try { verdict = RulesEngine.checkMove(ctx, unitId, path, { mode: "normal" }); }
        catch (error) { return { status: "unknown", reason: String(error.message || error) }; }
        if (!verdict?.legal) { if (blockers.size < 6) blockers.add(verdict?.reason || "rule_rejected"); continue; }
        const cost = Number(verdict.details?.spent ?? verdict.spent);
        if (!Number.isFinite(cost) || (best.has(next) && best.get(next) <= cost)) continue;
        best.set(next, cost);
        if (next === destination) return { status: "locally_reachable_now", path, movement_cost: cost, searched_hexes: best.size };
        queue.push({ hex: next, path, cost });
      }
    }
    return { status: "not_found_in_current_state", path: [], movement_cost: null, searched_hexes: best.size,
      search_scope: "current_phase_normal_movement_only", future_reachability: "unknown",
      terrain_obstacles: terrain, rule_blockers: [...blockers] };
  };
  for (const task of tasks || []) {
    const target = task.target_hex || "";
    if (!target) continue;
    for (const unitId of (task.assigned_units || []).slice(0, 12)) {
      const key = stateKey(unitId, target);
      const cached = cache.get(key);
      if (cached) { routes.push({ ...cached, task_id: task.id, phase }); continue; }
      if (expired()) {
        routes.push({ task_id: task.id, unit: unitId, phase, target_hex: target, status: "unknown", reason: "route_search_budget_exhausted" });
        continue;
      }
      const result = findBoundedPath(unitId, target);
      const route = {
        task_id: task.id, unit: unitId, phase, target_hex: target, ...result,
        assumptions: ["current board state", "no future enemy movement", "future phase eligibility is not guaranteed"]
      };
      if (route.status !== "unknown") cache.set(key, { ...route, task_id: undefined, phase: undefined });
      routes.push(route);
    }
  }
  return routes;
}

function buildTacticalSummary(input = {}, built = {}, taskPlan = null, allocation = {}, feedback = {}, routeConfig = {}) {
  const state = input.state || built.ctx?.state || {};
  const side = input.side || state.active_side || "axis";
  const enemySide = side === "axis" ? "allies" : "axis";
  const phase = input.phase || state.phase || "";
  const phaseStatus = feedback.phaseStatus || {};
  const unitFacts = buildPhaseUnitFacts({ ...input, phase }, built, phaseStatus);
  const victory = built.publicContext?.victory || {};
  const scoring = victory.current_scoring || {};
  const scenario = String(state.scenario || "july");
  const julyScoring = scoring.july_advance || {};
  const scenarioScoring = scenario === "september"
    ? (scoring.september_mine_clearance || {})
    : scenario === "october"
      ? (scoring.october_withdrawal || {})
      : julyScoring;
  const currentVp = Number(victory.current_vp ?? state.victory_points ?? state.vp ?? 0);
  const baselineVp = Number(feedback.baselineVp ?? RulesEngine.scenarioStartingVp(scenario, 0));
  const activeTasks = (taskPlan?.children || [])
    .filter((task) => task.status === "active" && !task.observation_only)
    .sort((left, right) => Number(left.priority || 99) - Number(right.priority || 99))
    .slice(0, 6);
  const executionSummary = taskExecutionSummary(taskPlan);
  const taskUnits = activeTasks.map((task) => ({
    task_id: task.id,
    task_class: task.task_class || "soft",
    type: task.type,
    title: task.title,
    status: task.status,
    progress: Number(task.progress || 0),
    progress_metric: task.progress_metric || "evidence",
    completion_criteria: task.completion_criteria || null,
    completion_evidence: task.completion_evidence || null,
    assigned_units: (task.assigned_units || []).slice(0, 12),
    applicable_phases: task.phase_scope || [],
    next_action: task.next_action || ""
  }));
  const routeFeasibility = taskRouteEvidence(
    built.ctx,
    activeTasks,
    phaseKind(phase),
    Math.max(1, Number(routeConfig.budget_ms || 2000)),
    feedback.deadline
  );
  let supplyStates = {};
  try {
    if (built.ctx?.rules && built.ctx?.terrain) supplyStates = RulesEngine.checkSupply(built.ctx, side) || {};
  }
  catch {}
  const supplyBottlenecks = unitFacts.facts
    .filter((unit) => RulesEngine.isCombatUnit({ id: unit.id, ...state.units?.[unit.id] })
      && !scoringEligibleSupply(supplyStates[unit.id] || unit.supply))
    .map((unit) => ({ unit: unit.id, hex: unit.hex, supply: supplyStates[unit.id] || unit.supply, reason: "not scoring-eligible" }))
    .slice(0, 12);
  const enemyThreats = [];
  const enemyUnits = Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === enemySide && !unit.eliminated && unit.hex && RulesEngine.isCombatUnit(unit));
  for (const [id, unit] of enemyUnits) {
    const closest = unitFacts.facts
      .filter((candidate) => candidate.hex && RulesEngine.isCombatUnit({ id: candidate.id, ...state.units?.[candidate.id] }))
      .map((candidate) => {
        try { return { candidate, distance: RulesEngine.hexDistance(candidate.hex, unit.hex) }; }
        catch { return { candidate, distance: 99 }; }
      })
      .sort((left, right) => left.distance - right.distance)[0];
    if (!closest || closest.distance > 4) continue;
    enemyThreats.push({
      unit: id,
      hex: unit.hex,
      column: safeUnitColumn(unit.hex),
      attack: Number(unit.attack || 0),
      defense: Number(unit.defense ?? unit.attack ?? 0),
      distance_to_friendly: closest.distance,
      threatened_unit: closest.candidate.id
    });
  }
  enemyThreats.sort((left, right) => left.distance_to_friendly - right.distance_to_friendly || right.column - left.column);
  const dispatch = feedback.phaseDispatch || (taskPlan ? phaseDispatchTasks(taskPlan, { ...input, ctx: built.ctx }) : null);
  const opportunities = {
    ...(taskPlan?.tactical_opportunities || {}),
    ...(dispatch?.tactical_opportunities || {}),
    combat: dispatch?.upcoming_combat_opportunities || []
  };
  const opportunityList = Object.entries(opportunities)
    .flatMap(([type, values]) => Array.isArray(values) ? values.slice(0, 6).map((value) => ({ type, ...value })) : [])
    .slice(0, 12);
  const keyUnits = unitFacts.facts
    .filter((unit) => unit.phase_eligible || (activeTasks.some((task) => task.assigned_units?.includes(unit.id))))
    .slice(0, 12)
    .map((unit) => ({
      unit: unit.id,
      position: unit.hex,
      attack: unit.attack,
      defense: unit.defense,
      movement: unit.movement,
      supply: supplyStates[unit.id] || unit.supply,
      legal_move_options_scope: "adjacent_hexes_only; full routes in unit planning and act",
      legal_move_options: legalMoveDirections(built.ctx, unit.id, 6)
    }));
  const nextScoringChange = scenario === "july"
    ? {
        current_scoring_column: Number(julyScoring.farthest_scoring_column ?? 34),
        next_scoring_column: Number(julyScoring.next_scoring_column ?? 35),
        vp_gain: Number(julyScoring.vp_gain_for_reaching_next_column ?? 3),
        scoring_requirement: julyScoring.scoring_requirement || "surviving supplied or partially supplied Axis ground combat unit"
      }
    : scenario === "september"
      ? {
          current_scoring_column: null,
          next_scoring_column: null,
          vp_gain: Number(scenarioScoring.vp_per_mine ?? 3),
          scoring_requirement: scenarioScoring.next_scoring_change || "clear an Allied minefield hex"
        }
      : {
          current_scoring_column: null,
          next_scoring_column: null,
          vp_gain: null,
          scoring_requirement: scenario === "october"
            ? scenarioScoring.next_scoring_change || "legally exit Axis units through the west edge"
            : "consult the authoritative scenario scoring rules"
        };
  const mustProcess = phaseStatus.mandatory_actions || unitFacts.facts.filter((unit) => unit.remaining).map((unit) => unit.id);
  const canHold = unitFacts.facts.filter((unit) => unit.phase_eligible && !unit.acted && !unit.held).map((unit) => unit.id);
  const shouldNotAct = unitFacts.facts.filter((unit) => unit.should_not_act).map((unit) => unit.id);
  return {
    protocol: "sae-tactical-summary-v1",
    side,
    opponent: enemySide,
    turn: Number(input.turn ?? state.turn ?? 1),
    phase,
    phase_kind: phaseKind(phase),
    remaining_action_opportunities: phaseStatus.remaining_units?.length ?? null,
    current_vp: currentVp,
    baseline_vp: baselineVp,
    vp_delta_from_baseline: currentVp - baselineVp,
    next_scoring_change: nextScoringChange,
    scoring_anchor: taskMonitors(taskPlan).find((task) => task.type === "preserve_scoring_anchor") || null,
    scoring_recovery: scoringRecoveryEvidence(built.ctx, side, taskPlan, supplyStates),
    remaining_phase_windows: Object.fromEntries(activeTasks.map((task) => {
      const { windows, ...summary } = remainingTaskWindows(input, task);
      return [task.id, summary];
    })),
    active_tasks: taskUnits,
    route_feasibility: routeFeasibility,
    combat_preparation: combatPreparationEvidence(built.ctx, side),
    task_units: taskUnits.flatMap((task) => task.assigned_units.map((unit) => ({ unit, task_id: task.task_id, task_class: task.task_class }))),
    key_units: keyUnits,
    supply_bottlenecks: supplyBottlenecks,
    enemy_threats: enemyThreats.slice(0, 12),
    tactical_opportunities: opportunityList,
    blocked_tasks: executionSummary.blocked_tasks,
    forbidden_targets: executionSummary.forbidden_targets,
    recent_execution_errors: executionSummary.recent_execution_errors,
    required_replanning: executionSummary.required_replanning,
    must_process_units: mustProcess,
    can_hold_units: canHold,
    should_not_act_units: shouldNotAct,
    last_action_effect: feedback.lastActionEffect || null,
    task_progress_delta: feedback.lastTaskProgressDelta || {},
    next_required_task: dispatch?.tasks?.[0]?.next_action
      || activeTasks[0]?.next_action
      || "choose the highest-value legal action for the active task",
    replanning_trigger: feedback.replanningTrigger || null,
    allocation_corrections: allocation?.allocation_corrections || []
  };
}

function stateSupplyMap(ctx, side) {
  if (!ctx?.rules || !ctx?.terrain || !side) return {};
  try { return RulesEngine.checkSupply(ctx, side) || {}; }
  catch { return {}; }
}

function countCombatOpportunities(ctx, side) {
  if (!ctx?.state || !ctx?.rules || !ctx?.terrain) return new Set();
  try {
    const byHex = RulesEngine.unitsByHex(ctx);
    const active = Object.entries(ctx.state.units || {})
      .filter(([, unit]) => unit.side === side && !unit.eliminated && unit.hex && RulesEngine.isCombatUnit(unit));
    return new Set(active.flatMap(([id, unit]) => RulesEngine.neighbors(unit.hex)
      .filter((hex) => (byHex[hex] || []).some((other) => other.side !== side && !other.eliminated && RulesEngine.isCombatUnit(other)))
      .map((hex) => `${id}:${hex}`)));
  }
  catch { return new Set(); }
}

function deriveActionEffect(beforeState, afterState, stepRecord = {}, options = {}) {
  const action = stepRecord.final_action || stepRecord.action_applied?.action || {};
  const before = beforeState || {};
  const after = afterState || {};
  const unitIds = [...new Set(action.unit ? [action.unit] : (action.attackers || []))];
  const appliedResult = stepRecord.action_applied?.result;
  const accepted = stepRecord.action_applied?.applied !== false
    && appliedResult?.legal !== false
    && (stepRecord.action_applied || stepRecord.final_action_source === "local_fallback" || stepRecord.action_attempts?.some((item) => item.accepted));
  const rules = options.rules || options.ctx?.rules;
  const terrain = options.terrain || options.ctx?.terrain;
  const makeCtx = (state) => rules && terrain ? RulesEngine.createContext({ state: clone(state), rules, terrain }) : null;
  const beforeCtx = makeCtx(before);
  const afterCtx = makeCtx(after);
  const supplyBefore = stateSupplyMap(beforeCtx, options.side || before.active_side);
  const supplyAfter = stateSupplyMap(afterCtx, options.side || after.active_side);
  const unitDetails = Object.fromEntries(unitIds.map((id) => {
    const previous = before.units?.[id] || {};
    const current = after.units?.[id] || {};
    const oldSupply = supplyBefore[id] || previous.supply_state || previous.supply || "unknown";
    const newSupply = supplyAfter[id] || current.supply_state || current.supply || "unknown";
    let enteredZoc = false;
    try { enteredZoc = !!afterCtx && !!current.hex && RulesEngine.enemyZocSources(afterCtx, current.side, current.hex).size; }
    catch {}
    return [id, {
      from: previous.hex || "",
      to: current.hex || "",
      supply_before: oldSupply,
      supply_after: newSupply,
      supply_changed: oldSupply !== newSupply,
      entered_enemy_zoc: enteredZoc,
      eliminated: !!current.eliminated,
      position_changed: (previous.hex || "") !== (current.hex || "")
    }];
  }));
  const beforeOpps = countCombatOpportunities(beforeCtx, options.side || before.active_side);
  const afterOpps = countCombatOpportunities(afterCtx, options.side || before.active_side);
  const gained = [...afterOpps].filter((item) => !beforeOpps.has(item));
  const lost = [...beforeOpps].filter((item) => !afterOpps.has(item));
  const acceptedAttempt = [...(stepRecord.action_attempts || [])].reverse().find((item) => item.accepted);
  const impact = acceptedAttempt?.assessment?.evaluation?.victory_impact || {};
  const result = stepRecord.action_applied?.result || null;
  let actualVpDelta = options.executionLedger ? null : 0;
  try {
    if (beforeCtx && afterCtx) {
      actualVpDelta = Number(RulesEngine.calculateVictoryPoints(afterCtx).victory_points || 0)
        - Number(RulesEngine.calculateVictoryPoints(beforeCtx).victory_points || 0);
    }
  }
  catch {}
  return {
    protocol: "sae-action-effect-v1",
    accepted: !!accepted,
    action_type: action.type || "",
    unit_ids: unitIds,
    units: unitDetails,
    combat_opportunities_gained: gained.slice(0, 12),
    combat_opportunities_lost: lost.slice(0, 12),
    // This record is written after execution. Never fall back to a proposal
    // estimate when the before/after rule states are unavailable.
    self_vp_delta: actualVpDelta == null ? null : (options.side === "allies" ? -actualVpDelta : actualVpDelta),
    actual_vp_delta: actualVpDelta,
    // A per-action effect is not the final-game result. The terminal
    // transcript owns actual_final_vp_delta.
    actual_final_vp_delta: null,
    proposal_estimates: {
      projected_vp_delta_from_current_state: impact.projected_vp_delta_from_current_state ?? impact.estimated_vp_delta ?? null,
      axis_scoring_threat_delta: impact.axis_scoring_threat_delta ?? null
    },
    opponent_vp_delta: Number(impact.opponent_vp_delta || 0),
    axis_scoring_threat_delta: Number(impact.axis_scoring_threat_delta || 0),
    supply_risk_delta: Number(impact.supply_risk_delta || 0),
    force_preservation_risk: impact.force_preservation_risk || "none",
    applied_result: result ? {
      legal: result.legal,
      outcome: result.outcome || result.details?.outcome || "",
      eliminated: (result.details?.effects?.eliminated || []).slice(0, 12),
      retreated: (result.details?.effects?.retreated?.retreated || []).slice(0, 12)
    } : null,
    mine_clearance: result?.mine_clearance || result?.details?.mine_clearance || null
  };
}

function localAllocation(state, side, intent) {
  const policy = scenarioPolicy({ ...state, active_side: side });
  const units = eligibleUnits(state, side);
  const combat = units.filter((unit) => unit.kind === "ground")
    .sort((a, b) => b.attack + b.defense - a.attack - a.defense || a.id.localeCompare(b.id));
  const supply = units
    .filter((unit) => RulesEngine.isSupplyUnit({ id: unit.id, ...(state.units?.[unit.id] || unit) }))
    .sort((a, b) => Number(b.movement || 0) - Number(a.movement || 0) || a.id.localeCompare(b.id));
  return {
    type: "force_allocation",
    operation: intent.operation || intent.type || policy.primary_metric,
    spearhead: combat.slice(0, 2).map((unit) => ({ unit: unit.id, task: policy.phase_focus })),
    support: combat.slice(2, 5).map((unit) => ({ unit: unit.id, task: policy.action_priorities[1] || policy.phase_focus })),
    supply: supply.slice(0, 2).map((unit) => ({ unit: unit.id, task: policy.supply_meaning })),
    reserve: combat.slice(5, 7).map((unit) => unit.id),
    source: "local_fallback"
  };
}

function normalizeIntent(raw, state) {
  const value = raw?.strategic_intent
    || (raw?.intent && typeof raw.intent === "object" ? { ...raw, ...raw.intent } : raw)
    || {};
  const policy = scenarioPolicy(state);
  const defaultIntent = state.scenario === "september"
    ? (state.active_side === "axis" ? "clear_mines" : "protect_mines")
    : state.scenario === "october"
      ? (state.active_side === "axis" ? "prepare_withdrawal" : "block_withdrawal")
      : state.active_side === "allies" ? "deny_frontier" : "advance";
  const operation = String(value.operation || value.operation_id || defaultIntent).slice(0, 80);
  const targetColumn = Number(value.target_column || value.targetColumn || 0);
  const allowedIntentTypes = new Set([
    "advance", "pressure", "consolidate", "supply", "attack_pressure", "protect_supply", "pass",
    ...(state.scenario === "september" ? ["clear_mines", "engineer_route", "protect_engineers", "protect_mines", "block_engineers", "protect_clearance_supply"] : []),
    ...(state.scenario === "october" ? ["prepare_withdrawal", "withdraw", "protect_withdrawal", "block_withdrawal", "disrupt_supply"] : []),
    ...(state.scenario === "july" && state.active_side === "allies" ? ["deny_frontier"] : [])
  ]);
  return {
    type: "phase_intent",
    intent: {
      type: allowedIntentTypes.has(value.intent_type || value.type)
        ? (value.intent_type || value.type) : "advance",
      sector: ["north", "central", "south"].includes(value.sector) ? value.sector : "",
      target_hex: String(value.target_hex || value.targetHex || ""),
      priority_units: Array.isArray(value.priority_units) ? value.priority_units.filter((id) => state.units?.[id]).slice(0, 8) : []
    },
    operation,
    target_column: Number.isFinite(targetColumn) && targetColumn > 0 ? targetColumn : null,
    objective_type: String(value.objective_type || policy.primary_metric).slice(0, 60),
    required_support: Array.isArray(value.required_support) ? value.required_support.slice(0, 4).map(String) : [],
    priorities: Array.isArray(value.priority) ? value.priority.slice(0, 6).map(String) : [],
    abort_condition: String(value.abort_condition || `abort if the ${policy.primary_metric} plan cannot preserve supply`).slice(0, 180),
    success_condition: String(value.success_condition || `${policy.phase_focus} while preserving supply`).slice(0, 180),
    fallback_condition: String(value.fallback_condition || "replan toward a legal alternative, consolidation, or supply if the primary route is infeasible").slice(0, 180),
    source: "model"
  };
}

function normalizeAllocation(raw, state, side, intent) {
  const value = raw?.force_allocation || raw?.allocation || raw || {};
  const eligible = eligibleUnits(state, side);
  const valid = new Set(eligible.map((unit) => unit.id));
  const movableSupply = new Set(eligible
    .filter((unit) => RulesEngine.isSupplyUnit({ id: unit.id, ...(state.units?.[unit.id] || unit) }))
    .map((unit) => unit.id));
  const assigned = new Set();
  const allocationCorrections = [];
  const rawIds = (key) => (Array.isArray(value[key]) ? value[key] : [])
    .map((item) => typeof item === "string" ? item : item?.unit)
    .filter(Boolean);
  const readGroup = (key, task) => (Array.isArray(value[key]) ? value[key] : [])
    .map((item) => typeof item === "string" ? { unit: item, task } : { unit: item?.unit, task: item?.task || task })
    .filter((item) => {
      if (!valid.has(item.unit)) {
        allocationCorrections.push({ group: key, unit: item.unit || "", reason: "unknown_or_unavailable_unit" });
        return false;
      }
      return true;
    })
    .filter((item) => key === "supply"
      ? (() => {
        if (!movableSupply.has(item.unit)) {
          allocationCorrections.push({ group: key, unit: item.unit, reason: "unit_is_not_a_movable_supply_unit" });
          return false;
        }
        return true;
      })()
      : side !== "allies" || RulesEngine.isCombatUnit({ id: item.unit, ...(state.units?.[item.unit] || {}) })
        || (() => {
          allocationCorrections.push({ group: key, unit: item.unit, reason: "defensive_task_requires_combat_unit" });
          return false;
        })())
    .filter((item) => {
      if (assigned.has(item.unit)) {
        allocationCorrections.push({ group: key, unit: item.unit, reason: "duplicate_unit_kept_in_first_group" });
        return false;
      }
      assigned.add(item.unit);
      return true;
    })
    .slice(0, 12);
  const supplyCorrections = [];
  const requestedSupply = Array.isArray(value.supply) ? value.supply : [];
  for (const item of requestedSupply) {
    const unit = typeof item === "string" ? item : item?.unit;
    if (valid.has(unit) && !movableSupply.has(unit)) supplyCorrections.push({ unit, reason: "removed non-movable supply marker from executable supply task" });
    else if (!valid.has(unit)) allocationCorrections.push({ group: "supply", unit: unit || "", reason: "unknown_or_unavailable_unit" });
  }
  const allocation = {
    type: "force_allocation",
    operation: intent.operation,
    spearhead: readGroup("spearhead", "advance toward the strategic objective"),
    support: readGroup("support", "support the spearhead"),
    supply: readGroup("supply", "maintain supply to the spearhead"),
    reserve: (Array.isArray(value.reserve) ? value.reserve : [])
      .filter((id) => {
        const unit = typeof id === "string" ? id : id?.unit;
        if (!valid.has(unit)) {
          allocationCorrections.push({ group: "reserve", unit: unit || "", reason: "unknown_or_unavailable_unit" });
          return false;
        }
        return true;
      })
      .map((id) => typeof id === "string" ? id : id.unit)
      .filter((id) => side !== "allies" || RulesEngine.isCombatUnit({ id, ...(state.units?.[id] || {}) })
        || (() => {
          allocationCorrections.push({ group: "reserve", unit: id, reason: "defensive_reserve_requires_combat_unit" });
          return false;
        })())
      .filter((id) => {
        if (assigned.has(id)) {
          allocationCorrections.push({ group: "reserve", unit: id, reason: "duplicate_unit_kept_in_first_group" });
          return false;
        }
        return true;
      })
      .filter((id, index, values) => values.indexOf(id) === index)
      .slice(0, 12),
    source: "model"
  };
  for (const id of allocation.reserve) assigned.add(id);
  for (const unit of eligible.filter((item) => !assigned.has(item.id) && item.kind === "ground").slice(0, 2)) {
    allocation.reserve.push(unit.id);
    assigned.add(unit.id);
  }
  const reserveSupplyIndex = allocation.reserve.findIndex((unit) => movableSupply.has(unit));
  if (!allocation.supply.length && reserveSupplyIndex >= 0) {
    const [unit] = allocation.reserve.splice(reserveSupplyIndex, 1);
    allocation.supply.push({ unit, task: "maintain supply to the spearhead" });
    supplyCorrections.push({ unit, reason: "promoted movable supply unit from reserve" });
  }
  if (!allocation.supply.length) {
    const replacement = eligible.find((unit) => movableSupply.has(unit.id) && !assigned.has(unit.id));
    if (replacement) {
      allocation.supply.push({ unit: replacement.id, task: "maintain supply to the spearhead" });
      assigned.add(replacement.id);
      supplyCorrections.push({ unit: replacement.id, reason: "assigned first executable supply unit" });
    }
  }
  allocation.supply_corrections = supplyCorrections;
  allocation.allocation_corrections = allocationCorrections;
  allocation.supply_executable_units = [...movableSupply];
  return allocation;
}

function operationState(intent, allocation, input, built, taskPlan = null, feedback = {}, routeConfig = {}) {
  const allAssigned = [
    ...allocation.spearhead,
    ...allocation.support,
    ...allocation.supply,
    ...allocation.reserve.map((unit) => ({ unit, task: "reserve" }))
  ];
  const units = Object.fromEntries(allAssigned.map((item) => {
    const id = item.unit || item;
    const unit = input.state.units?.[id];
    return [id, {
      role: allocation.spearhead.some((x) => x.unit === id) ? "spearhead"
        : allocation.support.some((x) => x.unit === id) ? "support"
          : allocation.supply.some((x) => x.unit === id) ? "supply" : "reserve",
      task: item.task || "",
      hex: unit?.hex || ""
    }];
  }));
  const activeTasks = (taskPlan?.children || []).filter((task) => task.status === "active" && !task.observation_only)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const phaseDispatch = taskPlan ? phaseDispatchTasks(taskPlan, {
    ...input,
    ctx: built.ctx
  }) : null;
  const primaryTask = activeTasks.find((task) => task.id === phaseDispatch?.primary_task_id)
    || activeTasks[0]
    || null;
  const tacticalSummary = buildTacticalSummary(input, built, taskPlan, allocation, {
    ...feedback,
    phaseStatus: feedback.phaseStatus || {},
    phaseDispatch
  }, feedback.route_config || routeConfig);
  const persistent = taskPlan?.parent?.persistent_operation
    || intent.goal_plan?.persistent_operation
    || null;
  const currentSubgoal = taskPlan?.parent?.current_subgoal
    || intent.goal_plan?.current_subgoal
    || persistent?.current_subgoal
    || null;
  const operationRevision = Number(taskPlan?.parent?.operation_revision
    ?? persistent?.revision
    ?? intent.goal_plan?.operation_revision
    ?? 0);
  return {
    version: taskPlan ? "sae-operation-v2+side-aware-goal-v2" : "sae-operation-v1",
    operation: intent.operation,
    persistent_operation: persistent,
    current_subgoal: currentSubgoal,
    operation_revision: Number.isFinite(operationRevision) ? operationRevision : 0,
    target_column: intent.target_column,
    goal_plan: intent.goal_plan || null,
    operation_policy: intent.goal_plan?.operation_policy || null,
    status: "in_progress",
    target: intent.intent,
    force_allocation: allocation,
    task_plan: taskPlan,
    active_tasks: activeTasks.map((task) => ({
      id: task.id,
      type: task.type,
      title: task.title,
      priority: task.priority,
      assigned_units: task.assigned_units,
      compatible_units: task.compatible_units || [],
      progress: task.progress,
      wait_state: task.wait_state || null,
      review_request: task.review_request || null,
      activation_reason: task.activation_reason || "",
      tactical_opportunities: task.tactical_opportunities || [],
      next_action: task.next_action
    })),
    phase_dispatch: phaseDispatch,
    tactical_summary: tacticalSummary,
    task_execution_summary: taskExecutionSummary(taskPlan),
    units,
    phase: input.phase,
    phase_kind: phaseKind(input.phase),
    current_vp: built.publicContext.victory?.current_vp ?? null,
    next_required_task: phaseDispatch?.tasks?.[0]?.next_action
      || taskPlan?.children?.find((task) => task.status === "active")?.next_action
      || (phaseKind(input.phase) === "supply_movement" && allocation.supply.length
      ? `maintain supply with ${allocation.supply[0].unit}`
      : allocation.spearhead.length ? `advance ${allocation.spearhead[0].unit} toward the strategic objective` : "choose a legal action"),
    progress: {
      spearhead_assigned: allocation.spearhead.length,
      support_assigned: allocation.support.length,
      supply_assigned: allocation.supply.length
    },
    execution_brief: primaryTask ? {
      current_task: `${primaryTask.title} (${primaryTask.id})`,
      executable_tasks_this_phase: phaseDispatch?.tasks || [],
      tactical_opportunities: taskPlan?.tactical_opportunities || {},
      observable_gap: primaryTask.progress_evidence || primaryTask.next_action || primaryTask.completion_condition,
      preferred_units: primaryTask.assigned_units || [],
      completion_condition: primaryTask.completion_condition,
      frontier_breakthrough: phaseDispatch?.frontier_breakthrough || null,
      avoid: [
        "Do not use a unit assigned to an inactive task unless the current task is impossible.",
        `Evaluate supply changes against the ${input.state?.scenario || "current"} objective; report affected units and tradeoffs.`,
        input.side === "allies"
          ? "Do not pass over a locally verified 3:1 counterattack against a supplied Axis frontier threat without rechecking it."
          : "Do not repeat a combat below 2:1 without a concrete emergency or VP justification."
      ]
    } : null,
    warnings: [
      input.state?.scenario === "july"
        ? "An unsupplied spearhead cannot establish a scoring frontier; evaluate projected end-turn supply."
        : "Supply coverage changes are tactical risks, not universal action prohibitions; compare route and scenario gains.",
      "The dynamic frontier_breakthrough plan is evidence and sequencing guidance, not a fixed target or mandatory attack combination."
    ],
    source: "sae_runtime"
  };
}

function createSaeRuntime({ config, runtime, client, taskChecker = null, decisionPolicy = "hierarchical_sae", reasoningMemory = null, availableTools = [] }) {
  const cache = new Map();
  const replanReasons = new Map();
  const executionLedger = config.task_management_options?.execution_ledger === true;
  const goalHistory = createGoalRevisionLedger((plan, input, goal) => ({
    ...groundedGoalCompleted(plan, input, goal),
    campaign_evaluation: goal.campaign_goal ? groundedGoalCompleted(plan, input, goal.campaign_goal) : null
  }));
  const taskManager = config.task_management === "multi_task"
    ? createTaskManager({
      executionLedger,
      taskProtocol: config.task_management_options?.protocol || config.task_management_options?.task_protocol || "",
      taskGeneration: config.task_management_options?.task_generation || "fixed_skeleton",
      scoringAnchorPolicy: config.task_management_options?.scoring_anchor_policy || "none",
      maxChildTasks: Number(config.task_management_options?.max_child_tasks || 6),
      maxActiveChildTasks: Number(config.task_management_options?.max_active_child_tasks || 3),
      noProgressThreshold: Number(config.task_management_options?.no_progress_replan_threshold || 3),
      blockedThreshold: Number(config.task_management_options?.blocked_replan_threshold || 2),
      supplyWorsenedThreshold: Number(config.task_management_options?.supply_worsened_replan_threshold || 2),
      lowOddsThreshold: Number(config.task_management_options?.low_odds_replan_threshold || 2),
      replanCooldownActions: Number(config.task_management_options?.replan_cooldown_actions || 3),
      passiveHoldThreshold: Number(config.task_management_options?.passive_hold_replan_threshold || 3),
      reviewPolicy: config.task_management_options?.review_policy || "legacy",
      dependencyPolicy: config.task_management_options?.dependency_policy || "hard_soft_conditional_v1",
      monitorPolicy: config.task_management_options?.monitor_policy || "legacy_children",
      replanOnNewTacticalOpportunity: config.task_management_options?.replan_on_new_tactical_opportunity !== false
    })
    : null;
  const openGoalEnabled = !!taskManager && config.task_management_options?.goal_management === "open_grounded";
  let lastPlan = null;
  let failedReplanPhase = null;
  let failedReplanReason = null;
  let pendingTaskCheck = null;
  let lastBuiltContext = null;
  let lastBuiltInput = null;
  let lastActionEffect = null;
  let recentCombatResults = [];
  const routeObstacles = new Map();
  let lastTaskProgressDelta = {};
  let currentReviewChecks = [];
  function runtimeInput(input = {}) {
    if (!config.performance || typeof config.performance !== "object") return input;
    return {
      ...input,
      performance: {
        ...(input.performance || {}),
        ...config.performance
      }
    };
  }
  function rememberBuiltContext(input, built) {
    lastBuiltInput = input;
    lastBuiltContext = built;
    return built;
  }
  function contextFor(input) {
    return lastBuiltInput?.state === input?.state ? lastBuiltContext : null;
  }
  async function runPendingTaskCheck(input, deadline = null) {
    if (!taskChecker || !taskManager) return;
    const reviews = taskManager.pendingReviews(input).slice(0, 1);
    if (config.task_management_options?.review_policy === "model_review_wait_v1" && !reviews.length) {
      pendingTaskCheck = null;
      return;
    }
    if (!pendingTaskCheck && !reviews.length) return;
    const pending = pendingTaskCheck || { stepRecord: {}, events: [] };
    pendingTaskCheck = null;
    const timeoutMs = requestTimeoutForDeadline(deadline, taskChecker.timeoutMs || 60000);
    if (timeoutMs != null && timeoutMs < 1000) {
      pending.stepRecord.task_observation ||= {};
      pending.stepRecord.task_observation.check = {
        skipped: true,
        reason: "step_deadline_exhausted",
        review_requests: clone(reviews)
      };
      taskManager.recordReviewAttempt(reviews.map((request) => request.id), input, pending.stepRecord.task_observation.check);
      currentReviewChecks.push(pending.stepRecord.task_observation.check);
      return;
    }
    const reviewPlan = taskManager.plan || pending.taskPlan;
    const checked = await taskChecker.check({
      input,
      taskPlan: { ...reviewPlan, scoring_recovery: scoringRecoveryEvidence(input.ctx, input.side, reviewPlan) },
      stepRecord: pending.stepRecord,
      events: [...new Set([...pending.events, ...reviews.flatMap((request) => request.reasons)])],
      reviewRequests: reviews,
      timeoutMs
    });
    pending.stepRecord.task_observation ||= {};
    pending.stepRecord.task_observation.check = checked;
    currentReviewChecks.push(checked);
    taskManager.recordReviewAttempt(checked.ok && !checked.result?.abstain && reviews.some((request) => request.id === checked.result?.review_id) ? [checked.result.review_id]
      : reviews.map((request) => request.id), input, checked);
    if (!checked.ok) return;
    const localSupplyConflict = pending.events.includes("supply_worsened")
      && checked.result?.supply_preserved === true;
    if (localSupplyConflict) {
      checked.consistency_warning = "checker reported preserved supply while local rule evaluation reported supply_worsened";
      return;
    }
    const beforeStatus = taskManager.plan?.children?.find((task) => task.id === checked.result?.task_id)?.status;
    const checkedPlan = taskManager.applyCheck(checked.result, input);
    const lastReview = checkedPlan?.children?.find((task) => task.id === checked.result?.task_id)?.review_history?.at(-1);
    checked.review_application = !checked.result?.abstain && Number(checked.result?.confidence) >= 0.5
      && lastReview?.review_id === checked.result?.review_id && lastReview?.at?.step === input.step ? lastReview : null;
    pending.stepRecord.task_observation.plan = checkedPlan || pending.stepRecord.task_observation.plan;
    checked.applied_task_transition = {
      task_id: checked.result?.task_id,
      status_before: beforeStatus,
      status_after: checkedPlan?.children?.find((task) => task.id === checked.result?.task_id)?.status
    };
  }
  async function plan(input, options = {}) {
    input = runtimeInput(input);
    const deadline = options.deadline == null ? null : Number(options.deadline);
    currentReviewChecks = [];
    if (taskManager?.plan) {
      const refreshedContext = buildContext(config, { state: input.state, decisionMode: "hierarchical_sae",
        includeInitialMap: false, privateCandidates: false });
      rememberBuiltContext(input, refreshedContext);
      taskManager.refresh({ ...input, ctx: refreshedContext.ctx });
    }
    await runPendingTaskCheck({ ...input, ctx: contextFor(input)?.ctx || input.ctx }, deadline);
    const key = phaseKey(input);
    const cached = cache.get(key);
    // Multi-task plans should survive ordinary enemy movement. Rebuild only
    // when material facts change; the execution context still contains the
    // latest enemy coordinates for tactical decisions.
    const currentFingerprint = battlefieldFingerprint(input, null, {
      includeRoutineUnitState: !executionLedger,
      includeEnemyPositions: !taskManager,
      includeControl: !taskManager,
      includeVp: !taskManager
    });
    const taskReplanReason = taskManager?.needsReplan() ? taskManager.consumeReplanReason() : "";
    const fingerprintChanged = (!!cached?.battlefield_fingerprint && cached.battlefield_fingerprint !== currentFingerprint)
      || (!!lastPlan?.battlefield_fingerprint && lastPlan.battlefield_fingerprint !== currentFingerprint);
    const replanReason = failedReplanPhase === `${input.turn}:${input.phase}` ? ""
      : replanReasons.get(key) || taskReplanReason || failedReplanReason || (fingerprintChanged ? "enemy_state_changed" : "");
    reasoningMemory?.begin(input, { replanned: !!replanReason, reason: replanReason });
    if (replanReason) {
      cache.delete(key);
      replanReasons.delete(key);
    }
    if (cached && !replanReason) {
      const built = rememberBuiltContext(input, contextFor(input) || buildContext(config, {
        state: input.state,
        decisionMode: "hierarchical_sae",
        includeInitialMap: false,
        privateCandidates: false
      }));
      const refreshed = clone(cached);
      refreshed.reused = true;
      const taskPlan = taskManager?.refresh({ ...input, ctx: built.ctx }) || refreshed.operation_state?.task_plan || null;
      refreshed.operation_state = operationState(refreshed.strategic_intent, refreshed.force_allocation, input, built, taskPlan, { lastActionEffect, lastTaskProgressDelta, deadline }, config.task_management_options || {});
      if (failedReplanReason) refreshed.operation_state.waiting_for_new_goal = true;
      refreshed.battlefield_fingerprint = currentFingerprint || battlefieldFingerprint(input, built, {
        includeRoutineUnitState: !executionLedger,
        includeEnemyPositions: !taskManager,
        includeControl: !taskManager,
        includeVp: !taskManager
      });
      refreshed.record = {
        ...refreshed.record,
        reused: true,
        planning_attempted: false,
        replanned: false,
        replan_reason: "",
        task_reviews: clone(currentReviewChecks),
        task_plan: taskPlan,
        operation: refreshed.operation_state
      };
      return refreshed;
    }
    if (taskManager?.plan && !replanReason && lastPlan
      && (!lastPlan.battlefield_fingerprint || lastPlan.battlefield_fingerprint === currentFingerprint)) {
      const built = rememberBuiltContext(input, contextFor(input) || buildContext(config, {
        state: input.state,
        decisionMode: "hierarchical_sae",
        includeInitialMap: false,
        privateCandidates: false
      }));
      const reused = clone(lastPlan);
      const taskPlan = taskManager.refresh({ ...input, ctx: built.ctx });
      reused.reused = true;
      reused.operation_state = operationState(reused.strategic_intent, reused.force_allocation, input, built, taskPlan, { lastActionEffect, lastTaskProgressDelta, deadline }, config.task_management_options || {});
      if (failedReplanReason) reused.operation_state.waiting_for_new_goal = true;
      reused.battlefield_fingerprint = currentFingerprint || battlefieldFingerprint(input, built, {
        includeRoutineUnitState: !executionLedger,
        includeEnemyPositions: !taskManager,
        includeControl: !taskManager,
        includeVp: !taskManager
      });
      reused.record = {
        ...reused.record,
        reused: true,
        planning_attempted: false,
        replanned: false,
        replan_reason: "",
        task_reviews: clone(currentReviewChecks),
        task_plan: taskPlan,
        task_management: "multi_task",
        operation: reused.operation_state
      };
      cache.set(key, reused);
      return reused;
    }
    // Keep the strategic request candidate-free at the action level, while exposing
    // locally evaluated objective routes through objective_resolution.candidates.
    const built = rememberBuiltContext(input, buildContext(config, {
      state: input.state,
      decisionMode: "intent",
      includeInitialMap: false,
      privateCandidates: false
    }));
    const previousOperation = persistentOperationFromPlan(taskManager?.plan)
      || persistentOperationFromPlan(lastPlan);
    const payload = publicPayload(config, built.publicContext, []);
    const strategicPayload = compactAgentPayload(payload, { includeInitialMap: false });
    strategicPayload.planning_request = openGoalEnabled ? "goal_plan" : "strategic_intent";
    strategicPayload.request_capabilities = { tools_callable: false, output: "structured strategic JSON", facts_source: "provided state; do not invent tool results" };
    if (previousOperation) strategicPayload.persistent_operation = previousOperation;
    strategicPayload.scoring_recovery = scoringRecoveryEvidence(built.ctx, input.side, taskManager?.plan);
    strategicPayload.verified_route_obstacles = [...routeObstacles.values()].slice(-24);
    strategicPayload.task_execution_constraints = taskExecutionSummary(taskManager?.plan);
    strategicPayload.combat_preparation = combatPreparationEvidence(built.ctx, input.side);
    if (taskManager) strategicPayload.task_policy = {
      scoring_anchor_policy: input.state?.scenario === "july" && input.side === "axis"
        ? config.task_management_options?.scoring_anchor_policy || "none" : "none",
      max_child_tasks: config.task_management_options?.max_child_tasks || 6,
      monitor_policy: config.task_management_options?.monitor_policy || "legacy_children",
      dependency_policy: config.task_management_options?.dependency_policy || "hard_soft_conditional_v1"
    };
    if (taskManager?.plan) strategicPayload.previous_task_acceptance = taskManager.plan.children.map((task) => ({
      id: task.id, title: task.title, status: task.status, acceptance_contract: task.acceptance_contract,
      completion_criteria: task.completion_criteria, completion_evidence: task.completion_evidence,
      acceptance_diagnostics: task.acceptance_diagnostics, dependency_status: task.dependency_status,
      action_window: task.action_window,
      failure_evidence: task.failure_evidence, observation_only: task.observation_only,
      scoring_anchor_state: task.scoring_anchor_state, scoring_anchor_loss_count: task.scoring_anchor_loss_count,
      scoring_anchor_history: task.scoring_anchor_history,
      assigned_units: task.assigned_units, normalization_corrections: task.normalization_corrections
    }));
    if (strategicPayload.task_policy?.scoring_anchor_policy === "july_terminal_v1") {
      strategicPayload.task_policy.breakthrough_access_policy = "model_selected_blockers_v1";
      strategicPayload.breakthrough_planning = taskManager?.plan?.breakthrough_planning || {
        guidance: "Choose whether enemy contact blocks your route. Plan preparation, blocker reduction and follow-on exploitation when needed; bypass and alternate routes remain available."
      };
    }
    strategicPayload.monitors = taskMonitors(taskManager?.plan);
    if (executionLedger) strategicPayload.goal_history = goalHistory.report({ ...input, ctx: built.ctx }, taskManager?.plan);
    if (recentCombatResults.length) strategicPayload.recent_combat_results = clone(recentCombatResults);
    if (reasoningMemory) strategicPayload.context.reasoning_memory = reasoningMemory.forPrompt(input);
    // Planning has no rule-inspection tool, so retain the compact rules brief.
    strategicPayload.context.rules_brief = built.publicContext.rules_brief;
    if (openGoalEnabled) {
      strategicPayload.goal_management = {
        protocol: "side-aware-goal-v2",
        freedom: "The model may propose original goals, combinations, axes, feints, consolidation, or recovery plans.",
        grounding: "Hard facts, VP, supply, legality, units, hexes, and completion evidence are authoritative from the supplied state and are corrected locally.",
        do_not_limit_to: "objective_resolution.candidates"
      };
    }
    let strategicResult;
    let strategic;
    const strategicTimeoutMs = requestTimeoutForDeadline(deadline, runtime.profile.defaults.timeout_ms);
    if (strategicTimeoutMs != null && strategicTimeoutMs < 1000) {
      strategic = { error: "step deadline exhausted before strategic planner", failure_type: "transport", error_class: "step_timeout" };
    }
    else {
      try {
        const request = {
          audit_stage: "strategic",
          messages: [{ role: "system", content: resolveSidePrompt(input.side, openGoalEnabled ? "external.goal_manager_system" : "external.strategic_planner_system")
            + (executionLedger ? `\n${promptValue("execution_ledger.planning")}` : "") }, { role: "user", content: JSON.stringify(strategicPayload) }],
          temperature: runtime.profile.defaults.temperature,
          max_tokens: Math.min(Number(config.task_management_options?.strategic_output_tokens || config.context?.strategicMaxTokens || 3600), runtime.profile.limits.output),
          response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
          thinking: thinkingRequest(runtime)
        };
        if (strategicTimeoutMs != null) { request.timeout_ms = strategicTimeoutMs; request.deadline_ms = deadline; }
        strategicResult = await client.complete(request);
        if (deadline != null && Date.now() >= deadline) strategicResult = { ...strategicResult, ok: false, error_class: "step_timeout" };
        strategic = strategicResult.ok ? parsePlanningResponse(strategicResult, openGoalEnabled ? "goal_plan" : "strategic_intent", "strategic planner") : { error: `model API status ${strategicResult.status}` };
        if (strategicResult.ok && strategic.error) {
          const record = runtime.transport?.find((item) => item.request_id === strategicResult.request_id);
          if (record) record.protocol_failure = { stage: "strategic", error: strategic.error, parse_status: strategic.parse_status };
        }
      }
      catch (error) {
        if (executionLedger && (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError)) throw error;
        strategic = { error: error.message };
      }
    }
    if (executionLedger && strategic.error && lastPlan && taskManager?.plan) {
      const retained = clone(lastPlan);
      const taskPlan = taskManager.refresh({ ...input, ctx: built.ctx });
      retained.operation_state = operationState(retained.strategic_intent, retained.force_allocation,
        input, built, taskPlan, { lastActionEffect, lastTaskProgressDelta, deadline }, config.task_management_options || {});
      retained.operation_state.waiting_for_new_goal = true;
      retained.reused = true;
      retained.battlefield_fingerprint = currentFingerprint;
      retained.record = { ...retained.record, reused: true, replanned: false, replan_reason: replanReason,
        task_reviews: clone(currentReviewChecks),
        planning_attempted: true, allocation_fallback: false, allocation_fallback_reason: "",
        strategic_fallback: true, strategic_fallback_reason: strategic.error, retained_previous_plan: true,
        task_plan: taskPlan, operation: retained.operation_state,
        strategic: { raw: strategic, model_output: strategicResult?.response_json || null,
          request_id: strategicResult?.request_id, status: strategicResult?.status ?? null } };
      failedReplanPhase = `${input.turn}:${input.phase}`;
      failedReplanReason = replanReason || "waiting_for_new_goal";
      cache.set(key, retained);
      lastPlan = clone(retained);
      return retained;
    }
    failedReplanPhase = null;
    failedReplanReason = null;
    const goalPlan = openGoalEnabled
      ? strategic.error
        ? localGoalPlan({ publicContext: built.publicContext, state: input.state, side: input.side,
          previousOperation, replanReason })
        : groundGoalPlan(strategic, { publicContext: built.publicContext, state: input.state, side: input.side,
          ctx: built.ctx, previousOperation, replanReason })
      : null;
    if (goalPlan && strategic.error) goalPlan.source = "local_default";
    if (goalPlan && executionLedger) {
      goalPlan.goal_revision = goalHistory.revise({ ...goalPlan.primary_goal, campaign_goal: goalPlan.campaign_goal,
        persistent_operation: goalPlan.persistent_operation, current_subgoal: goalPlan.current_subgoal }, { input: { ...input, ctx: built.ctx },
        plan: taskManager?.plan, rulesEvaluation: built.publicContext.victory, reason: replanReason || "opening_goal" });
    }
    const intent = normalizeIntent(goalPlan ? goalIntent(goalPlan) : strategic, input.state);
    if (goalPlan) {
      intent.source = goalPlan.source;
      intent.goal_plan = goalPlan;
      if (goalPlan.grounding?.correction_count) intent.grounding_corrections = goalPlan.grounding.corrections;
    }
    else if (strategic.error) intent.source = "local_default";
    const forcePayload = {
      planning_request: "force_allocation",
      strategic_intent: intent,
      goal_plan: goalPlan,
      reasoning_memory: reasoningMemory?.forPrompt(input) || null,
      current_state: built.publicContext.game,
      units: compactAllocationUnits(built.publicContext.unit_index),
      victory: built.publicContext.victory,
      objective_resolution: built.publicContext.objective_resolution,
      rules_brief: built.publicContext.rules_brief,
      request_capabilities: { tools_callable: false, output: "force_allocation JSON", available_facts: "provided unit and rule context" }
    };
    let allocationResult;
    let allocation;
    const allocationTimeoutMs = requestTimeoutForDeadline(deadline, runtime.profile.defaults.timeout_ms);
    if (allocationTimeoutMs != null && allocationTimeoutMs < 1000) {
      allocation = { error: "step deadline exhausted before force allocator", failure_type: "transport", error_class: "step_timeout" };
    }
    else {
      try {
        const request = {
          audit_stage: "allocation",
          messages: [{ role: "system", content: resolveSidePrompt(input.side, "external.force_allocator_system") }, { role: "user", content: JSON.stringify(forcePayload) }],
          temperature: runtime.profile.defaults.temperature,
          max_tokens: Math.min(Number(config.task_management_options?.allocation_output_tokens || config.context?.allocationMaxTokens || 3000), runtime.profile.limits.output),
          response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
          thinking: thinkingRequest(runtime)
        };
        if (allocationTimeoutMs != null) { request.timeout_ms = allocationTimeoutMs; request.deadline_ms = deadline; }
        allocationResult = await client.complete(request);
        if (deadline != null && Date.now() >= deadline) allocationResult = { ...allocationResult, ok: false, error_class: "step_timeout" };
        allocation = allocationResult.ok ? parsePlanningResponse(allocationResult, "force_allocation", "force allocator") : { error: `model API status ${allocationResult.status}` };
        if (allocationResult.ok && allocation.error) {
          const record = runtime.transport?.find((item) => item.request_id === allocationResult.request_id);
          if (record) record.protocol_failure = { stage: "allocation", error: allocation.error };
        }
      }
      catch (error) {
        if (executionLedger && (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError)) throw error;
        allocation = { error: error.message };
      }
    }
    if (allocation.error) allocation = localAllocation(input.state, input.side, intent);
    else allocation = normalizeAllocation(allocation, input.state, input.side, intent);
    allocation.allocation_id = allocationResult?.request_id || `${input.side}:${input.turn}:${input.step}:allocation`;
    allocation.allocation_corrections = (allocation.allocation_corrections || []).map((correction, index) => ({
      ...correction, allocation_id: allocation.allocation_id, event_id: `${allocation.allocation_id}:correction:${index}`
    }));
    const priorityUnits = allocation.spearhead.concat(allocation.support, allocation.supply).map((item) => item.unit);
    const phaseIntent = {
      ...intent.intent,
      priority_units: priorityUnits.slice(0, 8),
      source: intent.source === "model" ? "sae_strategic_model" : "local_default"
    };
    const taskPlan = taskManager
      ? taskManager.initialize({
        intent,
        operation: intent.operation,
        input: { ...input, ctx: built.ctx },
        allocation,
        rawPlan: goalPlan?.task_plan || strategic,
        taskGeneration: config.task_management_options?.task_generation || "fixed_skeleton",
        preserveParent: executionLedger ? !!taskManager.plan
          : !!replanReason && replanReason.startsWith("task_") && replanReason !== "task_goal_completed"
      })
      : null;
    const state = operationState(intent, allocation, input, built, taskPlan, { lastActionEffect, lastTaskProgressDelta, deadline }, config.task_management_options || {});
    const result = {
      phaseIntent,
      strategic_intent: intent,
      goal_plan: goalPlan,
      force_allocation: allocation,
      operation_state: state,
      battlefield_fingerprint: currentFingerprint,
      record: {
        source: intent.source,
        planning_attempted: true,
        context_profile: CONTEXT_PROFILE_ID,
        strategic_raw_context_bytes: contextBytes(payload),
        strategic_context_bytes: contextBytes(strategicPayload),
        allocation_context_bytes: contextBytes(forcePayload),
        planning_deadline_ms: deadline == null ? null : Number(deadline),
        strategic_timeout_ms: strategicTimeoutMs,
        allocation_timeout_ms: allocationTimeoutMs,
        planning_elapsed_ms: (strategicResult?.elapsed_ms || 0) + (allocationResult?.elapsed_ms || 0),
        planning_thinking_mode: runtime.profile.defaults.thinking,
        replanned: !!replanReason,
        replan_reason: replanReason,
        strategic_fallback: intent.source !== "model",
        strategic_fallback_reason: strategic.error || "",
        goal_grounding: goalPlan?.grounding || null,
        goal_revision: goalPlan?.goal_revision || null,
        capability_reference_errors: executionLedger ? capabilityReferenceErrors(strategic, availableTools) : [],
        goal_history: executionLedger ? goalHistory.report({ ...input, ctx: built.ctx }, taskPlan) : null,
        allocation_fallback: allocationResult ? allocationResult.ok !== true || allocation.source === "local_fallback" : true,
        allocation_fallback_reason: allocationResult?.error || allocation?.error || (allocation.source === "local_fallback" ? "local allocation fallback" : ""),
        strategic: { raw: strategic, model_output: strategicResult?.response_json || null, request_id: strategicResult?.request_id,
          status: strategicResult?.status ?? null, elapsed_ms: strategicResult?.elapsed_ms ?? null },
        allocation: { raw: allocationResult?.response_json || allocation, request_id: allocationResult?.request_id,
          status: allocationResult?.status ?? null, elapsed_ms: allocationResult?.elapsed_ms ?? null },
        task_management: taskManager ? "multi_task" : "disabled",
        task_plan: taskPlan,
        operation: state,
        battlefield_fingerprint: currentFingerprint,
        reused: false
      }
    };
    cache.set(key, result);
    result.record.task_reviews = clone(currentReviewChecks);
    lastPlan = clone(result);
    return clone(result);
  }
  async function observe(input, stepRecord) {
    input = runtimeInput(input);
    if (!stepRecord) return;
    const key = phaseKey(input);
    const rejected = stepRecord.action_attempts || [];
    const rejectedMoves = rejected.filter((item) => !item.accepted && ["move", "move_intent"].includes(item.action?.type));
    const observedContext = rejectedMoves.length ? contextFor(input)?.ctx || buildContext(config, { state: input.state,
      decisionMode: "hierarchical_sae", includeInitialMap: false, privateCandidates: false }).ctx : null;
    for (const attempt of rejectedMoves) {
      const action = attempt.action;
      const target = action.destination || action.target || action.path?.at(-1);
      for (const obstacle of terrainRouteEvidence(observedContext, action.unit, target)) {
        const key = `${obstacle.unit}:${obstacle.from}:${obstacle.to}:${obstacle.mode}`;
        routeObstacles.set(key, { ...obstacle, observed_step: input.step, observed_turn: input.turn });
      }
    }
    stepRecord.verified_route_obstacles = [...routeObstacles.values()].slice(-24);
    const pathFailures = rejected.filter((item) => /no legal path found/.test(item.reason || ""));
    const sameTargets = new Map();
    for (const item of pathFailures) {
      const action = item.action || {};
      const target = `${action.unit || ""}:${action.destination || ""}`;
      sameTargets.set(target, (sameTargets.get(target) || 0) + 1);
    }
    const supplyBreak = rejected.some((item) => item.accepted
      && item.assessment?.evaluation?.victory_impact?.maintains_july_scoring_supply === false);
    const repeatedTarget = [...sameTargets.values()].some((count) => count >= 2);
    let taskObservation = null;
    if (taskManager) {
      taskObservation = taskManager.observe(input, stepRecord);
      lastTaskProgressDelta = taskObservation.task_progress_delta || {};
      const checkerEvents = taskObservation.checker_events || taskObservation.events;
      if (taskChecker && checkerEvents.length) pendingTaskCheck = {
        taskPlan: taskObservation.plan,
        stepRecord,
        events: checkerEvents
      };
      stepRecord.task_observation = taskObservation;
      if (taskObservation.events.includes("task_blocked") || taskManager.needsReplan()) {
        replanReasons.set(key, taskManager.consumeReplanReason() || "task_requires_replanning");
      }
    }
    if (stepRecord.final_action?.type === "combat" && stepRecord.action_effect?.accepted
      && !recentCombatResults.some((record) => record.step === stepRecord.step)) {
      recentCombatResults.push({ step: stepRecord.step, turn: stepRecord.turn,
        attackers: stepRecord.final_action.attackers, defender_hexes: stepRecord.final_action.defender_hexes,
        actual_result: stepRecord.action_effect.applied_result,
        self_vp_delta: stepRecord.action_effect.self_vp_delta,
        force_preservation_risk: stepRecord.action_effect.force_preservation_risk });
      recentCombatResults = recentCombatResults.slice(-6);
    }
    lastActionEffect = stepRecord.action_effect ? { ...stepRecord.action_effect, recent_combat_results: clone(recentCombatResults) } : lastActionEffect;
    // The task manager owns task-mode recovery. Do not overwrite its reason with
    // the legacy SAE trigger, otherwise a local supply observation replaces the
    // stable parent task with a fresh strategic operation.
    if (!taskManager && !replanReasons.has(key)) {
      if (pathFailures.length >= 2 || repeatedTarget) replanReasons.set(key, "repeated_infeasible_route");
      else if (supplyBreak) replanReasons.set(key, "accepted_move_breaks_scoring_supply");
      else if (stepRecord.fallback_used) replanReasons.set(key, "execution_fallback_requires_reassessment");
    }
  }
  async function finalize(input) {
    input = runtimeInput(input);
    await runPendingTaskCheck(input);
    if (!taskManager) return null;
    const built = buildContext(config, {
      state: input.state,
      decisionMode: "hierarchical_sae",
      includeInitialMap: false,
      privateCandidates: false
    });
    const taskPlan = typeof taskManager.settle === "function"
      ? taskManager.settle({ ...input, ctx: built.ctx })
      : taskManager.refresh({ ...input, ctx: built.ctx });
    if (executionLedger) taskPlan.goal_history = goalHistory.report({ ...input, ctx: built.ctx }, taskPlan);
    if (executionLedger) taskPlan.archived_task_plans = taskManager.archives;
    if (executionLedger) taskPlan.task_execution_history = taskManager.executionHistory;
    if (executionLedger) taskPlan.task_review_history = taskManager.reviewHistory;
    if (lastPlan) {
      lastPlan.operation_state = operationState(
        lastPlan.strategic_intent,
        lastPlan.force_allocation,
        input,
        built,
        taskPlan,
        { lastActionEffect, lastTaskProgressDelta },
        config.task_management_options || {}
      );
      lastPlan.record = {
        ...lastPlan.record,
        task_plan: taskPlan,
        operation: lastPlan.operation_state
      };
    }
    return clone(taskPlan);
  }
  async function settleTurn(input) {
    if (!taskManager) return null;
    const built = buildContext(config, { state: input.state, decisionMode: "hierarchical_sae",
      includeInitialMap: false, privateCandidates: false });
    return taskManager.settle({ ...input, ctx: built.ctx });
  }
  function clear() {
    cache.clear();
    replanReasons.clear();
    taskManager?.clear();
    goalHistory.clear();
    lastPlan = null;
    failedReplanPhase = null;
    failedReplanReason = null;
    pendingTaskCheck = null;
    lastBuiltContext = null;
    lastBuiltInput = null;
    lastActionEffect = null;
    recentCombatResults = [];
    routeObstacles.clear();
    lastTaskProgressDelta = {};
  }
  return { cache, clear, contextFor, finalize, settleTurn, observe, plan, replanReasons, taskManager };
}

module.exports = {
  createSaeRuntime,
  localAllocation,
  normalizeAllocation,
  normalizeIntent,
  parsePlanningResponse,
  buildPhaseUnitFacts,
  buildTacticalSummary,
  scoringRecoveryEvidence,
  taskRouteEvidence,
  terrainRouteEvidence,
  combatPreparationEvidence,
  deriveActionEffect,
  operationState,
  phaseKey,
  battlefieldFingerprint
};
