#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Rules = require("./rule_engine.js");

const ROOT = __dirname;
const SCENARIO_FILES = {
  july: "scenarios/july.json",
  september: "scenarios/september.json",
  october: "scenarios/october.json"
};

function readJson(relativePath, fallback = null) {
  const file = path.join(ROOT, relativePath);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  catch {
    return fallback == null ? null : structuredClone(fallback);
  }
}

function clone(value) {
  return structuredClone(value);
}

function makeReplay(scenarioName, options = {}) {
  const rules = readJson("rules_first_alamein.json", Rules.DEFAULT_RULES) || Rules.DEFAULT_RULES;
  const terrain = readJson("terrain.json", { hexes: {}, edges: {} }) || { hexes: {}, edges: {} };
  const state = readJson(SCENARIO_FILES[scenarioName] || SCENARIO_FILES.july);
  if (!state) throw new Error(`Unknown scenario ${scenarioName}`);

  Rules.applyStateDefaults(state);
  state.player_control = { axis: "rules_ai", allies: "rules_ai" };
  state.ai_autoplay = true;
  state.ai_phase_action_counts ||= {};
  state.game_log ||= [];

  let aiScoreSupplyCache = null;
  let aiSupplyScorePhaseCache = null;
  let seed = Number(options.seed || 1942) >>> 0;

  const ctx = () => Rules.createContext({ state, rules, terrain });
  const normalizeHex = Rules.normalizeHex;
  const neighbors = Rules.neighbors;
  const phaseKind = () => Rules.phaseKind(state.phase);
  const phaseSide = (phase = state.phase) => Rules.phaseSide(phase) || state.active_side;
  const unitsArray = () => Rules.unitsArray(ctx());
  const combatUnitsArray = () => Rules.combatUnitsArray(ctx());
  const friendlyUnits = (side) => Rules.friendlyUnits(ctx(), side);
  const enemyUnits = (side) => Rules.enemyUnits(ctx(), side);
  const unitsByHex = (units = unitsArray()) => Rules.unitsByHex(ctx(), units);
  const hexTags = (hex) => Rules.hexTags(ctx(), hex);
  const enemyMinesAt = (side, hex) => Rules.enemyMinesAt(ctx(), side, hex);
  const minesAt = (hex) => Rules.minesAt(ctx(), hex);
  const enemyZocSources = (side, hex) => Rules.enemyZocSources(ctx(), side, hex);
  const checkMove = (unitId, rawPath, moveOptions = {}) => Rules.checkMove(ctx(), unitId, rawPath, moveOptions);
  const checkCombat = (action) => Rules.checkCombat(ctx(), action);
  const movementAllowance = (unit, moveOptions = {}) => Rules.movementAllowance(ctx(), unit, moveOptions);
  const checkSupply = (side) => Rules.checkSupply(ctx(), side);
  const supplyState = (unitId) => Rules.supplyState(ctx(), unitId);
  const isCombatUnit = Rules.isCombatUnit;
  const isSupplyUnit = Rules.isSupplyUnit;
  const isEngineer = Rules.isEngineer;
  const isMapCounter = Rules.isMapCounter;
  const isPlayableSide = Rules.isPlayableSide;

  function logEvent(type, summary, details = {}) {
    state.game_log.push({
      turn: Number(state.turn || 1),
      phase: state.phase,
      side: state.active_side,
      type,
      summary,
      details
    });
  }

  function die() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed % 6) + 1;
  }

  function distance(a, b) {
    const [ac, ar] = Rules.splitHex(a);
    const [bc, br] = Rules.splitHex(b);
    return Math.abs(ac - bc) + Math.abs(ar - br);
  }

  function hexColumn(hex) {
    return Number(normalizeHex(hex).slice(0, 2));
  }

  function fixedAiTarget(side = state.active_side) {
    if (side === "axis" && state.scenario === "october" && Number(state.turn || 1) > 10) return "0101";
    if (side === "axis") return normalizeHex(rules.game?.alamein_hex || "3711");
    return normalizeHex(rules.game?.alamein_hex || "3711");
  }

  function octoberAxisStagingTarget(unit) {
    if (!unit?.hex) return "1809";
    const [, row] = Rules.splitHex(unit.hex);
    if (hexColumn(unit.hex) <= 18) return normalizeHex(unit.hex);
    const candidate = `18${String(row).padStart(2, "0")}`;
    try { return normalizeHex(candidate); }
    catch { return "1809"; }
  }

  function nearestEnemyHexFor(unit, maxRange = Infinity) {
    const current = normalizeHex(unit.hex);
    let best = null;
    let bestDistance = Infinity;
    for (const enemy of enemyUnits(unit.side)) {
      if (!enemy.hex || enemy.eliminated) continue;
      const d = distance(current, enemy.hex);
      if (d < bestDistance) {
        bestDistance = d;
        best = normalizeHex(enemy.hex);
      }
    }
    return best && bestDistance <= maxRange ? { hex: best, distance: bestDistance } : null;
  }

  function supplyEscortTarget(unit) {
    if (unit.side === "axis" && state.scenario === "october" && Number(state.turn || 1) > 10) {
      return fixedAiTarget("axis");
    }
    if (unit.side === "axis" && state.scenario === "october") {
      const movement = Number(unit.movement || 0);
      if (movement >= 3) return "1903";
      if (movement >= 2) return "2003";
      return "2004";
    }
    const friendlies = friendlyUnits(unit.side).filter((item) => item.hex && !item.eliminated);
    if (!friendlies.length) return fixedAiTarget(unit.side);
    if (unit.side === "axis") {
      return friendlies
        .sort((a, b) => hexColumn(b.hex) - hexColumn(a.hex) || Number(b.attack || 0) - Number(a.attack || 0))[0].hex;
    }
    const anchor = fixedAiTarget("allies");
    return friendlies
      .sort((a, b) => distance(a.hex, anchor) - distance(b.hex, anchor) || Number(b.attack || 0) - Number(a.attack || 0))[0].hex;
  }

  function rulesAiMoveTarget(unit) {
    if (isSupplyUnit(unit)) return supplyEscortTarget(unit);
    if (unit.side === "axis" && state.scenario === "october" && Number(state.turn || 1) <= 10) return octoberAxisStagingTarget(unit);
    if (unit.side === "axis") return fixedAiTarget("axis");
    const nearbyEnemy = nearestEnemyHexFor(unit, 7);
    if (nearbyEnemy) return nearbyEnemy.hex;
    const alamein = fixedAiTarget("allies");
    return distance(unit.hex, alamein) <= 7 ? alamein : normalizeHex(unit.hex);
  }

  function rulesAiDirectionScore(unit, start, destination) {
    const startCol = hexColumn(start);
    const destCol = hexColumn(destination);
    const delta = destCol - startCol;
    if (unit.side === "axis" && state.scenario === "october" && isSupplyUnit(unit)) {
      return delta < 0 ? Math.abs(delta) * 10 : delta === 0 ? 0 : -delta * 14;
    }
    if (unit.side === "axis" && state.scenario === "october") {
      return delta < 0 ? Math.abs(delta) * 10 : delta === 0 ? 0 : -delta * 14;
    }
    if (unit.side === "axis") return delta >= 0 ? delta * 4 : delta * 18;
    const nearbyEnemy = nearestEnemyHexFor(unit, 7);
    if (nearbyEnemy) {
      const before = distance(start, nearbyEnemy.hex);
      const after = distance(destination, nearbyEnemy.hex);
      return (before - after) * 8 - Math.max(0, hexColumn(destination) - 38) * 2;
    }
    if (delta < 0) return delta * 14;
    if (delta > 2) return -delta * 3;
    return delta;
  }

  function aiScoreSupplyState(unitId) {
    if (aiScoreSupplyCache && Object.hasOwn(aiScoreSupplyCache, unitId)) return aiScoreSupplyCache[unitId];
    return supplyState(unitId);
  }

  function aiSupplyScoreMap(side = state.active_side) {
    const key = `${state.scenario || "custom"}:${Number(state.turn || 1)}:${state.phase}:${side}`;
    if (aiSupplyScorePhaseCache?.key === key) return aiSupplyScorePhaseCache.map;
    const map = checkSupply(side);
    aiSupplyScorePhaseCache = { key, map };
    return map;
  }

  function combatRiskScore(crtColumnMap) {
    const values = Object.values(crtColumnMap || {});
    if (!values.length) return 0;
    const weights = { De: 8, Ex: 3, D3: 5, D2: 4, D1: 3, A1: -2, A2: -4, A3: -5, Ae: -8 };
    return values.reduce((sum, outcome) => sum + (weights[outcome] || 0), 0) / values.length;
  }

  function crtColumn(column) {
    const columns = rules.combat?.odds_columns || Rules.DEFAULT_RULES.combat?.odds_columns || ["1-4", "1-3", "1-2", "1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"];
    const index = columns.indexOf(column);
    if (index < 0) return {};
    const result = {};
    for (let roll = 1; roll <= 6; roll += 1) result[String(roll)] = rules.combat?.crt?.[String(roll)]?.[index] || null;
    return result;
  }

  function publicCombatVerdict(action) {
    const verdict = checkCombat({ ...action, die: null });
    if (!verdict.legal) return verdict;
    return {
      legal: true,
      reason: verdict.reason,
      details: {
        ...verdict.details,
        die: null,
        outcome: null,
        crt_column: crtColumn(verdict.details.odds_column)
      }
    };
  }

  function rulesAiScore(action) {
    if (!action || action.type === "pass") return -10000;
    if (action.type === "exit_west") {
      const unit = state.units[action.unit];
      return 500 + (unit?.kind === "supply" ? 80 : Number(unit?.attack || unit?.defense || 0) * 12);
    }
    if (action.type === "combat") {
      const details = action.verdict?.details || {};
      const columns = rules.combat?.odds_columns || Rules.DEFAULT_RULES.combat?.odds_columns || ["1-4", "1-3", "1-2", "1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"];
      const oddsIndex = columns.indexOf(details.odds_column);
      const crtScore = combatRiskScore(details.crt_column);
      const exchangeRisk = Object.values(details.crt_column || {}).filter((outcome) => outcome === "Ex" || outcome?.startsWith("A")).length;
      return 120 + oddsIndex * 15 + crtScore * 12 - exchangeRisk * 6 + Number(details.attack || 0) - Number(details.defense || 0);
    }
    if (action.type === "move") {
      const unit = state.units[action.unit];
      if (!unit) return -10000;
      const start = normalizeHex(unit.hex);
      const destination = normalizeHex(action.path[action.path.length - 1]);
      const target = rulesAiMoveTarget(unit);
      const progress = distance(start, target) - distance(destination, target);
      const direction = rulesAiDirectionScore(unit, start, destination);
      const zocPenalty = enemyZocSources(unit.side, destination).size ? 8 : 0;
      const minePenalty = enemyMinesAt(unit.side, destination).length ? 4 : 0;
      const supply = aiScoreSupplyState(action.unit);
      const supplyPenalty = supply === "isolated" ? 20 : supply === "unsupplied" ? 8 : supply === "partially_supplied" ? 3 : 0;
      const roadBonus = action.mode === "road" && !enemyZocSources(unit.side, destination).size ? (isSupplyUnit(unit) ? 8 : 2) : 0;
      const terrainBonus = hexTags(destination).includes("hill_or_ridge") ? 2 : hexTags(destination).includes("alamein_box") ? 3 : 0;
      const spentPenalty = Number(action.verdict?.details?.spent || 0) * 0.25;
      const strength = Number(unit.attack || 0) + Number(unit.movement || 0) * 0.2;
      const progressWeight = unit.side === "axis" ? 18 : isSupplyUnit(unit) ? 12 : 8;
      const farFromTargetPenalty = unit.side === "axis" || isSupplyUnit(unit)
        ? distance(destination, target)
        : Math.max(0, distance(destination, target) - 2);
      const formationPenalty = isSupplyUnit(unit) && enemyZocSources(unit.side, destination).size ? 30 : 0;
      return progress * progressWeight + direction - farFromTargetPenalty - zocPenalty - minePenalty - supplyPenalty - formationPenalty - spentPenalty + roadBonus + terrainBonus + strength;
    }
    return -10000;
  }

  function aiUnitPriority(unit) {
    const full = { id: unit.id, ...unit };
    const target = rulesAiMoveTarget(full);
    const targetDistance = unit.hex ? distance(unit.hex, target) : 99;
    const strength = Number(unit.attack || 0) + Number(unit.movement || 0) * 0.15;
    const octoberSupply = octoberAxisSupplyExitPlan(full);
    if (octoberSupply) {
      if (Number(state.turn || 1) <= 10) {
        return 260 + octoberSupply.movement * 45 - octoberSupply.stagingDistance * 5 - targetDistance * 1.5;
      }
      return 360 + (octoberSupply.canStillExit ? 140 : -40) + octoberSupply.movement * 70 - octoberSupply.exitTurns * 22 - octoberSupply.westDistance * 3;
    }
    if (unit.side === "axis" && state.scenario === "october" && Number(state.turn || 1) > 10) {
      const exitValue = isSupplyUnit(full) ? 80 : Number(unit.attack || unit.defense || 0) * 10;
      const movement = Math.max(1, Number(unit.movement || 1));
      const remainingTurns = Math.max(1, scenarioFinalTurnForAi() - Number(state.turn || 1) + 1);
      const exitTurns = Math.ceil(Math.max(0, hexColumn(unit.hex) - 1) / movement);
      const canStillExit = exitTurns <= remainingTurns + 1;
      return 240 + (canStillExit ? 120 : -80) + exitValue + movement * 8 - exitTurns * 32 - hexColumn(unit.hex) * 1.5 + strength;
    }
    if (unit.side === "axis" && state.scenario === "october") {
      return 130 + Math.max(0, hexColumn(unit.hex) - 18) * 3 + Number(unit.movement || 0) * 4 + strength - targetDistance * 2;
    }
    if (isSupplyUnit(full)) return 100 - targetDistance * 4;
    if (unit.side === "axis") return hexColumn(unit.hex) * 3 - targetDistance * 2 + strength;
    const nearby = nearestEnemyHexFor(full, 8);
    return (nearby ? 80 - nearby.distance * 6 : 30 - targetDistance * 2) + strength;
  }

  function scenarioFinalTurnForAi() {
    return Number(state.scenario_meta?.final_turn || Rules.SCENARIO_META?.[state.scenario]?.final_turn || 7);
  }

  function octoberAxisSupplyExitPlan(unit) {
    if (!(unit?.side === "axis" && state.scenario === "october" && isSupplyUnit(unit) && unit.hex)) return null;
    const turn = Number(state.turn || 1);
    const movement = Math.max(1, Number(unit.movement || 1));
    const col = hexColumn(unit.hex);
    const finalTurn = scenarioFinalTurnForAi();
    const remainingSupplyMoves = Math.max(1, finalTurn - turn + 1);
    const westDistance = Math.max(0, col - 1);
    const exitTurns = Math.ceil(westDistance / movement);
    const stagingDistance = turn <= 10 ? Math.max(0, col - 18) : westDistance;
    return {
      movement,
      westDistance,
      stagingDistance,
      exitTurns,
      remainingSupplyMoves,
      canStillExit: exitTurns <= remainingSupplyMoves
    };
  }

  function octoberAxisWithdrawalCandidate(unit) {
    if (!(unit?.side === "axis" && state.scenario === "october" && Number(state.turn || 1) > 10 && unit.hex)) return true;
    if (canExitWest(unit.id).legal) return true;
    const col = hexColumn(unit.hex);
    const movement = Math.max(1, Number(unit.movement || 1));
    const remainingTurns = Math.max(1, scenarioFinalTurnForAi() - Number(state.turn || 1) + 1);
    const exitTurns = Math.ceil(Math.max(0, col - 1) / movement);
    if (isSupplyUnit(unit)) return col <= 22 || movement >= 3 || exitTurns <= remainingTurns + 1;
    const value = Number(unit.attack || unit.defense || 0);
    return col <= 12 || exitTurns <= remainingTurns + 1 || (movement >= 8 && col <= 30) || (value >= 4 && exitTurns <= remainingTurns + 2);
  }

  function enumerateStrategicMoveActions(unitId, mode = "normal", limit = 10) {
    const unit = state.units[unitId];
    if (!unit || unit.side !== state.active_side || unit.state !== "fresh") return [];
    const moveOptions = { mode };
    if (!Rules.canMoveInCurrentPhase(ctx(), { id: unitId, ...unit }, moveOptions)) return [];
    const start = normalizeHex(unit.hex);
    const actions = [];
    const pushPath = (movePath) => {
      if (movePath.length < 2) return;
      const verdict = checkMove(unitId, movePath, moveOptions);
      if (!verdict.legal) return;
      const action = { type: "move", unit: unitId, path: movePath, mode, verdict };
      actions.push({ score: rulesAiScore(action), ...action });
    };
    for (const nb of neighbors(start)) pushPath([start, nb]);
    if (mode === "road") {
      const roadPath = aiRoadPathBetween(start, rulesAiMoveTarget({ id: unitId, ...unit }));
      if (roadPath) {
        for (let length = roadPath.length; length >= 2; length -= 1) {
          pushPath(roadPath.slice(0, length));
          if (actions.length >= limit) break;
        }
      }
    }
    let movePath = [start];
    const maxDepth = Math.min(8, Math.max(2, Math.ceil(movementAllowance(unit, moveOptions))));
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const current = movePath[movePath.length - 1];
      const nextSteps = neighbors(current)
        .filter((hex) => !movePath.includes(hex))
        .map((hex) => {
          const nextPath = [...movePath, hex];
          const verdict = checkMove(unitId, nextPath, moveOptions);
          if (!verdict.legal) return null;
          const action = { type: "move", unit: unitId, path: nextPath, mode, verdict };
          return { score: rulesAiScore(action), ...action };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
      if (!nextSteps.length) break;
      const best = nextSteps[0];
      actions.push(best);
      movePath = best.path;
      if (enemyZocSources(unit.side, movePath[movePath.length - 1]).size) break;
    }
    const seen = new Set();
    return actions
      .sort((a, b) => b.score - a.score)
      .filter((action) => {
        const key = action.path.join("-");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map(({ score, ...action }) => action);
  }

  function aiRoadPathBetween(startHex, targetHex) {
    const roadPath = ctx().roadPath || [];
    const start = normalizeHex(startHex);
    const target = normalizeHex(targetHex);
    const startIndex = roadPath.indexOf(start);
    const targetIndex = roadPath.indexOf(target);
    if (startIndex < 0 || targetIndex < 0 || startIndex === targetIndex) return null;
    return startIndex < targetIndex
      ? roadPath.slice(startIndex, targetIndex + 1)
      : roadPath.slice(targetIndex, startIndex + 1).reverse();
  }

  function enumerateTargetReachableActions(unitId, mode = "normal", limit = 3) {
    const unit = state.units[unitId];
    if (!unit || unit.side !== state.active_side || unit.state !== "fresh") return [];
    const moveOptions = { mode };
    if (!Rules.canMoveInCurrentPhase(ctx(), { id: unitId, ...unit }, moveOptions)) return [];
    const start = normalizeHex(unit.hex);
    const target = rulesAiMoveTarget({ id: unitId, ...unit });
    const actions = [];
    let beam = [{ path: [start] }];
    const maxDepth = Math.min(8, Math.max(2, Math.ceil(movementAllowance(unit, moveOptions))));
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const nextBeam = [];
      for (const branch of beam) {
        const current = branch.path[branch.path.length - 1];
        for (const nb of neighbors(current)) {
          if (branch.path.includes(nb)) continue;
          const path = [...branch.path, nb];
          const verdict = checkMove(unitId, path, moveOptions);
          if (!verdict.legal) continue;
          const action = { type: "move", unit: unitId, path, mode, verdict };
          const progress = distance(start, target) - distance(nb, target);
          const score = rulesAiScore(action) + progress * 35 - distance(nb, target);
          actions.push({ score, ...action });
          nextBeam.push({ score, path });
        }
      }
      if (!nextBeam.length) break;
      const seenDestinations = new Set();
      beam = nextBeam
        .sort((a, b) => b.score - a.score)
        .filter((branch) => {
          const key = branch.path[branch.path.length - 1];
          if (seenDestinations.has(key)) return false;
          seenDestinations.add(key);
          return true;
        })
        .slice(0, 4);
    }
    const seen = new Set();
    return actions
      .sort((a, b) => b.score - a.score)
      .filter((action) => {
        const key = action.path.join("-");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map(({ score, ...action }) => action);
  }

  function enumerateAiRoadLineActions(unitId, limit = 3) {
    const unit = state.units[unitId];
    if (!unit || unit.side !== state.active_side || unit.state !== "fresh") return [];
    if (!Rules.canMoveInCurrentPhase(ctx(), { id: unitId, ...unit }, { mode: "road" })) return [];
    const path = aiRoadPathBetween(unit.hex, rulesAiMoveTarget({ id: unitId, ...unit }));
    if (!path) return [];
    const actions = [];
    for (let length = path.length; length >= 2; length -= 1) {
      const candidatePath = path.slice(0, length);
      const verdict = checkMove(unitId, candidatePath, { mode: "road" });
      if (!verdict.legal) continue;
      actions.push({ type: "move", unit: unitId, path: candidatePath, mode: "road", verdict });
      if (actions.length >= limit) break;
    }
    return actions;
  }

  function readyAttackersForAi() {
    return friendlyUnits(state.active_side).filter((unit) => {
      if (unit.state !== "fresh" || unit.attacked_this_turn || unit.attacked_this_phase) return false;
      if (aiScoreSupplyState(unit.id) === "isolated") return false;
      if (enemyMinesAt(unit.side, unit.hex).length && !unit.mine_cleared_entry) return false;
      return true;
    });
  }

  function requiredDefenderHexes(attackers) {
    const side = attackers[0]?.side;
    const enemyByHex = unitsByHex(enemyUnits(side));
    const required = new Set();
    for (const attacker of attackers) {
      for (const nb of neighbors(attacker.hex)) {
        if (enemyByHex[nb]?.length) required.add(nb);
      }
    }
    return required;
  }

  function enumerateCombatActions(limit = 50) {
    if (phaseKind() !== "combat") return [];
    const actions = [];
    const attackers = readyAttackersForAi();
    const enemyHexes = Object.keys(unitsByHex(enemyUnits(state.active_side)));
    const seen = new Set();
    for (const defenderHex of enemyHexes) {
      const adjacent = attackers
        .filter((unit) => neighbors(unit.hex).includes(defenderHex))
        .sort((a, b) => Number(b.attack || 0) - Number(a.attack || 0));
      const groups = [
        ...adjacent.map((unit) => [unit]),
        adjacent.slice(0, 2),
        adjacent.slice(0, 3),
        adjacent
      ].filter((group) => group.length);
      for (const group of groups) {
        const defenderHexes = [...requiredDefenderHexes(group)];
        if (!defenderHexes.length) continue;
        const attackerIds = [...new Set(group.map((unit) => unit.id))];
        const key = `${attackerIds.sort().join(",")}=>${defenderHexes.sort().join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const action = { type: "combat", attackers: attackerIds, defender_hexes: defenderHexes, no_retreat_order: false };
        const verdict = publicCombatVerdict(action);
        if (verdict.legal) {
          actions.push({ ...action, verdict });
          if (actions.length >= limit) return actions;
        }
      }
    }
    return actions;
  }

  function canExitWest(unitId) {
    const unit = state.units?.[unitId];
    if (!unit) return { legal: false, reason: "unknown unit" };
    if (state.scenario !== "october") return { legal: false, reason: "only october" };
    if (unit.side !== "axis" || state.active_side !== "axis") return { legal: false, reason: "only active axis" };
    if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind())) return { legal: false, reason: "only movement phase" };
    if (Number(state.turn || 1) <= 10) return { legal: false, reason: "after turn 10 only" };
    if (!unit.hex || hexColumn(unit.hex) !== 1) return { legal: false, reason: "must be west edge" };
    if (!(isCombatUnit({ id: unitId, ...unit }) || isSupplyUnit({ id: unitId, ...unit }))) return { legal: false, reason: "combat or supply only" };
    return { legal: true, reason: "exit west", action: { type: "exit_west", unit: unitId } };
  }

  function aiPhaseKey() {
    return `${state.scenario || "custom"}:${Number(state.turn || 1)}:${state.phase}`;
  }

  function aiPhaseActionCount() {
    state.ai_phase_action_counts ||= {};
    return Number(state.ai_phase_action_counts[aiPhaseKey()] || 0);
  }

  function incrementAiPhaseActionCount() {
    state.ai_phase_action_counts ||= {};
    const key = aiPhaseKey();
    state.ai_phase_action_counts[key] = Number(state.ai_phase_action_counts[key] || 0) + 1;
    return state.ai_phase_action_counts[key];
  }

  function aiPhaseActionLimit(side = state.active_side, kind = phaseKind()) {
    if (state.scenario === "october") {
      if (side === "axis" && Number(state.turn || 1) > 10) {
        if (kind === "combat") return 0;
        if (kind === "initial_movement") return 35;
        if (kind === "mechanized_movement") return 16;
        if (kind === "supply_movement") return 5;
        return 0;
      }
      if (kind === "combat") return 1;
      if (kind === "initial_movement") return 2;
      if (kind === "mechanized_movement") return 1;
      if (kind === "supply_movement") return side === "axis" ? 2 : 1;
      return 0;
    }
    if (state.scenario !== "july") {
      if (kind === "combat") return 1;
      if (kind === "initial_movement") return 4;
      if (kind === "mechanized_movement") return 2;
      if (kind === "supply_movement") return 1;
      return 0;
    }
    if (kind === "combat") return side === "axis" ? 3 : 2;
    if (kind === "initial_movement") return side === "axis" ? 10 : 7;
    if (kind === "mechanized_movement") return side === "axis" ? 4 : 3;
    if (kind === "supply_movement") return 2;
    return 0;
  }

  function shouldAdvanceAiPhaseByBudget(side = state.active_side) {
    const kind = phaseKind();
    const limit = aiPhaseActionLimit(side, kind);
    return limit > 0 && aiPhaseActionCount() >= limit;
  }

  function enumerateLegalAiActions(limit = 50) {
    const actions = [];
    const kind = phaseKind();
    if (kind === "combat") actions.push(...enumerateCombatActions(limit));
    else if (kind === "initial_movement" || kind === "mechanized_movement" || kind === "supply_movement") {
      if (state.scenario === "october" && state.active_side === "axis" && Number(state.turn || 1) > 10) {
        for (const unit of unitsArray().filter((u) => u.side === "axis" && canExitWest(u.id).legal)) {
          actions.push({ type: "exit_west", unit: unit.id });
          if (actions.length >= limit) return actions.slice(0, limit);
        }
      }
      const phaseLimit = aiPhaseActionLimit(state.active_side, kind);
      const remainingBudget = phaseLimit > 0 ? Math.max(1, phaseLimit - aiPhaseActionCount()) : 4;
      const octoberScenario = state.scenario === "october";
      const octoberWithdrawal = octoberScenario && state.active_side === "axis" && Number(state.turn || 1) > 10;
      const perUnitLimit = octoberScenario ? 1 : kind === "initial_movement" ? 3 : 2;
      const maxUnits = octoberWithdrawal
        ? (kind === "supply_movement" ? Math.min(2, remainingBudget + 1) : Math.min(4, remainingBudget + 1))
        : kind === "supply_movement"
        ? Math.min(state.scenario === "october" && state.active_side === "axis" ? 4 : 2, remainingBudget + 1)
        : kind === "mechanized_movement"
          ? Math.min(3, remainingBudget + 1)
          : Math.min(state.active_side === "axis" ? 6 : 5, remainingBudget + 3);
      const movableUnits = unitsArray()
        .filter((unit) => unit.side === state.active_side && (isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit)) && unit.state === "fresh" && Rules.canMoveInCurrentPhase(ctx(), unit))
        .filter((unit) => !octoberWithdrawal || octoberAxisWithdrawalCandidate(unit))
        .sort((a, b) => aiUnitPriority(b) - aiUnitPriority(a))
        .slice(0, maxUnits);
      for (const unit of movableUnits) {
        const remaining = limit - actions.length;
        if (remaining <= 0) break;
        const unitActions = [
          ...(isSupplyUnit(unit) ? enumerateTargetReachableActions(unit.id, "normal", 2) : []),
          ...enumerateStrategicMoveActions(unit.id, "normal", perUnitLimit),
          ...(isCombatUnit(unit) || isSupplyUnit(unit) ? enumerateAiRoadLineActions(unit.id, 2) : []),
          ...(isCombatUnit(unit) || isSupplyUnit(unit) ? enumerateStrategicMoveActions(unit.id, "road", 1) : [])
        ].map((action) => ({ score: rulesAiScore(action), ...action }))
          .sort((a, b) => b.score - a.score)
          .slice(0, perUnitLimit)
          .map(({ score, ...action }) => action);
        actions.push(...unitActions.slice(0, remaining));
        if (actions.length >= limit) break;
      }
    }
    actions.push({ type: "pass", reason: "pass" });
    return actions.slice(0, limit);
  }

  function suggestRulesAction() {
    aiScoreSupplyCache = aiSupplyScoreMap(state.active_side);
    try {
      const candidates = enumerateLegalAiActions(Math.max(80, Number(options.maxActions || 80)))
        .map((action) => ({ score: rulesAiScore(action), ...action }))
        .sort((a, b) => b.score - a.score);
      const kind = phaseKind();
      const minimumScore = kind === "combat" ? 165 : kind === "supply_movement" ? 2 : state.active_side === "axis" ? 4 : 6;
      const best = candidates.find((action) => action.type !== "pass" && action.score >= minimumScore);
      return {
        action: best || { type: "pass", reason: "rules ai pass" },
        candidates: candidates.slice(0, 5).map((action) => ({ score: action.score, type: action.type, unit: action.unit, destination: action.path?.at(-1), odds: action.verdict?.details?.odds_column }))
      };
    }
    finally {
      aiScoreSupplyCache = null;
    }
  }

  function normalizeAiAction(raw) {
    const action = raw?.action || raw;
    if (!action || typeof action !== "object") return { type: "pass", reason: "empty action" };
    if (action.type === "exit_west") return { type: "exit_west", unit: action.unit };
    if (action.type === "move") return { type: "move", unit: action.unit, path: (action.path || []).map(normalizeHex), mode: action.mode || "normal" };
    if (action.type === "combat") return { type: "combat", attackers: action.attackers || [], defender_hexes: (action.defender_hexes || []).map(normalizeHex), no_retreat_order: !!action.no_retreat_order };
    return { type: "pass", reason: action.reason || raw?.reason || "pass" };
  }

  function validateAiAction(rawAction) {
    let action;
    try {
      action = normalizeAiAction(rawAction);
    }
    catch (error) {
      return { legal: false, reason: error.message };
    }
    if (action.type === "pass") return { legal: true, reason: "pass", action };
    if (action.type === "exit_west") return canExitWest(action.unit);
    if (action.type === "move") return { ...checkMove(action.unit, action.path, { mode: action.mode || "normal" }), action };
    if (action.type === "combat") return { ...publicCombatVerdict(action), action };
    return { legal: false, reason: `unknown action ${action.type}`, action };
  }

  function applyAiAction(rawAction) {
    const validation = validateAiAction(rawAction);
    if (!validation.legal) return validation;
    const action = validation.action;
    if (action.type === "pass") return validation;
    if (action.type === "exit_west") {
      const unit = state.units[action.unit];
      unit.exited_edge = "west";
      unit.exit_edge = "west";
      unit.exited_turn = Number(state.turn || 1);
      unit.exit_turn = Number(state.turn || 1);
      unit.off_map = true;
      unit.state = "spent";
      return { legal: true, reason: "exit west", action, verdict: validation };
    }
    if (action.type === "move") {
      const unit = state.units[action.unit];
      unit.hex = normalizeHex(action.path[action.path.length - 1]);
      unit.road_mode = action.mode === "road";
      unit.road_facing = action.path.length > 1 ? Rules.hexDirection(action.path[action.path.length - 2], action.path[action.path.length - 1]) : unit.road_facing;
      unit.facing = unit.road_facing;
      unit.state = "spent";
      if (isEngineer({ id: action.unit, ...unit }) && phaseKind() === "initial_movement" && enemyMinesAt(unit.side, unit.hex).length) {
        Rules.clearMine(ctx(), action.unit, unit.hex);
      }
      return { legal: true, reason: "move applied", action, verdict: validation };
    }
    if (action.type === "combat") {
      const result = Rules.resolveCombat(ctx(), { ...action, die: die() });
      return { ...result, action };
    }
    return { legal: false, reason: `cannot apply ${action.type}`, action };
  }

  function recoverSpentForSide(side) {
    for (const unit of Object.values(state.units || {})) {
      if (unit.side !== side) continue;
      unit.state = "fresh";
      unit.attacked_this_turn = false;
      unit.attacked_this_phase = false;
      unit.defended_this_phase = false;
      unit.cleared_mine_this_turn = false;
      unit.mine_cleared_this_turn = false;
      unit.engineer_assisted_this_turn = false;
      unit.just_cleared_mine_hex = null;
      if (unit.supply_state === "isolated" || unit.supply_state === "unsupplied") {
        unit.road_mode = false;
        unit.road_facing = null;
        unit.facing = null;
      }
    }
  }

  function recoverMovementSpentForSide(side) {
    for (const unit of Object.values(state.units || {})) {
      if (unit.side !== side) continue;
      if (!unit.eliminated) unit.state = "fresh";
    }
  }

  function updateSupplyStates() {
    for (const side of ["axis", "allies"]) {
      const supply = checkSupply(side);
      for (const [id, value] of Object.entries(supply)) {
        const unit = state.units[id];
        if (!unit) continue;
        const previous = unit.supply_state;
        unit.supply_state = value;
        if (value === "isolated" && previous !== "isolated") unit.isolated_since = `${state.turn}:${state.phase}`;
        if (value !== "isolated") unit.isolated_since = null;
      }
    }
  }

  function eliminatePersistentIsolated() {
    for (const [id, unit] of Object.entries(state.units || {})) {
      if (!isCombatUnit({ id, ...unit }) || unit.eliminated || unit.supply_state !== "isolated" || !unit.isolated_since) continue;
      const [turnText] = String(unit.isolated_since).split(":");
      if (Number(state.turn || 1) - Number(turnText || state.turn) < 1) continue;
      unit.eliminated = true;
      unit.eliminated_reason = "isolation";
      unit.eliminated_turn = Number(state.turn || 1);
      unit.eliminated_phase = state.phase;
    }
  }

  function removeClearedMineMarkers() {
    for (const unit of Object.values(state.units || {})) {
      if (unit.kind === "mine" && unit.cleared && unit.eliminated_reason === "mine_cleared") {
        unit.eliminated = true;
        unit.off_map = true;
      }
    }
  }

  function updateJulyBoxes() {
    if (state.boxed_areas_active === false) return;
    const axisInBox = friendlyUnits("axis").some((unit) => hexTags(unit.hex).includes("alamein_box") && state.boxed_areas_active !== false);
    if (axisInBox) state.boxed_areas_active = false;
  }

  function applyPhaseEndEffects() {
    updateSupplyStates();
    eliminatePersistentIsolated();
    if (phaseKind() === "combat") removeClearedMineMarkers();
    if (state.scenario === "july") updateJulyBoxes();
  }

  function advancePhase() {
    const from = state.phase;
    applyPhaseEndEffects();
    const next = Rules.nextPhase(ctx());
    if (next.turn_increment) {
      state.turn = Number(state.turn || 1) + next.turn_increment;
      recoverSpentForSide("axis");
      recoverSpentForSide("allies");
    }
    state.phase = next.phase;
    const side = phaseSide(state.phase);
    if (isPlayableSide(side)) state.active_side = side;
    if (phaseKind() === "combat") recoverMovementSpentForSide(state.active_side);
    logEvent("phase", `${from} -> ${state.phase}`, { from, to: state.phase });
  }

  function compactAction(action) {
    if (!action) return null;
    if (action.type === "move") return { type: "move", unit: action.unit, destination: action.path?.at(-1), mode: action.mode || "normal" };
    if (action.type === "combat") return { type: "combat", attackers: action.attackers, defender_hexes: action.defender_hexes, odds: action.verdict?.details?.odds_column };
    if (action.type === "exit_west") return { type: "exit_west", unit: action.unit };
    return { type: "pass", reason: action.reason || "pass" };
  }

  function finalVictory() {
    return state.phase === "end_game_turn" && Number(state.turn || 1) >= Rules.scenarioFinalTurn(state.scenario)
      ? Rules.checkVictory(ctx())
      : null;
  }

  function buildDiagnostics(result) {
    const lateAxis = (result.log || []).filter((item) => (
      state.scenario === "october" &&
      item.side === "axis" &&
      Number(item.turn || 0) > 10
    ));
    const byUnit = {};
    for (const item of lateAxis) {
      const unitId = item.action?.unit;
      if (!unitId) continue;
      byUnit[unitId] ||= { moves: 0, exits: 0, destinations: [] };
      if (item.action.type === "move") {
        byUnit[unitId].moves += 1;
        byUnit[unitId].destinations.push(item.action.destination);
      }
      if (item.action.type === "exit_west") byUnit[unitId].exits += 1;
    }
    const axisUnits = Object.entries(state.units || {})
      .map(([id, unit]) => ({ id, ...unit }))
      .filter((unit) => unit.side === "axis" && (isCombatUnit(unit) || isSupplyUnit(unit)));
    const exited = axisUnits
      .filter((unit) => unit.off_map && unit.exited_edge === "west")
      .map((unit) => ({
        id: unit.id,
        kind: unit.kind,
        attack: Number(unit.attack || unit.defense || 0),
        turn: unit.exited_turn || unit.exit_turn || null
      }))
      .sort((a, b) => (b.kind === "supply") - (a.kind === "supply") || b.attack - a.attack || String(a.id).localeCompare(String(b.id)));
    const notExited = axisUnits
      .filter((unit) => !unit.off_map && !unit.eliminated)
      .map((unit) => ({
        id: unit.id,
        hex: unit.hex,
        column: unit.hex ? hexColumn(unit.hex) : null,
        kind: unit.kind,
        attack: Number(unit.attack || unit.defense || 0),
        movement: Number(unit.movement || 0),
        priority: Number(aiUnitPriority(unit).toFixed(2)),
        late_actions: byUnit[unit.id] || { moves: 0, exits: 0, destinations: [] }
      }))
      .sort((a, b) => (a.column || 99) - (b.column || 99) || b.attack - a.attack || String(a.id).localeCompare(String(b.id)));
    return {
      late_axis_action_count: lateAxis.length,
      late_axis_by_unit: byUnit,
      exited_west: exited,
      not_exited_axis_sample: notExited.slice(0, 20),
      late_axis_tail: lateAxis.slice(-30)
    };
  }

  function autoPlay(maxSteps = 1000) {
    const log = [];
    for (let step = 0; step < maxSteps && state.ai_autoplay; step += 1) {
      const victory = finalVictory();
      if (victory) {
        state.ai_autoplay = false;
        return { status: "final_victory", victory, log, steps: step };
      }
      if (state.phase === "end_game_turn") {
        const from = state.phase;
        advancePhase();
        log.push({ step: step + 1, action: "advance_phase", from, to: state.phase, turn: state.turn });
        continue;
      }
      const side = phaseSide(state.phase);
      if (!isPlayableSide(side)) break;
      state.active_side = side;
      if (shouldAdvanceAiPhaseByBudget(side)) {
        const from = state.phase;
        const count = aiPhaseActionCount();
        const limit = aiPhaseActionLimit(side);
        advancePhase();
        log.push({ step: step + 1, side, action: "budget_then_advance", count, limit, from, to: state.phase, turn: state.turn });
        continue;
      }
      const suggestion = suggestRulesAction();
      const action = normalizeAiAction(suggestion.action);
      if (action.type === "pass") {
        const from = state.phase;
        advancePhase();
        log.push({ step: step + 1, side, action: "pass_then_advance", from, to: state.phase, turn: state.turn });
        continue;
      }
      const result = applyAiAction(action);
      if (result.legal) incrementAiPhaseActionCount();
      log.push({ step: step + 1, side, phase: state.phase, turn: state.turn, action: compactAction(action), result: { legal: result.legal, reason: result.reason } });
      if (!result.legal) {
        state.ai_autoplay = false;
        return { status: "illegal_action", log, steps: step + 1, result };
      }
    }
    return { status: state.ai_autoplay ? "step_limit" : "stopped", log, steps: log.length };
  }

  return {
    state,
    debugCandidates(limit = 20) {
      aiScoreSupplyCache = aiSupplyScoreMap(state.active_side);
      try {
        return enumerateLegalAiActions(limit)
          .map((action) => ({ score: rulesAiScore(action), action: compactAction(action) }))
          .sort((a, b) => b.score - a.score);
      }
      finally {
        aiScoreSupplyCache = null;
      }
    },
    play: autoPlay,
    summary(result) {
      const victory = result.victory || Rules.checkVictory(ctx());
      const byType = {};
      for (const item of result.log || []) byType[item.action?.type || item.action] = (byType[item.action?.type || item.action] || 0) + 1;
      const summary = {
        scenario: scenarioName,
        status: result.status,
        steps: result.steps,
        turn: Number(state.turn || 1),
        phase: state.phase,
        active_side: state.active_side,
        victory,
        action_counts: byType,
        tail: (result.log || []).slice(-8)
      };
      if (options.diagnose) summary.diagnostics = buildDiagnostics(result);
      return summary;
    }
  };
}

function parseArgs(argv) {
  const args = { scenarios: [], maxSteps: 1000, seed: 1942 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") args.scenarios = Object.keys(SCENARIO_FILES);
    else if (arg === "--max-steps") args.maxSteps = Number(argv[++i] || args.maxSteps);
    else if (arg === "--seed") args.seed = Number(argv[++i] || args.seed);
    else if (arg === "--diagnose") args.diagnose = true;
    else if (!arg.startsWith("-")) args.scenarios.push(arg);
  }
  if (!args.scenarios.length) args.scenarios = ["july"];
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const results = [];
  for (const scenario of args.scenarios) {
    const replay = makeReplay(scenario, args);
    const started = Date.now();
    const result = replay.play(args.maxSteps);
    const summary = replay.summary(result);
    summary.elapsed_ms = Date.now() - started;
    results.push(summary);
  }
  process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  process.stdout.write("\n");
}

module.exports = { makeReplay };
