#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const RulesEngine = require("../../rule_engine.js");
const { defaultLogFile, prepareOutputFile } = require("../core/experiment_log.js");
const { readConfigFile } = require("../core/config_file.js");
const { promptValue, renderSidePrompt, resolveSidePrompt, sideStrategyConfig, strategyConfig } = require("../core/prompt_registry.js");
const { CONFIG_DIR, PROJECT_ROOT } = require("../core/project_paths.js");

const ROOT = PROJECT_ROOT;
const OUT = defaultLogFile("last_external_ai_transcript.json");
const CONTEXT_OUT = defaultLogFile("last_external_ai_context.json");
const MOCK_OUT = defaultLogFile("last_external_ai_mock_transcript.json");

function readConfig() {
  return { ...readConfigFile(path.join(CONFIG_DIR, "ai_config.yaml")), strategy: strategyConfig() };
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
  if (tags.includes("coastline")) areas.push("coastal hex");
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

function supplyRank(value) {
  return { isolated: 0, unsupplied: 1, partial: 2, partially_supplied: 2, supplied: 3 }[String(value || "").toLowerCase()] ?? -1;
}

function fixedAiTarget(ctx, side = ctx.state.active_side) {
  if (side === "axis" && ctx.state.scenario === "october" && Number(ctx.state.turn || 1) > 10) return "0101";
  return ctx.rules.game?.alamein_hex || "3711";
}

function scoringFrontier(ctx) {
  const scenario = ctx.state.scenario || "july";
  const victory = RulesEngine.checkVictory(ctx);
  if (scenario === "july") {
    const advance = victory.breakdown?.find((item) => item.id === "july_east_of_3400");
    const currentColumn = Number(advance?.farthest_column || 34);
    return {
      type: "scoring_frontier",
      scenario,
      current_value: currentColumn,
      next_value: Math.max(35, currentColumn + 1),
      gain: 3,
      eligible_unit: "surviving Axis ground combat unit",
      supply_required: true,
      rule_source: "current_scenario_scoring"
    };
  }
  return {
    type: "scenario_objective",
    scenario,
    current_value: Number(victory.victory_points || 0),
    next_value: null,
    gain: null,
    eligible_unit: "scenario-defined eligible unit",
    supply_required: true,
    rule_source: "current_scenario_scoring"
  };
}

function objectiveResolution(ctx, allUnits, candidateActions = []) {
  const frontier = scoringFrontier(ctx);
  const candidates = candidateActions
    .filter((item) => item.action?.type === "move")
    .map((item) => {
      const action = item.action;
      const impact = item.evaluation?.victory_impact || {};
      return {
        unit: action.unit,
        destination: action.destination || action.path?.at(-1) || "",
        path_exists: true,
        projected_supply: impact.projected_supply_after_move || "",
        crosses_frontier: Number(impact.estimated_vp_delta || 0) > 0,
        estimated_vp_delta: Number(impact.estimated_vp_delta || 0),
        risks: item.evaluation?.risks || [],
        score: Number(item.score || 0)
      };
    })
    .filter((item, index, values) => values.findIndex((other) => `${other.unit}:${other.destination}` === `${item.unit}:${item.destination}`) === index)
    .sort((left, right) => Number(right.crosses_frontier) - Number(left.crosses_frontier)
      || right.score - left.score)
    .slice(0, 8);
  return {
    frontier,
    operational_landmark: ctx.rules.game?.alamein_hex || "3711",
    candidates,
    selection_rule: "Prefer a legal route that improves the scoring frontier while preserving projected supply; use the operational landmark only when it also supports the active scoring objective."
  };
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
  if (unit.side === "axis" && ctx.state.scenario === "july" && unit.hex) {
    const [, row] = RulesEngine.splitHex(unit.hex);
    const targetColumn = Math.max(35, currentJulyAdvanceColumn(ctx) + 1);
    for (let offset = 0; offset <= 30; offset += 1) {
      for (const candidateRow of offset ? [row - offset, row + offset] : [row]) {
        if (candidateRow < 1) continue;
        try {
          return RulesEngine.normalizeHex(`${String(targetColumn).padStart(2, "0")}${String(candidateRow).padStart(2, "0")}`);
        }
        catch {}
      }
    }
    return fixedAiTarget(ctx, "axis");
  }
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

function projectedSupplyAfterMove(ctx, action) {
  const unit = ctx.state.units?.[action.unit];
  if (!unit || action.type !== "move") return "";
  const destination = RulesEngine.normalizeHex(action.destination || action.path?.at(-1) || unit.hex);
  ctx.ai_projected_move_supply_cache ||= new Map();
  const key = `${action.unit}:${destination}`;
  if (ctx.ai_projected_move_supply_cache.has(key)) return ctx.ai_projected_move_supply_cache.get(key);
  ctx.ai_supply_network_cache ||= {};
  ctx.ai_supply_network_cache[unit.side] ||= RulesEngine.buildSupplyNetwork(ctx, unit.side);
  const originalHex = unit.hex;
  unit.hex = destination;
  let supply;
  try {
    supply = RulesEngine.supplyState(ctx, action.unit, ctx.ai_supply_network_cache[unit.side]);
  }
  finally {
    unit.hex = originalHex;
  }
  ctx.ai_projected_move_supply_cache.set(key, supply);
  return supply;
}

function supplyCoverage(ctx, side) {
  const supply = RulesEngine.checkSupply(ctx, side);
  const units = Object.entries(ctx.state.units || {})
    .filter(([, unit]) => unit.side === side && !unit.eliminated && RulesEngine.isCombatUnit({ ...unit }))
    .map(([id]) => id);
  const eligible = units.filter((id) => ["supplied", "partially_supplied"].includes(supply[id]));
  return { eligible_units: eligible, eligible_count: eligible.length, states: supply };
}

function projectedSupplyCoverageAfterMove(ctx, action) {
  const unit = ctx.state.units?.[action?.unit];
  if (!unit || action?.type !== "move" || !RulesEngine.isSupplyUnit({ id: action.unit, ...unit })) return null;
  const destination = RulesEngine.normalizeHex(action.destination || action.path?.at(-1) || unit.hex);
  const before = supplyCoverage(ctx, unit.side);
  const originalHex = unit.hex;
  unit.hex = destination;
  let after;
  try { after = supplyCoverage(ctx, unit.side); }
  finally { unit.hex = originalHex; }
  const beforeSet = new Set(before.eligible_units);
  const afterSet = new Set(after.eligible_units);
  return {
    before_count: before.eligible_count,
    after_count: after.eligible_count,
    delta: after.eligible_count - before.eligible_count,
    newly_eligible_units: after.eligible_units.filter((id) => !beforeSet.has(id)),
    lost_eligible_units: before.eligible_units.filter((id) => !afterSet.has(id)),
    scoring_unit_count: after.eligible_count,
    summary: after.eligible_count > before.eligible_count
      ? `supply move makes ${after.eligible_count - before.eligible_count} additional combat unit(s) scoring-eligible`
      : after.eligible_count < before.eligible_count
        ? `supply move loses ${before.eligible_count - after.eligible_count} scoring-eligible combat unit(s)`
        : "supply move does not change scoring-eligible combat coverage"
  };
}

function alliedDefensiveImpactAfterMove(ctx, action, currentFarthestColumn) {
  const unit = ctx.state.units?.[action?.unit];
  if (!unit || unit.side !== "allies" || action.type !== "move" || !RulesEngine.isCombatUnit({ id: action.unit, ...unit })) {
    return { axis_scoring_threat_delta: 0, evidence: [] };
  }
  const start = RulesEngine.normalizeHex(unit.hex);
  const destination = RulesEngine.normalizeHex(action.destination || action.path?.at(-1) || start);
  const beforeZoc = new Set(RulesEngine.neighbors(start));
  const afterZoc = new Set(RulesEngine.neighbors(destination));
  const axisCombatUnits = Object.entries(ctx.state.units || {})
    .filter(([, other]) => other.side === "axis" && other.hex && !other.eliminated && RulesEngine.isCombatUnit(other))
    .map(([id, other]) => ({ id, hex: RulesEngine.normalizeHex(other.hex) }));
  const axisSupply = supplyCoverage(ctx, "axis").states;
  const frontierThreats = axisCombatUnits.filter((other) =>
    ["supplied", "partially_supplied", "partial"].includes(axisSupply[other.id])
      && Number(String(other.hex).slice(0, 2)) >= Number(currentFarthestColumn || 34));
  const pinnedBefore = frontierThreats.filter((other) => beforeZoc.has(other.hex)).map((other) => other.id);
  const pinnedAfter = frontierThreats.filter((other) => afterZoc.has(other.hex)).map((other) => other.id);
  const newlyPinnedAxisUnits = axisCombatUnits
    .filter((other) => afterZoc.has(other.hex) && !beforeZoc.has(other.hex))
    .map((other) => other.id);
  const releasedFrontierUnits = pinnedBefore.filter((id) => !pinnedAfter.includes(id));
  const nextScoringColumn = Number(currentFarthestColumn || 34) + 1;
  const destinationColumn = Number(destination.slice(0, 2));
  const blocksNextScoringEntry = destinationColumn === nextScoringColumn && newlyPinnedAxisUnits.length > 0;
  const beforeAxisSupply = supplyCoverage(ctx, "axis");
  const originalHex = unit.hex;
  unit.hex = destination;
  let afterAxisSupply;
  try { afterAxisSupply = supplyCoverage(ctx, "axis"); }
  finally { unit.hex = originalHex; }
  const afterSet = new Set(afterAxisSupply.eligible_units);
  const axisSupplyLosses = beforeAxisSupply.eligible_units.filter((id) => !afterSet.has(id));
  const verifiedEffects = newlyPinnedAxisUnits.length + axisSupplyLosses.length + Number(blocksNextScoringEntry);
  const releasedThreats = releasedFrontierUnits.length;
  const evidence = [
    ...(newlyPinnedAxisUnits.length ? [`new Axis units constrained by Allied ZOC: ${newlyPinnedAxisUnits.join(", ")}`] : []),
    ...(releasedFrontierUnits.length ? [`Axis frontier units released from Allied ZOC: ${releasedFrontierUnits.join(", ")}`] : []),
    ...(blocksNextScoringEntry ? [`occupies a contested entry in scoring column ${nextScoringColumn}`] : []),
    ...(axisSupplyLosses.length ? [`Axis units lose scoring supply: ${axisSupplyLosses.join(", ")}`] : [])
  ];
  return {
    axis_scoring_threat_delta: releasedThreats - verifiedEffects,
    newly_pinned_axis_units: newlyPinnedAxisUnits,
    released_axis_frontier_units: releasedFrontierUnits,
    defensive_line_coverage_delta: pinnedAfter.length - pinnedBefore.length,
    blocks_next_scoring_entry: blocksNextScoringEntry,
    axis_supply_coverage_delta: afterAxisSupply.eligible_count - beforeAxisSupply.eligible_count,
    axis_supply_losses: axisSupplyLosses,
    evidence
  };
}

function currentJulyAdvanceColumn(ctx) {
  if (ctx.state.scenario !== "july") return 34;
  ctx.ai_victory_impact_cache ||= RulesEngine.checkVictory(ctx);
  const advance = ctx.ai_victory_impact_cache.breakdown?.find((item) => item.id === "july_east_of_3400");
  return Number(advance?.farthest_column || 34);
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
  const postMoveSupply = projectedSupplyAfterMove(ctx, action);
  const destinationColumn = hexColumn(destination);
  const currentFarthestColumn = currentJulyAdvanceColumn(ctx);
  const julyScoringUnit = ctx.state.scenario === "july"
    && unit.side === "axis"
    && (unit.kind || "ground") === "ground"
    && ["supplied", "partially_supplied"].includes(postMoveSupply);
  const estimatedVpDelta = julyScoringUnit && destinationColumn > currentFarthestColumn
    ? (destinationColumn - currentFarthestColumn) * 3
    : 0;
  const directVpBonus = estimatedVpDelta * 32;
  const staleFrontierPenalty = julyScoringUnit && destinationColumn <= currentFarthestColumn ? 28 : 0;
  const breaksScoringSupplyPenalty = ctx.state.scenario === "july"
    && unit.side === "axis"
    && ["supplied", "partially_supplied"].includes(supply)
    && !["supplied", "partially_supplied"].includes(postMoveSupply)
    ? 120
    : 0;
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
  return Number((progressScore + direction + directVpBonus + finalThreatBonus + interceptionBonus - staleFrontierPenalty - breaksScoringSupplyPenalty - negativeProgressPenalty - farFromTargetPenalty - zocPenalty - minePenalty - overmatchPenalty - fragileContactPenalty - supplyPenalty - formationPenalty - spentPenalty + roadBonus + terrainBonus + strength).toFixed(2));
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
  const nearest = nearestEnemies(full, allUnits, 1)[0];
  const nearEnemyScore = nearest ? Math.max(0, 12 - nearest.distance) * 3 : 0;
  const objectiveDistance = unit.hex && unit.side === "axis" && ctx.state.scenario === "july"
    ? Math.abs(hexColumn(unit.hex) - (currentJulyAdvanceColumn(ctx) + 1))
    : unit.hex ? distance(unit.hex, fixedAiTarget(ctx, unit.side)) : 99;
  const objectiveScore = unit.hex ? Math.max(0, 18 - objectiveDistance) : 0;
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
  const julyScoring = ctx.state.scenario === "july";
  const objective = julyScoring ? null : fixedAiTarget(ctx, unit.side);
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
    distance_to_operational_landmark: !julyScoring && unit.hex ? distance(unit.hex, objective) : null,
    distance_to_scoring_frontier: unit.hex && unit.side === "axis" && ctx.state.scenario === "july"
      ? Math.max(0, currentJulyAdvanceColumn(ctx) + 1 - hexColumn(unit.hex))
      : null,
    enemy_zoc_here: unit.hex && RulesEngine.isPlayableSide(unit.side) ? RulesEngine.enemyZocSources(ctx, unit.side, unit.hex).size > 0 : false,
    zoc_hexes: RulesEngine.isCombatUnit(full) ? RulesEngine.zocHexes(full) : [],
    can_move_now: unit.side === ctx.state.active_side && unit.state === "fresh" && RulesEngine.canMoveInCurrentPhase(ctx, full),
    can_attack_now: unit.side === ctx.state.active_side && unit.state === "fresh" && kind === "combat" && RulesEngine.canAttackUnit(full) && !unit.attacked_this_turn && !unit.attacked_this_phase,
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
  const victory = victoryBrief(ctx);
  const julyAdvance = victory.current_scoring?.july_advance;
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
    description: "Operational board summary by region: force density, supply health, contact, scoring-frontier pressure, and landmark pressure.",
    active_side: activeSide,
    enemy_side: enemySide,
    strategic_objective: ctx.state.scenario === "july"
      ? {
          type: "eastern_scoring_frontier",
          next_scoring_column: Number(julyAdvance?.next_scoring_column || 35),
          scoring_requirement: julyAdvance?.scoring_requirement || "supplied or partially supplied Axis ground combat unit",
          vp_gain: Number(julyAdvance?.vp_gain_for_reaching_next_column || 3)
        }
      : { type: "landmark", hex: objective },
    reference_landmark_hex: objective,
    reference_landmark_role: ctx.state.scenario === "july"
      ? "Operational reference area; scoring is determined by current_scoring and the eastern frontier."
      : "Scenario operational objective.",
    reference_landmark_zone: {
      radius_hexes: 4,
      control: ctx.state.control?.[objective] || "",
      zoc_by_axis: RulesEngine.enemyZocSources(ctx, "allies", objective).size > 0,
      zoc_by_allies: RulesEngine.enemyZocSources(ctx, "axis", objective).size > 0,
      units: unitsNearObjective
    },
    closest_active_to_landmark: closestActive,
    closest_enemy_to_landmark: closestEnemy,
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

function intentBrief(ctx, activeUnits, activeSide) {
  const kind = phaseKind(ctx.state.phase);
  const movers = activeUnits
    .filter((unit) => unit.can_move_now && unit.mp > 0)
    .map((unit) => ({
      unit: unit.id,
      hex: unit.hex,
      movement: unit.mp,
      supply: unit.supply,
      mechanized: unit.mech,
      distance_to_objective: unit.distance_to_objective
    }));
  const attackers = activeUnits
    .filter((unit) => unit.can_attack_now)
    .map((unit) => ({ unit: unit.id, hex: unit.hex, attack: unit.atk, supply: unit.supply }));
  return {
    read_first: true,
    mode: "intent",
    side: activeSide,
    phase: ctx.state.phase,
    allowed: phaseAllowedActions(ctx.state),
    phase_goal: kind === "combat"
      ? "Choose a worthwhile attack only after checking combat odds; otherwise pass."
      : ["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)
        ? "Choose a unit and destination that improves victory position, then verify the route."
        : "Pass unless a legal action is explicitly available.",
    available_movers: movers,
    available_attackers: attackers,
    candidate_policy: "No action candidates are provided. Form an operational intent from the board state, then use tools to validate it.",
    tool_policy: "Use find_path before movement, check_combat before combat, and evaluate_action before any non-pass final action.",
    pass_policy: movers.length || attackers.length
      ? "Do not pass solely because no candidate list is present; inspect the board and validate an intent first."
      : "No fresh units can act in this phase; pass is acceptable."
  };
}

function phaseIntentCatalog(state) {
  const kind = phaseKind(state.phase);
  if (kind === "combat") return ["attack_pressure", "protect_supply", "pass"];
  if (kind === "supply_movement") return ["extend_supply", "protect_supply", "pass"];
  if (["initial_movement", "mechanized_movement"].includes(kind)) return ["advance", "pressure", "consolidate", "supply"];
  return ["pass"];
}

function defaultPhaseIntent(state) {
  const kind = phaseKind(state.phase);
  return {
    type: kind === "combat" ? "attack_pressure" : kind === "supply_movement" ? "extend_supply" : "advance",
    sector: "",
    target_hex: "",
    priority_units: [],
    source: "local_default"
  };
}

function normalizePhaseIntent(raw, state) {
  const fallback = defaultPhaseIntent(state);
  const allowed = new Set(phaseIntentCatalog(state));
  const value = raw?.intent || raw || {};
  const type = allowed.has(value.type) ? value.type : fallback.type;
  const sector = ["north", "central", "south"].includes(value.sector) ? value.sector : "";
  let targetHex = "";
  if (value.target_hex || value.targetHex) {
    try { targetHex = RulesEngine.normalizeHex(value.target_hex || value.targetHex); }
    catch {}
  }
  const priorityUnits = Array.isArray(value.priority_units)
    ? value.priority_units.filter((id) => state.units?.[id]).slice(0, 6)
    : [];
  return {
    type,
    sector,
    target_hex: targetHex,
    priority_units: priorityUnits,
    source: allowed.has(value.type) ? "model" : "local_default",
    fallback_reason: allowed.has(value.type) ? "" : "invalid or missing phase intent"
  };
}

function rulesBrief(rules) {
  return {
    game: rules.game?.title || "El Alamein",
    role: promptValue("context.rules_role"),
    turn_sequence: rules.turn_sequence,
    phases: [
      "Initial movement: move currently eligible friendly units; each unit may successfully act at most once in the phase.",
      "Combat: fresh adjacent attackers may attack, combine in joint attacks, or pass.",
      "Mechanized movement: only units currently eligible under mechanized-movement rules may act.",
      "Supply movement: only eligible supply units may move.",
      "A movement phase may end only after remaining eligible units have moved, become unavailable, or are explicitly held."
    ],
    movement: [
      "Units move only in movement phases for their side and become spent after moving.",
      `Enemy occupied hexes are ${rules.movement?.enemy_occupied_hex || "forbidden"}.`,
      rules.movement?.enter_enemy_zoc_must_stop ? "Entering enemy ZOC requires stopping." : "",
      rules.movement?.cannot_move_directly_between_zocs_of_same_enemy_unit ? "Do not move directly between ZOCs of the same enemy unit." : "",
      "Road mode is faster but must still pass check_move validation.",
      "A temporary illegal stack must be repaired before ordinary movement."
    ].filter(Boolean),
    stacking: [
      "Axis may stack at most 4 counted units in one hex; Allies may stack at most 3.",
      "Opposing sides may not occupy the same hex.",
      "All movement, retreat, and advance actions remain subject to stacking validation."
    ],
    combat: [
      rules.combat?.attacker_must_be_fresh ? "Attackers must be fresh." : "",
      "Every attacker must be adjacent to a selected defender hex; multiple legal attackers may combine against one target.",
      `Minimum odds ${rules.combat?.minimum_odds || "1-4"}, maximum odds ${rules.combat?.maximum_odds || "7-1"}.`,
      "Supply, terrain, friendly minefields, engineer assistance, and retreat availability affect combat resolution.",
      "Do not include die in combat actions; the front-end judge rolls or uses the selected die.",
      "Eliminations caused by combat or blocked retreat can add Axis VP when Allied ground combat units are lost."
    ].filter(Boolean),
    mines: [
      "Enemy minefields increase movement cost, can block supply, and may strengthen defenders.",
      "Engineers can assist attacks through minefields or clear mines when legally positioned, but an engineer cannot both assist and clear in the same turn.",
      "Use check_combat before committing an attack involving mines or defensive terrain."
    ],
    supply: {
      axis_sources: rules.game?.axis_supply_sources || [],
      allies_sources: rules.game?.allies_supply_sources || [],
      rules: [
        "Supply paths cannot trace through enemy-occupied hexes, effective enemy ZOC, or uncleared enemy minefields unless an explicit rule exception applies.",
        "Supply state changes movement, combat strength, road use, survival, and scenario scoring eligibility.",
        "July eastern advance VP counts only supplied or partially supplied Axis ground combat units."
      ]
    },
    isolation: [
      "A unit with no valid supply path becomes isolated.",
      "A combat unit that remains isolated into a later turn is eliminated during replay upkeep.",
      "Each Allied ground combat unit eliminated by isolation adds 1 Axis VP."
    ]
  };
}

function gameOverview(ctx, options = {}) {
  const state = ctx.state || {};
  const scenario = state.scenario || "july";
  const activeSide = state.active_side || "axis";
  const finalTurn = RulesEngine.scenarioFinalTurn(scenario);
  const scoring = scenarioScoringRules(scenario, ctx.rules?.game?.alamein_hex || "3711");
  const victory = victoryBrief(ctx);
  const objective = scenarioObjectives(ctx, victory);
  const playerGoal = activeSide === "axis"
    ? {
        side: "axis",
        win_condition: scenario === "july"
          ? "在终局时获得更高 VP；优先让仍有补给的 Axis 地面战斗单位跨过当前下一东部计分列，并通过消灭或孤立 Allied 单位增加 VP。"
          : "在终局时按照当前场景规则获得更高 VP，同时保持 Axis 补给、推进和战斗能力。",
        primary_objective: objective.axis_primary,
        tactical_priorities: [
          "提高有效计分位置或完成当前场景的直接得分条件",
          "保持关键 Axis 战斗单位 supplied 或 partially_supplied",
          "破坏、孤立或消灭 Allied 战斗单位",
          "保护补给线和突破部队",
          "避免没有 VP 或战术收益的移动和低赔率攻击"
        ],
        non_goal: scenario === "july" ? "不要把没有 VP 或明确战术收益的移动当作首要行动。" : "不要把没有明确计分或战术收益的移动当作首要行动。"
      }
    : {
        side: "allies",
        win_condition: "在终局时按照当前场景规则压低 Axis VP或取得更高结果，阻止 Axis 完成有效计分目标。",
        primary_objective: objective.allies_primary,
        tactical_priorities: [
          "阻止 Axis 跨过有效计分前沿或完成场景得分条件",
          "保持关键 Allied 阵地和单位生存",
          "切断 Axis 补给并制造孤立",
          "利用 ZOC、地形、雷区和反击拖慢 Axis",
          "避免无意义的暴露和不必要的低赔率攻击"
        ],
        non_goal: scenario === "july" ? "不要为了追逐 Axis 单位而放弃阻止其计分推进和维持自身补给。" : "不要把单一位置当作唯一目标，必须服从当前场景计分规则。"
      };
  const julyAdvance = victory.current_scoring?.july_advance;
  const mapOpening = "开局地图是二维交错六角格地图，共有 01 到 49 列、01 到 34 行，实际可玩的六角格为 1014 个。坐标格式为 CCRR，前两位表示列，后两位表示行；列从西向东增加，行从北向南增加，奇数列和偶数列存在垂直错位。每个格子最多连接六个相邻格，具体连接以 game_overview.initial_map_reference_2d 的完整布局和 connection_rule 为准。坐标布局和格子连接是固定几何信息，不代表当前地形、控制方、单位、补给、ZOC 或雷区；这些信息以当前局面和 view_map 返回结果为准。需要确认局部路线时使用 view_map。初始地图字段中的 layout_rows 是全图坐标布局，key_connections 是关键格的邻接和道路连接。";
  const playerGoalSummary = activeSide === "axis"
    ? scenario === "july"
      ? `你现在扮演 Axis，负责指挥 Axis 阵营完成阿拉曼六角格兵棋对局。${mapOpening}你的任务是在第 ${finalTurn} 回合结束时取得更高的最终 VP。July 初始 VP 是 25。Axis 可以通过三种方式获得 VP：第一，保留初始 VP；第二，每个因战斗、阻断撤退或孤立而被消灭的 Allied 地面作战单位增加 1 VP；第三，让仍有补给或部分补给的 Axis 地面战斗单位进入东部计分前沿，推进分等于最东有效列数减去 34，再乘以 3。第 35 列对应 3 VP，第 36 列对应 6 VP，第 37 列对应 9 VP；只有最东侧的一列计分，同一列中的多个单位不会重复计分。推进单位在移动后必须保持 supplied 或 partially_supplied，否则不能获得推进分。你应优先推进能够安全越过当前计分前沿的部队，同时维持补给、保护突破部队，并在有价值时孤立或消灭 Allied 单位。最终结果在第 ${finalTurn} 回合结束时判定：40 VP 以上为 Axis Marginal，50 VP 以上为 Axis Substantive，60 VP 以上为 Axis Decisive。`
      : `你现在扮演 Axis。你的任务是在第 ${finalTurn} 回合结束时依据当前场景规则取得更高的最终 VP。请先确认当前场景的具体得分条件，再安排推进、补给、战斗和部队保护；每个动作都应服务于可观察的得分机会或必要的战场准备。`
    : scenario === "july"
      ? `你现在扮演 Allies，负责指挥 Allied 阵营完成阿拉曼六角格兵棋对局。${mapOpening}你的任务是在第 ${finalTurn} 回合结束时阻断 Axis 的计分推进，阻止 Axis 获得有效推进计分，并依据场景规则取得更好的最终结果。July 的 Axis 初始 VP 是 25。Axis 会因为三类事件增加 VP：保留初始 VP；每个因战斗、阻断撤退或孤立而被消灭的 Allied 地面作战单位增加 1 VP；以及让仍有补给或部分补给的 Axis 地面战斗单位进入东部计分前沿，进入第 35 列增加 3 VP，第 36 列增加 6 VP，第 37 列增加 9 VP，且只有最东侧的一列计分。你的首要任务是阻止 Axis 跨越当前计分前沿，切断 Axis 补给，使其推进单位失去计分资格；同时避免 Allied 地面作战单位被战斗、阻断撤退或孤立消灭，因为这些损失会直接增加 Axis VP。你还应保持关键防御阵地、保存己方战斗力，并利用 ZOC、地形、雷区和反击拖慢 Axis 推进。最终结果在第 ${finalTurn} 回合结束时判定：Axis 低于 30 VP 时 Allies 获得胜利，30 至 39 VP 为平局，Axis 达到 40 VP 或更高时 Axis 获得不同等级的胜利。`
      : `你现在扮演 Allies。你的任务是在第 ${finalTurn} 回合结束时阻止 Axis 获得有效计分，并依据当前场景规则取得更好的最终结果。请优先阻止场景计分条件、保存 Allied 单位、切断 Axis 补给并拖慢 Axis 的推进。`;
  const turnGoalUpdate = activeSide === "axis"
    ? scenario === "july"
      ? `本回合局面更新：Axis 当前 VP 是 ${victory.current_vp}。当前最远有效计分列是第 ${julyAdvance?.farthest_scoring_column || 34} 列，下一项可争取的计分列是第 ${julyAdvance?.next_scoring_column || 35} 列。让符合补给条件的 Axis 地面战斗单位进入下一项计分列可增加 ${julyAdvance?.vp_gain_for_reaching_next_column || 3} VP；如果移动后失去补给，则不能获得这项推进分。请根据当前局面重新判断本回合最值得推进、补给、攻击或保护的单位。`
      : `本回合局面更新：Axis 当前 VP 是 ${victory.current_vp}。请读取当前场景的 victory.current_scoring，确认本回合仍然有效的得分机会，再决定推进、补给、战斗或保存战力。`
    : scenario === "july"
      ? `本回合局面更新：Axis 当前 VP 是 ${victory.current_vp}。Axis 当前最远有效计分列是第 ${julyAdvance?.farthest_scoring_column || 34} 列，下一项直接得分机会是第 ${julyAdvance?.next_scoring_column || 35} 列，进入下一列且保持补给可能使 Axis 增加 ${julyAdvance?.vp_gain_for_reaching_next_column || 3} VP。请优先判断如何阻止这项推进、切断 Axis 补给或保护 Allied 防线，并检查是否有 Allied 单位面临会给 Axis 增分的消灭风险。`
      : `本回合局面更新：Axis 当前 VP 是 ${victory.current_vp}。请读取当前场景的 victory.current_scoring，确认本回合最需要阻止的得分机会，再决定防守、补给、反击或保存战力。`;
  return {
    title: "阿拉曼六角格兵棋",
    game_type: "回合制、双方对抗、六角格与棋子单位兵棋游戏",
    current_scenario: scenario,
    current_side: activeSide,
    objective: activeSide === "axis"
      ? "依据场景计分规则提高 Axis VP，同时保持补给、保存战斗力并破坏 Allied 防线。"
      : "依据场景计分规则压低 Axis VP，同时阻止推进、保持阵地、保存单位并破坏 Axis 补给。",
    player_goal_summary: playerGoalSummary,
    turn_goal_update: turnGoalUpdate,
    player_goal: playerGoal,
    victory_decision: "胜负由场景最终 VP 和规则引擎的终局判定决定，不由模型自行判断。",
    turn_structure: {
      final_turn: finalTurn,
      sequence: ctx.rules?.turn_sequence || [],
      phase_roles: {
        initial_movement: "移动当前阶段允许行动的己方单位，改善计分位置、补给或战术态势。",
        combat: "使用相邻且符合资格的单位攻击，可以选择部分单位组成联合攻击，也可以 pass。",
        mechanized_movement: "让符合机械化移动条件的单位机动，扩大威胁或利用突破。",
        supply_movement: "移动补给单位，维持前线补给并支持下一阶段行动。",
        end_game_turn: "完成回合结算、补给和终局检查。"
      }
    },
    scoring_rules: scoring.scenario_rules,
    core_rules: [
      "规则引擎是动作合法性、补给、战斗、VP 和终局判定的唯一权威。",
      "单位只能在符合当前阶段条件时移动或攻击，成功行动后通常变为 spent。",
      "敌方占据格不能直接进入；敌方 ZOC、地形、雷区和堆叠会影响移动。",
      "Axis 最多在一个格子堆叠 4 个计数单位，Allies 最多堆叠 3 个。",
      "补给影响移动、战斗、生存和部分场景的计分资格。",
      "没有有效补给路径的单位可能变为 isolated，持续孤立可能被消灭。",
      "所有最终动作都必须通过 act 和本地规则验证。"
    ],
    decision_order: [
      "先确认当前场景的胜利和计分目标。",
      "再确认当前阶段允许的动作和仍可行动的单位。",
      "比较推进、补给、集中、侧翼机动、战斗和保存战力的收益。",
      "不确定地图、路线、补给或赔率时调用对应只读工具。",
      "最后通过 act 提交一个合法动作；接受后立即停止调用工具。"
    ],
    initial_map_reference_2d: options.includeInitialMap === true ? initialMapReference2d(ctx) : undefined,
    information_boundaries: "地图图片不是模型输入；初始移动阶段会提供二维坐标地图参照，其他阶段使用结构化单位、地图、邻接、路线、补给和战斗信息。"
  };
}

function inspectRulesTool(ctx, topic = "overview") {
  const rules = ctx?.rules || {};
  const brief = rulesBrief(rules);
  const selected = String(topic || "overview");
  const sections = {
    overview: {
      game: brief.game,
      turn_sequence: brief.turn_sequence,
      phases: brief.phases,
      current_phase: ctx?.state?.phase || "",
      active_side: ctx?.state?.active_side || ""
    },
    scoring: {
      scenario: ctx?.state?.scenario || "july",
      current: victoryBrief(ctx),
      scoring_rules: scenarioScoringRules(ctx?.state?.scenario || "july", rules.game?.alamein_hex || "3711")
    },
    movement: { movement: brief.movement },
    combat: { combat: brief.combat, mines: brief.mines },
    supply: { supply: brief.supply, isolation: brief.isolation },
    phase: { turn_sequence: brief.turn_sequence, phases: brief.phases },
    stacking: { stacking: brief.stacking }
  };
  if (!Object.hasOwn(sections, selected)) {
    return { ok: false, read_only: true, reason: `unknown rule topic ${selected}`, available_topics: Object.keys(sections) };
  }
  return {
    ok: true,
    read_only: true,
    topic: selected,
    authoritative_source: rules.source?.authoritative_rules || "rules_el_alamein.json",
    ...sections[selected]
  };
}

function scenarioScoringRules(scenario, alamein) {
  const common = [
    "Each Allied ground combat unit eliminated by combat, blocked retreat, or isolation adds 1 Axis VP.",
    "VP is evaluated at End of Game-Turn on the scenario final turn."
  ];
  if (scenario === "july") {
    return {
      common,
      scenario_rules: [
        "Start at 25 VP.",
        "Find the easternmost surviving Axis ground combat unit that is supplied or partially supplied.",
        "Its column scores 3 VP for every column east of column 34: 35xx=3, 36xx=6, 37xx=9, 38xx=12, and so on.",
        "Only the single easternmost eligible column scores; extra units in the same column do not add VP.",
        `Hex ${alamein} has no separate capture bonus in July. Its column 37 matters only through the easternmost-column rule.`,
        "An unsupplied unit does not count for July eastern advance VP."
      ]
    };
  }
  if (scenario === "september") {
    return {
      common,
      scenario_rules: [
        "Start at 30 VP.",
        "Each Allied mine counter cleared by Axis adds 3 VP."
      ]
    };
  }
  if (scenario === "october") {
    return {
      common,
      scenario_rules: [
        "Start at 30 VP.",
        "After Turn 10, each Axis supply unit legally exited through the west edge adds 10 VP.",
        "After Turn 10, each Axis ground combat unit legally exited west adds VP equal to its attack value, or defense value when attack is absent."
      ]
    };
  }
  return { common, scenario_rules: ["Use the authoritative victory breakdown supplied in current_scoring."] };
}

function nextAxisThreshold(currentVp) {
  const thresholds = [
    { vp: 30, level: "Draw" },
    { vp: 40, level: "Axis Marginal" },
    { vp: 50, level: "Axis Substantive" },
    { vp: 60, level: "Axis Decisive" }
  ];
  const next = thresholds.find((item) => currentVp < item.vp) || thresholds.at(-1);
  return { vp: next.vp, level: next.level, vp_needed: Math.max(0, next.vp - currentVp) };
}

function currentScenarioScoring(ctx, victory) {
  const scenario = ctx.state.scenario || "july";
  const breakdown = (victory.breakdown || []).map((item) => ({
    id: item.id,
    points: Number(item.points || 0),
    units: item.units || undefined,
    farthest_column: item.farthest_column || undefined,
    mines: item.mines || undefined
  }));
  const current = {
    total_vp: Number(victory.victory_points || 0),
    current_level: victory.level || "",
    breakdown,
    next_axis_threshold: nextAxisThreshold(Number(victory.victory_points || 0))
  };
  if (scenario === "july") {
    const advance = breakdown.find((item) => item.id === "july_east_of_3400");
    const farthestColumn = Number(advance?.farthest_column || 34);
    const eligible = Object.entries(ctx.state.units || {}).map(([id, unit]) => ({ id, ...unit }))
      .filter((unit) => RulesEngine.isMapCounter(unit)
        && !unit.eliminated
        && unit.side === "axis"
        && (unit.kind || "ground") === "ground"
        && unit.hex
        && ["supplied", "partially_supplied"].includes(supplyStateForAi(ctx, unit.id)))
      .map((unit) => ({ id: unit.id, hex: RulesEngine.normalizeHex(unit.hex), supply: supplyStateForAi(ctx, unit.id) }))
      .sort((left, right) => Number(right.hex.slice(0, 2)) - Number(left.hex.slice(0, 2)) || left.id.localeCompare(right.id));
    const nextColumn = Math.max(35, farthestColumn + 1);
    current.july_advance = {
      scoring_requirement: "surviving Axis ground combat unit with supplied or partially_supplied status",
      farthest_scoring_column: farthestColumn,
      farthest_scoring_units: eligible.filter((unit) => Number(unit.hex.slice(0, 2)) === farthestColumn).slice(0, 8),
      current_advance_vp: Math.max(0, farthestColumn - 34) * 3,
      next_scoring_column: nextColumn,
      next_scoring_hex_pattern: `${String(nextColumn).padStart(2, "0")}xx`,
      vp_gain_for_reaching_next_column: 3,
      warning: `Moving within column ${farthestColumn} or west of it adds 0 immediate advance VP. Multiple units in the same column do not stack VP.`
    };
  }
  return current;
}

function victoryBrief(ctx) {
  const state = ctx.state;
  const rules = ctx.rules;
  const scenario = state.scenario || "july";
  const finalTurn = RulesEngine.scenarioFinalTurn(scenario);
  const alamein = rules.game?.alamein_hex || "3711";
  const victory = RulesEngine.checkVictory(ctx);
  return {
    current_vp: Number(victory.victory_points || 0),
    current_level: victory.level || "",
    final_turn: finalTurn,
    final_check: "Winner is decided at End of Game-Turn on the scenario final turn.",
    vp_scale: ["60+ Axis Decisive", "50-59 Axis Substantive", "40-49 Axis Marginal", "30-39 Draw", "20-29 Allied Marginal", "10-19 Allied Substantive", "0-9 Allied Decisive"],
    scoring_rules: scenarioScoringRules(scenario, alamein),
    current_scoring: currentScenarioScoring(ctx, victory),
    side_goals: {
      axis: scenario === "july"
        ? [`Cross the next eastern scoring column with a supplied or partially supplied Axis ground combat unit; merely moving closer to ${alamein} does not score.`, "Destroy or isolate Allied ground combat units while preserving Axis supply." ]
        : [`Increase VP according to scoring_rules while pressuring ${alamein}.`, "Destroy Allied combat units, isolate them, and preserve Axis supply."],
      allies: [`Deny Axis VP, hold or contest ${alamein}, preserve units, and keep supply open.`, "Use terrain, mines, ZOC, and counterattacks to slow Axis tempo."]
    }
  };
}

function scenarioObjectives(ctx, victory) {
  const alamein = ctx.rules.game?.alamein_hex || "3711";
  if (ctx.state.scenario === "july") {
    const advance = victory.current_scoring?.july_advance || {};
    return {
      axis_primary: `Establish a supplied or partially supplied Axis ground combat unit in column ${advance.next_scoring_column || 35}xx`,
      axis_primary_type: "eastern_scoring_frontier",
      axis_next_scoring_column: Number(advance.next_scoring_column || 35),
      axis_vp_gain_at_next_column: Number(advance.vp_gain_for_reaching_next_column || 3),
      allies_primary: `Prevent a supplied Axis ground combat unit from crossing column ${advance.next_scoring_column || 35}xx`,
      alamein,
      alamein_role: "Important terrain landmark, but it has no separate July capture bonus."
    };
  }
  return {
    axis_primary: alamein,
    allies_primary: alamein,
    alamein,
    alamein_role: "Scenario landmark and operational objective."
  };
}

function initialMapReference2d(ctx) {
  const hexes = [];
  for (let column = 1; column <= 50; column += 1) {
    for (let row = 1; row <= 50; row += 1) {
      const hex = `${String(column).padStart(2, "0")}${String(row).padStart(2, "0")}`;
      if (RulesEngine.onMap(hex)) hexes.push(hex);
    }
  }
  const byRow = new Map();
  for (const hex of hexes) {
    const row = Number(hex.slice(2, 4));
    byRow.set(row, [...(byRow.get(row) || []), hex]);
  }
  const layoutRows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([row, values]) => ({
    row,
    hexes: values.sort((a, b) => Number(a.slice(0, 2)) - Number(b.slice(0, 2)))
  }));
  const keyHexes = new Set([
    "3208",
    ctx.rules.game?.alamein_hex,
    ...(ctx.rules.game?.axis_supply_sources || []),
    ...(ctx.rules.game?.allies_supply_sources || []),
    ...Object.values(ctx.state.units || {})
      .filter((unit) => RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
      .map((unit) => unit.hex)
  ].filter(Boolean).map((hex) => {
    try { return RulesEngine.normalizeHex(hex); }
    catch { return ""; }
  }).filter(Boolean));
  return {
    format: "staggered_hex_coordinate_map",
    purpose: "Opening two-dimensional coordinate reference. Use view_map for the latest local state and exact route validation.",
    orientation: "Columns increase from west to east; rows increase from north to south; odd-numbered columns and even-numbered columns are vertically offset.",
    coordinate_format: "CCRR: first two digits are the column, last two digits are the row.",
    connection_rule: {
      odd_column_offsets: [[0, -1], [1, -1], [1, 0], [0, 1], [-1, 0], [-1, -1]],
      even_column_offsets: [[0, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]],
      note: "A connection exists only when the resulting coordinate is on the playable map. The rule engine is authoritative."
    },
    layout_rows: layoutRows,
    key_connections: [...keyHexes].slice(0, 40).map((hex) => ({
      hex,
      neighbors: RulesEngine.neighbors(hex),
      road_neighbors: RulesEngine.neighbors(hex).filter((neighbor) => RulesEngine.edgeTags(ctx, RulesEngine.normalizeEdge(hex, neighbor)).includes("road"))
    })),
    full_local_connections: "Call view_map with focus=region and a center hex when a maneuver depends on exact nearby geometry."
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
    road_neighbors: RulesEngine.neighbors(normalized).filter((nb) => RulesEngine.edgeTags(ctx, RulesEngine.normalizeEdge(normalized, nb)).includes("road")),
    neighbors: RulesEngine.neighbors(normalized)
  };
}

function mapHexState(ctx, hex, side = ctx.state.active_side) {
  const normalized = RulesEngine.normalizeHex(hex);
  const byHex = RulesEngine.unitsByHex(ctx);
  const units = (byHex[normalized] || []).filter((unit) => !unit.eliminated);
  const neighbors = RulesEngine.neighbors(normalized);
  return {
    hex: normalized,
    terrain: RulesEngine.hexTags(ctx, normalized),
    map_area: mapArea(ctx, normalized),
    control: ctx.state.control?.[normalized] || "",
    units: units.map((unit) => ({ id: unit.id, side: unit.side, kind: unit.kind || "ground" })),
    mines: RulesEngine.minesAt(ctx, normalized).map((mine) => ({ id: mine.id, side: mine.side })),
    zoc: {
      enemy_sources: [...RulesEngine.enemyZocSources(ctx, side, normalized)],
      friendly_sources: [...RulesEngine.enemyZocSources(ctx, side === "axis" ? "allies" : "axis", normalized)]
    },
    neighbors,
    road_neighbors: neighbors.filter((neighbor) => RulesEngine.edgeTags(ctx, RulesEngine.normalizeEdge(normalized, neighbor)).includes("road"))
  };
}

function mapRegionHexes(ctx, center, radius = 2) {
  const origin = RulesEngine.normalizeHex(center);
  const result = new Set([origin]);
  let frontier = [origin];
  for (let depth = 0; depth < Math.max(0, Number(radius)); depth += 1) {
    const next = [];
    for (const hex of frontier) {
      for (const neighbor of RulesEngine.neighbors(hex)) {
        if (!result.has(neighbor)) {
          result.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return [...result];
}

function renderConnectionMap(ctx, hexes) {
  const region = new Set(hexes);
  const edges = [];
  const seen = new Set();
  for (const hex of hexes) {
    for (const neighbor of RulesEngine.neighbors(hex)) {
      if (!region.has(neighbor)) continue;
      const edge = RulesEngine.normalizeEdge(hex, neighbor);
      if (seen.has(edge)) continue;
      seen.add(edge);
      edges.push(edge.replace("-", " -- "));
    }
  }
  return edges;
}

function mapTopologySummary(ctx) {
  const hexes = [];
  for (let column = 1; column <= 50; column += 1) {
    for (let row = 1; row <= 50; row += 1) {
      const hex = `${String(column).padStart(2, "0")}${String(row).padStart(2, "0")}`;
      if (RulesEngine.onMap(hex)) hexes.push(hex);
    }
  }
  const edges = new Set();
  let roadEdges = 0;
  for (const hex of hexes) {
    for (const neighbor of RulesEngine.neighbors(hex)) {
      const edge = RulesEngine.normalizeEdge(hex, neighbor);
      if (edges.has(edge)) continue;
      edges.add(edge);
      if (RulesEngine.edgeTags(ctx, edge).includes("road")) roadEdges += 1;
    }
  }
  const columns = [...new Set(hexes.map((hex) => Number(hex.slice(0, 2))))];
  const rows = [...new Set(hexes.map((hex) => Number(hex.slice(2, 4))))];
  return {
    authority: "RulesEngine.neighbors and RulesEngine.onMap",
    hex_count: hexes.length,
    column_range: [Math.min(...columns), Math.max(...columns)],
    row_range: [Math.min(...rows), Math.max(...rows)],
    connection_count: edges.size,
    road_connection_count: roadEdges,
    full_hex_details_available_via: "view_map focus=region or focus=hex",
    full_map_details_not_included_in_every_step: true
  };
}

function topologyPath(ctx, unit, target, options = {}, excludedFirstSteps = new Set()) {
  const start = RulesEngine.normalizeHex(unit.hex);
  const destination = RulesEngine.normalizeHex(target);
  const queue = [{ hex: start, path: [start] }];
  const visited = new Set([start]);
  while (queue.length) {
    const current = queue.shift();
    for (const neighbor of RulesEngine.neighbors(current.hex)) {
      if (current.path.length === 1 && excludedFirstSteps.has(neighbor)) continue;
      if (visited.has(neighbor)) continue;
      const neighborMines = RulesEngine.minesAt(ctx, neighbor).some((mine) => mine.side !== unit.side && !mine.cleared);
      const enemyZoc = RulesEngine.enemyZocSources(ctx, unit.side, neighbor).size > 0;
      if (options.avoid_minefield && neighborMines) continue;
      if (options.avoid_enemy_zoc && enemyZoc) continue;
      visited.add(neighbor);
      const path = [...current.path, neighbor];
      if (neighbor === destination) return path;
      queue.push({ hex: neighbor, path });
    }
  }
  return null;
}

function planRouteTool(ctx, args = {}) {
  const unitId = String(args.unit || "");
  const unit = ctx.state.units?.[unitId];
  if (!unit || unit.eliminated || !unit.hex) return { legal: false, read_only: true, reason: `unknown or off-map unit ${unitId}` };
  let target;
  try { target = RulesEngine.normalizeHex(args.target); }
  catch (error) { return { legal: false, read_only: true, reason: error.message }; }
  if (target === RulesEngine.normalizeHex(unit.hex)) return { legal: false, read_only: true, reason: "unit is already at target" };
  const options = {
    mode: args.mode || "normal",
    avoid_enemy_zoc: args.avoid_enemy_zoc !== false,
    avoid_minefield: args.avoid_minefield !== false
  };
  const routes = [];
  const addRoute = (path, source, extra = {}) => {
    if (!path || path.length < 2) return;
    const key = path.join(">>");
    if (routes.some((route) => route.path.join(">>") === key)) return;
    const destinationState = mapHexState(ctx, path.at(-1), unit.side);
    const projectedSupply = supplyStateForAi(ctx, unitId);
    const risks = [];
    if (destinationState.zoc.enemy_sources.length) risks.push("enemy_zoc");
    if (destinationState.mines.some((mine) => mine.side !== unit.side)) risks.push("enemy_minefield");
    if (projectedSupply === "isolated") risks.push("current_supply_isolated");
    routes.push({
      path,
      source,
      steps: path.length - 1,
      current_phase_legal: source === "rules_engine_current_phase",
      supply_status: projectedSupply,
      risks,
      ...extra
    });
  };
  const legalPath = RulesEngine.findLegalPath(ctx, unitId, target, { mode: options.mode });
  addRoute(legalPath, "rules_engine_current_phase");
  const excluded = new Set(routes.map((route) => route.path[1]).filter(Boolean));
  for (let index = 0; index < Number(args.max_routes || 3) - 1; index += 1) {
    addRoute(topologyPath(ctx, unit, target, options, excluded), "topology_preview", {
      current_phase_legal: false,
      reason: "route reaches beyond current movement allowance or needs later phases"
    });
    const route = routes.at(-1);
    if (route?.path[1]) excluded.add(route.path[1]);
  }
  if (!routes.length) {
    const preview = topologyPath(ctx, unit, target, { ...options, avoid_enemy_zoc: false, avoid_minefield: false });
    if (preview) addRoute(preview, "topology_preview", { reason: "only route ignores one or more requested constraints" });
  }
  return {
    legal: routes.some((route) => route.current_phase_legal),
    read_only: true,
    unit: unitId,
    from: RulesEngine.normalizeHex(unit.hex),
    target,
    constraints: options,
    routes: routes.slice(0, Number(args.max_routes || 3)),
    recommendation: routes[0] || null,
    explanation: routes.some((route) => route.current_phase_legal)
      ? "The first route is legal in the current phase."
      : routes.length
        ? "No complete route is legal in the current phase; use the preview as a multi-phase direction and query again after the next phase."
        : "No route satisfies the requested constraints."
  };
}

function evaluateManeuverTool(ctx, args = {}) {
  const maneuver = args.maneuver || args.groups || {};
  const groups = Object.entries(maneuver).map(([name, value]) => ({
    name,
    units: Array.isArray(value?.units) ? value.units : [],
    target_hex: value?.target_hex || value?.target || ""
  })).filter((group) => group.units.length && group.target_hex);
  const groupReports = groups.map((group) => {
    const target = RulesEngine.normalizeHex(group.target_hex);
    const units = group.units.map((unitId) => {
      const unit = ctx.state.units?.[unitId];
      if (!unit || unit.side !== ctx.state.active_side || unit.eliminated || !unit.hex) {
        return { unit: unitId, valid: false, reason: "unit is unavailable to active side" };
      }
      const route = planRouteTool(ctx, { unit: unitId, target, max_routes: 1, avoid_enemy_zoc: true, avoid_minefield: true });
      const current = RulesEngine.normalizeHex(unit.hex);
      const contact = current === target || RulesEngine.neighbors(current).includes(target);
      return {
        unit: unitId,
        valid: true,
        current_hex: current,
        target_hex: target,
        at_target: current === target,
        in_contact: contact,
        supply: supplyStateForAi(ctx, unitId),
        route: route.recommendation,
        route_available: Boolean(route.routes?.length)
      };
    });
    return {
      name: group.name,
      target_hex: target,
      units,
      ready: units.length > 0 && units.every((unit) => unit.valid && unit.in_contact),
      supplied: units.filter((unit) => unit.valid).every((unit) => ["supplied", "partially_supplied", "partial"].includes(unit.supply))
    };
  });
  let attackTarget = "";
  try { attackTarget = args.attack_target ? RulesEngine.normalizeHex(args.attack_target) : ""; } catch {}
  const activeUnits = groupReports.flatMap((group) => group.units.filter((unit) => unit.valid && unit.in_contact));
  const attackers = attackTarget
    ? activeUnits.filter((unit) => RulesEngine.neighbors(unit.current_hex).includes(attackTarget)).map((unit) => unit.unit)
    : [];
  const escapeRoutes = attackTarget
    ? RulesEngine.neighbors(attackTarget).filter((hex) => !RulesEngine.enemyZocSources(ctx, ctx.state.active_side, hex).size).length
    : null;
  const missing = [];
  if (groupReports.some((group) => !group.ready)) missing.push("all maneuver groups must reach their assigned contact positions");
  if (groupReports.some((group) => !group.supplied)) missing.push("all maneuver groups must preserve supply");
  if (attackTarget && attackers.length < 2) missing.push("at least two eligible attackers must contact the attack target");
  if (attackTarget && escapeRoutes > 0) missing.push(`${escapeRoutes} target escape route(s) remain open`);
  const complete = groups.length >= 2 && missing.length === 0;
  return {
    legal: true,
    read_only: true,
    maneuver_status: complete ? "complete" : groupReports.some((group) => group.ready) ? "partial" : "not_ready",
    groups: groupReports,
    attack_target: attackTarget,
    eligible_attackers: attackers,
    escape_routes_remaining: escapeRoutes,
    conditions: {
      groups_in_position: groupReports.length > 0 && groupReports.every((group) => group.ready),
      supply_preserved: groupReports.every((group) => group.supplied),
      joint_attack_available: attackers.length >= 2,
      escape_routes_closed: attackTarget ? escapeRoutes === 0 : false
    },
    missing_conditions: missing,
    recommendation: complete ? "confirm the joint attack with check_combat, then call act" : (missing[0] || "continue the maneuver")
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
  if (!best) {
    const alternatives = legalMoveAlternatives(ctx, unitId, target);
    return {
      legal: false,
      reason: `no legal path found for ${unitId} to ${target}`,
      action: intent,
      alternatives,
      recommended_recovery: alternatives.length ? "choose_one_of_the_legal_alternatives" : "replan_operation"
    };
  }
  return {
    legal: true,
    reason: `planned ${best.action.mode} path for move_intent`,
    action: best.action,
    planned_from_intent: { unit: unitId, destination: target, requested_mode: intent.mode || "auto" },
    verdict: best.verdict,
    plan_score: best.score
  };
}

function legalMoveAlternatives(ctx, unitId, rejectedTarget) {
  const unit = ctx.state.units?.[unitId];
  if (!unit) return [];
  const allUnits = Object.entries(ctx.state.units || {}).map(([id, value]) => ({ id, ...value }));
  const reachable = RulesEngine.reachableHexes(ctx, unitId, { mode: "normal", maxHexes: 120 });
  return [...reachable.entries()]
    .filter(([hex, item]) => hex !== unit.hex && item.path?.length > 1)
    .map(([hex, item]) => {
      const action = { type: "move", unit: unitId, path: item.path, mode: "normal", destination: hex, spent: item.cost };
      const postMoveSupply = projectedSupplyAfterMove(ctx, action);
      const frontier = scoringFrontier(ctx);
      const column = hexColumn(hex);
      return {
        destination: hex,
        path: item.path,
        projected_supply: postMoveSupply,
        crosses_frontier: frontier.type === "scoring_frontier" && column >= frontier.next_value,
        estimated_vp_delta: frontier.type === "scoring_frontier" && column > frontier.current_value
          && ["supplied", "partially_supplied"].includes(postMoveSupply) ? (column - frontier.current_value) * frontier.gain : 0,
        score: movementActionScore(ctx, action, allUnits)
      };
    })
    .sort((left, right) => Number(right.crosses_frontier) - Number(left.crosses_frontier)
      || right.estimated_vp_delta - left.estimated_vp_delta
      || right.score - left.score)
    .slice(0, 5)
    .map((item) => ({ ...item, rejected_target: rejectedTarget }));
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
  add(alamein, "operational landmark");
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

function crtColumn(ctx, column, defenderHexes = []) {
  const columns = ctx.rules.combat?.odds_columns || [];
  const index = columns.indexOf(column);
  const result = {};
  const ruggedDefense = defenderHexes.some((hex) => RulesEngine.hexTags(ctx, hex).includes("hill_or_ridge"));
  for (const die of [1, 2, 3, 4, 5, 6]) {
    const raw = index >= 0 ? ctx.rules.combat?.crt?.[String(die)]?.[index] || null : null;
    result[String(die)] = ruggedDefense && /^D[123]$/.test(raw || "") ? "No Effect" : raw;
  }
  return result;
}

function combatVerdictTool(ctx, args = {}) {
  try {
    const action = {
      attackers: args.attackers || [],
      defender_hexes: (args.defender_hexes || []).map((hex) => RulesEngine.normalizeHex(hex))
    };
    const verdict = RulesEngine.checkCombat(ctx, action);
    if (!verdict.legal) return verdict;
    return {
      ...verdict,
      details: {
        ...(verdict.details || {}),
        crt_column: crtColumn(ctx, verdict.details?.odds_column, verdict.details?.defender_hexes || [])
      }
    };
  }
  catch (error) {
    return { legal: false, reason: error.message };
  }
}

function terrainDefenseBonusFromTags(tags = []) {
  if (tags.includes("alamein_box")) return 3;
  return 0;
}

function terrainDefenseMultiplierFromTags(tags = []) {
  return tags.includes("hill_or_ridge") ? 2 : 1;
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
      terrain_defense_multiplier: terrainDefenseMultiplierFromTags(terrainTags),
      rugged_defense_cancels_retreat: terrainTags.includes("hill_or_ridge"),
      is_primary_objective: hex === alamein,
      retreat_options_estimate: defenders.reduce((sum, defender) => {
        const unit = ctx.state.units[defender.id];
        if (!unit) return sum;
        return sum + RulesEngine.neighbors(hex).filter((nb) => RulesEngine.legalRetreatHex(ctx, { ...unit, id: defender.id }, nb, attackerSide)).length;
      }, 0)
    };
  });
}

function alliedCombatDefensiveEffect(ctx, action, currentFarthestColumn) {
  if (ctx?.state?.active_side !== "allies" || action?.type !== "combat") return null;
  const targets = (action.defender_hexes || []).map((rawHex) => RulesEngine.normalizeHex(rawHex));
  const byHex = RulesEngine.unitsByHex(ctx);
  const defenders = targets.flatMap((hex) => (byHex[hex] || [])
    .filter((unit) => unit.side === "axis" && RulesEngine.isCombatUnit(unit) && !unit.eliminated));
  const frontierDefenders = defenders.filter((unit) =>
    Number(String(unit.hex || "").slice(0, 2)) >= Number(currentFarthestColumn || 34));
  const suppliedFrontierDefenders = frontierDefenders.filter((unit) =>
    ["supplied", "partially_supplied", "partial"].includes(supplyStateForAi(ctx, unit.id)));
  return {
    target_hexes: targets,
    axis_defenders: defenders.map((unit) => unit.id),
    frontier_defenders: frontierDefenders.map((unit) => unit.id),
    supplied_frontier_defenders: suppliedFrontierDefenders.map((unit) => unit.id),
    immediate_axis_frontier_threat: suppliedFrontierDefenders.length > 0,
    explanation: suppliedFrontierDefenders.length
      ? "Target contains a supplied or partially supplied Axis unit at the current scoring frontier."
      : "Target does not contain a supplied Axis unit at the current scoring frontier."
  };
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
    current_level: victory.level || "",
    self_vp_delta: 0,
    opponent_vp_delta: 0,
    axis_scoring_threat_delta: 0,
    supply_risk_delta: 0,
    force_preservation_risk: "none"
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
    const postMoveSupply = unit && RulesEngine.isPlayableSide(unit.side) ? projectedSupplyAfterMove(ctx, action) : "";
    const scenario = ctx.state.scenario || "july";
    const currentAdvance = victory.breakdown?.find((item) => item.id === "july_east_of_3400");
    const currentFarthestColumn = Number(currentAdvance?.farthest_column || 34);
    const destinationColumn = Number(destination.slice(0, 2) || 0);
    const scoringSupply = ["supplied", "partially_supplied"].includes(postMoveSupply);
    const estimatedJulyVpDelta = scenario === "july" && unit?.side === "axis" && (unit?.kind || "ground") === "ground" && scoringSupply && destinationColumn > currentFarthestColumn
      ? (destinationColumn - currentFarthestColumn) * 3
      : 0;
    const selfVpDelta = unit?.side === "axis" ? estimatedJulyVpDelta : 0;
    const opponentVpDelta = 0;
    const defensiveImpact = scenario === "july"
      ? alliedDefensiveImpactAfterMove(ctx, action, currentFarthestColumn)
      : { axis_scoring_threat_delta: 0, evidence: [] };
    const alliedDenialMove = unit?.side === "allies" && defensiveImpact.axis_scoring_threat_delta < 0;
    return {
      ...base,
      summary: estimatedJulyVpDelta > 0
        ? `Move could increase July eastern advance score by ${estimatedJulyVpDelta} VP if the unit remains supplied or partially supplied after moving.`
        : alliedDenialMove
          ? `Move does not directly change VP; verified defensive effect: ${defensiveImpact.evidence.join("; ")}.`
        : scenario === "july" && destinationColumn > currentFarthestColumn
          ? unit?.side === "axis"
            ? "Move improves the Axis scoring frontier position but does not add immediate VP under the current supply projection."
            : "Allied eastward movement does not earn July advance VP; assess only blocking, supply, survival, or threat reduction."
        : scenario === "july"
          ? "Move stays at or west of the current scoring frontier; it needs a supply, ZOC, stacking, or tactical benefit to justify the tempo."
        : destination === alamein
          ? "Move reaches the scenario operational landmark. Apply the authoritative scenario scoring rules before treating it as a primary objective."
        : before != null && after != null && after < before
          ? "Move improves position toward the scenario operational landmark but does not create immediate VP."
          : "Move has no immediate primary-objective gain.",
      vp_relevance: estimatedJulyVpDelta > 0
        ? "direct"
        : alliedDenialMove
          ? "scoring_denial_setup"
        : scenario === "july" && destinationColumn > currentFarthestColumn
          ? unit?.side === "axis" ? "frontier_setup" : "low_direct"
          : scenario === "july"
            ? "low_direct"
            : destination === alamein
              ? "primary_objective"
              : before != null && after != null && after < before ? "positional_progress" : "low_direct",
      estimated_vp_delta: estimatedJulyVpDelta,
      self_vp_delta: selfVpDelta,
      opponent_vp_delta: opponentVpDelta,
      axis_scoring_threat_delta: unit?.side === "allies" ? defensiveImpact.axis_scoring_threat_delta : estimatedJulyVpDelta,
      axis_scoring_threat_evidence: unit?.side === "allies" ? defensiveImpact.evidence : [],
      newly_pinned_axis_units: unit?.side === "allies" ? defensiveImpact.newly_pinned_axis_units || [] : [],
      released_axis_frontier_units: unit?.side === "allies" ? defensiveImpact.released_axis_frontier_units || [] : [],
      defensive_line_coverage_delta: unit?.side === "allies" ? Number(defensiveImpact.defensive_line_coverage_delta || 0) : 0,
      blocks_next_scoring_entry: unit?.side === "allies" ? !!defensiveImpact.blocks_next_scoring_entry : false,
      axis_supply_coverage_delta: unit?.side === "allies" ? Number(defensiveImpact.axis_supply_coverage_delta || 0) : 0,
      supply_risk_delta: supplyRank(postMoveSupply) - supplyRank(supplied),
      force_preservation_risk: unit?.side === "allies" && !scoringSupply ? "requires_survival_review" : "none",
      scoring_condition: scenario === "july" ? "only an Axis ground combat unit with supplied or partially_supplied status earns July eastern advance VP" : "scenario-specific",
      current_farthest_scoring_column: scenario === "july" ? currentFarthestColumn : null,
      destination_column: destinationColumn,
      crosses_new_scoring_column: estimatedJulyVpDelta > 0,
      objective_hex: scenario === "july" ? null : alamein,
      distance_to_objective_before: scenario === "july" ? null : before,
      distance_to_objective_after: scenario === "july" ? null : after,
      distance_to_scoring_frontier_before: scenario === "july" && unit?.side === "axis" ? Math.max(0, currentFarthestColumn + 1 - Number(start.slice(0, 2) || 0)) : null,
      distance_to_scoring_frontier_after: scenario === "july" && unit?.side === "axis" ? Math.max(0, currentFarthestColumn + 1 - destinationColumn) : null,
      destination_is_primary_objective: scenario === "july"
        ? unit?.side === "axis" ? destinationColumn > currentFarthestColumn : alliedDenialMove
        : destination === alamein,
      unit_supply_before_move: supplied,
      projected_supply_after_move: postMoveSupply,
      supply_coverage: projectedSupplyCoverageAfterMove(ctx, action),
      maintains_july_scoring_supply: scenario === "july" ? scoringSupply : null
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
      defensive_effect: alliedCombatDefensiveEffect(
        ctx,
        action,
        Number(ctx.ai_victory_impact_cache?.breakdown?.find((item) => item.id === "july_east_of_3400")?.farthest_column || 34)
      ),
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
  const single = allUnits
    .filter((unit) => unit.side === side && RulesEngine.canAttackUnit(unit) && unit.hex && unit.state === "fresh" && !unit.attacked_this_turn)
    .flatMap((unit) => {
      const defenderHexes = RulesEngine.neighbors(unit.hex)
        .filter((hex) => (unitsByHex[hex] || []).some((enemy) => enemy.side !== side && RulesEngine.isCombatUnit(enemy)))
        .sort();
      if (!defenderHexes.length) return [];
      const action = { type: "combat", attackers: [unit.id], defender_hexes: defenderHexes };
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
            crt_column: crtColumn(ctx, verdict.details?.odds_column, action.defender_hexes || [])
          }
        }
      };
      return [{ score: combatActionScore(withVerdict), action: withVerdict, evaluation: actionEvaluation(ctx, withVerdict, allUnits) }];
    })
    .sort((a, b) => b.score - a.score);
  const combined = [...new Set(allUnits
    .filter((unit) => unit.side === side && RulesEngine.canAttackUnit(unit) && unit.hex && unit.state === "fresh" && !unit.attacked_this_turn)
    .flatMap((unit) => RulesEngine.neighbors(unit.hex)))]
    .flatMap((hex) => {
      const defenders = (unitsByHex[hex] || []).filter((unit) => unit.side !== side && RulesEngine.isCombatUnit(unit));
      if (!defenders.length) return [];
      const attackers = allUnits
        .filter((unit) => unit.side === side && unit.state === "fresh" && RulesEngine.canAttackUnit(unit) && unit.hex && RulesEngine.neighbors(unit.hex).includes(hex))
        .map((unit) => unit.id)
        .sort();
      if (attackers.length < 2) return [];
      const action = { type: "combat", attackers, defender_hexes: [hex] };
      const verdict = RulesEngine.checkCombat(ctx, action);
      if (!verdict.legal) return [];
      const withVerdict = { ...action, verdict: { ...verdict, details: { ...(verdict.details || {}), crt_column: crtColumn(ctx, verdict.details?.odds_column, [hex]) } } };
      return [{ score: combatActionScore(withVerdict), action: withVerdict, evaluation: actionEvaluation(ctx, withVerdict, allUnits) }];
    });
  return [...single, ...combined]
    .sort((a, b) => b.score - a.score)
    .filter((item, index, list) => index === list.findIndex((other) => sameProbeAction(item.action, other.action)));
}

function exitWestCandidates(ctx, allUnits) {
  const state = ctx.state;
  if (state.scenario !== "october" || state.active_side !== "axis" || Number(state.turn || 1) <= 10) return [];
  if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind(state.phase))) return [];
  return allUnits
    .filter((unit) => {
      if (unit.side !== "axis" || !unit.hex) return false;
      if (!(RulesEngine.isCombatUnit(unit) || RulesEngine.isSupplyUnit(unit))) return false;
      try { return RulesEngine.splitHex(unit.hex)[0] === 1; }
      catch { return false; }
    })
    .map((unit) => {
      const action = { type: "exit_west", unit: unit.id };
      return {
        score: 150 + Number(unit.attack || unit.defense || 0),
        action,
        evaluation: actionEvaluation(ctx, action, allUnits)
      };
    });
}

function candidateSector(ctx, action) {
  const hex = action.destination || action.path?.at(-1) || action.defender_hexes?.[0] || "";
  const areas = hex ? mapArea(ctx, hex) : [];
  if (areas.some((area) => area.includes("northern"))) return "north";
  if (areas.some((area) => area.includes("southern"))) return "south";
  return "central";
}

function candidateUnitIds(action = {}) {
  return action.type === "combat" ? action.attackers || [] : [action.unit].filter(Boolean);
}

function candidateTarget(action = {}) {
  return action.destination || action.path?.at(-1) || action.defender_hexes?.[0] || "";
}

function candidateMatchesIntent(ctx, item, intent) {
  const action = item.action || {};
  const unitIds = candidateUnitIds(action);
  const target = candidateTarget(action);
  if (intent.sector && candidateSector(ctx, action) !== intent.sector) return false;
  if (intent.target_hex && target !== intent.target_hex) return false;
  if (intent.priority_units.length && !intent.priority_units.some((id) => unitIds.includes(id))) return false;
  if (intent.type === "attack_pressure") return action.type === "combat";
  if (intent.type === "extend_supply" || intent.type === "supply") {
    return action.type === "move" && unitIds.some((id) => RulesEngine.isSupplyUnit({ id, ...(ctx.state.units[id] || {}) }));
  }
  if (intent.type === "pressure") {
    return action.type === "combat" || item.evaluation?.tactical_tags?.includes("contact") || item.evaluation?.victory_impact?.vp_relevance === "positional_progress";
  }
  if (intent.type === "consolidate" || intent.type === "protect_supply") {
    return action.type === "move" && (item.evaluation?.risks || []).length === 0;
  }
  return action.type === "move" || action.type === "combat" || action.type === "exit_west";
}

function isConservativeCandidate(item) {
  const action = item.action || {};
  if (action.type === "move") return (item.evaluation?.risks || []).length === 0;
  if (action.type === "combat") return Number(item.evaluation?.outcome_faces?.attacker_harm || 99) <= 1;
  return false;
}

function combatOddsIndex(value) {
  return ["1-4", "1-3", "1-2", "1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"].indexOf(String(value || ""));
}

function friendlyDestinationCount(ctx, action) {
  if (action?.type !== "move") return 0;
  const unit = ctx.state.units?.[action.unit];
  const destination = RulesEngine.normalizeHex(action.destination || action.path?.at(-1) || unit?.hex || "");
  if (!unit || !destination) return 0;
  return (RulesEngine.unitsByHex(ctx)[destination] || [])
    .filter((other) => other.side === unit.side && other.id !== action.unit && !other.eliminated)
    .length;
}

function opportunityAssessment(ctx, item, intent, config) {
  const action = item.action || {};
  const evaluation = item.evaluation || {};
  const settings = config.context?.opportunityAware || {};
  const reasons = [];
  const penalties = [];
  const bonuses = [];
  let adjustment = 0;
  let rejected = false;

  if (action.type === "combat") {
    const expected = Number(evaluation.expected_crt_score || 0);
    const stats = evaluation.outcome_faces || {};
    const primaryObjective = evaluation.victory_impact?.vp_relevance === "primary_objective";
    const minimumIndex = combatOddsIndex(settings.minimumCombatOdds || "2-1");
    const oddsIndex = combatOddsIndex(evaluation.odds_column);
    const belowMinimum = oddsIndex >= 0 && minimumIndex >= 0 && oddsIndex < minimumIndex;
    const allBad = Number(stats.defender_harm || 0) === 0 && Number(stats.attacker_harm || 0) > 0;
    if (allBad) {
      rejected = true;
      reasons.push("combat has no defender-harm outcome and exposes the attacker to harm");
    }
    if (belowMinimum) {
      adjustment -= 55;
      penalties.push(`combat odds ${evaluation.odds_column} are below ${settings.minimumCombatOdds || "2-1"}`);
    }
    if (expected < 0) {
      adjustment += expected * 18;
      penalties.push(`negative expected CRT score ${expected}`);
      if (settings.rejectNegativeExpectedCombat !== false
        && (!primaryObjective || settings.allowNegativeExpectedPrimaryObjective !== true)) {
        rejected = true;
        reasons.push("negative expected combat is not an allowed tactical opportunity");
      }
    }
    else {
      adjustment += expected * 16;
      bonuses.push(`non-negative expected CRT score ${expected}`);
    }
    if (primaryObjective) {
      adjustment += Number(settings.primaryObjectiveBonus || 70);
      bonuses.push("targets the primary objective");
    }
  }

  if (action.type === "move") {
    const progress = Number(evaluation.progress || 0);
    const mineCount = (evaluation.enemy_mines || []).length;
    const zocCount = (evaluation.enemy_zoc_sources || []).length;
    const crowding = friendlyDestinationCount(ctx, action);
    const unit = ctx.state.units?.[action.unit] || {};
    const supplyIntent = ["supply", "extend_supply", "protect_supply"].includes(intent.type);
    if (progress > 0) {
      adjustment += Math.min(progress, 6) * 12;
      bonuses.push(`advances ${progress} hex-distance toward its operational target`);
    }
    else if (!supplyIntent && intent.type !== "consolidate") {
      adjustment -= Number(settings.noProgressPenalty || 16);
      penalties.push("does not advance the current operational target");
    }
    if (mineCount) {
      const engineer = RulesEngine.isEngineer({ id: action.unit, ...unit });
      const penalty = Number(settings.mineRiskPenalty || 45) * mineCount * (engineer ? 0.35 : 1);
      adjustment -= penalty;
      penalties.push(`destination contains ${mineCount} enemy minefield${engineer ? " (engineer discount)" : ""}`);
    }
    if (zocCount) {
      adjustment -= Number(settings.enemyZocPenalty || 14) * zocCount;
      penalties.push(`destination is in enemy ZOC from ${zocCount} source(s)`);
    }
    if (crowding) {
      adjustment -= Number(settings.friendlyCrowdingPenalty || 18) * crowding;
      penalties.push(`destination already contains ${crowding} friendly unit(s)`);
    }
    if (supplyIntent && RulesEngine.isSupplyUnit({ id: action.unit, ...unit }) && progress > 0) {
      adjustment += Number(settings.supplyImprovementBonus || 24);
      bonuses.push("moves a supply unit toward its operational target");
    }
    if (evaluation.victory_impact?.vp_relevance === "primary_objective") {
      adjustment += Number(settings.primaryObjectiveBonus || 70);
      bonuses.push("reaches the primary objective");
    }
    const estimatedVpDelta = Number(evaluation.victory_impact?.estimated_vp_delta || 0);
    if (estimatedVpDelta > 0) {
      adjustment += estimatedVpDelta * 24;
      bonuses.push(`could add ${estimatedVpDelta} July eastern-advance VP`);
    }
    else if (ctx.state.scenario === "july"
      && unit.side === "axis"
      && ["supplied", "partially_supplied"].includes(evaluation.victory_impact?.unit_supply_before_move)
      && !evaluation.victory_impact?.maintains_july_scoring_supply) {
      adjustment -= 120;
      penalties.push(`projected post-move supply is ${evaluation.victory_impact?.projected_supply_after_move || "not scoring-eligible"}`);
    }
    else if (ctx.state.scenario === "july"
      && unit.side === "axis"
      && !RulesEngine.isSupplyUnit({ id: action.unit, ...unit })
      && Number(evaluation.victory_impact?.destination_column || 0) <= Number(evaluation.victory_impact?.current_farthest_scoring_column || 34)) {
      adjustment -= 24;
      penalties.push("does not cross the current July scoring frontier");
    }
  }

  return {
    rejected,
    reasons,
    bonuses,
    penalties,
    adjustment: Number(adjustment.toFixed(2)),
    score: Number((Number(item.intent_score ?? item.score ?? 0) + adjustment).toFixed(2))
  };
}

function selectOpportunityAwareCandidates(ctx, allUnits, pool, intent, config, limit = 6) {
  const pass = pool.find((item) => item.action?.type === "pass")
    || { score: -999, action: { type: "pass", reason: "No useful legal action" }, evaluation: actionEvaluation(ctx, { type: "pass" }, allUnits) };
  const intentRanked = selectExecutionCandidates(ctx, allUnits, pool, intent, Math.max(limit, pool.length))
    .filter((item) => item.action?.type !== "pass");
  const broadIntent = { ...intent, sector: "", target_hex: "", priority_units: [] };
  const backfillRanked = selectExecutionCandidates(ctx, allUnits, pool, broadIntent, Math.max(limit, pool.length))
    .filter((item) => item.action?.type !== "pass")
    .filter((item) => !intentRanked.some((preferred) => sameProbeAction(preferred.action, item.action)));
  const assessed = [...intentRanked, ...backfillRanked].map((item) => {
      const opportunity = opportunityAssessment(ctx, item, intent, config);
      return { ...item, opportunity, opportunity_score: opportunity.score };
    });
  const rejected = assessed.filter((item) => item.opportunity.rejected);
  const ranked = assessed
    .filter((item) => !item.opportunity.rejected)
    .sort((a, b) => b.opportunity_score - a.opportunity_score || b.score - a.score);
  const slots = Math.max(0, limit - 1);
  const selected = ranked.slice(0, slots);
  const conservative = ranked.find(isConservativeCandidate);
  if (conservative && !selected.some((item) => sameProbeAction(item.action, conservative.action))) {
    if (selected.length < slots) selected.push(conservative);
    else if (selected.length) selected[selected.length - 1] = conservative;
  }
  return {
    candidates: [...selected, { ...pass, opportunity: { rejected: false, reasons: [], bonuses: [], penalties: ["pass cedes tempo"], adjustment: 0, score: -999 }, opportunity_score: -999 }],
    audit: {
      assessed_candidate_count: assessed.length,
      rejected_candidate_count: rejected.length,
      backfill_candidate_count: backfillRanked.length,
      rejected_reasons: rejected.flatMap((item) => item.opportunity.reasons).reduce((counts, reason) => {
        counts[reason] = Number(counts[reason] || 0) + 1;
        return counts;
      }, {})
    }
  };
}

function selectExecutionCandidates(ctx, allUnits, pool, intent, limit = 6) {
  const pass = pool.find((item) => item.action?.type === "pass") || { score: -999, action: { type: "pass", reason: "No useful legal action" }, evaluation: actionEvaluation(ctx, { type: "pass" }, allUnits) };
  const nonPass = pool.filter((item) => item.action?.type !== "pass");
  const ranked = nonPass.map((item) => {
    const action = item.action || {};
    const unitIds = candidateUnitIds(action);
    const target = candidateTarget(action);
    let bonus = 0;
    if (intent.sector && candidateSector(ctx, action) === intent.sector) bonus += 35;
    if (intent.target_hex && target === intent.target_hex) bonus += 55;
    if (intent.priority_units.some((id) => unitIds.includes(id))) bonus += 25;
    if (intent.type === "attack_pressure" && action.type === "combat") bonus += 40;
    if (intent.type === "extend_supply" && unitIds.some((id) => RulesEngine.isSupplyUnit({ id, ...(ctx.state.units[id] || {}) }))) bonus += 40;
    if (intent.type === "pressure" && item.evaluation?.tactical_tags?.includes("contact")) bonus += 20;
    if (intent.type === "consolidate" && (item.evaluation?.risks || []).length === 0) bonus += 15;
    return { ...item, intent_score: Number(item.score || 0) + bonus, intent_bonus: bonus };
  }).sort((a, b) => b.intent_score - a.intent_score || b.score - a.score);
  const matching = ranked.filter((item) => candidateMatchesIntent(ctx, item, intent));
  const source = matching.length ? matching : ranked;
  const slots = Math.max(0, limit - 1);
  const selected = source.slice(0, slots);
  const conservative = source.find(isConservativeCandidate);
  if (conservative && !selected.some((item) => sameProbeAction(item.action, conservative.action))) {
    if (selected.length < slots) selected.push(conservative);
    else if (selected.length) selected[selected.length - 1] = conservative;
  }
  return [...selected, pass];
}

function movementCandidates(ctx, allUnits, activeUnits, config) {
  const contextLimit = Number(config.context?.maxCandidateActions || 12);
  const reachableLimit = Number(config.context?.maxReachableHexesPerCandidateUnit || 120);
  const moverLimit = Math.min(24, Math.max(8, Math.ceil(contextLimit / 2)));
  const candidatesPerMover = Math.min(8, Math.max(2, Math.ceil(Math.max(1, contextLimit - 1) / moverLimit)));
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
      .slice(0, candidatesPerMover)
      .map(({ progress: _progress, ...item }) => ({ ...item, evaluation: actionEvaluation(ctx, item.action, allUnits) }));
  }).sort((a, b) => b.score - a.score);
}

function buildContext(config, options = {}) {
  const scenarioInput = options.scenario || "july";
  const scenarioPath = /\.json$/i.test(String(scenarioInput))
    ? String(scenarioInput)
    : `scenarios/${String(scenarioInput)}.json`;
  const state = options.state ? cloneJson(options.state) : readJson(scenarioPath);
  if (options.phase) state.phase = options.phase;
  if (options.activeSide) state.active_side = options.activeSide;
  if (options.turn != null) state.turn = Number(options.turn);
  for (const [unitId, patch] of Object.entries(options.unitPatches || {})) {
    if (state.units?.[unitId]) state.units[unitId] = { ...state.units[unitId], ...patch };
  }
  const rules = readJson("rules_el_alamein.json");
  const terrain = readJson("terrain.json");
  RulesEngine.applyStateDefaults(state);
  const ctx = RulesEngine.createContext({ state, rules, terrain });
  const firstPhase = rules.turn_sequence?.[0] || "axis_initial_movement";
  const includeInitialMap = options.includeInitialMap === true
    || (options.includeInitialMap == null && options.state && !options.phase)
    || (options.includeInitialMap !== false && Number(state.turn || 1) === 1 && state.phase === firstPhase);
  const entries = Object.entries(state.units || {});
  const allUnits = entries.map(([id, unit]) => ({ id, ...unit }));
  const activeSide = state.active_side || "axis";
  const enemySide = activeSide === "axis" ? "allies" : "axis";
  const decisionMode = ["direct", "candidates", "intent", "hybrid", "opportunity_aware_hybrid", "unit_plan_hybrid", "hierarchical_sae", "strategy_execute"].includes(options.decisionMode) ? options.decisionMode : "candidates";
  const limit = Number(config.context.maxUnitsPerSide || 28);
  const activeForce = forceDigest(entries, activeSide, ctx, allUnits, limit, config);
  const enemyForce = forceDigest(entries, enemySide, ctx, allUnits, limit, config);
  const activeUnits = allUnits
    .filter((unit) => unit.side === activeSide && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map((unit) => compactUnit(unit.id, ctx.state.units[unit.id], ctx, allUnits, { includeNearby: false }));
  const kind = phaseKind(state.phase);
  const candidateMode = ["candidates", "hybrid", "opportunity_aware_hybrid"].includes(decisionMode);
  const buildPrivateCandidates = candidateMode || options.privateCandidates === true;
  let candidateActions = buildPrivateCandidates
    ? kind === "combat"
      ? combatCandidates(ctx, allUnits)
      : ["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)
        ? movementCandidates(ctx, allUnits, activeUnits, config)
        : []
    : [];
  if (buildPrivateCandidates) {
    candidateActions = [...candidateActions, ...exitWestCandidates(ctx, allUnits)];
  }
  const passAction = { type: "pass", reason: "No useful legal action" };
  const passCandidate = { score: -999, action: passAction, evaluation: actionEvaluation(ctx, passAction, allUnits) };
  const candidateLimit = Number(config.context.maxCandidateActions || 12);
  const selectedCandidates = [
    ...candidateActions.filter((item) => item.action?.type !== "pass").slice(0, Math.max(0, candidateLimit - 1)),
    passCandidate
  ];

  const victory = victoryBrief(ctx);
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
      victory_points: victory.current_vp,
      victory_level: victory.current_level
    },
    game_overview: gameOverview(ctx, { includeInitialMap }),
    decision_mode: decisionMode,
    decision_brief: ["direct", "intent", "strategy_execute"].includes(decisionMode) || (["hybrid", "opportunity_aware_hybrid", "unit_plan_hybrid", "hierarchical_sae"].includes(decisionMode) && !options.phaseIntent)
      ? intentBrief(ctx, activeUnits, activeSide)
      : decisionBrief(ctx, selectedCandidates, activeSide),
    mission: {
      identity: "game_agent",
      side: activeSide,
      opponent: enemySide,
      objective: activeSide === "axis"
        ? "Win as Axis by executing the exact scenario scoring rules, maintaining supply, and avoiding actions that improve position without creating VP or a concrete scoring opportunity."
        : "Win as Allies by keeping VP low, holding Alamein, preserving units, and disrupting Axis supply/tempo.",
      current_phase_allowed_actions: phaseAllowedActions(state),
      decision_rule: "Read victory.scoring_rules and victory.current_scoring first. Prefer legal actions with immediate VP gain or a concrete path to the next scoring threshold. Use tools when legality, supply, pathing, or combat odds are uncertain."
    },
    rules_brief: rulesBrief(rules),
    victory,
    strategy: {
      doctrine: config.strategy.doctrine,
      active_phase_objective: config.strategy.phaseObjectives[phaseKind(state.phase)] || config.strategy.phaseObjectives.initial_movement,
      priorities: config.strategy.priorities,
      action_contract: config.strategy.actionContract
    },
    objectives: scenarioObjectives(ctx, victory),
    objective_resolution: objectiveResolution(ctx, allUnits, selectedCandidates),
    forces: {
      active: activeForce,
      enemy: enemyForce
    },
    unit_index: {
      active: unitIndex(entries, activeSide, ctx, config.context?.maxUnitIndexPerSide || 160),
      enemy: unitIndex(entries, enemySide, ctx, config.context?.maxUnitIndexPerSide || 160)
    },
    battlefield_summary: battlefieldSummary(ctx, allUnits, activeSide),
    map_intel: mapIntel(ctx, candidateMode ? selectedCandidates : [passCandidate], allUnits, activeSide),
    map_topology: mapTopologySummary(ctx),
    recent_log: [],
    tools: [],
    tool_results: []
  };
  if (decisionMode === "hybrid") {
    publicContext.phase_intent_catalog = phaseIntentCatalog(state);
    if (options.phaseIntent) {
      const phaseIntent = normalizePhaseIntent(options.phaseIntent, state);
      const executionCandidates = selectExecutionCandidates(ctx, allUnits, selectedCandidates, phaseIntent, 6);
      publicContext.phase_intent = phaseIntent;
      publicContext.decision_brief = decisionBrief(ctx, executionCandidates, activeSide);
      publicContext.candidate_actions = executionCandidates;
      publicContext.execution_candidate_count = executionCandidates.length;
    }
  }
  if (decisionMode === "opportunity_aware_hybrid") {
    publicContext.phase_intent_catalog = phaseIntentCatalog(state);
    if (options.phaseIntent) {
      const phaseIntent = normalizePhaseIntent(options.phaseIntent, state);
      const opportunitySelection = selectOpportunityAwareCandidates(ctx, allUnits, selectedCandidates, phaseIntent, config, 6);
      const executionCandidates = opportunitySelection.candidates;
      publicContext.phase_intent = phaseIntent;
      publicContext.decision_brief = decisionBrief(ctx, executionCandidates, activeSide);
      publicContext.candidate_actions = executionCandidates;
      publicContext.execution_candidate_count = executionCandidates.length;
      publicContext.opportunity_filter = {
        policy: "Prefer legal actions with positive tactical opportunity after combat-risk, minefield, ZOC, crowding, supply, and objective checks.",
        ...opportunitySelection.audit
      };
    }
  }
  if (decisionMode === "unit_plan_hybrid") {
    publicContext.phase_intent_catalog = phaseIntentCatalog(state);
    if (options.phaseIntent) {
      publicContext.phase_intent = normalizePhaseIntent(options.phaseIntent, state);
      publicContext.rolling_unit_execution = {
        movement_phase_policy: "rule_complete",
        phase_unit_plan_protocol: null,
        rolling_unit_action_protocol: "v1",
        execution_order: "model_tool_call_order",
        unit_resolution: "one accepted move per replay step; hold_unit continues within the step",
        fixed_movement_action_limits: false
      };
    }
  }
  if (decisionMode === "hierarchical_sae") {
    publicContext.phase_intent_catalog = phaseIntentCatalog(state);
    if (options.phaseIntent) publicContext.phase_intent = normalizePhaseIntent(options.phaseIntent, state);
    if (options.strategicIntent) publicContext.strategic_intent = cloneJson(options.strategicIntent);
    if (options.forceAllocation) publicContext.force_allocation = cloneJson(options.forceAllocation);
    if (options.operationState) publicContext.operation_state = cloneJson(options.operationState);
    publicContext.hierarchical_execution = {
      protocol: options.operationState?.task_plan ? "side-aware-goal-v2" : "sae-v1",
      layers: options.operationState?.task_plan
        ? ["open_goal_plan", "rule_grounding", "task_plan", "force_allocation", "rolling_unit_dispatch", "task_check"]
        : ["strategic_intent", "force_allocation", "rolling_unit_dispatch"],
      execution_rule: options.operationState?.task_plan
        ? "Follow the highest-priority active task and the model-selected operation policy. Use current state and rule-tool results as authoritative; hard facts ground the open goal, and task checks evaluate progress but never execute actions."
        : "Follow operation_state.next_required_task and the assigned unit roles unless the current map or rules make them infeasible. Current state and rule-tool results are authoritative."
    };
    publicContext.rolling_unit_execution = {
      movement_phase_policy: "rule_complete",
      rolling_unit_action_protocol: "v1",
      execution_order: "model_tool_call_order",
      unit_resolution: "one accepted move per replay step; hold_unit continues within the step",
      fixed_movement_action_limits: false
    };
    publicContext.decision_brief.execution_rule = options.operationState?.task_plan
      ? "Complete the highest-priority active task first. Read operation_state.phase_dispatch.frontier_breakthrough when present: it shows the current scoring frontier, locally verified direct entry routes, approach routes, projected supply, and risks. Use it to build a supply -> blocker -> entry sequence, but treat routes as recommendations and retain freedom to choose another legal route or selective attacker subset. Keep each unit assigned to one task unless a concrete tactical gain justifies a cross-task action, and use current tool results when they conflict with the plan."
      : "Complete operation_state.next_required_task first. Prefer units assigned to that task, preserve spearhead supply, and use current tool results when they conflict with the plan.";
  }
  if (decisionMode === "strategy_execute") {
    publicContext.phase_intent_catalog = phaseIntentCatalog(state);
    if (options.phaseIntent) {
      const phaseIntent = normalizePhaseIntent(options.phaseIntent, state);
      publicContext.phase_intent = phaseIntent;
      publicContext.strategy_execution = {
        policy: "Execute actions that advance the cached phase strategy. Use the current map as ground truth and keep the strategy until the phase changes.",
        no_action_candidates: true,
        replan_trigger: "A new strategy is generated automatically when turn, phase, or side changes."
      };
      publicContext.decision_brief.phase_strategy = phaseIntent;
      publicContext.decision_brief.execution_rule = "Use view_map when board detail is needed, then call act with one legal action that advances phase_strategy.";
    }
  }
  if (decisionMode === "candidates") publicContext.candidate_actions = selectedCandidates;
  return { publicContext, ctx, allUnits, candidatePool: selectedCandidates };
}

function systemPrompt(config, decisionMode = "candidates", side) {
  if (decisionMode === "hybrid_intent") return resolveSidePrompt(side, "external.phase_intent_system");
  const intentMode = ["intent", "strategy_execute"].includes(decisionMode);
  const strategy = sideStrategyConfig(side);
  return renderSidePrompt(side, "external.system", {
    doctrine: strategy.doctrine,
    action_contract: strategy.actionContract,
    priorities: (strategy.priorities || []).map((item) => `Priority: ${item}`).join("\n"),
    context_instruction: resolveSidePrompt(side, intentMode ? "external.context_intent" : "external.context_candidates"),
    decision_instruction: resolveSidePrompt(side, intentMode ? "external.decision_intent" : "external.decision_candidates"),
    review_instruction: resolveSidePrompt(side, intentMode ? "external.review_intent" : "external.review_candidates")
  });
}

function publicPayload(config, context, toolResults) {
  return {
    provider: config.provider,
    model: config.api.model,
    rules_summary: promptValue("context.rules_summary"),
    context: { ...context, tool_results: toolResults.slice(-(config.context.maxToolResults || 6)) }
  };
}

function runTool(env, context, tool, args = {}) {
  const unitsById = env.unitsById || env;
  const ctx = env.ctx;
  const allUnits = env.allUnits || [];
  if (tool === "inspect_rules") return ctx ? inspectRulesTool(ctx, args.topic) : { ok: false, read_only: true, reason: "rules context unavailable" };
  if (tool === "list_legal_actions") {
    if (!Array.isArray(context.candidate_actions)) {
      return { legal: false, reason: "list_legal_actions is disabled in intent mode; inspect the board and validate a specific intent" };
    }
    return { legal: true, actions: context.candidate_actions.slice(0, Number(args.limit || context.candidate_actions.length)) };
  }
  if (tool === "check_move") return ctx ? checkMoveTool(ctx, args) : { legal: false, reason: "rules context unavailable" };
  if (tool === "find_path") return ctx ? findPathTool(ctx, args) : { legal: false, reason: "rules context unavailable" };
  if (tool === "plan_route") return ctx ? planRouteTool(ctx, args) : { legal: false, read_only: true, reason: "rules context unavailable" };
  if (tool === "evaluate_maneuver") return ctx ? evaluateManeuverTool(ctx, args) : { legal: false, read_only: true, reason: "rules context unavailable" };
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
  const freeActionModes = ["direct", "intent", "strategy_execute", "hierarchical_sae"];
  const planning = action?.type === "move_intent" && ctx ? resolveMoveIntent(ctx, action) : null;
  let resolvedAction = planning?.legal ? planning.action : action;
  const candidates = Array.isArray(context.candidate_actions) ? context.candidate_actions : [];
  const index = candidates.findIndex((item) => sameProbeAction(resolvedAction, item.action));
  const best = candidates[0] || null;
  const matched = index >= 0 ? context.candidate_actions[index] : null;
  let genericVerdict = null;
  if (freeActionModes.includes(context.decision_mode) && ctx && !planning?.legal && resolvedAction?.type === "move") {
    try {
      genericVerdict = RulesEngine.checkMove(ctx, resolvedAction.unit, resolvedAction.path || [], { mode: resolvedAction.mode || "normal" });
    }
    catch (error) {
      genericVerdict = { legal: false, reason: error.message };
    }
  }
  if (freeActionModes.includes(context.decision_mode) && ctx && resolvedAction?.type === "combat") {
    try {
      genericVerdict = RulesEngine.checkCombat(ctx, resolvedAction);
      if (genericVerdict.legal) {
        resolvedAction = {
          ...resolvedAction,
          verdict: {
            ...genericVerdict,
            details: {
              ...(genericVerdict.details || {}),
              crt_column: crtColumn(ctx, genericVerdict.details?.odds_column, resolvedAction.defender_hexes || [])
            }
          }
        };
      }
    }
    catch (error) {
      genericVerdict = { legal: false, reason: error.message };
    }
  }
  const legal = resolvedAction.type === "pass" || index >= 0 || !!planning?.legal || !!genericVerdict?.legal;
  const fallback = resolvedAction.type === "pass"
    ? { summary: "Pass ends the current phase. Use only when no useful legal action remains.", risks: ["cedes tempo"] }
    : planning?.legal
      ? actionEvaluation(ctx, planning.action, Object.entries(ctx.state.units || {}).map(([id, unit]) => ({ id, ...unit })))
      : genericVerdict?.legal
        ? actionEvaluation(ctx, resolvedAction, Object.entries(ctx.state.units || {}).map(([id, unit]) => ({ id, ...unit })))
      : null;
  const alternatives = candidates
    .filter((item) => item?.action && item.action.type !== "pass" && !sameProbeAction(item.action, resolvedAction))
    .slice(0, 3)
    .map((item) => ({
      action: item.action,
      score: item.score,
      evaluation: item.evaluation,
      reason: "locally evaluated alternative"
    }));
  return {
    legal,
    score: matched?.score ?? (resolvedAction.type === "pass" ? -999 : planning?.legal ? 0 : null),
    evaluation: matched?.evaluation || fallback,
    action: resolvedAction,
    planned_from_intent: planning?.planned_from_intent || null,
    alternatives: planning?.alternatives?.length ? planning.alternatives : alternatives,
    recommended_recovery: planning?.recommended_recovery || "",
    candidate_match: {
      exact_candidate: index >= 0,
      candidate_rank: index >= 0 ? index + 1 : null,
      candidate_score: matched?.score ?? null,
      best_score: best?.score ?? null,
      score_delta_from_best: matched && best ? Number((matched.score - best.score).toFixed(2)) : null,
      best_action: best?.action || null
    },
    reason: planning && !planning.legal
      ? planning.reason
      : genericVerdict && !genericVerdict.legal
        ? genericVerdict.reason
        : !legal
          ? freeActionModes.includes(context.decision_mode)
            ? "intent mode requires a legal move_intent, move, combat, exit_west, or pass"
            : "transcript probe validates exact candidate actions, move_intent with legal planned route, or pass only"
          : "action is legal, but may be rejected by the strategy review"
  };
}

function finalActionReview(context, action = {}, assessment) {
  const freeActionModes = ["direct", "intent", "strategy_execute", "hierarchical_sae"];
  const match = assessment?.candidate_match || {};
  const bestAction = match.best_action || null;
  const bestScore = Number(match.best_score);
  const score = Number(assessment?.score);
  const issues = [];
  if (!assessment?.legal) issues.push(assessment?.reason || "final action is illegal");
  const reviewedAction = assessment?.action || action;
  if (reviewedAction?.type === "move" && (reviewedAction.path || []).length <= 1) issues.push("final action is a no-op move");
  if (action?.type === "pass" && !freeActionModes.includes(context.decision_mode) && bestAction?.type && bestAction.type !== "pass" && Number.isFinite(bestScore) && bestScore > 0) {
    issues.push("pass rejects useful non-pass candidate");
  }
  if (!freeActionModes.includes(context.decision_mode) && match.exact_candidate && Number(match.candidate_rank) > 5 && Number.isFinite(Number(match.score_delta_from_best)) && Number(match.score_delta_from_best) < -20) {
    issues.push(`candidate rank ${match.candidate_rank} is too far below best action`);
  }
  if (!freeActionModes.includes(context.decision_mode) && !match.exact_candidate && Number.isFinite(score) && Number.isFinite(bestScore) && score < bestScore - 20) {
    issues.push("non-candidate final action scores much worse than best candidate");
  }
  return {
    accept: issues.length === 0,
    issues,
    action,
    assessment,
    instruction: issues.length
      ? freeActionModes.includes(context.decision_mode)
        ? "Choose another legal intent and validate it with tools before returning final_action."
        : "Choose a stronger legal final_action. Prefer candidate_match.best_action or a top candidate_actions item; copy its action exactly."
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
  const outFile = prepareOutputFile(argValue("--out", mockReview ? MOCK_OUT : OUT));
  const contextOutFile = prepareOutputFile(argValue("--context-out", CONTEXT_OUT));
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
        { role: "system", content: systemPrompt(config, "candidates", publicContext.game.active_side) },
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
      { role: "system", content: systemPrompt(config, "candidates", publicContext.game.active_side) },
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
  actionEvaluation,
  buildContext,
  candidateSector,
  evaluateProbeAction,
  gameOverview,
  finalActionReview,
  movementActionScore,
  normalizePhaseIntent,
  opportunityAssessment,
  objectiveResolution,
  phaseKind,
  publicPayload,
  readConfig,
  resolveMoveIntent,
  runTool,
  evaluateManeuverTool,
  mapHexState,
  mapRegionHexes,
  mapTopologySummary,
  planRouteTool,
  renderConnectionMap,
  scoringFrontier,
  inspectRulesTool,
  systemPrompt
};
