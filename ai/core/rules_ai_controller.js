/*
 * Shared complex rules AI controller.
 *
 * This module is deliberately usable from Node and from the browser.  The
 * browser application and experiment replay provide the same rule engine,
 * state, rules, and terrain objects, so candidate generation and scoring are
 * identical in both environments.
 */
(function initRulesAiController(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AlameinRulesAiController = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function makeApi(root) {
  function createRulesAiController(options = {}) {
    const engine = options.engine || root.AlameinRules;
    if (!engine) throw new Error("Alamein rule engine is required by the rules AI controller");
    const state = options.state;
    if (!state || typeof state !== "object") throw new Error("state is required by the rules AI controller");
    const rules = options.rules || engine.DEFAULT_RULES;
    const terrain = options.terrain || {};
    const defaultMaxActions = Math.max(1, Number(options.maxActions || 80));
    let supplyCache = null;

    const ctx = () => engine.createContext({ state, rules, terrain });
    const phaseKind = () => engine.phaseKind(state.phase);
    const units = () => engine.unitsArray(ctx());
    const combats = () => engine.combatUnitsArray(ctx());
    const friends = (side) => engine.friendlyUnits(ctx(), side);
    const enemies = (side) => engine.enemyUnits(ctx(), side);
    const byHex = (items) => engine.unitsByHex(ctx(), items || units());
    const normalizeHex = engine.normalizeHex;
    const neighbors = engine.neighbors;

    function distance(a, b) {
      const [ac, ar] = engine.splitHex(a);
      const [bc, br] = engine.splitHex(b);
      return Math.abs(ac - bc) + Math.abs(ar - br);
    }

    function column(hex) {
      return Number(normalizeHex(hex).slice(0, 2));
    }

    function hexAtColumn(targetColumn, referenceHex) {
      const bounds = engine.COLUMN_ROW_BOUNDS?.[targetColumn];
      if (!bounds) return normalizeHex(referenceHex);
      const [, referenceRow] = engine.splitHex(referenceHex);
      const row = Math.max(bounds[0], Math.min(bounds[1], referenceRow));
      return normalizeHex(`${String(targetColumn).padStart(2, "0")}${String(row).padStart(2, "0")}`);
    }

    function supplyStates(side = state.active_side) {
      if (!supplyCache || supplyCache.side !== side) {
        supplyCache = { side, values: engine.checkSupply(ctx(), side) };
      }
      return supplyCache.values;
    }

    function supplyState(unitId) {
      return supplyStates(state.active_side)?.[unitId]
        || state.units?.[unitId]?.supply_state
        || "supplied";
    }

    function enemyMinesAt(side, hex) {
      return engine.enemyMinesAt(ctx(), side, hex);
    }

    function enemyZocSources(side, hex) {
      return engine.enemyZocSources(ctx(), side, hex);
    }

    function nearestEnemyHex(unit, maxRange = Infinity) {
      if (!unit?.hex) return null;
      let best = null;
      for (const enemy of enemies(unit.side)) {
        if (!enemy.hex || enemy.eliminated) continue;
        const current = { hex: normalizeHex(enemy.hex), distance: distance(unit.hex, enemy.hex) };
        if (current.distance > maxRange || (best && current.distance >= best.distance)) continue;
        best = current;
      }
      return best;
    }

    function currentAxisFrontier() {
      if (state.scenario !== "july") return null;
      try {
        const breakdown = engine.checkVictory(ctx()).breakdown || [];
        const item = breakdown.find((entry) => entry.id === "july_east_of_3400");
        return Number(item?.farthest_column || 34);
      }
      catch {
        return 34;
      }
    }

    function nearestMine(unit) {
      const candidates = units()
        .filter((item) => item.kind === "mine" && item.side !== unit.side && item.hex && !item.eliminated && !item.cleared)
        .map((item) => ({ hex: normalizeHex(item.hex), distance: distance(unit.hex, item.hex) }))
        .sort((a, b) => a.distance - b.distance || a.hex.localeCompare(b.hex));
      return candidates[0] || null;
    }

    function dynamicTargetForSide(side = state.active_side, unit = null) {
      const reference = unit?.hex || friends(side).find((item) => item.hex)?.hex || "0101";
      if (state.scenario === "july" && side === "axis") {
        return hexAtColumn(Math.min(49, Math.max(35, (currentAxisFrontier() || 34) + 1)), reference);
      }
      if (state.scenario === "september" && side === "axis") {
        const mine = nearestMine(unit || { side, hex: reference });
        if (mine) return mine.hex;
        return nearestEnemyHex(unit || { side, hex: reference }, 12)?.hex || reference;
      }
      if (state.scenario === "september" && side === "allies") {
        return nearestEnemyHex(unit || { side, hex: reference }, Infinity)?.hex || reference;
      }
      if (state.scenario === "october" && side === "axis") {
        return Number(state.turn || 1) > 10 ? "0101" : reference;
      }
      if (state.scenario === "october" && side === "allies") {
        return nearestEnemyHex(unit || { side, hex: reference }, Infinity)?.hex || reference;
      }
      return nearestEnemyHex(unit || { side, hex: reference }, 8)?.hex || reference;
    }

    function moveTarget(unit) {
      if (engine.isSupplyUnit(unit)) {
        const candidate = friends(unit.side)
          .filter((item) => item.hex && !item.eliminated && item.id !== unit.id)
          .sort((a, b) => {
            if (unit.side === "axis") return column(b.hex) - column(a.hex) || Number(b.attack || 0) - Number(a.attack || 0);
            return distance(unit.hex, a.hex) - distance(unit.hex, b.hex) || Number(b.attack || 0) - Number(a.attack || 0);
          })[0];
        if (candidate) return normalizeHex(candidate.hex);
      }
      return dynamicTargetForSide(unit.side, unit);
    }

    function directionScore(unit, start, destination) {
      const delta = column(destination) - column(start);
      if (state.scenario === "october" && unit.side === "axis") {
        if (Number(state.turn || 1) > 10) return delta < 0 ? Math.abs(delta) * 10 : -Math.max(0, delta) * 14;
        // Before the withdrawal window, avoid gratuitous movement.  The
        // October restriction itself remains enforced by the rule engine.
        return delta === 0 ? 2 : -Math.abs(delta) * 4;
      }
      if (unit.side === "axis") return delta >= 0 ? delta * 4 : delta * 18;
      const nearby = nearestEnemyHex(unit, 7);
      if (nearby) {
        const before = distance(start, nearby.hex);
        const after = distance(destination, nearby.hex);
        const awayPenalty = after > before ? (after - before) * 16 : 0;
        return (before - after) * 8 - awayPenalty - Math.max(0, column(destination) - 38) * 2;
      }
      if (delta < 0) return delta * 14;
      if (delta > 2) return -delta * 3;
      return delta;
    }

    function canExitWest(unitId) {
      const unit = state.units?.[unitId];
      if (!unit) return { legal: false, reason: "未知单位" };
      if (state.scenario !== "october") return { legal: false, reason: "只有 October 场景允许西边撤出" };
      if (unit.side !== "axis" || state.active_side !== "axis") return { legal: false, reason: "只有 Axis 当前方单位可撤出" };
      if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind())) {
        return { legal: false, reason: "只能在移动阶段撤出" };
      }
      if (Number(state.turn || 1) <= 10) return { legal: false, reason: "October 第 10 回合后才可撤出" };
      if (!unit.hex || column(unit.hex) !== 1) return { legal: false, reason: "单位必须位于西边缘" };
      if (!(engine.isCombatUnit({ id: unitId, ...unit }) || engine.isSupplyUnit({ id: unitId, ...unit }))) {
        return { legal: false, reason: "只有作战或补给单位计撤出 VP" };
      }
      return { legal: true, reason: "可从西边撤出", action: { type: "exit_west", unit: unitId } };
    }

    function octoberWithdrawalCandidate(unit) {
      if (!(unit?.side === "axis" && state.scenario === "october" && Number(state.turn || 1) > 10 && unit.hex)) return true;
      if (canExitWest(unit.id).legal) return true;
      const movement = Math.max(1, Number(unit.movement || 1));
      const remainingTurns = Math.max(1, engine.scenarioFinalTurn(state.scenario) - Number(state.turn || 1) + 1);
      const exitTurns = Math.ceil(Math.max(0, column(unit.hex) - 1) / movement);
      if (engine.isSupplyUnit(unit)) return column(unit.hex) <= 22 || movement >= 3 || exitTurns <= remainingTurns + 1;
      const value = Number(unit.attack || unit.defense || 0);
      return column(unit.hex) <= 12 || exitTurns <= remainingTurns + 1 || (movement >= 8 && column(unit.hex) <= 30) || (value >= 4 && exitTurns <= remainingTurns + 2);
    }

    function combatRiskScore(crtColumn = {}) {
      const weights = { De: 8, Ex: 3, D3: 5, D2: 4, D1: 3, A1: -2, A2: -4, A3: -5, Ae: -8 };
      const values = Object.values(crtColumn).filter(Boolean);
      return values.length ? values.reduce((sum, value) => sum + (weights[value] || 0), 0) / values.length : 0;
    }

    function combatOutcomeStats(crtColumn = {}) {
      const outcomes = Object.values(crtColumn).filter(Boolean);
      const count = (predicate) => outcomes.filter(predicate).length;
      return {
        defender_eliminated: count((value) => value === "De" || value === "Ex"),
        defender_retreat: count((value) => /^D[123]$/.test(String(value))),
        attacker_eliminated: count((value) => value === "Ae"),
        attacker_retreat: count((value) => /^A[123]$/.test(String(value))),
        exchange: count((value) => value === "Ex"),
        defender_harm: count((value) => /^D[123]$/.test(String(value)) || value === "De" || value === "Ex"),
        attacker_harm: count((value) => /^A[123]$/.test(String(value)) || value === "Ae" || value === "Ex")
      };
    }

    function crtColumn(columnName, defenderHexes = []) {
      const columns = rules.combat?.odds_columns || engine.DEFAULT_RULES.combat?.odds_columns || [];
      const index = columns.indexOf(columnName);
      if (index < 0) return {};
      const rugged = defenderHexes.some((hex) => engine.hexTags(ctx(), hex).includes("hill_or_ridge"));
      const result = {};
      for (let roll = 1; roll <= 6; roll += 1) {
        const raw = rules.combat?.crt?.[String(roll)]?.[index] || null;
        result[String(roll)] = rugged && /^D[123]$/.test(String(raw)) ? "No Effect" : raw;
      }
      return result;
    }

    function requiredDefenderHexes(attackers) {
      return engine.requiredDefenderHexes(ctx(), attackers);
    }

    function publicCombatVerdict(action) {
      const verdict = engine.checkCombat(ctx(), { ...action, die: null });
      if (!verdict.legal) return verdict;
      return {
        legal: true,
        reason: verdict.reason,
        details: {
          ...verdict.details,
          die: null,
          outcome: null,
          crt_column: crtColumn(verdict.details.odds_column, action.defender_hexes || [])
        }
      };
    }

    function combatStrategicValue(action) {
      const details = action.verdict?.details || {};
      const stats = combatOutcomeStats(details.crt_column || {});
      const targetHexes = action.defender_hexes || [];
      const targetUnits = targetHexes.flatMap((hex) => (byHex()[normalizeHex(hex)] || []).filter((unit) => unit.side !== state.active_side));
      const objectiveBonus = state.scenario === "july" && targetHexes.includes(normalizeHex(rules.game?.alamein_hex || "3711")) ? 28 : 0;
      const mineBonus = state.scenario === "september" && targetUnits.some((unit) => unit.kind === "mine") ? 24 : 0;
      const targetSupplyBonus = targetUnits.filter((unit) => engine.isSupplyUnit(unit)).length * 18;
      const attackerStrength = Number(details.attack || 0);
      const defenderStrength = Number(details.defense || 0);
      return stats.defender_harm * 9 + stats.defender_eliminated * 8 - stats.attacker_harm * 7
        + objectiveBonus + mineBonus + targetSupplyBonus + Math.max(0, attackerStrength - defenderStrength) * 1.5;
    }

    function scoreAction(action) {
      if (!action || action.type === "pass") return -10000;
      if (action.type === "exit_west") {
        const unit = state.units[action.unit];
        return 500 + (engine.isSupplyUnit(unit || {}) ? 80 : Number(unit?.attack || unit?.defense || 0) * 12);
      }
      if (action.type === "combat") {
        const details = action.verdict?.details || {};
        const columns = rules.combat?.odds_columns || engine.DEFAULT_RULES.combat?.odds_columns || [];
        const oddsIndex = columns.indexOf(details.odds_column);
        const stats = combatOutcomeStats(details.crt_column);
        const badOddsPenalty = oddsIndex >= 0 && oddsIndex < 3 ? (3 - oddsIndex) * 20 : 0;
        return 110 + oddsIndex * 14 + combatRiskScore(details.crt_column) * 10 + combatStrategicValue(action)
          - (stats.exchange + stats.attacker_harm) * 5 - badOddsPenalty
          + Number(details.attack || 0) - Number(details.defense || 0);
      }
      if (action.type !== "move") return -10000;
      const unit = state.units[action.unit];
      if (!unit || !action.path?.length) return -10000;
      const full = { id: action.unit, ...unit };
      const start = normalizeHex(unit.hex);
      const destination = normalizeHex(action.path.at(-1));
      const target = moveTarget(full);
      const progress = distance(start, target) - distance(destination, target);
      const zocSources = enemyZocSources(unit.side, destination);
      const mineCount = enemyMinesAt(unit.side, destination).length;
      const adjacentEnemyStrength = enemies(unit.side)
        .filter((enemy) => enemy.hex && distance(destination, enemy.hex) <= 1)
        .reduce((sum, enemy) => sum + Number(enemy.attack || enemy.defense || 0), 0);
      const defense = Math.max(1, Number(unit.defense ?? unit.attack ?? 1));
      const zocPenalty = zocSources.size ? 10 + zocSources.size * 6 : 0;
      const minePenalty = mineCount ? (engine.isEngineer(full) ? 6 : 26 + mineCount * 4) : 0;
      const overmatchPenalty = zocSources.size ? Math.max(0, adjacentEnemyStrength - defense) * 3 : 0;
      const fragileContactPenalty = zocSources.size && defense <= 1 ? 12 : 0;
      const supply = supplyState(action.unit);
      const supplyPenalty = supply === "isolated" ? 20 : supply === "unsupplied" ? 8 : ["partially_supplied", "partial"].includes(supply) ? 3 : 0;
      const roadBonus = action.mode === "road" && !zocSources.size ? (engine.isSupplyUnit(unit) ? 8 : 2) : 0;
      const tags = engine.hexTags(ctx(), destination);
      const terrainBonus = tags.includes("hill_or_ridge") ? 2 : tags.includes("alamein_box") && state.scenario === "july" ? 3 : 0;
      const spentPenalty = Number(action.verdict?.details?.spent || 0) * 0.25;
      const strength = Number(unit.attack || 0) + Number(unit.movement || 0) * 0.2;
      const usefulProgress = Math.max(0, progress);
      const progressWeight = unit.side === "axis" ? 18 : engine.isSupplyUnit(unit) ? 12 : 8;
      const progressScore = Math.min(usefulProgress, 8) * progressWeight + Math.max(0, usefulProgress - 8) * (unit.side === "axis" ? 6 : 3);
      const negativeProgressPenalty = unit.side !== "axis" && !engine.isSupplyUnit(unit) && progress < 0 ? Math.abs(progress) * 12 : 0;
      const farFromTargetPenalty = unit.side === "axis" || engine.isSupplyUnit(unit) ? distance(destination, target) * 2 : Math.max(0, distance(destination, target) - 2);
      const turnsRemaining = Math.max(0, engine.scenarioFinalTurn(state.scenario) - Number(state.turn || 1) + 1);
      const finalThreatBonus = turnsRemaining <= 1 && unit.side === "axis"
        ? distance(destination, target) <= 2 ? 45 : distance(destination, target) <= 4 ? 20 : distance(destination, target) <= 6 ? 6 : -12
        : distance(destination, target) <= 2 ? 12 : distance(destination, target) <= 4 ? 5 : 0;
      const formationPenalty = engine.isSupplyUnit(unit) && zocSources.size ? 40 : 0;
      const interceptionBonus = unit.side !== "axis" && !engine.isSupplyUnit(unit) && progress > 0 ? 14 + Math.min(progress, 3) * 6 : 0;
      return progressScore + directionScore(unit, start, destination) + finalThreatBonus + interceptionBonus
        - negativeProgressPenalty - farFromTargetPenalty - zocPenalty - minePenalty - overmatchPenalty
        - fragileContactPenalty - supplyPenalty - formationPenalty - spentPenalty + roadBonus + terrainBonus + strength;
    }

    function roadPathBetween(startHex, targetHex) {
      const roadPath = ctx().roadPath || [];
      const startIndex = roadPath.indexOf(normalizeHex(startHex));
      const targetIndex = roadPath.indexOf(normalizeHex(targetHex));
      if (startIndex < 0 || targetIndex < 0 || startIndex === targetIndex) return null;
      return startIndex < targetIndex ? roadPath.slice(startIndex, targetIndex + 1) : roadPath.slice(targetIndex, startIndex + 1).reverse();
    }

    function enumerateStrategicMoves(unitId, mode = "normal", limit = 3) {
      const unit = state.units?.[unitId];
      const full = unit && { id: unitId, ...unit };
      if (!full || full.side !== state.active_side || full.state !== "fresh") return [];
      if (!engine.canMoveInCurrentPhase(ctx(), full, { mode })) return [];
      const start = normalizeHex(full.hex);
      const actions = [];
      const add = (path) => {
        if (path.length < 2) return;
        const verdict = engine.checkMove(ctx(), unitId, path, { mode });
        if (verdict.legal) actions.push({ type: "move", unit: unitId, path, mode, verdict });
      };
      for (const next of neighbors(start)) add([start, next]);
      if (mode === "road") {
        const roadPath = roadPathBetween(start, moveTarget(full));
        if (roadPath) for (let length = roadPath.length; length >= 2 && actions.length < limit; length -= 1) add(roadPath.slice(0, length));
      }
      let path = [start];
      const maxDepth = Math.min(8, Math.max(2, Math.ceil(engine.movementAllowance(ctx(), full, { mode }))));
      for (let depth = 0; depth < maxDepth; depth += 1) {
        const nextSteps = neighbors(path.at(-1))
          .filter((hex) => !path.includes(hex))
          .map((hex) => {
            const nextPath = [...path, hex];
            const verdict = engine.checkMove(ctx(), unitId, nextPath, { mode });
            if (!verdict.legal) return null;
            const action = { type: "move", unit: unitId, path: nextPath, mode, verdict };
            return { score: scoreAction(action), action };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);
        if (!nextSteps.length) break;
        path = nextSteps[0].action.path;
        actions.push(nextSteps[0].action);
        if (enemyZocSources(full.side, path.at(-1)).size) break;
      }
      const seen = new Set();
      return actions
        .sort((a, b) => scoreAction(b) - scoreAction(a))
        .filter((action) => {
          const key = action.path.join("-");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, limit);
    }

    function enumerateTargetMoves(unitId, mode = "normal", limit = 2) {
      const unit = state.units?.[unitId];
      const full = unit && { id: unitId, ...unit };
      if (!full || full.side !== state.active_side || full.state !== "fresh") return [];
      if (!engine.canMoveInCurrentPhase(ctx(), full, { mode })) return [];
      const start = normalizeHex(full.hex);
      const target = moveTarget(full);
      let beam = [{ path: [start] }];
      const actions = [];
      const maxDepth = Math.min(8, Math.max(2, Math.ceil(engine.movementAllowance(ctx(), full, { mode }))));
      for (let depth = 0; depth < maxDepth; depth += 1) {
        const nextBeam = [];
        for (const branch of beam) {
          for (const next of neighbors(branch.path.at(-1))) {
            if (branch.path.includes(next)) continue;
            const path = [...branch.path, next];
            const verdict = engine.checkMove(ctx(), unitId, path, { mode });
            if (!verdict.legal) continue;
            const action = { type: "move", unit: unitId, path, mode, verdict };
            const progress = distance(start, target) - distance(next, target);
            const score = scoreAction(action) + progress * 35 - distance(next, target);
            actions.push({ score, action });
            nextBeam.push({ score, path });
          }
        }
        if (!nextBeam.length) break;
        const seen = new Set();
        beam = nextBeam.sort((a, b) => b.score - a.score).filter((branch) => {
          const destination = branch.path.at(-1);
          if (seen.has(destination)) return false;
          seen.add(destination);
          return true;
        }).slice(0, 4);
      }
      const seen = new Set();
      return actions.sort((a, b) => b.score - a.score).filter((entry) => {
        const key = entry.action.path.join("-");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, limit).map((entry) => entry.action);
    }

    function enumerateRoadMoves(unitId, limit = 2) {
      const unit = state.units?.[unitId];
      const full = unit && { id: unitId, ...unit };
      if (!full || full.side !== state.active_side || full.state !== "fresh") return [];
      if (!engine.canMoveInCurrentPhase(ctx(), full, { mode: "road" })) return [];
      const path = roadPathBetween(full.hex, moveTarget(full));
      if (!path) return [];
      const actions = [];
      for (let length = path.length; length >= 2 && actions.length < limit; length -= 1) {
        const candidate = path.slice(0, length);
        const verdict = engine.checkMove(ctx(), unitId, candidate, { mode: "road" });
        if (verdict.legal) actions.push({ type: "move", unit: unitId, path: candidate, mode: "road", verdict });
      }
      return actions;
    }

    function readyAttackers() {
      return friends(state.active_side).filter((unit) => engine.canAttackUnit(unit)
        && unit.state === "fresh" && !unit.attacked_this_turn && !unit.attacked_this_phase
        && supplyState(unit.id) !== "isolated" && !enemyMinesAt(unit.side, unit.hex).length);
    }

    function enumerateCombat(limit) {
      if (phaseKind() !== "combat") return [];
      const attackers = readyAttackers();
      const enemyHexes = Object.keys(byHex(enemies(state.active_side)));
      const actions = [];
      const seen = new Set();
      for (const defenderHex of enemyHexes) {
        const adjacent = attackers.filter((unit) => neighbors(unit.hex).includes(defenderHex))
          .sort((a, b) => Number(b.attack || 0) - Number(a.attack || 0));
      const groups = [...adjacent.map((unit) => [unit]), adjacent.slice(0, 2), adjacent.slice(0, 3), adjacent].filter((group) => group.length);
      for (const group of groups) {
          const defenderHexes = [...requiredDefenderHexes(group)];
          // A minefield target is the rule-defined 9.25 exception. It is not
          // returned as a mandatory ordinary defender, but it remains the
          // selected target for this candidate and must be included alone.
          if (!defenderHexes.includes(defenderHex)) defenderHexes.push(defenderHex);
          if (!defenderHexes.length) continue;
          const attackerIds = [...new Set(group.map((unit) => unit.id))];
          const key = `${attackerIds.sort().join(",")}=>${defenderHexes.sort().join(",")}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const action = { type: "combat", attackers: attackerIds, defender_hexes: defenderHexes };
          const verdict = publicCombatVerdict(action);
          if (verdict.legal) actions.push({ ...action, verdict });
          if (actions.length >= limit) return actions;
        }
      }
      return actions;
    }

    function enumerateLegalActions(limit = defaultMaxActions) {
      const max = Math.max(1, Number(limit) || defaultMaxActions);
      const kind = phaseKind();
      if (kind === "combat") return [...enumerateCombat(max), { type: "pass", reason: "不行动" }].slice(0, max);
      if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) return [{ type: "pass", reason: "当前阶段无 AI 动作" }].slice(0, max);
      const actions = [];
      const withdrawal = state.scenario === "october" && state.active_side === "axis" && Number(state.turn || 1) > 10;
      if (withdrawal) {
        for (const unit of units().filter((item) => item.side === "axis" && canExitWest(item.id).legal)) {
          actions.push({ type: "exit_west", unit: unit.id });
          if (actions.length >= max) return actions;
        }
      }
      const movable = units()
        .filter((unit) => unit.side === state.active_side && unit.state === "fresh" && (engine.isCombatUnit(unit) || engine.isSupplyUnit(unit) || engine.isEngineer(unit)))
        .filter((unit) => engine.canMoveInCurrentPhase(ctx(), unit))
        .filter((unit) => !withdrawal || octoberWithdrawalCandidate(unit))
        .sort((a, b) => {
          const aTarget = moveTarget(a);
          const bTarget = moveTarget(b);
          return (distance(a.hex, aTarget) - distance(b.hex, bTarget)) || String(a.id).localeCompare(String(b.id));
        });
      const perUnitLimit = state.scenario === "october" ? 1 : kind === "initial_movement" ? 3 : 2;
      for (const unit of movable) {
        const candidates = [
          ...(engine.isSupplyUnit(unit) ? enumerateTargetMoves(unit.id, "normal", 2) : []),
          ...enumerateStrategicMoves(unit.id, "normal", perUnitLimit),
          ...(engine.isCombatUnit(unit) || engine.isSupplyUnit(unit) ? enumerateRoadMoves(unit.id, 2) : []),
          ...(engine.isCombatUnit(unit) || engine.isSupplyUnit(unit) ? enumerateStrategicMoves(unit.id, "road", 1) : [])
        ].map((action) => ({ score: scoreAction(action), action }));
        candidates.sort((a, b) => b.score - a.score);
        for (const candidate of candidates.slice(0, perUnitLimit)) {
          actions.push(candidate.action);
          if (actions.length >= max) return actions;
        }
      }
      actions.push({ type: "pass", reason: "不行动" });
      return actions.slice(0, max);
    }

    function compactAction(action) {
      if (!action) return null;
      if (action.type === "exit_west") return { type: "exit_west", unit: action.unit };
      if (action.type === "move") return {
        type: "move", unit: action.unit, path: action.path,
        mode: action.mode || "normal", destination: action.path?.at(-1),
        spent: action.verdict?.details?.spent, allowance: action.verdict?.details?.allowance
      };
      if (action.type === "combat") return {
        type: "combat", attackers: action.attackers, defender_hexes: action.defender_hexes,
        odds_column: action.verdict?.details?.odds_column, attack: action.verdict?.details?.attack,
        defense: action.verdict?.details?.defense, crt_column: action.verdict?.details?.crt_column
      };
      return { type: "pass", reason: action.reason || "不行动" };
    }

    function suggestAction() {
      supplyCache = null;
      const candidates = enumerateLegalActions(Math.max(80, Number(options.maxActions || 80)))
        .map((action) => ({ score: scoreAction(action), ...action }))
        .sort((a, b) => b.score - a.score);
      const kind = phaseKind();
      const minimumScore = kind === "combat" ? 165 : kind === "supply_movement" ? 2 : state.active_side === "axis" ? 4 : 6;
      const best = candidates.find((action) => action.type !== "pass" && action.score >= minimumScore);
      const firstMovable = units().find((unit) => unit.side === state.active_side && unit.hex && engine.canMoveInCurrentPhase(ctx(), unit));
      return {
        type: "rules",
        policy: "共享前端复杂规则 AI：按当前场景目标、补给、ZOC、雷区、路径、堆叠和战斗期望值选择合法动作；不使用固定 3711 或固定第 18 列目标。",
        target: dynamicTargetForSide(state.active_side, firstMovable),
        action: best || { type: "pass", reason: kind === "combat" && candidates.some((item) => item.type === "combat") ? "存在攻击但风险不值得承担" : "没有找到值得执行的合法动作" },
        candidates: candidates.slice(0, 10).map((action) => ({ score: Number(action.score.toFixed(2)), action: compactAction(action) }))
      };
    }

    return {
      enumerateLegalActions,
      scoreAction,
      directionScore,
      suggestAction,
      moveTarget,
      dynamicTargetForSide,
      canExitWest,
      compactAction
    };
  }

  return { createRulesAiController };
});
