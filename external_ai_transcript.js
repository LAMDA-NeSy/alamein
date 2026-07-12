#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const RulesEngine = require("./rule_engine.js");

const ROOT = __dirname;
const OUT = path.join(ROOT, "last_external_ai_transcript.json");
const CONTEXT_OUT = path.join(ROOT, "last_external_ai_context.json");
const MOCK_OUT = path.join(ROOT, "last_external_ai_mock_transcript.json");

function readConfig() {
  const source = fs.readFileSync(path.join(ROOT, "ai_config.js"), "utf8");
  const context = { globalThis: {} };
  context.globalThis.globalThis = context.globalThis;
  vm.runInNewContext(source, context, { filename: "ai_config.js" });
  return context.globalThis.ALAMEIN_AI_CONFIG;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function distance(a, b) {
  const [ac, ar] = RulesEngine.splitHex(a);
  const [bc, br] = RulesEngine.splitHex(b);
  return Math.abs(ac - bc) + Math.abs(ar - br);
}

function hexColumn(hex) {
  return Number(RulesEngine.normalizeHex(hex).slice(0, 2));
}

function mapArea(ctx, hex) {
  const normalized = RulesEngine.normalizeHex(hex);
  const [col, row] = RulesEngine.splitHex(normalized);
  const tags = RulesEngine.hexTags(ctx, normalized);
  const areas = [];
  if (tags.includes("alamein_box")) areas.push("Alamein box");
  if (tags.includes("hill_or_ridge")) areas.push("ridge line");
  if (tags.includes("depression")) areas.push("depression");
  if (tags.includes("minefield") || RulesEngine.minesAt(ctx, normalized).length) areas.push("minefield belt");
  if (RulesEngine.neighbors(normalized).some((nb) => RulesEngine.edgeTags(ctx, RulesEngine.normalizeEdge(normalized, nb)).includes("road"))) areas.push("road corridor");
  if (row <= 12) areas.push("northern coastal sector");
  else if (row <= 22) areas.push("central desert sector");
  else areas.push("southern desert sector");
  if (col <= 20) areas.push("western approach");
  else if (col >= 36) areas.push("eastern objective area");
  else areas.push("middle battlefield");
  return [...new Set(areas)];
}

function operationalAreaCode(hex) {
  const normalized = RulesEngine.normalizeHex(hex);
  const [col, row] = RulesEngine.splitHex(normalized);
  const sector = row <= 12 ? "N" : row <= 22 ? "C" : "S";
  const depth = col <= 20 ? "W" : col >= 36 ? "E" : "M";
  return `${sector}/${depth}`;
}

function nearestEnemies(unit, allUnits, limit = 3) {
  if (!unit?.hex || !RulesEngine.isPlayableSide(unit.side)) return [];
  return allUnits
    .filter((enemy) => enemy.side !== unit.side && RulesEngine.isCombatUnit(enemy) && enemy.hex && !enemy.eliminated)
    .map((enemy) => ({
      id: enemy.id,
      name: enemy.name || enemy.id,
      hex: enemy.hex,
      atk: Number(enemy.attack || 0),
      def: Number(enemy.defense ?? enemy.attack ?? 0),
      distance: distance(unit.hex, enemy.hex)
    }))
    .sort((a, b) => a.distance - b.distance || String(a.hex).localeCompare(String(b.hex)))
    .slice(0, limit);
}

function nearestEnemyHexFor(unit, allUnits, maxRange = Infinity) {
  const nearest = nearestEnemies(unit, allUnits, 1)[0];
  return nearest && nearest.distance <= maxRange ? { hex: nearest.hex, distance: nearest.distance } : null;
}

function fixedAiTarget(ctx, side = ctx.state.active_side) {
  if (side === "axis" && ctx.state.scenario === "october" && Number(ctx.state.turn || 1) > 10) return "0101";
  return ctx.rules.game?.alamein_hex || "3711";
}

function supplyEscortTarget(ctx, unit, allUnits) {
  if (unit.side === "axis" && ctx.state.scenario === "october" && Number(ctx.state.turn || 1) > 10) {
    return fixedAiTarget(ctx, "axis");
  }
  const friendlies = allUnits.filter((item) => item.side === unit.side && item.hex && !item.eliminated && RulesEngine.isMapCounter(item));
  if (!friendlies.length) return fixedAiTarget(ctx, unit.side);
  if (unit.side === "axis") {
    return friendlies
      .sort((a, b) => hexColumn(b.hex) - hexColumn(a.hex) || Number(b.attack || 0) - Number(a.attack || 0))[0].hex;
  }
  const anchor = fixedAiTarget(ctx, "allies");
  return friendlies
    .sort((a, b) => distance(a.hex, anchor) - distance(b.hex, anchor) || Number(b.attack || 0) - Number(a.attack || 0))[0].hex;
}

function moveTarget(ctx, unit, allUnits) {
  if (RulesEngine.isSupplyUnit(unit)) return supplyEscortTarget(ctx, unit, allUnits);
  if (unit.side === "axis") return fixedAiTarget(ctx, "axis");
  const nearbyEnemy = nearestEnemyHexFor(unit, allUnits, 7);
  if (nearbyEnemy) return nearbyEnemy.hex;
  const alamein = fixedAiTarget(ctx, "allies");
  return distance(unit.hex, alamein) <= 7 ? alamein : RulesEngine.normalizeHex(unit.hex);
}

function moveDirectionScore(ctx, unit, start, destination, allUnits) {
  const startCol = hexColumn(start);
  const destCol = hexColumn(destination);
  const delta = destCol - startCol;
  if (unit.side === "axis" && ctx.state.scenario === "october") {
    return delta < 0 ? Math.abs(delta) * 10 : delta === 0 ? 0 : -delta * 14;
  }
  if (unit.side === "axis") return delta >= 0 ? delta * 4 : delta * 18;
  const nearbyEnemy = nearestEnemyHexFor(unit, allUnits, 7);
  if (nearbyEnemy) {
    const before = distance(start, nearbyEnemy.hex);
    const after = distance(destination, nearbyEnemy.hex);
    const awayPenalty = after > before ? (after - before) * 16 : 0;
    const alamein = fixedAiTarget(ctx, "allies");
    const abandonsBoxPenalty = distance(start, alamein) <= 4 && distance(destination, alamein) > distance(start, alamein) ? 10 : 0;
    return (before - after) * 8 - awayPenalty - abandonsBoxPenalty - Math.max(0, hexColumn(destination) - 38) * 2;
  }
  if (delta < 0) return delta * 14;
  if (delta > 2) return -delta * 3;
  return delta;
}

function supplyStateForAi(ctx, unitId) {
  const unit = ctx.state.units?.[unitId];
  if (!unit || !RulesEngine.isPlayableSide(unit.side)) return "";
  ctx.ai_supply_state_cache ||= {};
  ctx.ai_supply_state_cache[unit.side] ||= RulesEngine.checkSupply(ctx, unit.side);
  return ctx.ai_supply_state_cache[unit.side][unitId] || RulesEngine.supplyState(ctx, unitId);
}

function moveUnitPriority(ctx, unit, allUnits) {
  const full = { id: unit.id, ...ctx.state.units[unit.id] };
  const target = moveTarget(ctx, full, allUnits);
  if (full.side === "allies" && !RulesEngine.isSupplyUnit(full) && RulesEngine.normalizeHex(target) === RulesEngine.normalizeHex(full.hex)) return 999;
  const targetDistance = full.hex ? distance(full.hex, target) : 99;
  const nearestEnemy = nearestEnemyHexFor(full, allUnits, 12);
  const contactBonus = nearestEnemy ? Math.max(0, 12 - nearestEnemy.distance) : 0;
  const mobility = Number(full.movement || unit.mp || 0);
  const strength = Number(full.attack || 0) + Number(full.defense ?? full.attack ?? 0);
  return targetDistance * 4 - contactBonus - mobility * 0.5 - strength;
}

function movementActionScore(ctx, action, allUnits) {
  const unit = ctx.state.units[action.unit];
  if (!unit || !action.path?.length) return -10000;
  const full = { id: action.unit, ...unit };
  const start = RulesEngine.normalizeHex(unit.hex);
  const destination = RulesEngine.normalizeHex(action.path.at(-1));
  const target = moveTarget(ctx, full, allUnits);
  const progress = distance(start, target) - distance(destination, target);
  const direction = moveDirectionScore(ctx, full, start, destination, allUnits);
  const targetDistance = distance(destination, target);
  const zocSources = RulesEngine.enemyZocSources(ctx, unit.side, destination);
  const mineCount = RulesEngine.enemyMinesAt(ctx, unit.side, destination).length;
  const adjacentEnemyStrength = allUnits
    .filter((enemy) => enemy.side !== unit.side && RulesEngine.isCombatUnit(enemy) && enemy.hex && distance(destination, enemy.hex) <= 1)
    .reduce((sum, enemy) => sum + Number(enemy.attack || enemy.defense || 0), 0);
  const defense = Math.max(1, Number(unit.defense ?? unit.attack ?? 1));
  const zocPenalty = zocSources.size ? 10 + zocSources.size * 6 : 0;
  const minePenalty = mineCount ? 26 + mineCount * 4 : 0;
  const overmatchPenalty = zocSources.size ? Math.max(0, adjacentEnemyStrength - defense) * 3 : 0;
  const fragileContactPenalty = zocSources.size && defense <= 1 ? 12 : 0;
  const supply = supplyStateForAi(ctx, action.unit);
  const supplyPenalty = supply === "isolated" ? 20 : supply === "unsupplied" ? 8 : supply === "partially_supplied" ? 3 : 0;
  const roadBonus = action.mode === "road" && !zocSources.size ? (RulesEngine.isSupplyUnit(full) ? 8 : 2) : 0;
  const terrainTags = RulesEngine.hexTags(ctx, destination);
  const terrainBonus = terrainTags.includes("alamein_box") ? 3 : terrainTags.includes("hill_or_ridge") ? 2 : 0;
  const spentPenalty = Number(action.spent || 0) * 0.25;
  const strength = Number(unit.attack || 0) + Number(unit.movement || 0) * 0.2;
  const usefulProgress = Math.max(0, progress);
  const progressScore = Math.min(usefulProgress, 8) * (unit.side === "axis" ? 18 : RulesEngine.isSupplyUnit(full) ? 12 : 8)
    + Math.max(0, usefulProgress - 8) * (unit.side === "axis" ? 6 : 3);
  const negativeProgressPenalty = unit.side !== "axis" && !RulesEngine.isSupplyUnit(full) && progress < 0 ? Math.abs(progress) * 12 : 0;
  const farFromTargetPenalty = unit.side === "axis" || RulesEngine.isSupplyUnit(full)
    ? targetDistance * 2
    : Math.max(0, targetDistance - 2);
  const turnsRemaining = Math.max(0, RulesEngine.scenarioFinalTurn(ctx.state.scenario || "july") - Number(ctx.state.turn || 1) + 1);
  const finalThreatBonus = turnsRemaining <= 1 && unit.side === "axis"
    ? targetDistance <= 2 ? 45 : targetDistance <= 4 ? 20 : targetDistance <= 6 ? 6 : -12
    : targetDistance <= 2 ? 12 : targetDistance <= 4 ? 5 : 0;
  const formationPenalty = RulesEngine.isSupplyUnit(full) && zocSources.size ? 40 : 0;
  const interceptionBonus = unit.side !== "axis" && !RulesEngine.isSupplyUnit(full) && progress > 0
    ? 14 + Math.min(progress, 3) * 6
    : 0;
  return Number((progressScore + direction + finalThreatBonus + interceptionBonus - negativeProgressPenalty - farFromTargetPenalty - zocPenalty - minePenalty - overmatchPenalty - fragileContactPenalty - supplyPenalty - formationPenalty - spentPenalty + roadBonus + terrainBonus + strength).toFixed(2));
}

function usefulMoveCandidate(ctx, action, allUnits) {
  if (!action || action.type !== "move") return true;
  const unit = ctx.state.units[action.unit];
  if (!unit || unit.side !== "allies" || RulesEngine.isSupplyUnit({ id: action.unit, ...unit })) return true;
  const start = RulesEngine.normalizeHex(unit.hex);
  const destination = RulesEngine.normalizeHex(action.path?.at(-1) || start);
  const target = moveTarget(ctx, { id: action.unit, ...unit }, allUnits);
  return distance(start, target) - distance(destination, target) > 0;
}

function unitContextPriority(id, unit, ctx, allUnits = []) {
  const full = { id, ...unit };
  const objective = fixedAiTarget(ctx, unit.side);
  const nearest = nearestEnemies(full, allUnits, 1)[0];
  const nearEnemyScore = nearest ? Math.max(0, 12 - nearest.distance) * 3 : 0;
  const objectiveScore = unit.hex ? Math.max(0, 18 - distance(unit.hex, objective)) : 0;
  const actionScore = unit.side === ctx.state.active_side && unit.state === "fresh" ? 18 : 0;
  const contactScore = unit.hex && RulesEngine.enemyZocSources(ctx, unit.side, unit.hex).size ? 20 : 0;
  const combatScore = RulesEngine.isCombatUnit(full) ? Number(unit.attack || 0) + Number(unit.defense ?? unit.attack ?? 0) : 0;
  return actionScore + contactScore + nearEnemyScore + objectiveScore + combatScore;
}

function nearbyDetailUnitIds(entries, side, ctx, allUnits, limit) {
  return new Set(entries
    .filter(([, unit]) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map(([id, unit]) => ({ id, score: unitContextPriority(id, unit, ctx, allUnits) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Number(limit || 0)))
    .map((item) => item.id));
}

function compactUnit(id, unit, ctx, allUnits = [], options = {}) {
  const full = { id, ...unit };
  const objective = fixedAiTarget(ctx, unit.side);
  const kind = phaseKind(ctx.state.phase);
  const includeNearby = options.includeNearby !== false;
  const nearbyLimit = Number(options.nearbyLimit || 3);
  const supply = RulesEngine.isPlayableSide(unit.side) ? supplyStateForAi(ctx, id) : "";
  const suppliedFull = supply ? { ...full, supply_state: supply } : full;
  return {
    id,
    name: unit.name || id,
    side: unit.side,
    hex: unit.hex,
    kind: unit.kind || "ground",
    atk: Number(unit.attack || 0),
    def: Number(unit.defense ?? unit.attack ?? 0),
    mp: Number(unit.movement || 0),
    state: unit.state || "fresh",
    supply,
    road: !!unit.road_mode,
    mech: RulesEngine.isMechanized(ctx, full),
    terrain: unit.hex ? RulesEngine.hexTags(ctx, unit.hex) : [],
    map_area: unit.hex ? mapArea(ctx, unit.hex) : [],
    effective_attack: RulesEngine.isCombatUnit(full) ? RulesEngine.effectiveAttack(ctx, suppliedFull) : 0,
    effective_defense: RulesEngine.isCombatUnit(full) ? RulesEngine.effectiveDefense(ctx, suppliedFull) : Number(unit.defense ?? unit.attack ?? 0),
    effective_movement: RulesEngine.isMapCounter(full) ? RulesEngine.effectiveMovement(ctx, suppliedFull) : Number(unit.movement || 0),
    distance_to_objective: unit.hex ? distance(unit.hex, objective) : null,
    enemy_zoc_here: unit.hex && RulesEngine.isPlayableSide(unit.side) ? RulesEngine.enemyZocSources(ctx, unit.side, unit.hex).size > 0 : false,
    zoc_hexes: RulesEngine.isCombatUnit(full) ? RulesEngine.zocHexes(ctx, full) : [],
    can_move_now: unit.side === ctx.state.active_side && unit.state === "fresh" && RulesEngine.canMoveInCurrentPhase(ctx, full),
    can_attack_now: unit.side === ctx.state.active_side && unit.state === "fresh" && kind === "combat" && RulesEngine.isCombatUnit(full) && !unit.attacked_this_turn && !unit.attacked_this_phase,
    nearby_enemies: includeNearby ? nearestEnemies(full, allUnits, nearbyLimit) : []
  };
}

function forceDigest(entries, side, ctx, allUnits, limit, config = {}) {
  const nearbyLimit = Number(config.context?.maxNearbyEnemiesPerUnit || 3);
  const detailIds = nearbyDetailUnitIds(entries, side, ctx, allUnits, config.context?.maxNearbyEnemyDetailUnitsPerSide ?? 18);
  const units = entries
    .filter(([, unit]) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .sort((a, b) => {
      const aFresh = a[1].state === "fresh" ? 0 : 1;
      const bFresh = b[1].state === "fresh" ? 0 : 1;
      if (aFresh !== bFresh) return aFresh - bFresh;
      return String(a[1].hex || "").localeCompare(String(b[1].hex || "")) || a[0].localeCompare(b[0]);
    });
  const combat = units.filter(([, unit]) => RulesEngine.isCombatUnit(unit));
  const supply = units.filter(([, unit]) => RulesEngine.isSupplyUnit(unit));
  return {
    side,
    total_units: units.length,
    fresh_units: units.filter(([, unit]) => unit.state === "fresh").length,
    combat_units: combat.length,
    supply_units: supply.length,
    sample_units: units.slice(0, limit).map(([id, unit]) => compactUnit(id, unit, ctx, allUnits, { includeNearby: detailIds.has(id), nearbyLimit })),
    omitted_units: Math.max(0, units.length - limit)
  };
}

function unitIndex(entries, side, ctx, limit) {
  return entries
    .filter(([, unit]) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .sort((a, b) => String(a[1].hex || "").localeCompare(String(b[1].hex || "")) || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, Number(limit || 0)))
    .map(([id, unit]) => ({
      id,
      h: unit.hex,
      k: unit.kind || "ground",
      a: Number(unit.attack || 0),
      d: Number(unit.defense ?? unit.attack ?? 0),
      m: Number(unit.movement || 0),
      s: unit.state || "fresh",
      sup: RulesEngine.isPlayableSide(unit.side) ? supplyStateForAi(ctx, id) : "",
      area: unit.hex ? operationalAreaCode(unit.hex) : ""
    }));
}

function primaryOperationalArea(ctx, hex) {
  const areas = mapArea(ctx, hex);
  const sector = areas.find((item) => /sector$/.test(item)) || "unknown sector";
  const depth = areas.find((item) => /approach|battlefield|objective area/.test(item)) || "unknown depth";
  return `${sector} / ${depth}`;
}

function compactBattleUnit(id, unit, ctx, objective) {
  return {
    id,
    name: unit.name || id,
    side: unit.side,
    hex: unit.hex,
    kind: unit.kind || "ground",
    atk: Number(unit.attack || 0),
    def: Number(unit.defense ?? unit.attack ?? 0),
    mp: Number(unit.movement || 0),
    supply: RulesEngine.isPlayableSide(unit.side) ? supplyStateForAi(ctx, id) : "",
    map_area: unit.hex ? mapArea(ctx, unit.hex) : [],
    distance_to_objective: unit.hex ? distance(unit.hex, objective) : null
  };
}

function emptyAreaSide() {
  return { units: 0, combat_units: 0, attack: 0, defense: 0, fresh: 0, supplied: 0, partial: 0, isolated: 0 };
}

function addAreaSideStats(stats, id, unit, ctx) {
  stats.units += 1;
  if (RulesEngine.isCombatUnit(unit)) stats.combat_units += 1;
  stats.attack += Number(unit.attack || 0);
  stats.defense += Number(unit.defense ?? unit.attack ?? 0);
  if (unit.state === "fresh") stats.fresh += 1;
  const supply = RulesEngine.isPlayableSide(unit.side) ? supplyStateForAi(ctx, id) : "";
  if (supply === "supplied") stats.supplied += 1;
  else if (supply === "partially_supplied") stats.partial += 1;
  else if (supply === "isolated") stats.isolated += 1;
}

function battlefieldSummary(ctx, allUnits, activeSide) {
  const enemySide = activeSide === "axis" ? "allies" : "axis";
  const objective = ctx.rules.game?.alamein_hex || "3711";
  const areaMap = new Map();
  const areaFor = (hex) => {
    const label = primaryOperationalArea(ctx, hex);
    if (!areaMap.has(label)) {
      areaMap.set(label, {
        area: label,
        active: emptyAreaSide(),
        enemy: emptyAreaSide(),
        active_nearest_objective_unit: null,
        enemy_nearest_objective_unit: null,
        contact_hexes: []
      });
    }
    return areaMap.get(label);
  };
  const mapUnits = allUnits
    .filter((unit) => RulesEngine.isMapCounter(unit) && unit.hex && !unit.eliminated);
  for (const unit of mapUnits) {
    const area = areaFor(unit.hex);
    const sideKey = unit.side === activeSide ? "active" : unit.side === enemySide ? "enemy" : "";
    if (!sideKey) continue;
    addAreaSideStats(area[sideKey], unit.id, unit, ctx);
    const compact = compactBattleUnit(unit.id, unit, ctx, objective);
    const nearestKey = `${sideKey}_nearest_objective_unit`;
    if (!area[nearestKey] || Number(compact.distance_to_objective ?? 99) < Number(area[nearestKey].distance_to_objective ?? 99)) {
      area[nearestKey] = compact;
    }
    if (RulesEngine.enemyZocSources(ctx, unit.side, unit.hex).size || RulesEngine.enemyMinesAt(ctx, unit.side, unit.hex).length) {
      area.contact_hexes.push(unit.hex);
    }
  }
  const unitsNearObjective = mapUnits
    .filter((unit) => distance(unit.hex, objective) <= 4)
    .sort((a, b) => distance(a.hex, objective) - distance(b.hex, objective) || a.id.localeCompare(b.id))
    .slice(0, 12)
    .map((unit) => compactBattleUnit(unit.id, unit, ctx, objective));
  const closestActive = mapUnits
    .filter((unit) => unit.side === activeSide)
    .sort((a, b) => distance(a.hex, objective) - distance(b.hex, objective) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((unit) => compactBattleUnit(unit.id, unit, ctx, objective));
  const closestEnemy = mapUnits
    .filter((unit) => unit.side === enemySide)
    .sort((a, b) => distance(a.hex, objective) - distance(b.hex, objective) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((unit) => compactBattleUnit(unit.id, unit, ctx, objective));
  const areas = [...areaMap.values()]
    .map((area) => ({ ...area, contact_hexes: [...new Set(area.contact_hexes)].slice(0, 8) }))
    .sort((a, b) => (b.active.attack + b.enemy.attack + b.active.units + b.enemy.units) - (a.active.attack + a.enemy.attack + a.active.units + a.enemy.units))
    .slice(0, 8);
  return {
    description: "Operational board summary by region: force density, supply health, contact, and objective pressure.",
    active_side: activeSide,
    enemy_side: enemySide,
    primary_objective_hex: objective,
    objective_zone: {
      radius_hexes: 4,
      control: ctx.state.control?.[objective] || "",
      zoc_by_axis: RulesEngine.enemyZocSources(ctx, "allies", objective).size > 0,
      zoc_by_allies: RulesEngine.enemyZocSources(ctx, "axis", objective).size > 0,
      units: unitsNearObjective
    },
    closest_active_to_objective: closestActive,
    closest_enemy_to_objective: closestEnemy,
    regional_balance: areas
  };
}

function phaseKind(phase) {
  return String(phase || "").replace(/^axis_/, "").replace(/^allies_/, "");
}

function phaseAllowedActions(state) {
  const kind = phaseKind(state.phase);
  if (kind === "combat") return ["combat", "pass"];
  if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) return ["pass"];
  const actions = ["move_intent", "move", "pass"];
  if (state.scenario === "october" && state.active_side === "axis" && Number(state.turn || 1) > 10) actions.splice(1, 0, "exit_west");
  return actions;
}

function decisionBrief(ctx, candidates, activeSide) {
  const nonPass = candidates.filter((item) => item.action?.type !== "pass");
  const top = candidates[0] || null;
  const bestNonPass = nonPass[0] || null;
  const allowed = phaseAllowedActions(ctx.state);
  const kind = phaseKind(ctx.state.phase);
  return {
    read_first: true,
    side: activeSide,
    phase: ctx.state.phase,
    allowed: allowed,
    phase_goal: kind === "combat"
      ? "Attack only if worthwhile and legal; otherwise pass."
      : ["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)
        ? "Choose the strongest legal move/exit that improves victory position without reckless exposure."
        : "Pass unless a legal action is explicitly available.",
    top: top ? {
      score: top.score,
      type: top.action?.type || "",
      ref: "candidate_actions[0].action",
      summary: top.evaluation?.summary || "",
      risks: top.evaluation?.risks || []
    } : null,
    best_non_pass: bestNonPass ? {
      score: bestNonPass.score,
      type: bestNonPass.action?.type || "",
      summary: bestNonPass.evaluation?.summary || ""
    } : null,
    candidate_policy: bestNonPass
      ? "Prefer a high-ranked candidate_action. If choosing one, copy its action exactly."
      : "No useful non-pass candidate is exposed; pass is acceptable unless a tool reveals a stronger legal action.",
    tool_policy: "Use tools when legality, route, combat, or supply is uncertain; evaluate non-candidate final actions.",
    pass_policy: bestNonPass ? "Do not pass while useful non-pass candidates exist unless a tool proves them bad." : "Pass is acceptable now."
  };
}

function rulesBrief(rules) {
  return {
    game: rules.game?.title || "First Alamein",
    role: "You are the active side's game agent. Your job is to win the scenario, using only legal actions accepted by the front-end judge.",
    turn_sequence: rules.turn_sequence,
    movement: [
      "Units move only in movement phases for their side and become spent after moving.",
      `Enemy occupied hexes are ${rules.movement?.enemy_occupied_hex || "forbidden"}.`,
      rules.movement?.enter_enemy_zoc_must_stop ? "Entering enemy ZOC requires stopping." : "",
      rules.movement?.cannot_move_directly_between_zocs_of_same_enemy_unit ? "Do not move directly between ZOCs of the same enemy unit." : "",
      "Road mode is faster but must still pass check_move validation."
    ].filter(Boolean),
    combat: [
      rules.combat?.attacker_must_be_fresh ? "Attackers must be fresh." : "",
      `Minimum odds ${rules.combat?.minimum_odds || "1-4"}, maximum odds ${rules.combat?.maximum_odds || "7-1"}.`,
      "Do not include die in combat actions; the front-end judge rolls or uses the selected die."
    ].filter(Boolean),
    supply: {
      axis_sources: rules.game?.axis_supply_sources || [],
      allies_sources: rules.game?.allies_supply_sources || [],
      note: "Supplied and partially supplied units are much more valuable for victory and survival."
    }
  };
}

function victoryBrief(state, rules) {
  const scenario = state.scenario || "july";
  const finalTurn = RulesEngine.scenarioFinalTurn(scenario);
  const startingVp = RulesEngine.scenarioStartingVp(scenario, Number(state.victory_points || 0));
  const alamein = rules.game?.alamein_hex || "3711";
  return {
    current_vp: startingVp,
    final_turn: finalTurn,
    final_check: "Winner is decided at End of Game-Turn on the final scenario turn.",
    vp_scale: ["60+ Axis Decisive", "50-59 Axis Substantive", "40-49 Axis Marginal", "30-39 Draw", "20-29 Allied Marginal", "10-19 Allied Substantive", "0-9 Allied Decisive"],
    side_goals: {
      axis: [`Increase VP and pressure/capture ${alamein} with supplied or partially supplied combat units.`, "Destroy Allied combat units, isolate them, and push supplied Axis combat units east when the scenario awards it."],
      allies: [`Deny Axis VP, hold or contest ${alamein}, preserve combat units, and keep supply open.`, "Use terrain, mines, ZOC, and counterattacks to slow Axis tempo."]
    }
  };
}

function hexIntel(ctx, hex, label = "") {
  const normalized = RulesEngine.normalizeHex(hex);
  const units = (RulesEngine.unitsByHex(ctx)[normalized] || []).map((unit) => ({
    id: unit.id,
    name: unit.name || unit.id,
    side: unit.side,
    kind: unit.kind || "ground",
    atk: Number(unit.attack || 0),
    def: Number(unit.defense ?? unit.attack ?? 0),
    state: unit.state || "fresh",
    supply: RulesEngine.isPlayableSide(unit.side) ? supplyStateForAi(ctx, unit.id) : ""
  }));
  return {
    hex: normalized,
    label,
    terrain: RulesEngine.hexTags(ctx, normalized),
    map_area: mapArea(ctx, normalized),
    control: ctx.state.control?.[normalized] || "",
    units,
    mines: RulesEngine.minesAt(ctx, normalized).map((mine) => ({ id: mine.id, side: mine.side, name: mine.name || mine.id })),
    zoc_by_axis: RulesEngine.enemyZocSources(ctx, "allies", normalized).size > 0,
    zoc_by_allies: RulesEngine.enemyZocSources(ctx, "axis", normalized).size > 0,
    road_neighbors: RulesEngine.neighbors(normalized).filter((nb) => RulesEngine.edgeTags(ctx, RulesEngine.normalizeEdge(normalized, nb)).includes("road"))
  };
}

function inspectUnit(ctx, allUnits, unitId) {
  const unit = ctx.state.units[unitId];
  if (!unit) return { legal: false, reason: `unknown unit ${unitId}` };
  return { legal: true, unit: compactUnit(unitId, unit, ctx, allUnits) };
}

function inspectHex(ctx, rawHex) {
  try {
    return { legal: true, ...hexIntel(ctx, rawHex) };
  }
  catch (error) {
    return { legal: false, reason: error.message };
  }
}

function traceSupply(ctx, unitId) {
  const unit = ctx.state.units[unitId];
  if (!unit) return { legal: false, reason: `unknown unit ${unitId}` };
  const path = RulesEngine.traceSupplyPath(ctx, unitId);
  return {
    legal: true,
    unit: unitId,
    supply_state: RulesEngine.isPlayableSide(unit.side) ? supplyStateForAi(ctx, unitId) : "",
    path,
    blocked: path.length ? [] : [...RulesEngine.supplyBlockedHexes(ctx, unit.side)].slice(0, 80)
  };
}

function checkMoveTool(ctx, args = {}) {
  try {
    return RulesEngine.checkMove(ctx, args.unit, args.path || [], { mode: args.mode || "normal" });
  }
  catch (error) {
    return { legal: false, reason: error.message };
  }
}

function findPathTool(ctx, args = {}) {
  try {
    const path = RulesEngine.findLegalPath(ctx, args.unit, args.target, { mode: args.mode || "normal" });
    return path
      ? { legal: true, path, verdict: RulesEngine.checkMove(ctx, args.unit, path, { mode: args.mode || "normal" }) }
      : { legal: false, reason: "no legal path found" };
  }
  catch (error) {
    return { legal: false, reason: error.message };
  }
}

function plannedMoveScore(ctx, action, verdict) {
  const unit = ctx.state.units?.[action.unit];
  const destination = action.path?.at(-1);
  if (!unit || !destination) return -10000;
  const zocPenalty = RulesEngine.enemyZocSources(ctx, unit.side, destination).size * 20;
  const minePenalty = RulesEngine.enemyMinesAt(ctx, unit.side, destination).length * 30;
  const roadBonus = action.mode === "road" ? 4 : 0;
  const spent = Number(verdict.details?.spent || action.spent || 0);
  return 100 - spent - zocPenalty - minePenalty + roadBonus;
}

function resolveMoveIntent(ctx, rawAction = {}) {
  const intent = rawAction.action || rawAction;
  const unitId = intent.unit;
  const destination = intent.destination || intent.target || intent.hex;
  if (!unitId || !destination) return { legal: false, reason: "move_intent requires unit and destination", action: intent };
  let target;
  try { target = RulesEngine.normalizeHex(destination); }
  catch (error) { return { legal: false, reason: error.message, action: intent }; }
  const modes = intent.mode && intent.mode !== "auto" ? [intent.mode] : ["normal", "road"];
  const plans = [];
  for (const mode of modes) {
    const path = RulesEngine.findLegalPath(ctx, unitId, target, { mode });
    if (!path || path.length <= 1) continue;
    const verdict = RulesEngine.checkMove(ctx, unitId, path, { mode });
    if (!verdict.legal) continue;
    const action = {
      type: "move",
      unit: unitId,
      path,
      mode,
      destination: target,
      spent: verdict.details?.spent
    };
    plans.push({ action, verdict, score: plannedMoveScore(ctx, action, verdict) });
  }
  plans.sort((a, b) => b.score - a.score);
  const best = plans[0];
  if (!best) return { legal: false, reason: `no legal path found for ${unitId} to ${target}`, action: intent };
  return {
    legal: true,
    reason: `planned ${best.action.mode} path for move_intent`,
    action: best.action,
    planned_from_intent: { unit: unitId, destination: target, requested_mode: intent.mode || "auto" },
    verdict: best.verdict,
    plan_score: best.score
  };
}

function mapIntel(ctx, candidateActions, allUnits, activeSide) {
  const labeled = new Map();
  const add = (hex, label) => {
    try {
      const normalized = RulesEngine.normalizeHex(hex);
      if (!labeled.has(normalized)) labeled.set(normalized, label);
    }
    catch {}
  };
  const alamein = ctx.rules.game?.alamein_hex || "3711";
  add(alamein, "Alamein / primary victory hex");
  for (const hex of ctx.rules.game?.axis_supply_sources || []) add(hex, "Axis supply source");
  for (const hex of ctx.rules.game?.allies_supply_sources || []) add(hex, "Allied supply source");
  for (const item of candidateActions) {
    const action = item.action || item;
    if (action.type === "move") add(action.destination || action.path?.at(-1), "candidate destination");
    if (action.type === "combat") for (const hex of action.defender_hexes || []) add(hex, "candidate combat target");
  }
  const frontline = allUnits
    .filter((unit) => unit.side === activeSide && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map((unit) => {
      const nearest = nearestEnemies(unit, allUnits, 3);
      return {
        unit: compactUnit(unit.id, unit, ctx, allUnits),
        nearest_enemies: nearest,
        enemy_zoc_sources: [...RulesEngine.enemyZocSources(ctx, activeSide, unit.hex)],
        enemy_mines_here: RulesEngine.enemyMinesAt(ctx, activeSide, unit.hex).map((mine) => mine.id)
      };
    })
    .sort((a, b) => (a.nearest_enemies[0]?.distance ?? 99) - (b.nearest_enemies[0]?.distance ?? 99))
    .slice(0, 10);
  return {
    description: "Compressed board intel: key geography, front-line units, ZOC, mines, roads, and distances.",
    key_hexes: [...labeled.entries()].slice(0, 16).map(([hex, label]) => hexIntel(ctx, hex, label)),
    frontline
  };
}

function combatRiskScore(crtColumnMap = {}) {
  const values = Object.values(crtColumnMap || {});
  if (!values.length) return 0;
  const weights = { De: 8, Ex: 3, D3: 5, D2: 4, D1: 3, A1: -2, A2: -4, A3: -5, Ae: -8 };
  return values.reduce((sum, outcome) => sum + (weights[outcome] || 0), 0) / values.length;
}

function combatOutcomeStats(crtColumnMap = {}) {
  const outcomes = Object.values(crtColumnMap || {}).filter(Boolean);
  const count = (predicate) => outcomes.filter(predicate).length;
  return {
    faces: outcomes.length,
    defender_eliminated: count((outcome) => outcome === "De" || outcome === "Ex"),
    defender_retreat: count((outcome) => /^D[123]$/.test(String(outcome))),
    attacker_eliminated: count((outcome) => outcome === "Ae"),
    attacker_retreat: count((outcome) => /^A[123]$/.test(String(outcome))),
    exchange: count((outcome) => outcome === "Ex"),
    defender_harm: count((outcome) => /^D[123]$/.test(String(outcome)) || outcome === "De" || outcome === "Ex"),
    attacker_harm: count((outcome) => /^A[123]$/.test(String(outcome)) || outcome === "Ae" || outcome === "Ex")
  };
}

function crtColumn(ctx, column) {
  const columns = ctx.rules.combat?.odds_columns || [];
  const index = columns.indexOf(column);
  const result = {};
  for (const die of [1, 2, 3, 4, 5, 6]) {
    result[String(die)] = index >= 0 ? ctx.rules.combat?.crt?.[String(die)]?.[index] || null : null;
  }
  return result;
}

function combatVerdictTool(ctx, args = {}) {
  try {
    const action = {
      attackers: args.attackers || [],
      defender_hexes: (args.defender_hexes || []).map((hex) => RulesEngine.normalizeHex(hex)),
      no_retreat_order: !!args.no_retreat_order
    };
    const verdict = RulesEngine.checkCombat(ctx, action);
    if (!verdict.legal) return verdict;
    return {
      ...verdict,
      details: {
        ...(verdict.details || {}),
        crt_column: crtColumn(ctx, verdict.details?.odds_column)
      }
    };
  }
  catch (error) {
    return { legal: false, reason: error.message };
  }
}

function terrainDefenseBonusFromTags(tags = []) {
  if (tags.includes("alamein_box")) return 3;
  if (tags.includes("hill_or_ridge") || tags.includes("depression")) return 1;
  return 0;
}

function combatTargetIntel(ctx, action) {
  const attackerSide = ctx.state.active_side;
  const defenderSide = attackerSide === "axis" ? "allies" : "axis";
  const alamein = ctx.rules.game?.alamein_hex || "3711";
  return (action.defender_hexes || []).map((rawHex) => {
    const hex = RulesEngine.normalizeHex(rawHex);
    const terrainTags = RulesEngine.hexTags(ctx, hex);
    const defenders = (RulesEngine.unitsByHex(ctx)[hex] || [])
      .filter((unit) => unit.side === defenderSide && RulesEngine.isCombatUnit(unit))
      .map((unit) => {
        const supply = supplyStateForAi(ctx, unit.id);
        return {
          id: unit.id,
          name: unit.name || unit.id,
          atk: Number(unit.attack || 0),
          def: Number(unit.defense ?? unit.attack ?? 0),
          effective_defense: RulesEngine.effectiveDefense(ctx, { ...unit, supply_state: supply }, hex),
          supply
        };
      });
    return {
      hex,
      terrain: terrainTags,
      map_area: mapArea(ctx, hex),
      control: ctx.state.control?.[hex] || "",
      defenders,
      defender_supply_states: [...new Set(defenders.map((unit) => unit.supply).filter(Boolean))],
      friendly_mines: RulesEngine.friendlyMinesAt(ctx, defenderSide, hex).map((mine) => mine.id),
      enemy_mines: RulesEngine.enemyMinesAt(ctx, attackerSide, hex).map((mine) => mine.id),
      terrain_defense_bonus: terrainDefenseBonusFromTags(terrainTags),
      is_primary_objective: hex === alamein,
      retreat_options_estimate: defenders.reduce((sum, defender) => {
        const unit = ctx.state.units[defender.id];
        if (!unit) return sum;
        return sum + RulesEngine.neighbors(hex).filter((nb) => RulesEngine.legalRetreatHex(ctx, { ...unit, id: defender.id }, nb, attackerSide)).length;
      }, 0)
    };
  });
}

function victoryImpact(ctx, action = {}) {
  const finalTurn = RulesEngine.scenarioFinalTurn(ctx.state.scenario || "july");
  const turnsRemaining = Math.max(0, finalTurn - Number(ctx.state.turn || 1) + 1);
  const alamein = ctx.rules.game?.alamein_hex || "3711";
  ctx.ai_victory_impact_cache ||= RulesEngine.checkVictory(ctx);
  const victory = ctx.ai_victory_impact_cache;
  const base = {
    turns_remaining: turnsRemaining,
    final_turn: finalTurn,
    urgency: turnsRemaining <= 1 ? "final turn or final check imminent" : turnsRemaining <= 2 ? "late scenario" : "developing scenario",
    current_vp: Number(victory.victory_points || 0),
    current_level: victory.level || ""
  };
  if (action.type === "pass") return { ...base, summary: "Pass has no direct VP effect and may waste tempo if useful candidates exist." };
  if (action.type === "exit_west") {
    const unit = ctx.state.units[action.unit];
    return {
      ...base,
      summary: "October Axis west exit can directly affect withdrawal VP when legal.",
      vp_relevance: "direct",
      unit: action.unit,
      unit_value_hint: unit?.kind === "supply" ? "supply unit" : Number(unit?.attack || unit?.defense || 0)
    };
  }
  if (action.type === "combat") {
    const targets = (action.defender_hexes || []).map((hex) => RulesEngine.normalizeHex(hex));
    return {
      ...base,
      summary: targets.includes(alamein)
        ? "Combat targets Alamein, the primary victory hex."
        : "Combat may affect VP indirectly through losses, retreats, supply, or access routes.",
      vp_relevance: targets.includes(alamein) ? "primary_objective" : "indirect",
      targets_primary_objective: targets.includes(alamein),
      defender_hexes: targets
    };
  }
  if (action.type === "move") {
    const unit = ctx.state.units[action.unit];
    const start = unit?.hex ? RulesEngine.normalizeHex(unit.hex) : "";
    const destination = RulesEngine.normalizeHex(action.destination || action.path?.at(-1) || start);
    const before = start ? distance(start, alamein) : null;
    const after = destination ? distance(destination, alamein) : null;
    const supplied = unit && RulesEngine.isPlayableSide(unit.side) ? supplyStateForAi(ctx, action.unit) : "";
    return {
      ...base,
      summary: destination === alamein
        ? "Move reaches Alamein, the primary victory hex, if the action remains legal and supplied enough for scoring."
        : before != null && after != null && after < before
          ? "Move improves distance to Alamein / eastern victory area."
          : "Move has no immediate primary-objective gain.",
      vp_relevance: destination === alamein ? "primary_objective" : before != null && after != null && after < before ? "positional_progress" : "low_direct",
      objective_hex: alamein,
      distance_to_objective_before: before,
      distance_to_objective_after: after,
      destination_is_primary_objective: destination === alamein,
      unit_supply_before_move: supplied
    };
  }
  return base;
}

function actionEvaluation(ctx, action, allUnits) {
  if (!action) return { summary: "missing action" };
  if (action.type === "pass") return { summary: "Pass ends the current phase. Use only when no useful legal action remains.", victory_impact: victoryImpact(ctx, action), risks: ["cedes tempo"] };
  if (action.type === "exit_west") return { summary: "Withdraws a unit west for October scenario VP when legal.", unit: action.unit, victory_impact: victoryImpact(ctx, action), risks: [] };
  if (action.type === "combat") {
    const details = action.verdict?.details || {};
    const crt = details.crt_column || {};
    const stats = combatOutcomeStats(crt);
    const targetIntel = combatTargetIntel(ctx, action);
    const attackers = (action.attackers || []).map((id) => {
      const unit = ctx.state.units[id];
      return unit ? { id, name: unit.name || id, hex: unit.hex, atk: Number(unit.attack || 0), supply: supplyStateForAi(ctx, id) } : { id };
    });
    return {
      summary: `Combat at ${details.odds_column || "unknown odds"} against ${(action.defender_hexes || []).join(", ") || "unknown target"}.`,
      odds_column: details.odds_column,
      attack: details.attack,
      defense: details.defense,
      expected_crt_score: Number(combatRiskScore(crt).toFixed(2)),
      victory_impact: victoryImpact(ctx, action),
      outcome_faces: stats,
      attackers,
      targets: targetIntel,
      tactical_tags: [
        stats.defender_harm >= 4 ? "high defender pressure" : "",
        stats.defender_eliminated >= 2 ? "elimination chance" : "",
        stats.defender_retreat >= 3 ? "retreat pressure" : "",
        targetIntel.some((target) => target.is_primary_objective) ? "primary objective target" : "",
        targetIntel.some((target) => target.retreat_options_estimate <= target.defenders.length) ? "limited defender retreat" : "",
        stats.attacker_harm >= 3 ? "meaningful attacker risk" : ""
      ].filter(Boolean),
      risks: [
        stats.attacker_harm >= 3 ? "attacker losses likely on several die faces" : "",
        stats.exchange >= 2 ? "exchange risk" : "",
        targetIntel.some((target) => target.terrain.includes("hill_or_ridge")) ? "rugged defense may cancel defender retreat" : "",
        (details.attack || 0) < (details.defense || 1) ? "low odds attack" : ""
      ].filter(Boolean)
    };
  }
  if (action.type === "move") {
    const unit = ctx.state.units[action.unit];
    if (!unit || !action.path?.length) return { summary: "Move action has unknown unit or path." };
    const start = RulesEngine.normalizeHex(unit.hex);
    const destination = RulesEngine.normalizeHex(action.path.at(-1));
    const target = moveTarget(ctx, { id: action.unit, ...unit }, allUnits);
    const before = distance(start, target);
    const after = distance(destination, target);
    const zocSources = [...RulesEngine.enemyZocSources(ctx, unit.side, destination)];
    const mines = RulesEngine.enemyMinesAt(ctx, unit.side, destination).map((mine) => mine.id);
    const terrainTags = RulesEngine.hexTags(ctx, destination);
    return {
      summary: `${action.unit} ${start} -> ${destination}; objective distance ${before} -> ${after}.`,
      start,
      destination,
      objective: target,
      distance_before: before,
      distance_after: after,
      progress: before - after,
      victory_impact: victoryImpact(ctx, action),
      spent: action.spent,
      terrain: terrainTags,
      map_area: mapArea(ctx, destination),
      enemy_zoc_sources: zocSources,
      enemy_mines: mines,
      nearest_enemies: nearestEnemies({ id: action.unit, ...unit, hex: destination }, allUnits, 3),
      tactical_tags: [
        before - after > 0 ? "objective progress" : "",
        terrainTags.includes("alamein_box") ? "Alamein box" : "",
        zocSources.length ? "contact" : ""
      ].filter(Boolean),
      risks: [
        zocSources.length ? `enters enemy ZOC from ${zocSources.join(", ")}` : "",
        mines.length ? `enters enemy mines ${mines.join(", ")}` : ""
      ].filter(Boolean)
    };
  }
  return { summary: `Action type ${action.type}` };
}

function combatActionScore(action) {
  const details = action.verdict?.details || {};
  const columns = ["1-4", "1-3", "1-2", "1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"];
  const oddsIndex = Math.max(0, columns.indexOf(details.odds_column));
  const stats = combatOutcomeStats(details.crt_column);
  const exchangeRisk = stats.exchange + stats.attacker_harm;
  return Number((110 + oddsIndex * 14 + combatRiskScore(details.crt_column) * 10 - exchangeRisk * 5 + Number(details.attack || 0) - Number(details.defense || 0)).toFixed(2));
}

function combatCandidates(ctx, allUnits) {
  const side = ctx.state.active_side;
  const unitsByHex = RulesEngine.unitsByHex(ctx);
  const seen = new Set();
  return allUnits
    .filter((unit) => unit.side === side && RulesEngine.isCombatUnit(unit) && unit.hex && unit.state === "fresh" && !unit.attacked_this_turn)
    .flatMap((unit) => {
      const defenderHexes = RulesEngine.neighbors(unit.hex)
        .filter((hex) => (unitsByHex[hex] || []).some((enemy) => enemy.side !== side && RulesEngine.isCombatUnit(enemy)))
        .sort();
      if (!defenderHexes.length) return [];
      const action = { type: "combat", attackers: [unit.id], defender_hexes: defenderHexes, no_retreat_order: false };
      const key = `${action.attackers.join(",")}=>${defenderHexes.join(",")}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const verdict = RulesEngine.checkCombat(ctx, action);
      if (!verdict.legal) return [];
      const withVerdict = {
        ...action,
        verdict: {
          ...verdict,
          details: {
            ...(verdict.details || {}),
            crt_column: crtColumn(ctx, verdict.details?.odds_column)
          }
        }
      };
      return [{ score: combatActionScore(withVerdict), action: withVerdict, evaluation: actionEvaluation(ctx, withVerdict, allUnits) }];
    })
    .sort((a, b) => b.score - a.score);
}

function movementCandidates(ctx, allUnits, activeUnits, config) {
  const contextLimit = Number(config.context?.maxCandidateActions || 12);
  const reachableLimit = Number(config.context?.maxReachableHexesPerCandidateUnit || 120);
  const moverLimit = Math.min(8, Math.max(5, Math.ceil(contextLimit / 2)));
  const firstMovers = activeUnits
    .filter((unit) => unit.state === "fresh" && unit.mp > 0 && unit.can_move_now)
    .sort((a, b) => moveUnitPriority(ctx, a, allUnits) - moveUnitPriority(ctx, b, allUnits))
    .slice(0, moverLimit);
  return firstMovers.flatMap((unit) => {
    const target = moveTarget(ctx, { id: unit.id, ...ctx.state.units[unit.id] }, allUnits);
    const reachable = RulesEngine.reachableHexes(ctx, unit.id, { mode: "normal", maxHexes: reachableLimit });
    return [...reachable.entries()]
      .filter(([hex, item]) => hex !== unit.hex && item.path?.length > 1)
      .map(([hex, item]) => {
        const action = { type: "move", unit: unit.id, path: item.path, mode: "normal", destination: hex, spent: item.cost };
        const progress = distance(unit.hex, target) - distance(hex, target);
        return { score: movementActionScore(ctx, action, allUnits), progress, action };
      })
      .filter((item) => usefulMoveCandidate(ctx, item.action, allUnits) && (item.progress > 0 || item.score > 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map(({ progress: _progress, ...item }) => ({ ...item, evaluation: actionEvaluation(ctx, item.action, allUnits) }));
  }).sort((a, b) => b.score - a.score);
}

function buildContext(config, options = {}) {
  const state = options.state ? cloneJson(options.state) : readJson(options.scenario || "scenarios/july.json");
  if (options.phase) state.phase = options.phase;
  if (options.activeSide) state.active_side = options.activeSide;
  if (options.turn != null) state.turn = Number(options.turn);
  for (const [unitId, patch] of Object.entries(options.unitPatches || {})) {
    if (state.units?.[unitId]) state.units[unitId] = { ...state.units[unitId], ...patch };
  }
  const rules = readJson("rules_first_alamein.json");
  const terrain = readJson("terrain.json");
  RulesEngine.applyStateDefaults(state);
  const ctx = RulesEngine.createContext({ state, rules, terrain });
  const entries = Object.entries(state.units || {});
  const allUnits = entries.map(([id, unit]) => ({ id, ...unit }));
  const activeSide = state.active_side || "axis";
  const enemySide = activeSide === "axis" ? "allies" : "axis";
  const limit = Number(config.context.maxUnitsPerSide || 28);
  const activeForce = forceDigest(entries, activeSide, ctx, allUnits, limit, config);
  const enemyForce = forceDigest(entries, enemySide, ctx, allUnits, limit, config);
  const activeUnits = allUnits
    .filter((unit) => unit.side === activeSide && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map((unit) => compactUnit(unit.id, ctx.state.units[unit.id], ctx, allUnits, { includeNearby: false }));
  const kind = phaseKind(state.phase);
  const candidateActions = kind === "combat"
    ? combatCandidates(ctx, allUnits)
    : ["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)
      ? movementCandidates(ctx, allUnits, activeUnits, config)
      : [];
  const passAction = { type: "pass", reason: "No useful legal action" };
  const passCandidate = { score: -999, action: passAction, evaluation: actionEvaluation(ctx, passAction, allUnits) };
  const candidateLimit = Number(config.context.maxCandidateActions || 12);
  const selectedCandidates = [
    ...candidateActions.filter((item) => item.action?.type !== "pass").slice(0, Math.max(0, candidateLimit - 1)),
    passCandidate
  ];

  const publicContext = {
    protocol: {
      response_json_only: true,
      allowed_final_actions: ["move_intent", "move", "combat", "exit_west", "pass"],
      current_phase_allowed_actions: phaseAllowedActions(state),
      compressed_fields: {
        unit_index: {
          h: "hex",
          k: "kind",
          a: "attack",
          d: "defense",
          m: "movement points",
          s: "state",
          sup: "supply state",
          area: "operational area code: N/C/S = north/central/south sector; W/M/E = west/middle/east depth, e.g. N/M"
        }
      },
      tool_call_shape: { type: "tool_call", tool: "inspect_unit", arguments: { unit: "unit-id" } },
      final_action_shape: { type: "final_action", reason: "short reason", action: { type: "move_intent", unit: "unit-id", destination: "hex", mode: "auto" } }
    },
    game: {
      scenario: state.scenario || "july",
      turn: Number(state.turn || 1),
      final_turn: RulesEngine.scenarioFinalTurn(state.scenario || "july"),
      turns_remaining: Math.max(0, RulesEngine.scenarioFinalTurn(state.scenario || "july") - Number(state.turn || 1) + 1),
      phase: state.phase,
      phase_kind: phaseKind(state.phase),
      active_side: activeSide,
      victory_points: Number(state.victory_points || 0)
    },
    decision_brief: decisionBrief(ctx, selectedCandidates, activeSide),
    mission: {
      identity: "game_agent",
      side: activeSide,
      opponent: enemySide,
      objective: activeSide === "axis"
        ? "Win as Axis by raising VP, maintaining supply, pressuring Alamein/eastern routes, and avoiding wasteful losses."
        : "Win as Allies by keeping VP low, holding Alamein, preserving units, and disrupting Axis supply/tempo.",
      current_phase_allowed_actions: phaseAllowedActions(state),
      decision_rule: "Choose the legal action that most improves your chance to win the scenario. Use tools when legality, supply, pathing, or combat odds are uncertain."
    },
    rules_brief: rulesBrief(rules),
    victory: victoryBrief(state, rules),
    strategy: {
      doctrine: config.strategy.doctrine,
      active_phase_objective: config.strategy.phaseObjectives[phaseKind(state.phase)] || config.strategy.phaseObjectives.initial_movement,
      priorities: config.strategy.priorities,
      action_contract: config.strategy.actionContract
    },
    objectives: {
      axis_primary: rules.game?.alamein_hex || "3711",
      allies_primary: rules.game?.alamein_hex || "3711",
      alamein: rules.game?.alamein_hex || "3711"
    },
    forces: {
      active: activeForce,
      enemy: enemyForce
    },
    unit_index: {
      active: unitIndex(entries, activeSide, ctx, config.context?.maxUnitIndexPerSide || 160),
      enemy: unitIndex(entries, enemySide, ctx, config.context?.maxUnitIndexPerSide || 160)
    },
    battlefield_summary: battlefieldSummary(ctx, allUnits, activeSide),
    map_intel: mapIntel(ctx, selectedCandidates, allUnits, activeSide),
    candidate_actions: selectedCandidates,
    recent_log: [],
    tools: [
      { name: "list_legal_actions", arguments: { limit: "number" }, returns: "scored actions with evaluation summaries, risks, and tactical tags" },
      { name: "check_move", arguments: { unit: "string", path: ["hex"], mode: "normal|road" } },
      { name: "find_path", arguments: { unit: "string", target: "hex", mode: "normal|road" } },
      { name: "check_combat", arguments: { attackers: ["unit-id"], defender_hexes: ["hex"] } },
      { name: "inspect_unit", arguments: { unit: "unit-id" } },
      { name: "inspect_hex", arguments: { hex: "hex" } },
      { name: "trace_supply", arguments: { unit: "unit-id" } },
      { name: "evaluate_action", arguments: { action: { type: "move_intent|move|combat|exit_west|pass" } }, returns: "legality plus score, planned route for move_intent, candidate rank, evaluation, risks, and tactical tags" }
    ],
    tool_results: []
  };
  return { publicContext, ctx, allUnits };
}

function systemPrompt(config) {
  return [
    "You are the game agent for the active side in El Alamein. Your objective is to win the scenario, not merely to output any legal move.",
    "You are El Alamein external AI. You can call read-only tools. Final actions are validated by the front end.",
    config.strategy.doctrine,
    config.strategy.actionContract,
    ...(config.strategy.priorities || []).map((item) => `Priority: ${item}`),
    "Read decision_brief first, then mission, rules_brief, victory, game, forces, battlefield_summary, map_intel, candidate_actions, and recent_log before choosing.",
    "Only return final actions allowed by protocol.current_phase_allowed_actions.",
    "For movement, prefer move_intent with unit + destination + mode:auto. The local planner will choose the full legal route. Use full move only when you intentionally need a specific path.",
    "Prefer candidate_actions for strong known options. If choosing one, either copy its action exactly or return move_intent with the same unit and destination.",
    "Before returning a non-candidate final_action, call evaluate_action and compare its score/risk to the best candidate.",
    "If tool_results contains final_action_review with accept=false, do not repeat that action; choose the recommended best_action or another stronger legal candidate.",
    "Return compact JSON only. Never wrap JSON in Markdown. Never include die rolls in combat."
  ].filter(Boolean).join("\n");
}

function publicPayload(config, context, toolResults) {
  return {
    provider: config.provider,
    model: config.api.model,
    rules_summary:
      "External AI is a game agent playing to win. It may call read-only tools. Final move/combat/exit_west/pass actions are validated. Combat must not include die.",
    context: { ...context, tool_results: toolResults.slice(-(config.context.maxToolResults || 6)) }
  };
}

function runTool(env, context, tool, args = {}) {
  const unitsById = env.unitsById || env;
  const ctx = env.ctx;
  const allUnits = env.allUnits || [];
  if (tool === "list_legal_actions") {
    return { legal: true, actions: context.candidate_actions.slice(0, Number(args.limit || context.candidate_actions.length)) };
  }
  if (tool === "check_move") return ctx ? checkMoveTool(ctx, args) : { legal: false, reason: "rules context unavailable" };
  if (tool === "find_path") return ctx ? findPathTool(ctx, args) : { legal: false, reason: "rules context unavailable" };
  if (tool === "check_combat") return ctx ? combatVerdictTool(ctx, args) : { legal: false, reason: "rules context unavailable" };
  if (tool === "inspect_unit") {
    if (ctx) return inspectUnit(ctx, allUnits, args.unit);
    const unit = unitsById[args.unit];
    return unit ? { legal: true, unit } : { legal: false, reason: `unknown unit ${args.unit}` };
  }
  if (tool === "inspect_hex") return ctx ? inspectHex(ctx, args.hex) : { legal: false, reason: "rules context unavailable" };
  if (tool === "trace_supply") return ctx ? traceSupply(ctx, args.unit) : { legal: false, reason: "rules context unavailable" };
  if (tool === "evaluate_action") {
    const result = evaluateProbeAction(context, args.action || {}, ctx);
    return {
      ...result,
      reason: result.candidate_match.exact_candidate ? "matches provided candidate action" : result.reason
    };
  }
  return { legal: false, reason: `unknown tool ${tool}` };
}

function sameProbeAction(left = {}, right = {}) {
  if (left.type !== right.type) return false;
  if (left.type === "pass") return true;
  if (left.type === "move") {
    return left.unit === right.unit &&
      (left.mode || "normal") === (right.mode || "normal") &&
      (left.path || []).join("-") === (right.path || []).join("-");
  }
  if (left.type === "combat") {
    return [...(left.attackers || [])].sort().join(",") === [...(right.attackers || [])].sort().join(",") &&
      [...(left.defender_hexes || [])].sort().join(",") === [...(right.defender_hexes || [])].sort().join(",");
  }
  return left.type === "exit_west" && left.unit === right.unit;
}

function evaluateProbeAction(context, action = {}, ctx = null) {
  const planning = action?.type === "move_intent" && ctx ? resolveMoveIntent(ctx, action) : null;
  const resolvedAction = planning?.legal ? planning.action : action;
  const index = context.candidate_actions.findIndex((item) => sameProbeAction(resolvedAction, item.action));
  const best = context.candidate_actions[0] || null;
  const matched = index >= 0 ? context.candidate_actions[index] : null;
  const legal = resolvedAction.type === "pass" || index >= 0 || !!planning?.legal;
  const fallback = resolvedAction.type === "pass"
    ? { summary: "Pass ends the current phase. Use only when no useful legal action remains.", risks: ["cedes tempo"] }
    : planning?.legal
      ? actionEvaluation(ctx, planning.action, Object.entries(ctx.state.units || {}).map(([id, unit]) => ({ id, ...unit })))
    : null;
  return {
    legal,
    score: matched?.score ?? (resolvedAction.type === "pass" ? -999 : planning?.legal ? 0 : null),
    evaluation: matched?.evaluation || fallback,
    action: resolvedAction,
    planned_from_intent: planning?.planned_from_intent || null,
    candidate_match: {
      exact_candidate: index >= 0,
      candidate_rank: index >= 0 ? index + 1 : null,
      candidate_score: matched?.score ?? null,
      best_score: best?.score ?? null,
      score_delta_from_best: matched && best ? Number((matched.score - best.score).toFixed(2)) : null,
      best_action: best?.action || null
    },
    reason: planning && !planning.legal ? planning.reason : legal ? "legal in transcript probe" : "transcript probe validates exact candidate actions, move_intent with legal planned route, or pass only"
  };
}

function finalActionReview(context, action = {}, assessment) {
  const match = assessment?.candidate_match || {};
  const bestAction = match.best_action || null;
  const bestScore = Number(match.best_score);
  const score = Number(assessment?.score);
  const issues = [];
  if (!assessment?.legal) issues.push(assessment?.reason || "final action is illegal");
  const reviewedAction = assessment?.action || action;
  if (reviewedAction?.type === "move" && (reviewedAction.path || []).length <= 1) issues.push("final action is a no-op move");
  if (action?.type === "pass" && bestAction?.type && bestAction.type !== "pass" && Number.isFinite(bestScore) && bestScore > 0) {
    issues.push("pass rejects useful non-pass candidate");
  }
  if (match.exact_candidate && Number(match.candidate_rank) > 5 && Number.isFinite(Number(match.score_delta_from_best)) && Number(match.score_delta_from_best) < -20) {
    issues.push(`candidate rank ${match.candidate_rank} is too far below best action`);
  }
  if (!match.exact_candidate && Number.isFinite(score) && Number.isFinite(bestScore) && score < bestScore - 20) {
    issues.push("non-candidate final action scores much worse than best candidate");
  }
  return {
    accept: issues.length === 0,
    issues,
    action,
    assessment,
    instruction: issues.length
      ? "Choose a stronger legal final_action. Prefer candidate_match.best_action or a top candidate_actions item; copy its action exactly."
      : "Final action accepted."
  };
}

async function readKey() {
  return await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value.trim()));
    process.stdin.on("error", reject);
  });
}

async function callModel(config, apiKey, messages, label) {
  const api = config.api;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(api.timeoutSeconds || 30) * 1000);
  try {
    const requestBody = {
      model: api.model,
      messages,
      temperature: Number(api.temperature ?? 0.25),
      max_tokens: Math.min(Number(api.maxTokens || 3600), 2400),
      response_format: api.responseFormat || { type: "json_object" }
    };
    const response = await fetch(api.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const responseText = await response.text();
    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    }
    catch {
      responseJson = { raw_text: responseText };
    }
    return { label, ok: response.ok, status: response.status, elapsed_ms: Date.now() - started, request_body: requestBody, response_json: responseJson };
  }
  finally {
    clearTimeout(timer);
  }
}

function messageText(result) {
  return result.response_json?.choices?.[0]?.message?.content || "";
}

function reasoningText(result) {
  return result.response_json?.choices?.[0]?.message?.reasoning_content || "";
}

function parseJsonFromResult(result) {
  const content = messageText(result);
  if (!content && reasoningText(result)) return { parse_error: "empty content with reasoning_content", content: reasoningText(result) };
  if (!content) return null;
  try {
    return JSON.parse(content);
  }
  catch (error) {
    return { parse_error: error.message, content };
  }
}

function mockModelResult(config, messages, label, context, toolResults) {
  const reviewed = toolResults.some((item) => item.tool === "final_action_review");
  const bestAction = context.candidate_actions.find((item) => item.action?.type !== "pass")?.action || { type: "pass", reason: "No useful legal action" };
  const reviewedAction = bestAction.type === "move"
    ? { type: "move_intent", unit: bestAction.unit, destination: bestAction.destination || bestAction.path?.at(-1), mode: "auto" }
    : bestAction;
  const payload = reviewed
    ? { type: "final_action", reason: "Use reviewed best candidate", action: reviewedAction }
    : { type: "final_action", reason: "Mock weak first choice", action: { type: "pass", reason: "Mock pass to test review" } };
  return {
    label,
    ok: true,
    status: 200,
    elapsed_ms: 0,
    request_body: {
      model: `${config.api.model || "mock"}:mock-review`,
      messages,
      temperature: 0,
      max_tokens: 512,
      response_format: config.api.responseFormat || { type: "json_object" }
    },
    response_json: {
      choices: [
        { message: { content: JSON.stringify(payload) } }
      ]
    }
  };
}

async function main() {
  const config = readConfig();
  const scenarioArg = process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : null;
  const phaseArg = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1] : null;
  const sideArg = process.argv.includes("--active-side") ? process.argv[process.argv.indexOf("--active-side") + 1] : null;
  const turnArg = process.argv.includes("--turn") ? process.argv[process.argv.indexOf("--turn") + 1] : null;
  const mockReview = process.argv.includes("--mock-review");
  const outFile = path.resolve(argValue("--out", mockReview ? MOCK_OUT : OUT));
  const contextOutFile = path.resolve(argValue("--context-out", CONTEXT_OUT));
  const { publicContext, ctx, allUnits } = buildContext(config, {
    scenario: scenarioArg || undefined,
    phase: phaseArg || undefined,
    activeSide: sideArg || undefined,
    turn: turnArg == null ? undefined : Number(turnArg)
  });
  const toolEnv = { ctx, allUnits };
  const toolResults = [];
  if (process.argv.includes("--context-only")) {
    const requestBody = {
      model: config.api.model,
      messages: [
        { role: "system", content: systemPrompt(config) },
        { role: "user", content: JSON.stringify(publicPayload(config, publicContext, toolResults)) }
      ],
      temperature: Number(config.api.temperature ?? 0.25),
      max_tokens: Math.min(Number(config.api.maxTokens || 3600), 2400),
      response_format: config.api.responseFormat || { type: "json_object" }
    };
    fs.writeFileSync(contextOutFile, JSON.stringify({ generated_at: new Date().toISOString(), request_body: requestBody }, null, 2));
    console.log(JSON.stringify({ output: contextOutFile, message_count: requestBody.messages.length }, null, 2));
    return;
  }
  const apiKey = mockReview ? "" : await readKey();
  if (!mockReview && !apiKey) throw new Error("API key is required on stdin");
  const transcript = {
    generated_at: new Date().toISOString(),
    mode: mockReview ? "mock_review" : "api",
    config: {
      provider: config.provider,
      url: config.api.url,
      model: config.api.model,
      max_tokens: config.api.maxTokens,
      temperature: config.api.temperature
    },
    rounds: []
  };

  let finalJson = null;
  let finalReviewUsed = false;
  for (let round = 0; round <= Number(config.api.maxToolRounds || 4); round += 1) {
    const messages = [
      { role: "system", content: systemPrompt(config) },
      { role: "user", content: JSON.stringify(publicPayload(config, publicContext, toolResults)) }
    ];
    const result = mockReview
      ? mockModelResult(config, messages, `round_${round}`, publicContext, toolResults)
      : await callModel(config, apiKey, messages, `round_${round}`);
    const modelJson = parseJsonFromResult(result);
    transcript.rounds.push({
      label: result.label,
      ok: result.ok,
      status: result.status,
      elapsed_ms: result.elapsed_ms,
      model_input: result.request_body,
      model_output: result.response_json,
      parsed_output: modelJson
    });
    if (!result.ok || !modelJson || modelJson.parse_error) break;
    if (modelJson.type === "tool_call") {
      const toolResult = runTool(toolEnv, publicContext, modelJson.tool, modelJson.arguments || {});
      const record = { tool: modelJson.tool, arguments: modelJson.arguments || {}, result: toolResult };
      toolResults.push(record);
      transcript.rounds.at(-1).tool_result = record;
      continue;
    }
    const finalAction = modelJson.type === "final_action" ? modelJson.action : modelJson.action || modelJson;
    const assessment = evaluateProbeAction(publicContext, finalAction, ctx);
    transcript.rounds.at(-1).assessment = assessment;
    const review = finalActionReview(publicContext, finalAction, assessment);
    transcript.rounds.at(-1).final_action_review = review;
    if (!review.accept && !finalReviewUsed && round < Number(config.api.maxToolRounds || 4)) {
      finalReviewUsed = true;
      toolResults.push({ tool: "final_action_review", arguments: { action: finalAction }, result: review });
      continue;
    }
    transcript.final_assessment = assessment;
    transcript.final_action_review = review;
    finalJson = modelJson;
    break;
  }

  transcript.final = finalJson;
  fs.writeFileSync(outFile, JSON.stringify(transcript, null, 2));
  console.log(JSON.stringify({
    output: outFile,
    rounds: transcript.rounds.length,
    final: transcript.final,
    last_status: transcript.rounds.at(-1)?.status,
    last_elapsed_ms: transcript.rounds.at(-1)?.elapsed_ms
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildContext,
  evaluateProbeAction,
  finalActionReview,
  publicPayload,
  readConfig,
  runTool,
  systemPrompt
};
