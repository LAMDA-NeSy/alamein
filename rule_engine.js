/*
 * El Alamein rule engine for the Web Studio.
 *
 * This file is intentionally dependency-free and usable from both the browser
 * and Node-based tests. It owns the rule decisions; app.js owns rendering,
 * history, logging, and user interaction.
 */
(function initRuleEngine(root, factory) {
  const engine = factory();
  if (typeof module === "object" && module.exports) module.exports = engine;
  root.AlameinRules = engine;
})(typeof globalThis !== "undefined" ? globalThis : window, function makeRuleEngine() {
  const COLUMN_ROW_BOUNDS = {
    1: [1, 7], 2: [1, 7], 3: [1, 8], 4: [1, 8], 5: [1, 9],
    6: [1, 9], 7: [1, 10], 8: [1, 10], 9: [1, 11], 10: [1, 11],
    11: [1, 12], 12: [1, 12], 13: [1, 13], 14: [1, 13], 15: [1, 14],
    16: [1, 14], 17: [1, 15], 18: [1, 17], 19: [1, 18], 20: [1, 19],
    21: [1, 21], 22: [1, 21], 23: [1, 34], 24: [2, 33], 25: [3, 34],
    26: [3, 33], 27: [4, 34], 28: [4, 33], 29: [5, 34], 30: [5, 33],
    31: [6, 34], 32: [6, 33], 33: [7, 34], 34: [7, 33], 35: [8, 34],
    36: [8, 33], 37: [9, 34], 38: [9, 33], 39: [10, 34], 40: [10, 33],
    41: [10, 34], 42: [10, 33], 43: [10, 34], 44: [10, 33], 45: [10, 34],
    46: [10, 33], 47: [10, 34], 48: [10, 33], 49: [10, 34]
  };

  const DEFAULT_RULES = {
    turn_sequence: [
      "axis_initial_movement",
      "axis_combat",
      "axis_mechanized_movement",
      "axis_supply_movement",
      "allies_initial_movement",
      "allies_combat",
      "allies_mechanized_movement",
      "allies_supply_movement",
      "end_game_turn"
    ],
    stacking: {
      allied_max_units_per_hex: 3,
      axis_max_units_per_hex: 4,
      one_side_per_hex: true
    },
    movement: {
      default_hex_cost: 1,
      mechanized_threshold: 6,
      terrain_costs: {
        clear: { mechanized: 1, non_mechanized: 1 },
        hill_or_ridge: { mechanized: 5, non_mechanized: 2 },
        depression: { mechanized: 4, non_mechanized: 2 },
        sea: { mechanized: null, non_mechanized: null },
        enemy_minefield: { mechanized: 9, non_mechanized: 3 }
      },
      road_mode: { mechanized_entry_cost: 3, non_mechanized_entry_cost: 1, multiplier: 5 }
    },
    combat: {
      odds_columns: ["1-4", "1-3", "1-2", "1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"],
      crt: {
        1: ["A3", "A2", "A1", "D1", "D1", "D1", "Ex", "Ex", "De", "De"],
        2: ["Ae", "A3", "A2", "A1", "D1", "D1", "D3", "Ex", "Ex", "De"],
        3: ["Ae", "A3", "A2", "A1", "A1", "D1", "D2", "D3", "Ex", "De"],
        4: ["Ae", "Ae", "A3", "A2", "A2", "A1", "D2", "D2", "Ex", "Ex"],
        5: ["Ae", "Ae", "A3", "A2", "A2", "A2", "D2", "D2", "D3", "Ex"],
        6: ["Ae", "Ae", "A3", "A3", "A3", "A2", "D1", "D1", "D3", "Ex"]
      }
    }
  };

  const SCENARIO_META = {
    july: {
      first_player: "axis",
      starting_turn: 1,
      final_turn: 7,
      starting_vp: 25,
      needs_review: false
    },
    september: {
      first_player: "axis",
      starting_turn: 1,
      final_turn: 7,
      starting_vp: 35,
      skip_phases: [{ turn: 1, phase: "allies_initial_movement", next: "allies_combat" }],
      needs_review: false
    },
    october: {
      first_player: "allies",
      starting_turn: 1,
      final_turn: 15,
      starting_vp: -20,
      needs_review: true,
      review_notes: ["Axis withdrawal/start-line coordinates need map review."]
    }
  };

  const DEFAULT_ROAD_PATH = [
    "0101", "0201", "0302", "0402", "0503", "0603", "0704", "0804", "0905", "1005",
    "1106", "1206", "1307", "1407", "1508", "1608", "1709", "1809", "1910", "2010",
    "2111", "2211", "2312", "2412", "2513", "2613", "2714", "2814", "2915", "3015",
    "3116", "3216", "3317", "3417", "3518", "3618", "3719", "3819", "3920", "4020",
    "4121", "4221", "4322", "4422", "4523", "4623", "4724", "4824", "4925"
  ];

  function clone(value) {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function normalizeHex(raw) {
    const match = String(raw || "").trim().toUpperCase().match(/(?:MAP\s*)?([0-9]{2})\s*[,/ -]?\s*([0-9]{2})/);
    if (!match) throw new Error(`invalid hex: ${raw}`);
    const col = Number(match[1]);
    const row = Number(match[2]);
    const bounds = COLUMN_ROW_BOUNDS[col];
    if (!bounds || row < bounds[0] || row > bounds[1]) throw new Error(`hex outside map: ${match[1]}${match[2]}`);
    return `${String(col).padStart(2, "0")}${String(row).padStart(2, "0")}`;
  }

  function splitHex(hex) {
    const hx = normalizeHex(hex);
    return [Number(hx.slice(0, 2)), Number(hx.slice(2, 4))];
  }

  function onMap(hex) {
    try {
      normalizeHex(hex);
      return true;
    }
    catch {
      return false;
    }
  }

  function neighbors(hex) {
    const [col, row] = splitHex(hex);
    const even = (col - 1) % 2 === 0;
    const offsets = [
      [0, -1],
      [1, even ? -1 : 0],
      [1, even ? 0 : 1],
      [0, 1],
      [-1, even ? 0 : 1],
      [-1, even ? -1 : 0]
    ];
    return offsets
      .map(([dc, dr]) => `${String(col + dc).padStart(2, "0")}${String(row + dr).padStart(2, "0")}`)
      .filter(onMap);
  }

  function normalizeEdge(a, b) {
    const items = [normalizeHex(a), normalizeHex(b)];
    items.sort((x, y) => {
      const [xc, xr] = splitHex(x);
      const [yc, yr] = splitHex(y);
      return xc === yc ? xr - yr : xc - yc;
    });
    return `${items[0]}-${items[1]}`;
  }

  function oppositeSide(side) {
    return side === "axis" ? "allies" : "axis";
  }

  function phaseSide(phase) {
    if (String(phase).startsWith("axis_")) return "axis";
    if (String(phase).startsWith("allies_")) return "allies";
    return null;
  }

  function phaseKind(phase) {
    return String(phase || "").replace(/^axis_/, "").replace(/^allies_/, "");
  }

  function scenarioFinalTurn(scenario) {
    return SCENARIO_META[scenario]?.final_turn || 7;
  }

  function scenarioStartingVp(scenario, fallback = 0) {
    return SCENARIO_META[scenario]?.starting_vp ?? fallback;
  }

  function coastlineHexes(terrain) {
    const coastline = terrain?.notes?.coastline || terrain?.notes?.coastal_road;
    if (!Array.isArray(coastline)) return new Set();
    const result = new Set();
    for (const rawHex of coastline) {
      try { result.add(normalizeHex(rawHex)); }
      catch {
        // Ignore incomplete terrain-review placeholders.
      }
    }
    return result;
  }

  function coastalSeaHexes(terrain) {
    const coastline = coastlineHexes(terrain);
    const firstLandRowByColumn = new Map();
    for (const hex of coastline) {
      const col = Number(hex.slice(0, 2));
      const row = Number(hex.slice(2, 4));
      firstLandRowByColumn.set(col, Math.min(firstLandRowByColumn.get(col) ?? row, row));
    }
    const result = new Set();
    for (const [col, firstLandRow] of firstLandRowByColumn) {
      const bounds = COLUMN_ROW_BOUNDS[col];
      if (!bounds) continue;
      for (let row = bounds[0]; row < firstLandRow; row += 1) {
        result.add(`${String(col).padStart(2, "0")}${String(row).padStart(2, "0")}`);
      }
    }
    return result;
  }

  function createContext(input) {
    const state = input.state;
    const rules = { ...DEFAULT_RULES, ...(input.rules || {}) };
    rules.stacking = { ...DEFAULT_RULES.stacking, ...(input.rules?.stacking || {}) };
    rules.movement = { ...DEFAULT_RULES.movement, ...(input.rules?.movement || {}) };
    rules.movement.terrain_costs = { ...DEFAULT_RULES.movement.terrain_costs, ...(input.rules?.movement?.terrain_costs || {}) };
    rules.movement.road_mode = { ...DEFAULT_RULES.movement.road_mode, ...(input.rules?.movement?.road_mode || {}) };
    rules.combat = { ...DEFAULT_RULES.combat, ...(input.rules?.combat || {}) };
    const terrain = input.terrain || { hexes: {}, edges: {} };
    const roadPath = state?.scenario_meta?.road_path || input.roadPath || terrain.notes?.coastal_road || DEFAULT_ROAD_PATH;
    const normalizedRoadPath = roadPath.map((hex) => {
      try { return normalizeHex(hex); }
      catch { return null; }
    }).filter(Boolean);
    const roadEdges = new Set();
    for (let i = 1; i < normalizedRoadPath.length; i += 1) {
      try {
        roadEdges.add(normalizeEdge(normalizedRoadPath[i - 1], normalizedRoadPath[i]));
      }
      catch {
        // Keep data-review placeholders from breaking the engine.
      }
    }
    return {
      state,
      rules,
      terrain,
      roadPath: normalizedRoadPath,
      coastlineHexes: coastlineHexes(terrain),
      allSeaHexes: coastalSeaHexes(terrain),
      roadEdges
    };
  }

  function isPlayableSide(side) {
    return side === "axis" || side === "allies";
  }

  function isTrackMarker(unit) {
    const text = `${unit?.id || ""} ${unit?.name || ""} ${unit?.image || ""}`.toLowerCase();
    return text.includes("game-turn") || text.includes("turn marker") || text.includes("turn-record");
  }

  function isMapCounter(unit) {
    return !!unit && !unit.off_map && !isTrackMarker(unit);
  }

  function isEngineer(unit) {
    const text = `${unit?.name || ""} ${unit?.piece_type || ""} ${unit?.kind || ""}`.toLowerCase();
    return unit?.kind === "engineer" || text.includes("eng") || text.includes("engineer");
  }

  function isCombatUnit(unit) {
    return isMapCounter(unit) && isPlayableSide(unit.side) && ((unit.kind || "ground") === "ground" || isEngineer(unit)) && !unit.eliminated;
  }

  function canAttackUnit(unit) {
    const rawAttack = String(unit?.attack ?? "");
    return isCombatUnit(unit) && !unit.no_attack && !unit.parenthesized_attack && !unit.attack_parenthesized && !/[()]/.test(rawAttack);
  }

  function isSupplyUnit(unit) {
    const name = String(unit?.name || "").toLowerCase();
    return isMapCounter(unit) && isPlayableSide(unit.side) && unit.kind === "supply" && !name.includes("vanguard") && Number(unit.movement || 0) > 0 && !unit.eliminated;
  }

  function isMineUnit(unit) {
    return isMapCounter(unit) && unit.kind === "mine" && !unit.eliminated && unit.hex && !unit.cleared;
  }

  function isStackingUnit(unit) {
    return isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit);
  }

  function isMechanized(ctx, unit) {
    const type = String(unit?.piece_type || "").toLowerCase();
    if (type.includes("non")) return false;
    if (type.includes("mech") || type.includes("armor") || type.includes("armour") || type.includes("recon") || type.includes("tank")) return true;
    return Number(unit?.movement || 0) >= Number(ctx.rules.movement?.mechanized_threshold || 6);
  }

  function unitsArray(ctx, sourceState = ctx.state) {
    return Object.entries(sourceState.units || {}).map(([id, unit]) => ({ ...unit, id }));
  }

  function unitsByHex(ctx, units = unitsArray(ctx)) {
    const grouped = {};
    for (const unit of units) {
      if (!isMapCounter(unit) || !unit.hex || unit.eliminated) continue;
      const hx = normalizeHex(unit.hex);
      grouped[hx] ||= [];
      grouped[hx].push(unit);
    }
    return grouped;
  }

  function combatUnitsArray(ctx) {
    return unitsArray(ctx).filter(isCombatUnit);
  }

  function friendlyUnits(ctx, side) {
    return combatUnitsArray(ctx).filter((unit) => unit.side === side);
  }

  function enemyUnits(ctx, side) {
    return combatUnitsArray(ctx).filter((unit) => unit.side === oppositeSide(side));
  }

  function mineUnits(ctx) {
    return unitsArray(ctx).filter(isMineUnit);
  }

  function minesByHex(ctx) {
    const grouped = {};
    for (const mine of mineUnits(ctx)) {
      const hx = normalizeHex(mine.hex);
      grouped[hx] ||= [];
      grouped[hx].push(mine);
    }
    return grouped;
  }

  function minesAt(ctx, hex) {
    return minesByHex(ctx)[normalizeHex(hex)] || [];
  }

  function enemyMinesAt(ctx, side, hex) {
    const enemy = oppositeSide(side);
    return minesAt(ctx, hex).filter((mine) => mine.side === enemy && !mine.cleared);
  }

  function friendlyMinesAt(ctx, side, hex) {
    return minesAt(ctx, hex).filter((mine) => mine.side === side && !mine.cleared);
  }

  function edgeTags(ctx, edge) {
    const tags = ctx.terrain.edges?.[edge] || [];
    const list = Array.isArray(tags) ? tags : [tags];
    return ctx.roadEdges.has(edge) && !list.includes("road") ? [...list, "road"] : list;
  }

  function hexTags(ctx, hex) {
    const normalized = normalizeHex(hex);
    const tags = ctx.terrain.hexes?.[normalized] || [];
    const list = Array.isArray(tags) ? [...tags] : [tags];
    if (ctx.coastlineHexes?.has(normalized) && !list.includes("coastline")) list.push("coastline");
    if (ctx.allSeaHexes?.has(normalized) && !list.includes("sea") && !list.includes("all_sea")) list.push("all_sea");
    return list;
  }

  function hexDirection(origin, target) {
    return neighbors(origin).indexOf(normalizeHex(target));
  }

  function roadModeZocHexes(unit) {
    const facing = unit.road_facing ?? unit.facing;
    if (!unit.road_mode || facing == null) return [];
    const nbs = neighbors(unit.hex);
    return [nbs[Number(facing)], nbs[(Number(facing) + 3) % 6]].filter(Boolean);
  }

  function roadModeSpaceHexes(unit) {
    return roadModeZocHexes(unit);
  }

  function roadModeSpaceIssue(ctx, unit, hex, facing, sourceState = ctx.state) {
    const testUnit = { ...unit, hex: normalizeHex(hex), road_mode: true, road_facing: facing, facing };
    const grouped = unitsByHex(ctx, unitsArray(ctx, sourceState).filter(isStackingUnit));
    for (const space of roadModeSpaceHexes(testUnit)) {
      const occupants = (grouped[space] || []).filter((item) => item.id !== unit.id);
      if (occupants.length) return `道路模式前/后方 ${space} 必须保持空置`;
      for (const other of unitsArray(ctx, sourceState).filter((item) => item.id !== unit.id && item.road_mode && item.hex && !item.eliminated)) {
        if (roadModeSpaceHexes(other).includes(space)) return `道路移动空间 ${space} 与 ${other.id} 重叠`;
      }
    }
    return null;
  }

  function zocHexes(unit) {
    if (!isCombatUnit(unit) || isEngineer(unit)) return [];
    return unit.road_mode ? roadModeZocHexes(unit) : neighbors(unit.hex);
  }

  function enemyZocSources(ctx, side, hex, options = {}) {
    const hx = normalizeHex(hex);
    return new Set(enemyUnits(ctx, side)
      .filter((unit) => options.ignoreUnitId !== unit.id)
      .filter((unit) => zocHexes(unit).includes(hx))
      .map((unit) => unit.id));
  }

  function occupiedByEnemy(ctx, side) {
    return unitsByHex(ctx, enemyUnits(ctx, side));
  }

  function occupiedByFriendly(ctx, side) {
    return unitsByHex(ctx, unitsArray(ctx).filter((unit) => unit.side === side && !unit.eliminated && isStackingUnit(unit)));
  }

  function terrainKeyForMove(ctx, unit, target) {
    const tags = hexTags(ctx, target);
    if (tags.includes("sea") || tags.includes("all_sea")) return "sea";
    if (enemyMinesAt(ctx, unit.side, target).length && !isEngineer(unit)) return "enemy_minefield";
    if (tags.includes("depression")) return "depression";
    if (tags.includes("hill_or_ridge")) return "hill_or_ridge";
    return "clear";
  }

  function stepMovementCost(ctx, unit, origin, target, options = {}) {
    const edge = normalizeEdge(origin, target);
    const tags = edgeTags(ctx, edge);
    const roadMode = options.mode === "road";
    const mechanized = isMechanized(ctx, unit);
    if (tags.includes("sea") || hexTags(ctx, target).includes("all_sea")) {
      return { cost: Infinity, reason: `${origin} -> ${target} 是不可通过海边/海域` };
    }
    if (roadMode) {
      if (!tags.includes("road")) return { cost: Infinity, reason: "道路模式必须沿道路移动" };
      if (hexTags(ctx, target).includes("hill_or_ridge")) return { cost: Infinity, reason: "道路模式不能进入 ridge hex" };
      if (enemyMinesAt(ctx, unit.side, target).length) return { cost: Infinity, reason: "道路模式不能进入敌方雷区" };
      return { cost: 1, terrain: "road_mode", road: true };
    }
    const key = tags.includes("road") ? "clear" : terrainKeyForMove(ctx, unit, target);
    const table = ctx.rules.movement?.terrain_costs || DEFAULT_RULES.movement.terrain_costs;
    const value = table?.[key]?.[mechanized ? "mechanized" : "non_mechanized"];
    if (value == null) return { cost: Infinity, reason: `${target} 是禁止进入地形` };
    return { cost: Number(value || ctx.rules.movement.default_hex_cost || 1), terrain: tags.includes("road") ? "clear_road" : key, road: tags.includes("road") };
  }

  function movementCostSummary(steps = []) {
    const terrainLabels = {
      clear: "清晰地形",
      clear_road: "普通道路",
      hill_or_ridge: "山脊",
      depression: "洼地",
      enemy_minefield: "敌方雷区",
      road_mode: "道路移动"
    };
    const formatStep = (step) => {
      const cost = `${Number(step.cost || 0)} MP`;
      if (step.terrain === "leave_stack") return `离开 ${step.from} 堆叠 ${cost}`;
      if (step.terrain === "enter_stack") return `进入 ${step.to} 堆叠 ${cost}`;
      if (step.terrain === "enter_road_mode") return `进入道路模式 ${cost}`;
      if (step.terrain === "leave_road_mode") return `退出道路模式 ${cost}`;
      return `${step.from} → ${step.to} ${terrainLabels[step.terrain] || step.terrain || "移动"} ${cost}`;
    };
    if (steps.length <= 8) return steps.map(formatStep);
    const special = steps.filter((step) => ["leave_stack", "enter_stack", "enter_road_mode", "leave_road_mode"].includes(step.terrain)).map(formatStep);
    const grouped = new Map();
    for (const step of steps.filter((item) => !["leave_stack", "enter_stack", "enter_road_mode", "leave_road_mode"].includes(item.terrain))) {
      const label = terrainLabels[step.terrain] || step.terrain || "移动";
      const current = grouped.get(label) || { count: 0, cost: 0 };
      current.count += 1;
      current.cost += Number(step.cost || 0);
      grouped.set(label, current);
    }
    return [...special, ...[...grouped].map(([label, value]) => `${label} ${value.count} 格，共 ${value.cost} MP`)];
  }

  function effectiveMovement(ctx, unit) {
    let value = Number(unit.movement || 0);
    const supply = unit.supply_state || (unit.id ? supplyState(ctx, unit.id) : "supplied");
    if (supply === "unsupplied" || supply === "isolated") value = Math.floor(value / 2);
    return Math.max(0, value);
  }

  function roadModeTransitionCost(ctx, unit) {
    return isMechanized(ctx, unit)
      ? Number(ctx.rules.movement.road_mode.mechanized_entry_cost || 3)
      : Number(ctx.rules.movement.road_mode.non_mechanized_entry_cost || 1);
  }

  function movementAllowance(ctx, unit, options = {}) {
    const base = effectiveMovement(ctx, unit);
    if (options.mode !== "road") return base;
    const multiplier = Number(ctx.rules.movement?.road_mode?.multiplier || 5);
    const entryCost = Number(options.road_entry_cost || 0);
    if (entryCost <= 0) return Math.floor(base * multiplier);
    return entryCost + Math.max(0, base - entryCost) * multiplier;
  }

  function effectiveAttack(ctx, unit) {
    let value = Number(unit.attack || 0);
    const supply = unit.supply_state || (unit.id ? supplyState(ctx, unit.id) : "supplied");
    if (ctx.state.scenario === "september" && Number(ctx.state.turn || 1) === 1 && unit.side === "axis") value *= 2;
    if (unit.road_mode) value = Math.floor(value / 2);
    if (supply === "partially_supplied" || supply === "unsupplied") value = Math.floor(value / 2);
    if (supply === "isolated") value = 0;
    return Math.max(0, value);
  }

  function effectiveDefense(ctx, unit, hex = unit.hex, options = {}) {
    let value = Number(unit.defense ?? unit.attack ?? 0);
    const supply = unit.supply_state || (unit.id ? supplyState(ctx, unit.id) : "supplied");
    if (unit.road_mode) value = Math.floor(value / 2);
    if (supply === "isolated") value = Math.floor(value / 2);
    if (!options.ignoreFriendlyMine && friendlyMinesAt(ctx, unit.side, hex).length) value *= 2;
    return Math.max(supply === "isolated" ? 1 : 0, value);
  }

  function checkStacking(ctx, sourceState = ctx.state, options = {}) {
    const checkedHexes = options.hexes ? new Set(options.hexes.map(normalizeHex)) : null;
    const allCheckedUnits = Object.entries(sourceState.units || {})
        .map(([id, unit]) => ({ ...unit, id }))
        .filter(isStackingUnit);
    const grouped = unitsByHex(ctx, allCheckedUnits);
    const issues = [];
    for (const [hex, units] of Object.entries(grouped)) {
      if (checkedHexes && !checkedHexes.has(hex)) continue;
      const sides = new Set(units.map((unit) => unit.side).filter(isPlayableSide));
      if (ctx.rules.stacking.one_side_per_hex && sides.size > 1) issues.push(`${hex}: 敌我同格`);
      for (const side of sides) {
        const counted = units.filter((unit) => unit.side === side && !isEngineer(unit));
        const maxUnits = side === "axis"
          ? Number(ctx.rules.stacking.axis_max_units_per_hex || 4)
          : Number(ctx.rules.stacking.allied_max_units_per_hex || 3);
        if (counted.length > maxUnits) issues.push(`${hex}: ${side} ${counted.length} 个单位，超过 ${maxUnits}`);
      }
      if (units.some((unit) => unit.road_mode) && units.length > 1) issues.push(`${hex}: 道路模式单位不能堆叠`);
    }
    const roadUnits = allCheckedUnits.filter((unit) => unit.road_mode && unit.hex && !unit.eliminated);
    const roadSpaces = new Map();
    for (const unit of roadUnits) {
      const unitHex = normalizeHex(unit.hex);
      if (checkedHexes && !checkedHexes.has(unitHex) && !roadModeSpaceHexes(unit).some((hex) => checkedHexes.has(hex))) continue;
      for (const hex of roadModeSpaceHexes(unit)) {
        const occupants = (grouped[hex] || []).filter((item) => item.id !== unit.id);
        if (occupants.length) issues.push(`${unit.id}: 道路模式前/后方 ${hex} 必须保持空置`);
        const key = normalizeHex(hex);
        const previous = roadSpaces.get(key);
        if (previous && previous !== unit.id) issues.push(`${unit.id}: 道路移动空间 ${key} 与 ${previous} 重叠`);
        roadSpaces.set(key, unit.id);
      }
    }
    return { legal: issues.length === 0, reason: issues.length ? issues.join("\n") : "堆叠合法" };
  }

  function stackingLimitForSide(ctx, side) {
    return side === "axis"
      ? Number(ctx.rules.stacking.axis_max_units_per_hex || 4)
      : Number(ctx.rules.stacking.allied_max_units_per_hex || 3);
  }

  function countedStackingUnitsAt(ctx, side, hex, sourceState = ctx.state) {
    const target = normalizeHex(hex);
    return unitsArray(ctx, sourceState)
      .filter((unit) => isStackingUnit(unit)
        && unit.side === side
        && unit.hex
        && normalizeHex(unit.hex) === target
        && !isEngineer(unit));
  }

  function hexExceedsStackingLimit(ctx, side, hex, sourceState = ctx.state) {
    return countedStackingUnitsAt(ctx, side, hex, sourceState).length > stackingLimitForSide(ctx, side);
  }

  function temporaryOverstackGroups(ctx, side = null) {
    const markedHexes = new Set(unitsArray(ctx)
      .filter((unit) => (!side || unit.side === side) && unit.temporary_overstack && unit.hex && !unit.eliminated)
      .map((unit) => normalizeHex(unit.hex)));
    const groups = [];
    for (const hex of markedHexes) {
      const units = unitsArray(ctx).filter((unit) => isStackingUnit(unit) && unit.hex && normalizeHex(unit.hex) === hex && !unit.eliminated);
      const groupSide = units.find((unit) => isPlayableSide(unit.side))?.side;
      if (!groupSide || (side && groupSide !== side)) continue;
      const counted = units.filter((unit) => unit.side === groupSide && !isEngineer(unit));
      const limit = stackingLimitForSide(ctx, groupSide);
      if (counted.length <= limit) continue;
      groups.push({
        hex,
        side: groupSide,
        limit,
        excess: counted.length - limit,
        unit_ids: units.filter((unit) => unit.side === groupSide).map((unit) => unit.id),
        removable_unit_ids: counted.map((unit) => unit.id)
      });
    }
    return groups.sort((a, b) => a.hex.localeCompare(b.hex));
  }

  function markTemporaryOverstackAt(ctx, hex) {
    const target = normalizeHex(hex);
    const group = unitsArray(ctx).filter((unit) => isStackingUnit(unit) && unit.hex && normalizeHex(unit.hex) === target && !unit.eliminated);
    const side = group.find((unit) => isPlayableSide(unit.side))?.side;
    if (!side || !hexExceedsStackingLimit(ctx, side, target)) return [];
    const marked = [];
    for (const unit of group.filter((item) => item.side === side)) {
      ctx.state.units[unit.id].temporary_overstack = true;
      marked.push(unit.id);
    }
    return marked;
  }

  function clearTemporaryOverstackAt(ctx, hex) {
    const target = normalizeHex(hex);
    for (const unit of unitsArray(ctx)) {
      if (unit.hex && normalizeHex(unit.hex) === target && ctx.state.units[unit.id]) {
        ctx.state.units[unit.id].temporary_overstack = false;
      }
    }
  }

  function canMoveInCurrentPhase(ctx, unit) {
    const kind = phaseKind(ctx.state.phase);
    if (kind === "initial_movement") return (isCombatUnit(unit) || isEngineer(unit)) && unit.side === ctx.state.active_side;
    if (kind === "mechanized_movement") {
      return isCombatUnit(unit) && !isEngineer(unit) && isMechanized(ctx, unit) && !unit.attacked_this_turn && !unit.attacked_this_phase && unit.side === ctx.state.active_side;
    }
    if (kind === "supply_movement") return isSupplyUnit(unit) && unit.side === ctx.state.active_side;
    return false;
  }

  function roadIndex(ctx, hex) {
    return ctx.roadPath.indexOf(normalizeHex(hex));
  }

  function isRoadHex(ctx, hex) {
    const hx = normalizeHex(hex);
    return ctx.roadPath.includes(hx) || Object.keys(ctx.terrain.edges || {}).some((edge) => edge.includes(hx) && edgeTags(ctx, edge).includes("road"));
  }

  function friendlyUnitsAt(ctx, side, hex, options = {}) {
    return (occupiedByFriendly(ctx, side)[normalizeHex(hex)] || []).filter((unit) => unit.id !== options.ignoreUnitId);
  }

  function mayLeaveEnemyZoc(ctx, unit, origin) {
    if (!enemyZocSources(ctx, unit.side, origin).size) return true;
    return friendlyUnitsAt(ctx, unit.side, origin, { ignoreUnitId: unit.id }).length > 0;
  }

  function enteringRoadModeCost(ctx, unit, path, options) {
    const entering = options.mode === "road" && !unit.road_mode;
    if (!entering) return { legal: true, cost: 0 };
    if (!isCombatUnit(unit) && !isEngineer(unit)) return { legal: false, reason: "只有战斗单位可以进入道路模式" };
    if (!isMechanized(ctx, unit) && phaseKind(ctx.state.phase) !== "initial_movement") return { legal: false, reason: "非机械化单位只能在初始移动阶段进入道路模式" };
    if (supplyState(ctx, unit.id) !== "supplied") return { legal: false, reason: "进入道路模式必须有补给" };
    if (enemyZocSources(ctx, unit.side, path[0]).size) return { legal: false, reason: "敌 ZOC 中不能进入道路模式" };
    if (enemyMinesAt(ctx, unit.side, path[0]).length) return { legal: false, reason: "敌方雷区中不能进入道路模式" };
    if (friendlyUnitsAt(ctx, unit.side, path[0], { ignoreUnitId: unit.id }).length) return { legal: false, reason: "堆叠中不能进入道路模式" };
    const tags = hexTags(ctx, path[0]);
    if (tags.includes("depression") || tags.includes("hill_or_ridge")) return { legal: false, reason: "ridge/depression 中不能进入道路模式" };
    if (isMechanized(ctx, unit) && !isRoadHex(ctx, path[0])) return { legal: false, reason: "机械化单位只能在道路上进入道路模式" };
    return { legal: true, cost: roadModeTransitionCost(ctx, unit) };
  }

  function leavingRoadModeCost(ctx, unit, options) {
    const leaving = unit.road_mode && options.mode !== "road";
    if (!leaving) return { legal: true, cost: 0 };
    return { legal: true, cost: roadModeTransitionCost(ctx, unit) };
  }

  function checkScenarioMoveRestriction(ctx, unit, path) {
    if (ctx.state.scenario === "october" && unit.side === "axis" && Number(ctx.state.turn || 1) <= 10) {
      if (path.some((hex) => Number(hex.slice(0, 2)) < 18)) {
        return { legal: false, reason: "October 特殊规则：第 10 回合结束前 Axis 不能向西越过撤退线" };
      }
    }
    if (ctx.state.scenario === "july" && unit.side === "allies" && ctx.state.boxed_areas_active !== false) {
      const startsBoxed = !!unit.box_restricted || hexTags(ctx, unit.hex).includes("alamein_box");
      if (startsBoxed && path.some((hex) => !hexTags(ctx, hex).includes("alamein_box"))) {
        return { legal: false, reason: "July Boxed Area：受限 Allied 单位不能自愿离开方框区域" };
      }
    }
    return { legal: true };
  }

  function temporaryOverstackHexes(ctx, side) {
    return new Set(temporaryOverstackGroups(ctx, side).map((group) => group.hex));
  }

  function checkMove(ctx, unitId, rawPath, options = {}) {
    const unit = ctx.state.units?.[unitId];
    if (!unit) return { legal: false, reason: `未知单位 ${unitId}` };
    const fullUnit = { ...unit, id: unitId };
    if (fullUnit.side !== ctx.state.active_side) return { legal: false, reason: `${unitId} 属于 ${fullUnit.side}，当前主动方是 ${ctx.state.active_side}` };
    if (!canMoveInCurrentPhase(ctx, fullUnit)) return { legal: false, reason: `${ctx.state.phase} 阶段不允许该单位移动` };
    if ((fullUnit.state || "fresh") !== "fresh") return { legal: false, reason: `${unitId} 已 spent，不能移动` };
    const overstackHexes = phaseKind(ctx.state.phase).includes("movement") ? temporaryOverstackHexes(ctx, fullUnit.side) : new Set();
    const mustRepairOverstack = overstackHexes.size > 0;

    let path;
    try { path = rawPath.map(normalizeHex); }
    catch (error) { return { legal: false, reason: error.message }; }
    if (path.length < 2) return { legal: false, reason: "路径至少需要起点和终点" };
    if (normalizeHex(fullUnit.hex) !== path[0]) return { legal: false, reason: `路径起点是 ${path[0]}，但单位在 ${fullUnit.hex}` };
    if (mustRepairOverstack && !overstackHexes.has(path[0])) return { legal: false, reason: "必须先移动临时超堆叠 hex 中的单位以恢复合法堆叠" };
    if (!mayLeaveEnemyZoc(ctx, fullUnit, path[0])) return { legal: false, reason: "单个单位不能自愿离开敌方 ZOC，必须有友军留守" };
    if (enemyMinesAt(ctx, fullUnit.side, path[0]).length && !isEngineer(fullUnit)) {
      return { legal: false, reason: `${path[0]} 是敌方雷区，非工兵不能自愿离开，必须先清雷` };
    }
    const scenarioRule = checkScenarioMoveRestriction(ctx, fullUnit, path);
    if (!scenarioRule.legal) return scenarioRule;

    const roadCost = enteringRoadModeCost(ctx, fullUnit, path, options);
    if (!roadCost.legal) return roadCost;
    const leaveRoadCost = leavingRoadModeCost(ctx, fullUnit, options);
    if (!leaveRoadCost.legal) return leaveRoadCost;
    let spent = roadCost.cost + leaveRoadCost.cost;
    const steps = [];
    if (roadCost.cost) steps.push({ from: path[0], to: path[0], cost: roadCost.cost, terrain: "enter_road_mode" });
    if (leaveRoadCost.cost) steps.push({ from: path[0], to: path[0], cost: leaveRoadCost.cost, terrain: "leave_road_mode" });
    const enemyByHex = occupiedByEnemy(ctx, fullUnit.side);
    const allowance = movementAllowance(ctx, fullUnit, { ...options, road_entry_cost: roadCost.cost });

    for (let i = 1; i < path.length; i += 1) {
      const origin = path[i - 1];
      const target = path[i];
      if (!neighbors(origin).includes(target)) return { legal: false, reason: `${origin} -> ${target} 不是相邻格` };
      if (enemyByHex[target]) return { legal: false, reason: `${target} 有敌军，不能进入` };
      if (isSupplyUnit(fullUnit) && enemyMinesAt(ctx, fullUnit.side, target).length) return { legal: false, reason: "补给单位不能进入敌方雷区" };
      if (!mayLeaveEnemyZoc(ctx, fullUnit, origin)) return { legal: false, reason: "单个单位不能自愿离开敌方 ZOC，必须有友军留守" };

      const cost = stepMovementCost(ctx, fullUnit, origin, target, options);
      if (!Number.isFinite(cost.cost)) return { legal: false, reason: cost.reason || `${origin} -> ${target} 禁止移动` };
      spent += cost.cost;

      const originFriendlies = friendlyUnitsAt(ctx, fullUnit.side, origin, { ignoreUnitId: fullUnit.id });
      const targetFriendlies = friendlyUnitsAt(ctx, fullUnit.side, target, { ignoreUnitId: fullUnit.id });
      if (options.mode === "road" && targetFriendlies.length) return { legal: false, reason: "道路模式不能进入或穿过有单位的 hex" };
      const stackCost = isMechanized(ctx, fullUnit) ? 3 : 1;
      if (originFriendlies.length) {
        spent += stackCost;
        steps.push({ from: origin, to: origin, cost: stackCost, terrain: "leave_stack" });
      }
      if (targetFriendlies.length) {
        spent += stackCost;
        steps.push({ from: target, to: target, cost: stackCost, terrain: "enter_stack" });
      }

      steps.push({ from: origin, to: target, cost: cost.cost, terrain: cost.terrain || "clear", road: !!cost.road });
      if (options.mode === "road") {
        const previousDirection = i > 1
          ? hexDirection(path[i - 2], origin)
          : (fullUnit.road_mode ? Number(fullUnit.road_facing ?? fullUnit.facing) : null);
        const currentDirection = hexDirection(origin, target);
        if (previousDirection != null && Number.isFinite(previousDirection)) {
          const delta = Math.abs(previousDirection - currentDirection);
          if (!(delta === 0 || delta === 1 || delta === 5)) return { legal: false, reason: "道路模式每格最多只能转向相邻方向" };
        }
        const roadSpaceIssue = roadModeSpaceIssue(ctx, fullUnit, target, currentDirection);
        if (roadSpaceIssue) return { legal: false, reason: roadSpaceIssue };
      }
      const targetZoc = enemyZocSources(ctx, fullUnit.side, target);
      if (targetZoc.size && i !== path.length - 1) return { legal: false, reason: `${unitId} 进入敌 ZOC ${target} 后必须停止` };
    }

    if (spent > allowance) {
      const costs = movementCostSummary(steps);
      return {
        legal: false,
        reason: `移动力 ${allowance} MP，不足以完成路线；共需要 ${spent} MP${costs.length ? `：${costs.join(" + ")}` : ""}`,
        details: { spent, allowance, steps, costs }
      };
    }
    const projected = clone(ctx.state);
    projected.units[unitId].hex = path[path.length - 1];
    projected.units[unitId].road_mode = options.mode === "road";
    projected.units[unitId].road_facing = path.length > 1 ? hexDirection(path[path.length - 2], path[path.length - 1]) : projected.units[unitId].road_facing;
    projected.units[unitId].facing = projected.units[unitId].road_facing;
    projected.units[unitId].temporary_overstack = false;
    const repairingOrigin = mustRepairOverstack && overstackHexes.has(path[0]);
    const destinationStacking = checkStacking(ctx, projected, { hexes: [path[path.length - 1]] });
    if (!destinationStacking.legal) return destinationStacking;
    const originStacking = checkStacking(ctx, projected, { hexes: [path[0]] });
    if (!originStacking.legal && !repairingOrigin) return originStacking;
    const repairComplete = repairingOrigin && !hexExceedsStackingLimit(ctx, fullUnit.side, path[0], projected);
    return {
      legal: true,
      reason: repairComplete ? "移动合法，临时超堆叠已恢复" : repairingOrigin ? "移动合法，必须继续优先恢复临时超堆叠" : "移动合法",
      details: {
        spent,
        allowance,
        destination: path[path.length - 1],
        mode: options.mode || "normal",
        steps,
        repaired_temporary_overstack: repairComplete,
        progressed_temporary_overstack: repairingOrigin && !repairComplete
      }
    };
  }

  function checkLeaveRoadMode(ctx, unitId) {
    const unit = ctx.state.units?.[unitId];
    if (!unit) return { legal: false, reason: `未知单位 ${unitId}` };
    const fullUnit = { ...unit, id: unitId };
    if (!fullUnit.road_mode) return { legal: false, reason: `${unitId} 不在道路模式中` };
    if (fullUnit.side !== ctx.state.active_side) return { legal: false, reason: `${unitId} 属于 ${fullUnit.side}，当前主动方是 ${ctx.state.active_side}` };
    if (!canMoveInCurrentPhase(ctx, fullUnit)) return { legal: false, reason: `${ctx.state.phase} 阶段不允许该单位退出道路模式` };
    if ((fullUnit.state || "fresh") !== "fresh") return { legal: false, reason: `${unitId} 已 spent，不能退出道路模式` };
    const cost = roadModeTransitionCost(ctx, fullUnit);
    const allowance = effectiveMovement(ctx, fullUnit);
    if (cost > allowance) return { legal: false, reason: `移动力 ${allowance}，退出道路模式需要 ${cost}`, details: { spent: cost, allowance } };
    const projected = clone(ctx.state);
    projected.units[unitId].road_mode = false;
    projected.units[unitId].road_facing = null;
    projected.units[unitId].facing = null;
    const stacking = checkStacking(ctx, projected, { hexes: [fullUnit.hex] });
    if (!stacking.legal) return stacking;
    return { legal: true, reason: "可以退出道路模式", details: { spent: cost, allowance, destination: normalizeHex(fullUnit.hex), mode: "normal", steps: [{ from: fullUnit.hex, to: fullUnit.hex, cost, terrain: "leave_road_mode" }] } };
  }

  function leaveRoadMode(ctx, unitId) {
    const verdict = checkLeaveRoadMode(ctx, unitId);
    if (!verdict.legal) return verdict;
    const unit = ctx.state.units[unitId];
    unit.road_mode = false;
    unit.road_facing = null;
    unit.facing = null;
    unit.state = "spent";
    return { legal: true, reason: `${unitId} 已退出道路模式`, details: verdict.details };
  }

  function findLegalPath(ctx, unitId, targetHex, options = {}) {
    const unit = ctx.state.units?.[unitId];
    if (!unit || !unit.hex) return null;
    let target;
    try { target = normalizeHex(targetHex); }
    catch { return null; }
    const start = normalizeHex(unit.hex);
    if (start === target) return [start];
    const queue = [{ hex: start, path: [start], cost: 0 }];
    const best = new Map([[start, 0]]);
    while (queue.length) {
      queue.sort((a, b) => a.cost - b.cost);
      const current = queue.shift();
      for (const nb of neighbors(current.hex)) {
        const path = [...current.path, nb];
        const verdict = checkMove(ctx, unitId, path, options);
        if (!verdict.legal) continue;
        const spent = Number(verdict.details?.spent || 0);
        if (best.has(nb) && best.get(nb) <= spent) continue;
        best.set(nb, spent);
        if (nb === target) return path;
        queue.push({ hex: nb, path, cost: spent });
      }
    }
    return null;
  }

  function reachableHexes(ctx, unitId, options = {}) {
    const unit = ctx.state.units?.[unitId];
    if (!unit || !unit.hex) return new Map();
    const start = normalizeHex(unit.hex);
    const maxHexes = Number(options.maxHexes || 240);
    const result = new Map([[start, { cost: 0, path: [start] }]]);
    const queue = [{ hex: start, path: [start], cost: 0 }];
    while (queue.length && result.size <= maxHexes) {
      queue.sort((a, b) => a.cost - b.cost);
      const current = queue.shift();
      for (const nb of neighbors(current.hex)) {
        const path = [...current.path, nb];
        const verdict = checkMove(ctx, unitId, path, options);
        if (!verdict.legal) continue;
        const spent = Number(verdict.details?.spent || 0);
        if (result.has(nb) && result.get(nb).cost <= spent) continue;
        result.set(nb, { cost: spent, path });
        queue.push({ hex: nb, path, cost: spent });
      }
    }
    return result;
  }

  function diagnoseUnreachableMove(ctx, unitId, targetHex, options = {}) {
    const unit = ctx.state.units?.[unitId];
    if (!unit?.hex) return { legal: false, reason: `找不到单位 ${unitId} 或单位不在地图上` };
    let target;
    try { target = normalizeHex(targetHex); }
    catch (error) { return { legal: false, reason: error.message }; }
    const start = normalizeHex(unit.hex);
    if (start === target) return { legal: false, reason: `${unitId} 已经位于 ${target}` };

    const direct = checkMove(ctx, unitId, [start, target], options);
    if (neighbors(start).includes(target) || !String(direct.reason || "").includes("不是相邻格")) {
      return {
        ...direct,
        legal: false,
        reason: `${start} → ${target} 不能移动：${direct.reason || "裁判拒绝这一步"}`,
        details: { ...(direct.details || {}), start, target, blocked_step: [start, target] }
      };
    }

    const enemyAtTarget = occupiedByEnemy(ctx, unit.side)[target] || [];
    if (enemyAtTarget.length) {
      return {
        legal: false,
        reason: `${target} 有敌军 ${enemyAtTarget.map((item) => item.name || item.id).join("、")}，移动不能进入敌军占据格；应在战斗阶段发起攻击`,
        details: { start, target, category: "enemy_occupied", units: enemyAtTarget.map((item) => item.id) }
      };
    }

    const projected = clone(ctx.state);
    projected.units[unitId].hex = target;
    projected.units[unitId].temporary_overstack = false;
    const targetStacking = checkStacking(ctx, projected, { hexes: [target] });
    if (!targetStacking.legal) {
      return {
        legal: false,
        reason: `${target} 不能作为终点：${targetStacking.reason}`,
        details: { start, target, category: "stacking" }
      };
    }

    const reachable = reachableHexes(ctx, unitId, options);
    const approaches = neighbors(target)
      .map((hex) => ({ hex, route: reachable.get(hex) }))
      .filter((item) => item.route)
      .sort((a, b) => Number(a.route.cost || 0) - Number(b.route.cost || 0));
    for (const approach of approaches) {
      const path = [...approach.route.path, target];
      const verdict = checkMove(ctx, unitId, path, options);
      if (!verdict.legal) {
        return {
          legal: false,
          reason: `最接近目标的合法路线可到 ${approach.hex}，但 ${approach.hex} → ${target} 被阻止：${verdict.reason}`,
          details: { ...(verdict.details || {}), start, target, approach: approach.hex, path, blocked_step: [approach.hex, target] }
        };
      }
    }

    const firstStepFailures = neighbors(start)
      .map((hex) => ({ hex, verdict: checkMove(ctx, unitId, [start, hex], options) }))
      .filter((item) => !item.verdict.legal);
    const reasons = [...new Set(firstStepFailures.map((item) => item.verdict.reason).filter(Boolean))];
    if (firstStepFailures.length === neighbors(start).length && reasons.length) {
      return {
        legal: false,
        reason: `${start} 无法走出第一步：${reasons.slice(0, 3).join("；")}`,
        details: { start, target, category: "origin_blocked", reasons }
      };
    }

    const allowance = effectiveMovement(ctx, { ...unit, id: unitId });
    return {
      legal: false,
      reason: `${start} → ${target} 在 ${allowance} MP 内没有合法路线；途中受到地形费用、ZOC 停止或堆叠限制`,
      details: { start, target, allowance, category: "no_complete_route" }
    };
  }

  function supplyBlockedHexes(ctx, side) {
    const blocked = new Set();
    const friendlyHexes = new Set(unitsArray(ctx).filter((unit) => unit.side === side && unit.hex && !unit.eliminated && isMapCounter(unit)).map((unit) => normalizeHex(unit.hex)));
    for (const enemy of enemyUnits(ctx, side).filter((unit) => unit.hex)) {
      blocked.add(normalizeHex(enemy.hex));
      for (const hx of zocHexes(enemy)) {
        if (!friendlyHexes.has(hx)) blocked.add(hx);
      }
    }
    for (const mine of mineUnits(ctx).filter((mine) => mine.side === oppositeSide(side) && mine.hex)) blocked.add(normalizeHex(mine.hex));
    for (const hex of ctx.allSeaHexes || []) blocked.add(hex);
    for (const [hex, tagsRaw] of Object.entries(ctx.terrain.hexes || {})) {
      const tags = Array.isArray(tagsRaw) ? tagsRaw : [tagsRaw];
      if (tags.includes("depression") || tags.includes("sea") || tags.includes("all_sea")) blocked.add(normalizeHex(hex));
    }
    return blocked;
  }

  function edgeSupplySources(ctx, side) {
    const sources = new Set();
    const west = side === "axis";
    for (const [col, bounds] of Object.entries(COLUMN_ROW_BOUNDS)) {
      if ((west && Number(col) !== 1) || (!west && Number(col) !== 49)) continue;
      for (let row = bounds[0]; row <= bounds[1]; row += 1) sources.add(`${String(col).padStart(2, "0")}${String(row).padStart(2, "0")}`);
    }
    return sources;
  }

  function roadMarkerHex(ctx, side) {
    const markerUnits = unitsArray(ctx).filter((unit) => unit.side === side && /supply.vanguard|vanguard/i.test(`${unit.name || ""} ${unit.image || ""}`));
    if (markerUnits.length) {
      const markerUnit = markerUnits.find((unit) => isMapCounter(unit) && !unit.eliminated && unit.hex);
      return markerUnit ? normalizeHex(markerUnit.hex) : null;
    }
    const legacyMarker = ctx.state.road_supply_markers?.[side];
    return legacyMarker && onMap(legacyMarker) ? normalizeHex(legacyMarker) : null;
  }

  function activeRoadSegment(ctx, side) {
    const marker = roadMarkerHex(ctx, side);
    if (!marker) return new Set();
    const markerIndex = roadIndex(ctx, marker);
    if (markerIndex < 0) return new Set();
    const range = side === "axis"
      ? ctx.roadPath.slice(0, markerIndex + 1)
      : ctx.roadPath.slice(markerIndex);
    const blocked = supplyBlockedHexes(ctx, side);
    const segment = new Set();
    for (const hex of range) {
      if (blocked.has(hex)) break;
      segment.add(hex);
    }
    return segment;
  }

  function supplyDistancesFromSources(ctx, side, sources) {
    const blocked = supplyBlockedHexes(ctx, side);
    const usableSources = new Set([...sources].filter((source) => source && onMap(source) && !blocked.has(normalizeHex(source))));
    const distances = new Map();
    const queue = [];
    for (const source of usableSources) {
      distances.set(normalizeHex(source), 0);
      queue.push(normalizeHex(source));
    }
    while (queue.length) {
      const hex = queue.shift();
      const distance = distances.get(hex);
      for (const nb of neighbors(hex)) {
        if (distances.has(nb)) continue;
        if (blocked.has(nb) && !usableSources.has(nb)) continue;
        distances.set(nb, distance + 1);
        queue.push(nb);
      }
    }
    return distances;
  }

  function buildSupplyNetwork(ctx, side) {
    const edgeSources = edgeSupplySources(ctx, side);
    const roadSources = activeRoadSegment(ctx, side);
    const baseSources = new Set([...edgeSources, ...roadSources]);
    const sources = new Set(baseSources);
    let changed = true;
    while (changed) {
      changed = false;
      const distances = supplyDistancesFromSources(ctx, side, sources);
      for (const unit of unitsArray(ctx).filter((item) => item.side === side && item.hex && isSupplyUnit(item))) {
        const hx = normalizeHex(unit.hex);
        if (!sources.has(hx) && distances.has(hx) && distances.get(hx) <= 4) {
          sources.add(hx);
          changed = true;
        }
      }
    }
    const unitSources = new Set([...sources].filter((hex) => !baseSources.has(hex)));
    return {
      sources,
      unitSources,
      baseSources,
      roadSources,
      edgeSources,
      distances: supplyDistancesFromSources(ctx, side, sources),
      edgeDistances: supplyDistancesFromSources(ctx, side, edgeSources),
      roadDistances: supplyDistancesFromSources(ctx, side, roadSources),
      unitDistances: supplyDistancesFromSources(ctx, side, unitSources)
    };
  }

  function supplyState(ctx, unitId, network = null) {
    const raw = ctx.state.units?.[unitId];
    if (!raw) return "unknown";
    if (raw.eliminated) return "eliminated";
    if (raw.off_map || !raw.hex) return "off_map";
    const unit = { ...raw, id: unitId };
    if (ctx.state.scenario === "july" && unit.side === "allies" && hexTags(ctx, unit.hex).includes("alamein_box")) return "supplied";
    const net = network || buildSupplyNetwork(ctx, unit.side);
    const start = normalizeHex(unit.hex);
    const distance = net.distances.get(start);
    if (distance == null) return "isolated";
    const roadRange = isSupplyUnit(unit) ? 4 : 6;
    const genericRange = isSupplyUnit(unit) ? 4 : Number(unit.attack_supply_range || 6);
    const edgeDistance = net.edgeDistances?.get(start);
    if (edgeDistance != null && edgeDistance <= 4) return "supplied";
    const roadDistance = net.roadDistances?.get(start);
    if (roadDistance != null && roadDistance <= roadRange) return "supplied";
    const unitDistance = net.unitDistances?.get(start);
    if (unitDistance != null && unitDistance <= genericRange) return "supplied";
    if (
      (edgeDistance != null && edgeDistance <= 8) ||
      (roadDistance != null && roadDistance <= roadRange * 2) ||
      (unitDistance != null && unitDistance <= genericRange * 2)
    ) return "partially_supplied";
    return "unsupplied";
  }

  function checkSupply(ctx, side = ctx.state.active_side) {
    const result = {};
    const network = buildSupplyNetwork(ctx, side);
    for (const unit of unitsArray(ctx).filter((item) => item.side === side && item.hex && !item.off_map && (isCombatUnit(item) || isSupplyUnit(item) || isEngineer(item)))) {
      result[unit.id] = supplyState(ctx, unit.id, network);
    }
    return result;
  }

  function traceSupplyPath(ctx, unitId) {
    const unit = ctx.state.units?.[unitId];
    if (!unit || !unit.hex || !isPlayableSide(unit.side)) return [];
    const network = buildSupplyNetwork(ctx, unit.side);
    const start = normalizeHex(unit.hex);
    if (!network.distances.has(start)) return [];
    const sources = new Set([...network.sources].map(normalizeHex));
    const path = [start];
    let current = start;
    let guard = 0;
    while (!sources.has(current) && guard < 240) {
      guard += 1;
      const distance = network.distances.get(current);
      const next = neighbors(current)
        .filter((hex) => network.distances.has(hex))
        .sort((a, b) => network.distances.get(a) - network.distances.get(b))[0];
      if (!next || network.distances.get(next) >= distance) break;
      path.push(next);
      current = next;
    }
    return sources.has(current) ? path : [];
  }

  function combatOddsColumn(ctx, attack, defense) {
    if (defense <= 0) return "7-1";
    const columns = ctx.rules.combat?.odds_columns || DEFAULT_RULES.combat.odds_columns;
    const ratios = { "1-4": 0.25, "1-3": 1 / 3, "1-2": 0.5, "1-1": 1, "2-1": 2, "3-1": 3, "4-1": 4, "5-1": 5, "6-1": 6, "7-1": 7 };
    const value = attack / defense;
    if (value < ratios["1-4"]) return "1-4";
    let chosen = columns[0];
    for (const column of columns) if (value >= ratios[column]) chosen = column;
    return chosen;
  }

  function adjacentCombats(ctx, side = ctx.state.active_side) {
    const enemyByHex = unitsByHex(ctx, enemyUnits(ctx, side));
    const pairs = [];
    for (const unit of friendlyUnits(ctx, side).filter(canAttackUnit)) {
      for (const nb of neighbors(unit.hex)) {
        if (enemyByHex[nb]) pairs.push({ attacker: unit.id, attacker_hex: normalizeHex(unit.hex), defender_hex: nb, defenders: enemyByHex[nb].map((item) => item.id) });
      }
    }
    return pairs;
  }

  function requiredDefenderHexes(ctx, attackers) {
    const side = attackers[0]?.side;
    const enemyByHex = unitsByHex(ctx, enemyUnits(ctx, side));
    const required = new Set();
    for (const attacker of attackers) {
      for (const nb of neighbors(attacker.hex)) {
        if (enemyByHex[nb]?.length) required.add(nb);
      }
    }
    return required;
  }

  function terrainDefenseMultiplier(ctx, hex) {
    const tags = hexTags(ctx, hex);
    if (tags.includes("hill_or_ridge")) return 2;
    return 1;
  }

  function terrainDefenseBonus(ctx, hex) {
    const tags = hexTags(ctx, hex);
    if (tags.includes("alamein_box")) return 3;
    return 0;
  }

  function normalizeEngineerAssistIds(action) {
    const raw = action.engineer_assists || action.engineers || action.assisting_engineers || [];
    return Array.isArray(raw) ? raw : [raw].filter(Boolean);
  }

  function validateEngineerAssists(ctx, action, defenderHexes) {
    const ids = [...new Set(normalizeEngineerAssistIds(action))];
    const assists = [];
    for (const id of ids) {
      const unit = ctx.state.units?.[id];
      if (!unit) return { legal: false, reason: `协助工兵 ${id} 不存在` };
      const full = { ...unit, id };
      if (full.side !== ctx.state.active_side) return { legal: false, reason: "协助工兵必须属于当前主动方" };
      if (!isEngineer(full)) return { legal: false, reason: `${id} 不是工兵单位` };
      if ((full.state || "fresh") !== "fresh" || full.engineer_assisted_this_turn) return { legal: false, reason: `${id} 本回合不能再协助攻击` };
      if (full.mine_cleared_this_turn || full.cleared_mine_this_turn) return { legal: false, reason: `${id} 本回合已清雷，不能协助攻击` };
      if (full.just_cleared_mine_hex && normalizeHex(full.hex) === normalizeHex(full.just_cleared_mine_hex)) return { legal: false, reason: `${id} 不能从本回合刚清除雷区的 hex 协助攻击` };
      const assistedHexes = defenderHexes.filter((hex) => neighbors(full.hex).includes(hex) && friendlyMinesAt(ctx, oppositeSide(ctx.state.active_side), hex).length);
      if (!assistedHexes.length) return { legal: false, reason: `${id} 必须邻接位于敌方雷区中的被攻击单位` };
      assists.push({ id, hexes: assistedHexes });
    }
    return { legal: true, assists, assisted_hexes: [...new Set(assists.flatMap((item) => item.hexes))] };
  }

  function checkCombat(ctx, action) {
    const side = ctx.state.active_side;
    if (phaseKind(ctx.state.phase) !== "combat") return { legal: false, reason: "只能在 Combat Phase 结算战斗" };
    if (!action.attackers?.length) return { legal: false, reason: "请选择攻击单位" };
    if (!action.defender_hexes?.length) return { legal: false, reason: "请选择防御 hex" };
    let defenderHexes;
    try { defenderHexes = action.defender_hexes.map(normalizeHex); }
    catch (error) { return { legal: false, reason: error.message }; }
    const attackers = action.attackers.map((id) => ({ ...(ctx.state.units?.[id] || {}), id })).filter((unit) => ctx.state.units?.[unit.id]);
    if (attackers.length !== action.attackers.length) return { legal: false, reason: "攻击单位包含未知 id" };
    if (attackers.some((unit) => unit.side !== side)) return { legal: false, reason: "攻击单位必须属于当前主动方" };
    if (attackers.some((unit) => !canAttackUnit(unit))) return { legal: false, reason: "只有可攻击的作战单位可以攻击，括号战力单位不能攻击" };
    if (attackers.some((unit) => unit.state !== "fresh" || unit.attacked_this_turn || unit.attacked_this_phase)) return { legal: false, reason: "已行动或已攻击单位不能再次攻击" };
    if (attackers.some((unit) => supplyState(ctx, unit.id) === "isolated")) return { legal: false, reason: "孤立单位不能攻击" };
    if (attackers.some((unit) => enemyMinesAt(ctx, unit.side, unit.hex).length)) return { legal: false, reason: "位于未清除敌方雷区中的单位不能攻击" };
    if (attackers.some((unit) => unit.just_cleared_mine_hex && normalizeHex(unit.hex) === normalizeHex(unit.just_cleared_mine_hex))) return { legal: false, reason: "本玩家回合刚清除雷区的单位不能从该 hex 攻击" };
    if (attackers.some((unit) => !defenderHexes.some((hex) => neighbors(unit.hex).includes(hex)))) {
      return { legal: false, reason: "每个攻击单位必须邻接至少一个本次攻击的防御 hex" };
    }

    const enemyByHex = unitsByHex(ctx, enemyUnits(ctx, side));
    const defenders = [];
    for (const hex of defenderHexes) {
      const stack = enemyByHex[hex] || [];
      if (!stack.length) return { legal: false, reason: `${hex} 没有敌军` };
      if (!attackers.some((unit) => neighbors(unit.hex).includes(hex))) return { legal: false, reason: `没有攻击单位邻接 ${hex}` };
      if (stack.some((unit) => unit.defended_this_phase)) return { legal: false, reason: `${hex} 中已有单位本阶段防御过` };
      defenders.push(...stack);
    }

    const required = requiredDefenderHexes(ctx, attackers);
    const missing = [...required].filter((hex) => !defenderHexes.includes(hex));
    if (missing.length) return { legal: false, reason: "相邻敌军必须一并攻击", details: { missing } };
    const mineTargetCount = defenderHexes.filter((hex) => friendlyMinesAt(ctx, oppositeSide(side), hex).length || enemyMinesAt(ctx, side, hex).length).length;
    if (mineTargetCount && defenderHexes.length > 1) return { legal: false, reason: "不能在同一次攻击中同时攻击雷区内敌军和其他 hex" };
    const engineerAssist = validateEngineerAssists(ctx, action, defenderHexes);
    if (!engineerAssist.legal) return engineerAssist;

    const attack = attackers.reduce((sum, unit) => sum + effectiveAttack(ctx, unit), 0);
    let defense = 0;
    for (const defender of defenders) {
      const hex = normalizeHex(defender.hex);
      defense += effectiveDefense(ctx, defender, hex, { ignoreFriendlyMine: engineerAssist.assisted_hexes.includes(hex) }) * terrainDefenseMultiplier(ctx, hex);
    }
    defense += defenderHexes.reduce((sum, hex) => sum + terrainDefenseBonus(ctx, hex), 0);
    const column = combatOddsColumn(ctx, attack, defense);
    const outcome = action.die ? ctx.rules.combat?.crt?.[String(action.die)]?.[(ctx.rules.combat?.odds_columns || DEFAULT_RULES.combat.odds_columns).indexOf(column)] : null;
    const ruggedDefense = defenderHexes.some((hex) => hexTags(ctx, hex).includes("hill_or_ridge"));
    const finalOutcome = ruggedDefense && /^D[123]$/.test(outcome || "") ? "No Effect" : outcome;
    return {
      legal: true,
      reason: "战斗合法",
      details: {
        attack,
        defense,
        odds_column: column,
        die: action.die,
        outcome: finalOutcome,
        raw_outcome: outcome,
        attackers: attackers.map((unit) => unit.id),
        defender_hexes: defenderHexes,
        defenders: defenders.map((unit) => unit.id),
        engineer_assists: engineerAssist.assists,
        mine_defense_canceled_hexes: engineerAssist.assisted_hexes,
        rugged_defense: ruggedDefense
      }
    };
  }

  function legalRetreatHex(ctx, unit, hex) {
    if (occupiedByEnemy(ctx, unit.side)[hex]) return false;
    if (enemyZocSources(ctx, unit.side, hex).size) return false;
    if (hexTags(ctx, hex).includes("sea") || hexTags(ctx, hex).includes("all_sea")) return false;
    if (enemyMinesAt(ctx, unit.side, hex).length) return false;
    return true;
  }

  function compareTuples(a, b) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
      const left = a[i] ?? 0;
      const right = b[i] ?? 0;
      if (left !== right) return left - right;
    }
    return 0;
  }

  function retreatPriorityTuple(ctx, unit, hex) {
    const tags = hexTags(ctx, hex);
    const sources = [...buildSupplyNetwork(ctx, unit.side).sources];
    const sourceDistance = sources.length ? Math.min(...sources.map((source) => hexDistance(hex, source))) : Infinity;
    const friendlyMine = friendlyMinesAt(ctx, unit.side, hex).length > 0;
    const rugged = tags.includes("hill_or_ridge") || tags.includes("depression");
    const terrainRank = friendlyMine ? 1 : rugged ? 2 : 0;
    const friendlies = friendlyUnitsAt(ctx, unit.side, hex, { ignoreUnitId: unit.id }).length;
    return [sourceDistance, terrainRank, friendlies];
  }

  function retreatWouldOverstack(ctx, unit, hex) {
    if (isEngineer(unit)) return false;
    const existing = countedStackingUnitsAt(ctx, unit.side, hex).filter((item) => item.id !== unit.id).length;
    return existing + 1 > stackingLimitForSide(ctx, unit.side);
  }

  function retreatOptions(ctx, unitOrId, currentHex = null) {
    const id = typeof unitOrId === "string" ? unitOrId : unitOrId?.id;
    const raw = typeof unitOrId === "string" ? ctx.state.units?.[unitOrId] : unitOrId;
    if (!raw || !id) return [];
    const current = normalizeHex(currentHex || raw.hex);
    const unit = { ...raw, id, hex: current };
    const ranked = neighbors(current)
      .filter((hex) => legalRetreatHex(ctx, unit, hex))
      .map((hex) => ({ hex, priority: retreatPriorityTuple(ctx, unit, hex) }))
      .sort((a, b) => compareTuples(a.priority, b.priority) || a.hex.localeCompare(b.hex));
    if (!ranked.length) return [];
    const best = ranked[0].priority;
    const priorityOptions = ranked.filter((option) => compareTuples(option.priority, best) === 0);
    const withinLimit = priorityOptions.filter((option) => !retreatWouldOverstack(ctx, unit, option.hex));
    if (withinLimit.length) return withinLimit;
    return priorityOptions.length === 1
      ? priorityOptions.map((option) => ({ ...option, temporary_overstack: true }))
      : [];
  }

  function bestRetreatHex(ctx, unit, current, enemySide) {
    return retreatOptions(ctx, unit, current)[0]?.hex || null;
  }

  function hexDistance(a, b) {
    const [ac, ar] = splitHex(a);
    const [bc, br] = splitHex(b);
    return Math.abs(ac - bc) + Math.abs(ar - br);
  }

  function planRetreats(ctx, unitIds, count, retreatPaths = {}) {
    const simulation = createContext({ state: clone(ctx.state), rules: ctx.rules, terrain: ctx.terrain, roadPath: ctx.roadPath });
    const paths = {};
    const destinations = {};
    const eliminated = [];
    for (const id of unitIds) {
      const unit = simulation.state.units?.[id];
      if (!unit || unit.eliminated) continue;
      const requested = Array.isArray(retreatPaths?.[id]) ? retreatPaths[id] : [];
      if (requested.length > count) return { legal: false, complete: false, reason: `${id} 撤退路线超过 ${count} 格` };
      paths[id] = [];
      let current = normalizeHex(unit.hex);
      let blocked = false;
      for (let step = 0; step < count; step += 1) {
        const options = retreatOptions(simulation, { ...unit, id, hex: current }, current);
        if (!options.length) {
          unit.eliminated = true;
          unit.eliminated_reason = "blocked_retreat";
          eliminated.push(id);
          blocked = true;
          break;
        }
        if (requested[step] == null) {
          return {
            legal: true,
            complete: false,
            reason: `${id} 需要选择第 ${step + 1} 格撤退位置`,
            paths,
            destinations,
            eliminated,
            pending: { unit: id, from: current, step: step + 1, total: count, options }
          };
        }
        let chosen;
        try { chosen = normalizeHex(requested[step]); }
        catch (error) { return { legal: false, complete: false, reason: error.message, paths, destinations, eliminated }; }
        if (!options.some((option) => option.hex === chosen)) {
          return {
            legal: false,
            complete: false,
            reason: `${chosen} 不符合 ${id} 第 ${step + 1} 格撤退优先级`,
            paths,
            destinations,
            eliminated,
            pending: { unit: id, from: current, step: step + 1, total: count, options }
          };
        }
        paths[id].push(chosen);
        current = chosen;
        unit.hex = current;
      }
      if (blocked) continue;
      unit.hex = current;
      destinations[id] = current;
    }
    return { legal: true, complete: true, reason: "撤退路线已完成", paths, destinations, eliminated };
  }

  function autoPlanRetreats(ctx, unitIds, count) {
    const paths = {};
    const maxChoices = Math.max(1, unitIds.length * Math.max(1, Number(count) || 0));
    for (let choice = 0; choice <= maxChoices; choice += 1) {
      const plan = planRetreats(ctx, unitIds, count, paths);
      if (!plan.legal || plan.complete) return plan;
      const pending = plan.pending;
      const destination = pending?.options?.[0]?.hex;
      if (!pending?.unit || !destination) return { ...plan, legal: false, reason: plan.reason || "AI 无法完成撤退规划" };
      paths[pending.unit] ||= [];
      paths[pending.unit][pending.step - 1] = destination;
    }
    return { legal: false, complete: false, reason: "AI 撤退规划超过最大步骤", paths };
  }

  function retreatUnits(ctx, unitIds, count, enemySide, planned = null) {
    const eliminated = [];
    const retreated = [];
    const overstacked = [];
    for (const id of unitIds) {
      const unit = ctx.state.units[id];
      if (!unit || unit.eliminated) continue;
      if (planned?.eliminated?.includes(id)) {
        unit.eliminated = true;
        unit.eliminated_reason = "blocked_retreat";
        eliminated.push(id);
        continue;
      }
      if (planned?.destinations?.[id]) {
        unit.hex = normalizeHex(planned.destinations[id]);
        const marked = markTemporaryOverstackAt(ctx, unit.hex);
        if (marked.length) overstacked.push(...marked);
        retreated.push(id);
        continue;
      }
      let current = normalizeHex(unit.hex);
      let failed = false;
      for (let step = 0; step < count; step += 1) {
        const next = bestRetreatHex(ctx, { ...unit, id, hex: current }, current, enemySide);
        if (!next) {
          failed = true;
          break;
        }
        current = next;
      }
      if (failed) {
        unit.eliminated = true;
        unit.eliminated_reason = "blocked_retreat";
        eliminated.push(id);
      }
      else {
        unit.hex = current;
        const marked = markTemporaryOverstackAt(ctx, current);
        if (marked.length) overstacked.push(...marked);
        retreated.push(id);
      }
    }
    return { eliminated, retreated, overstacked: [...new Set(overstacked)] };
  }

  function overstackRepairOptions(ctx, hex) {
    const target = normalizeHex(hex);
    const group = temporaryOverstackGroups(ctx).find((item) => item.hex === target);
    if (!group || phaseKind(ctx.state.phase) !== "initial_movement" || ctx.state.active_side !== group.side) return [];
    const options = [];
    for (const id of group.unit_ids) {
      const unit = ctx.state.units?.[id];
      if (!unit || !canMoveInCurrentPhase(ctx, { ...unit, id }) || (unit.state || "fresh") !== "fresh") continue;
      for (const destination of neighbors(target)) {
        const verdict = checkMove(ctx, id, [target, destination], { mode: "normal" });
        if (verdict.legal) options.push({ unit: id, destination, verdict });
      }
    }
    return options;
  }

  function eliminateTemporaryOverstackUnit(ctx, unitId) {
    const unit = ctx.state.units?.[unitId];
    if (!unit || unit.eliminated || !unit.hex) return { legal: false, reason: `找不到可移除单位 ${unitId}` };
    const group = temporaryOverstackGroups(ctx, unit.side).find((item) => item.hex === normalizeHex(unit.hex));
    if (!group) return { legal: false, reason: `${unitId} 不在需要恢复的临时超堆叠中` };
    if (!group.removable_unit_ids.includes(unitId)) return { legal: false, reason: "工兵不计入堆叠上限，不能作为超限单位移除" };
    if (overstackRepairOptions(ctx, group.hex).length) return { legal: false, reason: "该堆叠仍可通过移动恢复，不能选择消灭单位" };
    eliminateUnits(ctx, [unitId], "unresolved_temporary_overstack");
    const stillOverstacked = hexExceedsStackingLimit(ctx, group.side, group.hex);
    if (stillOverstacked) markTemporaryOverstackAt(ctx, group.hex);
    else clearTemporaryOverstackAt(ctx, group.hex);
    return {
      legal: true,
      reason: stillOverstacked ? `${unitId} 已移除；该格仍超限，必须继续选择超限单位` : `${unitId} 已移除，临时超堆叠已恢复`,
      details: { eliminated: unitId, hex: group.hex, repair_complete: !stillOverstacked }
    };
  }

  function eliminateUnits(ctx, unitIds, reason) {
    const eliminated = [];
    for (const id of unitIds) {
      const unit = ctx.state.units[id];
      if (!unit || unit.eliminated) continue;
      unit.eliminated = true;
      unit.eliminated_reason = reason;
      unit.eliminated_turn = Number(ctx.state.turn || 1);
      unit.eliminated_phase = ctx.state.phase;
      eliminated.push(id);
    }
    return eliminated;
  }

  function exchangeAttackerLossIds(ctx, attackerIds, defenderIds) {
    const defenderStrength = defenderIds.reduce((sum, id) => sum + Number(ctx.state.units[id]?.defense || ctx.state.units[id]?.attack || 0), 0);
    let removed = 0;
    const eliminatedAttackers = [];
    for (const id of [...attackerIds].sort((a, b) => Number(ctx.state.units[b]?.attack || 0) - Number(ctx.state.units[a]?.attack || 0))) {
      if (removed >= defenderStrength) break;
      removed += Number(ctx.state.units[id]?.attack || 0);
      eliminatedAttackers.push(id);
    }
    return eliminatedAttackers;
  }

  function exchangeLosses(ctx, attackerIds, defenderIds) {
    const eliminatedDefenders = eliminateUnits(ctx, defenderIds, "exchange");
    const eliminatedAttackerIds = exchangeAttackerLossIds(ctx, attackerIds, defenderIds);
    const eliminatedAttackers = eliminateUnits(ctx, eliminatedAttackerIds, "exchange");
    return { eliminated_attackers: eliminatedAttackers, eliminated_defenders: eliminatedDefenders };
  }

  function combatAdvanceOptions(ctx, action) {
    const verdict = checkCombat(ctx, action);
    if (!verdict.legal) return { legal: false, available: false, reason: verdict.reason, options: [] };
    const outcome = verdict.details.outcome;
    if (!/^D[123]$/.test(outcome || "") && outcome !== "De" && outcome !== "Ex") {
      return { legal: true, available: false, reason: "本次战斗结果不允许进攻方战后推进", options: [] };
    }

    const eliminatedAttackers = outcome === "Ex"
      ? new Set(exchangeAttackerLossIds(ctx, verdict.details.attackers, verdict.details.defenders))
      : new Set();
    const candidateIds = verdict.details.attackers.filter((id) => !eliminatedAttackers.has(id));
    const options = [];
    for (const target of verdict.details.defender_hexes) {
      const tags = hexTags(ctx, target);
      if (tags.includes("hill_or_ridge") || tags.includes("depression")) continue;
      const side = ctx.state.units[candidateIds.find((id) => ctx.state.units[id])]?.side;
      if (side && enemyMinesAt(ctx, side, target).length) continue;
      for (const id of candidateIds) {
        const unit = ctx.state.units[id];
        if (!unit || unit.eliminated || !neighbors(unit.hex).includes(target)) continue;
        const origin = normalizeHex(unit.hex);
        const projected = clone(ctx.state);
        for (const defenderId of verdict.details.defenders) {
          if (projected.units[defenderId]) projected.units[defenderId].eliminated = true;
        }
        for (const attackerId of eliminatedAttackers) {
          if (projected.units[attackerId]) projected.units[attackerId].eliminated = true;
        }
        projected.units[id].hex = normalizeHex(target);
        projected.units[id].road_mode = false;
        projected.units[id].road_facing = null;
        projected.units[id].facing = null;
        projected.units[id].temporary_overstack = false;
        if (!checkStacking(ctx, projected, { hexes: [origin, target] }).legal) continue;
        options.push({ unit: id, target: normalizeHex(target) });
      }
    }
    return {
      legal: true,
      available: options.length > 0,
      reason: options.length ? "可以选择一个参战单位战后推进" : "没有合法的战后推进选择",
      options
    };
  }

  function advanceAfterCombat(ctx, unitIds, targetHex, options = {}) {
    const target = normalizeHex(targetHex);
    const allowedTargets = (options.allowedTargets || []).map(normalizeHex);
    if (allowedTargets.length && !allowedTargets.includes(target)) return null;
    if (!options.allowRugged && (hexTags(ctx, target).includes("hill_or_ridge") || hexTags(ctx, target).includes("depression"))) return null;
    if (!options.allowEnemyMine) {
      const side = ctx.state.units[unitIds.find((id) => ctx.state.units[id])]?.side;
      if (side && enemyMinesAt(ctx, side, target).length) return null;
    }
    const first = unitIds.find((id) => ctx.state.units[id] && !ctx.state.units[id].eliminated && neighbors(ctx.state.units[id].hex).includes(target));
    if (!first) return null;
    const origin = normalizeHex(ctx.state.units[first].hex);
    const projected = clone(ctx.state);
    projected.units[first].hex = target;
    projected.units[first].road_mode = false;
    projected.units[first].road_facing = null;
    projected.units[first].facing = null;
    projected.units[first].temporary_overstack = false;
    if (!checkStacking(ctx, projected, { hexes: [origin, target] }).legal) return null;
    ctx.state.units[first].hex = target;
    ctx.state.units[first].road_mode = false;
    ctx.state.units[first].road_facing = null;
    ctx.state.units[first].facing = null;
    return { unit: first, to: target };
  }

  function requestedAdvance(action, side) {
    const direct = side === "attacker"
      ? (action.advance_attacker || action.attacker_advance)
      : (action.advance_defender || action.defender_advance);
    if (direct === false) return { enabled: false };
    if (direct && typeof direct === "object") return { enabled: true, unit: direct.unit, target: direct.target || direct.hex || direct.to };
    const unit = side === "attacker"
      ? (action.advance_attacker_unit || action.attacker_advance_unit)
      : (action.advance_defender_unit || action.defender_advance_unit);
    const target = side === "attacker"
      ? (action.advance_attacker_hex || action.attacker_advance_hex)
      : (action.advance_defender_hex || action.defender_advance_hex);
    if (!direct && !unit && !target) return { enabled: false };
    return { enabled: true, unit, target };
  }

  function advanceAfterCombatChoice(ctx, candidateIds, defaultTarget, action, side, options = {}) {
    const request = requestedAdvance(action, side);
    if (!request.enabled) return null;
    const target = request.target || defaultTarget;
    if (!target) return null;
    const candidates = request.unit ? candidateIds.filter((id) => id === request.unit) : candidateIds;
    return advanceAfterCombat(ctx, candidates, target, options);
  }

  function resolveCombat(ctx, action) {
    const verdict = checkCombat(ctx, action);
    if (!verdict.legal) return verdict;
    if (!action.die) return { legal: false, reason: "结算战斗需要选择骰子" };
    const outcome = verdict.details.outcome;
    const attackerIds = verdict.details.attackers;
    const defenderIds = verdict.details.defenders;
    const retreatIds = /^A[123]$/.test(outcome) ? attackerIds : /^D[123]$/.test(outcome) ? defenderIds : [];
    const retreatCount = retreatIds.length ? Number(outcome.slice(1)) : 0;
    let explicitRetreatPlan = null;
    if (retreatCount && action.retreat_paths != null) {
      const requestedOrder = action.retreat_order == null ? retreatIds : action.retreat_order;
      const validOrder = Array.isArray(requestedOrder)
        && requestedOrder.length === retreatIds.length
        && new Set(requestedOrder).size === retreatIds.length
        && requestedOrder.every((id) => retreatIds.includes(id));
      if (!validOrder) return { legal: false, reason: "撤退处理顺序必须且只能包含所有撤退单位" };
      explicitRetreatPlan = planRetreats(ctx, requestedOrder, retreatCount, action.retreat_paths);
      if (!explicitRetreatPlan.legal || !explicitRetreatPlan.complete) {
        return {
          legal: false,
          reason: explicitRetreatPlan.reason || "撤退路线未完成",
          details: { ...verdict.details, retreat_plan: explicitRetreatPlan }
        };
      }
    }
    const attackerStartHexes = [...new Set(attackerIds.map((id) => ctx.state.units[id]?.hex).filter(Boolean).map(normalizeHex))];
    for (const id of attackerIds) {
      ctx.state.units[id].attacked_this_turn = true;
      ctx.state.units[id].attacked_this_phase = true;
      ctx.state.units[id].state = "spent";
      if (ctx.state.units[id].road_mode) {
        ctx.state.units[id].road_mode = false;
        ctx.state.units[id].road_facing = null;
      }
    }
    for (const id of defenderIds) ctx.state.units[id].defended_this_phase = true;
    for (const assist of verdict.details.engineer_assists || []) {
      if (ctx.state.units[assist.id]) ctx.state.units[assist.id].engineer_assisted_this_turn = true;
    }
    const effects = { outcome, eliminated: [], retreated: [], advanced: null, defender_advanced: null, exchange: null };
    if (/^A[123]$/.test(outcome)) {
      effects.retreated = retreatUnits(ctx, attackerIds, Number(outcome.slice(1)), oppositeSide(ctx.state.active_side), explicitRetreatPlan);
      effects.defender_advanced = advanceAfterCombatChoice(ctx, defenderIds, attackerStartHexes[0], action, "defender", { allowRugged: true, allowEnemyMine: true, allowedTargets: attackerStartHexes });
    }
    else if (/^D[123]$/.test(outcome)) {
      effects.retreated = retreatUnits(ctx, defenderIds, Number(outcome.slice(1)), ctx.state.active_side, explicitRetreatPlan);
      effects.advanced = advanceAfterCombatChoice(ctx, attackerIds, verdict.details.defender_hexes[0], action, "attacker", { allowedTargets: verdict.details.defender_hexes });
    }
    else if (outcome === "Ae") {
      effects.eliminated = eliminateUnits(ctx, attackerIds, "combat");
      effects.defender_advanced = advanceAfterCombatChoice(ctx, defenderIds, attackerStartHexes[0], action, "defender", { allowRugged: true, allowEnemyMine: true, allowedTargets: attackerStartHexes });
    }
    else if (outcome === "De") {
      effects.eliminated = eliminateUnits(ctx, defenderIds, "combat");
      effects.advanced = advanceAfterCombatChoice(ctx, attackerIds, verdict.details.defender_hexes[0], action, "attacker", { allowedTargets: verdict.details.defender_hexes });
    }
    else if (outcome === "Ex") {
      effects.exchange = exchangeLosses(ctx, attackerIds, defenderIds);
      effects.advanced = advanceAfterCombatChoice(ctx, attackerIds.filter((id) => !ctx.state.units[id].eliminated), verdict.details.defender_hexes[0], action, "attacker", { allowedTargets: verdict.details.defender_hexes });
    }
    return { legal: true, reason: `战斗已结算：${outcome}`, details: { ...verdict.details, effects } };
  }

  function clearMine(ctx, unitId, rawHex, die = null) {
    const unit = ctx.state.units?.[unitId];
    if (!unit) return { legal: false, reason: "请选择清雷单位" };
    const full = { ...unit, id: unitId };
    if (full.side !== ctx.state.active_side) return { legal: false, reason: "只能使用当前主动方单位清雷" };
    if (full.engineer_assisted_this_turn) return { legal: false, reason: "该工兵本回合已协助攻击，不能再清雷" };
    const hex = normalizeHex(rawHex);
    const mines = enemyMinesAt(ctx, full.side, hex);
    if (!mines.length) return { legal: false, reason: `${hex} 没有敌方雷区` };
    if (full.mine_cleared_this_turn || full.cleared_mine_this_turn) return { legal: false, reason: "该单位本回合已清雷" };
    if (isEngineer(full)) {
      if (phaseKind(ctx.state.phase) !== "initial_movement") return { legal: false, reason: "工兵清雷应在初始移动阶段进入雷区时发生" };
      if (![normalizeHex(full.hex), ...neighbors(full.hex)].includes(hex)) return { legal: false, reason: "工兵必须在雷区内或相邻 hex" };
    }
    else {
      if (!isCombatUnit(full)) return { legal: false, reason: "只有工兵或战斗单位可以清雷" };
      if (phaseKind(ctx.state.phase) !== "combat") return { legal: false, reason: "战斗单位只能在战斗阶段开始尝试清雷" };
      if (normalizeHex(full.hex) !== hex) return { legal: false, reason: "战斗单位必须位于敌方雷区内才能尝试清雷" };
      if (die == null) return { legal: false, reason: "战斗单位清雷需要骰子" };
      if ((full.side === "allies" && Number(die) === 1) || (full.side === "axis" && Number(die) <= 2)) {
        unit.mine_cleared_this_turn = true;
        unit.cleared_mine_this_turn = true;
        return { legal: true, reason: `清雷失败，骰子 ${die}`, details: { unit: unitId, mine_hex: hex, die: Number(die), cleared: false, removed: [] } };
      }
    }
    for (const mine of mines) {
      const stateMine = ctx.state.units[mine.id];
      stateMine.eliminated = true;
      stateMine.cleared = true;
      stateMine.eliminated_reason = "mine_cleared";
      stateMine.cleared_by_side = full.side;
      stateMine.cleared_turn = Number(ctx.state.turn || 1);
      stateMine.cleared_phase = ctx.state.phase;
    }
    unit.mine_cleared_this_turn = true;
    unit.cleared_mine_this_turn = true;
    unit.just_cleared_mine_hex = hex;
    return {
      legal: true,
      reason: `已清除 ${hex} 敌方雷区`,
      details: {
        unit: unitId,
        mine_hex: hex,
        die: isEngineer(full) ? null : Number(die),
        cleared: true,
        removed: mines.map((mine) => mine.id)
      }
    };
  }

  function calculateVictoryPoints(ctx) {
    const scenario = ctx.state.scenario || "custom";
    const breakdown = [];
    let vp = scenarioStartingVp(scenario, Number(ctx.state.victory_points || 0));
    breakdown.push({ id: "scenario_start", label: `${scenario} 初始 VP`, points: vp });
    const alliedCombatEliminated = unitsArray(ctx).filter((unit) => unit.eliminated && unit.side === "allies" && (unit.kind || "ground") === "ground" && ["combat", "blocked_retreat"].includes(unit.eliminated_reason || ""));
    if (alliedCombatEliminated.length) {
      vp += alliedCombatEliminated.length;
      breakdown.push({ id: "allied_combat_eliminated", label: "Allied 作战单位因 Ae/De/阻断撤退被消灭", points: alliedCombatEliminated.length, units: alliedCombatEliminated.map((unit) => unit.id) });
    }
    const isolatedEliminated = unitsArray(ctx).filter((unit) => unit.eliminated && unit.side === "allies" && (unit.kind || "ground") === "ground" && unit.eliminated_reason === "isolation");
    if (isolatedEliminated.length) {
      vp += isolatedEliminated.length;
      breakdown.push({ id: "allied_isolated_eliminated", label: "Allied 作战单位因孤立被消灭", points: isolatedEliminated.length, units: isolatedEliminated.map((unit) => unit.id) });
    }
    if (scenario === "july") {
      const eastAxis = unitsArray(ctx).filter((unit) => isMapCounter(unit) && !unit.eliminated && unit.side === "axis" && (unit.kind || "ground") === "ground" && unit.hex && Number(unit.hex.slice(0, 2)) > 34 && ["supplied", "partially_supplied"].includes(supplyState(ctx, unit.id)));
      const farthestCol = eastAxis.reduce((max, unit) => Math.max(max, Number(unit.hex.slice(0, 2))), 34);
      const points = Math.max(0, farthestCol - 34) * 3;
      if (points) {
        vp += points;
        breakdown.push({ id: "july_east_of_3400", label: "July: Axis 最东补给/部分补给作战单位超过 3400 列", points, farthest_column: farthestCol });
      }
    }
    if (scenario === "september") {
      const cleared = unitsArray(ctx).filter((unit) => unit.kind === "mine" && unit.side === "allies" && unit.eliminated && unit.eliminated_reason === "mine_cleared" && unit.cleared_by_side === "axis");
      if (cleared.length) {
        const points = cleared.length * 3;
        vp += points;
        breakdown.push({ id: "september_axis_cleared_mines", label: "September: Axis 清除 Allied 雷区", points, mines: cleared.map((unit) => unit.id) });
      }
    }
    if (scenario === "october") {
      const exited = unitsArray(ctx).filter((unit) => unit.side === "axis" && unit.eliminated !== true && (unit.exited_edge || unit.exit_edge || unit.exited) === "west" && Number(unit.exited_turn || unit.exit_turn || 0) > 10);
      const supply = exited.filter((unit) => unit.kind === "supply");
      const combat = exited.filter((unit) => (unit.kind || "ground") === "ground");
      if (supply.length) {
        const points = supply.length * 10;
        vp += points;
        breakdown.push({ id: "october_supply_exited_west", label: "October: Axis Supply units 在 Turn 10 后从西边撤出", points, units: supply.map((unit) => unit.id) });
      }
      const combatPoints = combat.reduce((sum, unit) => sum + Number(unit.attack || unit.defense || 0), 0);
      if (combatPoints) {
        vp += combatPoints;
        breakdown.push({ id: "october_combat_exited_west", label: "October: Axis Combat units 在 Turn 10 后从西边撤出", points: combatPoints, units: combat.map((unit) => unit.id) });
      }
    }
    return { victory_points: vp, breakdown };
  }

  function victoryLevel(vp) {
    if (vp >= 60) return { winner: "axis", label: "Axis Decisive" };
    if (vp >= 50) return { winner: "axis", label: "Axis Substantive" };
    if (vp >= 40) return { winner: "axis", label: "Axis Marginal" };
    if (vp >= 30) return { winner: null, label: "Draw" };
    if (vp >= 20) return { winner: "allies", label: "Allied Marginal" };
    if (vp >= 10) return { winner: "allies", label: "Allied Substantive" };
    return { winner: "allies", label: "Allied Decisive" };
  }

  function checkVictory(ctx) {
    const result = calculateVictoryPoints(ctx);
    const level = victoryLevel(result.victory_points);
    const final = ctx.state.phase === "end_game_turn" && Number(ctx.state.turn || 1) >= scenarioFinalTurn(ctx.state.scenario);
    return {
      winner: final ? level.winner : null,
      level: level.label,
      final,
      final_turn: scenarioFinalTurn(ctx.state.scenario),
      reason: final
        ? `${level.label} (${result.victory_points} VP)`
        : `未到最终结算：当前预计 ${level.label} (${result.victory_points} VP)，${ctx.state.scenario || "custom"} 场景最终 Turn ${scenarioFinalTurn(ctx.state.scenario)} 的 End of Game-Turn 判定`,
      ...result
    };
  }

  function nextPhase(ctx) {
    const sequence = ctx.rules.turn_sequence || DEFAULT_RULES.turn_sequence;
    const current = sequence.indexOf(ctx.state.phase);
    let next = sequence[(current + 1) % sequence.length] || sequence[0];
    const skip = SCENARIO_META[ctx.state.scenario]?.skip_phases?.find((item) => item.turn === Number(ctx.state.turn || 1) && item.phase === next);
    if (skip) next = skip.next;
    const turnEnds = ctx.state.phase === "end_game_turn" || next === sequence[0];
    return { phase: next, turn_increment: turnEnds ? 1 : 0, active_side: phaseSide(next) || ctx.state.active_side };
  }

  function applyStateDefaults(state) {
    if (!state.rules_version || state.rules_version === "first-alamein-standard-v1") {
      state.rules_version = "el-alamein-cn-translation-v1";
    }
    state.scenario_meta = { ...(SCENARIO_META[state.scenario] || {}), ...(state.scenario_meta || {}), standard_scenario_only: true };
    if (state.scenario === "october" && (!state.phase || state.phase === "axis_initial_movement")) {
      state.phase = "allies_initial_movement";
      state.active_side = "allies";
    }
    state.road_supply_markers ||= {};
    const markerContext = createContext({ state, rules: DEFAULT_RULES, terrain: {} });
    for (const side of ["axis", "allies"]) {
      const hasMarkerCounter = unitsArray(markerContext).some((unit) => unit.side === side && /supply.vanguard|vanguard/i.test(`${unit.name || ""} ${unit.image || ""}`));
      const marker = roadMarkerHex(markerContext, side);
      if (marker) state.road_supply_markers[side] = marker;
      else if (hasMarkerCounter) delete state.road_supply_markers[side];
    }
    for (const [id, unit] of Object.entries(state.units || {})) {
      unit.supply_state ||= "supplied";
      unit.road_mode = !!unit.road_mode;
      unit.road_facing ??= unit.facing ?? null;
      unit.attacked_this_turn = !!unit.attacked_this_turn;
      unit.attacked_this_phase = !!unit.attacked_this_phase;
      unit.defended_this_phase = !!unit.defended_this_phase;
      unit.mine_cleared_this_turn = !!(unit.mine_cleared_this_turn || unit.cleared_mine_this_turn);
      unit.cleared_mine_this_turn = unit.mine_cleared_this_turn;
      unit.engineer_assisted_this_turn = !!unit.engineer_assisted_this_turn;
      delete unit.mine_cleared_entry;
      if (state.scenario === "july" && unit.side === "allies" && unit.hex) unit.box_restricted ??= false;
      if (id) unit.id = id;
    }
    return state;
  }

  return {
    COLUMN_ROW_BOUNDS,
    DEFAULT_RULES,
    SCENARIO_META,
    DEFAULT_ROAD_PATH,
    createContext,
    normalizeHex,
    splitHex,
    onMap,
    neighbors,
    normalizeEdge,
    oppositeSide,
    phaseSide,
    phaseKind,
    scenarioFinalTurn,
    scenarioStartingVp,
    isPlayableSide,
    isTrackMarker,
    isMapCounter,
    isEngineer,
    isCombatUnit,
    isSupplyUnit,
    isMechanized,
    unitsArray,
    unitsByHex,
    combatUnitsArray,
    friendlyUnits,
    enemyUnits,
    mineUnits,
    minesByHex,
    minesAt,
    enemyMinesAt,
    friendlyMinesAt,
    edgeTags,
    hexTags,
    hexDirection,
    zocHexes,
    roadModeSpaceHexes,
    enemyZocSources,
    stepMovementCost,
    roadModeTransitionCost,
    movementAllowance,
    effectiveMovement,
    effectiveAttack,
    effectiveDefense,
    canAttackUnit,
    checkStacking,
    stackingLimitForSide,
    temporaryOverstackGroups,
    overstackRepairOptions,
    eliminateTemporaryOverstackUnit,
    canMoveInCurrentPhase,
    checkMove,
    checkLeaveRoadMode,
    leaveRoadMode,
    findLegalPath,
    reachableHexes,
    diagnoseUnreachableMove,
    supplyBlockedHexes,
    buildSupplyNetwork,
    supplyState,
    checkSupply,
    traceSupplyPath,
    combatOddsColumn,
    adjacentCombats,
    checkCombat,
    combatAdvanceOptions,
    resolveCombat,
    clearMine,
    legalRetreatHex,
    retreatOptions,
    planRetreats,
    autoPlanRetreats,
    calculateVictoryPoints,
    victoryLevel,
    checkVictory,
    nextPhase,
    applyStateDefaults,
    hexDistance,
    activeRoadSegment
  };
});
