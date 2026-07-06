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

const MAP_ZONE_POLYGON = "54,31;1926,29;1960,85;1934,133;1953,166;2007,168;2034,211;2085,213;2113,259;2166,261;2194,306;2243,308;2276,352;2329,355;2356,397;2408,400;2438,442;2489,445;2519,492;2571,492;2601,537;2653,540;2684,584;2732,585;2763,633;2819,634;2845,678;2894,679;2925,726;2976,726;3005,774;3055,775;3086,820;3138,821;3168,864;3216,866;3890,870;4051,866;4056,3235;1854,3228;1825,3173;1847,3125;1827,3078;1849,3028;1823,2982;1850,2936;1826,2889;1847,2843;1823,2797;1846,2748;1821,2705;1842,2656;1824,2607;1845,2563;1824,2516;1847,2470;1824,2421;1849,2373;1823,2327;1850,2281;1825,2235;1851,2187;1823,2141;1853,2095;1831,2061;1780,2062;1749,2012;1698,2012;1662,1954;1686,1908;1666,1873;1616,1871;1582,1818;1609,1769;1588,1732;1536,1733;1508,1685;1452,1685;1417,1627;1441,1581;1416,1527;1443,1487;1427,1455;1378,1454;1346,1406;1289,1406;1261,1359;1204,1357;1182,1314;1129,1315;1100,1267;1050,1267;1021,1219;963,1219;939,1172;883,1172;857,1122;804,1123;774,1075;720,1074;693,1031;642,1031;616,982;559,981;533,937;480,934;454,888;401,888;371,843;313,841;287,796;236,797;208,748;157,744;133,701;51,701"
  .split(";")
  .map((pair) => pair.split(",").map(Number));

const DEFAULT_RULES = {
  game: {
    axis_supply_sources: ["0101", "0501"],
    allies_supply_sources: ["3711", "4934", "1211", "0407"],
    alamein_hex: "3711"
  },
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
  stacking: { allied_max_units_per_hex: 3, axis_max_units_per_hex: 4, max_divisions_per_hex: 2, one_side_per_hex: true },
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
  victory: {
    axis: [
      { id: "reach_alamein", phase: "end_game_turn", supplied_unit_on: "3711" }
    ],
    allies: [
      { id: "reach_axis_entry", phase: "end_game_turn", supplied_unit_on: "0101" },
      { id: "hold_alamein_on_turn_10", phase: "end_game_turn", turn: 10, control: "3711" }
    ]
  }
};

const FALLBACK_STATE = {
  turn: 7,
  phase: "axis_initial_movement",
  active_side: "axis",
  control: { "3711": "allies" },
  units: {
    "axis-2307": { side: "axis", hex: "2307", state: "fresh", attack: 1, defense: 1, movement: 3, size: "division", kind: "ground" },
    "axis-2308": { side: "axis", hex: "2308", state: "fresh", attack: 1, defense: 1, movement: 3, size: "division", kind: "ground" },
    "axis-2713": { side: "axis", hex: "2713", state: "fresh", attack: 1, defense: 1, movement: 6, size: "regiment", kind: "ground" },
    "axis-2810": { side: "axis", hex: "2810", state: "fresh", attack: 2, defense: 2, movement: 4, size: "regiment", kind: "ground" },
    "allies-3011": { side: "allies", hex: "3011", state: "fresh", attack: 2, defense: 2, movement: 8, size: "division", kind: "ground" },
    "allies-3321": { side: "allies", hex: "3321", state: "fresh", attack: 3, defense: 3, movement: 4, size: "division", kind: "ground" },
    "allies-3711": { side: "allies", hex: "3711", state: "fresh", attack: 3, defense: 3, movement: 4, size: "division", kind: "ground" }
  }
};

const SCENARIO_URLS = {
  july: "./scenarios/july.json",
  september: "./scenarios/september.json",
  october: "./scenarios/october.json"
};

const APP_VERSION = "v2026.07.06.42";
const ASSET_VERSION = "20260706-42";
const SAVE_SLOTS_STORAGE_KEY = "alamein_judge_studio.save_slots.v1";
const AI_PROFILES_STORAGE_KEY = "alamein_judge_studio.ai_profiles.v1";
const MAX_SAVE_SLOTS = 12;

const DEFAULT_COUNTER_IMAGES = {
  axis: {
    ground: "mod_images/125-Inf.png",
    mechanized: "mod_images/2-10-pzg.png",
    engineer: "mod_images/axis-engineers.png",
    supply: "mod_images/Axis-Supply-1.png",
    mine: "mod_images/axis-mines.png",
    road_mode: "mod_images/Axis-Road-Mode.png",
    vanguard: "mod_images/Axis-Supply-Vanguard.png"
  },
  allies: {
    ground: "mod_images/2-4-CW-inf.png",
    mechanized: "mod_images/2-10-pzg.png",
    engineer: "mod_images/allied-engineers.png",
    supply: "mod_images/Allied-Supply.png",
    mine: "mod_images/allies-mines.png",
    road_mode: "mod_images/Allies-Road-Mode.png",
    vanguard: "mod_images/Allies-Supply-Vanguard.png"
  },
  neutral: {
    marker: "mod_images/game-turn-axis.png",
    supply: "mod_images/supply.png",
    mine: "mod_images/mines-brown.png"
  }
};

let rules = structuredClone(DEFAULT_RULES);
let terrain = { hexes: {}, edges: {} };
let state = structuredClone(FALLBACK_STATE);
let aiSuggestion = null;
let selectedUnitId = null;
let selectedHexId = null;
let movePathDraft = [];
let actionLog = [];
let highlightedSupplyPath = [];
let selectedCombatDefenderHex = null;
let aiAutoRunning = false;
let suppressAiActionRender = false;
let setupMode = "home";
let aiScoreSupplyCache = null;
let aiSupplyScorePhaseCache = null;

const el = (id) => document.getElementById(id);
const RulesEngine = globalThis.AlameinRules;

function versionedLocalUrl(url) {
  if (/^(?:https?:|data:|blob:)/i.test(String(url))) return url;
  return `${url}${String(url).includes("?") ? "&" : "?"}v=${encodeURIComponent(ASSET_VERSION)}`;
}

function syncVersionLabels() {
  document.documentElement.dataset.appVersion = APP_VERSION;
  document.title = `Alamein Judge Studio ${APP_VERSION}`;
  if (el("setupVersionText")) el("setupVersionText").textContent = APP_VERSION;
  if (el("appVersionText")) el("appVersionText").textContent = APP_VERSION;
}

const settings = {
  originX: 30,
  originY: 36,
  colStep: 80.9,
  rowStep: 93.7,
  rowOffset: 46.85,
  unitSize: 54,
  stackSpread: 38,
  zoom: 72
};

function rulesContext(sourceState = state) {
  return RulesEngine.createContext({ state: sourceState, rules, terrain });
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

function unitsArray() {
  return Object.entries(state.units || {}).map(([id, unit]) => ({ ...unit, id }));
}

function isPlayableSide(side) {
  return side === "axis" || side === "allies";
}

function isTrackMarker(unit) {
  const text = `${unit.id || ""} ${unit.name || ""} ${unit.image || ""}`.toLowerCase();
  return text.includes("game-turn") || text.includes("turn marker") || text.includes("turn-record");
}

function isMapCounter(unit) {
  return !unit.off_map && !isTrackMarker(unit);
}

function isCombatUnit(unit) {
  return isMapCounter(unit) && isPlayableSide(unit.side) && (unit.kind || "ground") === "ground" && !unit.eliminated;
}

function isSupplyUnit(unit) {
  const name = String(unit.name || "").toLowerCase();
  return isMapCounter(unit) && isPlayableSide(unit.side) && unit.kind === "supply" && !name.includes("vanguard") && Number(unit.movement || 0) > 0 && !unit.eliminated;
}

function isEngineer(unit) {
  const text = `${unit.name || ""} ${unit.piece_type || ""}`.toLowerCase();
  return text.includes("eng") || text.includes("engineer");
}

function isMechanized(unit) {
  return RulesEngine.isMechanized(rulesContext(), unit);
}

function defaultCounterImage(unit) {
  const side = isPlayableSide(unit.side) ? unit.side : "neutral";
  const images = DEFAULT_COUNTER_IMAGES[side] || DEFAULT_COUNTER_IMAGES.neutral;
  const text = `${unit.id || ""} ${unit.name || ""} ${unit.kind || ""} ${unit.piece_type || ""}`.toLowerCase();
  if (text.includes("road") && text.includes("mode")) return images.road_mode || images.marker;
  if (text.includes("vanguard")) return images.vanguard || images.supply || images.marker;
  if (unit.kind === "mine" || text.includes("minefield")) return images.mine || images.marker;
  if (unit.kind === "supply" || text.includes("supply")) return images.supply || images.marker;
  if (isEngineer(unit)) return images.engineer || images.ground || images.marker;
  if (isMechanized(unit)) return images.mechanized || images.ground || images.marker;
  return images.ground || images.marker;
}

function counterImageFor(unit) {
  return unit.image || defaultCounterImage(unit);
}

function unitTypeGroup(unit) {
  const text = `${unit.piece_type || ""} ${unit.name || ""} ${unit.kind || ""}`.toLowerCase();
  if (unit.kind === "mine") return { key: "mine", label: "雷区", order: 90 };
  if (isSupplyUnit(unit) || unit.kind === "supply") return { key: "supply", label: "补给", order: 80 };
  if (isEngineer(unit)) return { key: "engineer", label: "工程兵", order: 50 };
  if (text.includes("armor") || text.includes("tank") || text.includes("armoured")) return { key: "armor", label: "装甲", order: 10 };
  if (text.includes("recon")) return { key: "recon", label: "侦察", order: 20 };
  if (text.includes("mechanized") || text.includes("mech")) return { key: "mechanized", label: "机械化", order: 30 };
  if (text.includes("para")) return { key: "paratroop", label: "伞兵", order: 42 };
  if (text.includes("airborne")) return { key: "airborne", label: "空降步兵", order: 43 };
  if (text.includes("inf") || text.includes("infantry")) return { key: "infantry", label: "步兵", order: 40 };
  if (text.includes("anti-air") || text.includes("aa")) return { key: "anti_air", label: "防空", order: 60 };
  if (isCombatUnit(unit)) return { key: "combat_unknown", label: isMechanized(unit) ? "机械化作战单位" : "非机械化作战单位", order: isMechanized(unit) ? 35 : 45 };
  return { key: "marker", label: "标记", order: 99 };
}

function combatUnitsArray() {
  return unitsArray().filter(isCombatUnit);
}

function unitsByHex(units = unitsArray()) {
  const grouped = {};
  for (const unit of units) {
    if (!isMapCounter(unit)) continue;
    if (!unit.hex || unit.eliminated) continue;
    const hx = normalizeHex(unit.hex);
    grouped[hx] ||= [];
    grouped[hx].push(unit);
  }
  return grouped;
}

function mineUnits() {
  return unitsArray().filter((unit) => isMapCounter(unit) && unit.kind === "mine" && !unit.eliminated && unit.hex);
}

function minesByHex() {
  const grouped = {};
  for (const mine of mineUnits()) {
    const hx = normalizeHex(mine.hex);
    grouped[hx] ||= [];
    grouped[hx].push(mine);
  }
  return grouped;
}

function friendlyUnits(side) {
  return combatUnitsArray().filter((unit) => unit.side === side);
}

function enemyUnits(side) {
  return combatUnitsArray().filter((unit) => unit.side !== side);
}

function oppositeSide(side) {
  return side === "axis" ? "allies" : "axis";
}

function hexDirection(origin, target) {
  return neighbors(origin).indexOf(normalizeHex(target));
}

function roadModeZocHexes(unit) {
  const facingValue = unit.road_facing ?? unit.facing;
  if (!unit.road_mode || facingValue == null) return [];
  const nbs = neighbors(unit.hex);
  const facing = Number(facingValue);
  return [nbs[facing], nbs[(facing + 3) % 6]].filter(Boolean);
}

function zocHexes(unit) {
  if (!isCombatUnit(unit)) return [];
  return unit.road_mode ? roadModeZocHexes(unit) : neighbors(unit.hex);
}

function enemyZocSources(side, hex) {
  const hx = normalizeHex(hex);
  return new Set(enemyUnits(side).filter((unit) => zocHexes(unit).includes(hx)).map((unit) => unit.id));
}

function edgeTags(edge) {
  return terrain.edges?.[edge] || [];
}

function hexTags(hex) {
  return terrain.hexes?.[normalizeHex(hex)] || [];
}

function minesAt(hex) {
  return minesByHex()[normalizeHex(hex)] || [];
}

function enemyMinesAt(side, hex) {
  const enemy = oppositeSide(side);
  return minesAt(hex).filter((mine) => mine.side === enemy && !mine.cleared);
}

function friendlyMinesAt(side, hex) {
  return minesAt(hex).filter((mine) => mine.side === side && !mine.cleared);
}

function terrainKeyForMove(unit, target, options = {}) {
  const tags = hexTags(target);
  if (tags.includes("sea") || tags.includes("all_sea")) return "sea";
  if (enemyMinesAt(unit.side, target).length && !isEngineer(unit)) return "enemy_minefield";
  if (tags.includes("depression")) return "depression";
  if (tags.includes("hill_or_ridge")) return "hill_or_ridge";
  return "clear";
}

function movementCost(unit, origin, target, options = {}) {
  return RulesEngine.stepMovementCost(rulesContext(), unit, origin, target, options);
}

function movementAllowance(unit, options = {}) {
  return RulesEngine.movementAllowance(rulesContext(), unit, options);
}

function effectiveMovement(unit) {
  return RulesEngine.effectiveMovement(rulesContext(), unit);
}

function effectiveAttack(unit) {
  return RulesEngine.effectiveAttack(rulesContext(), unit);
}

function effectiveDefense(unit, hex = unit.hex) {
  return RulesEngine.effectiveDefense(rulesContext(), unit, hex);
}

function checkStacking(sourceState = state, options = {}) {
  return RulesEngine.checkStacking(rulesContext(sourceState), sourceState, options);
}

function phaseSide(phase = state.phase) {
  return RulesEngine.phaseSide(phase) || state.active_side;
}

function phaseKind(phase = state.phase) {
  return RulesEngine.phaseKind(phase);
}

function canMoveInCurrentPhase(unit, options = {}) {
  return RulesEngine.canMoveInCurrentPhase(rulesContext(), unit, options);
}

function checkMove(unitId, rawPath, options = {}) {
  return RulesEngine.checkMove(rulesContext(), unitId, rawPath, options);
}

function findLegalPath(unitId, targetHex, options = {}) {
  return RulesEngine.findLegalPath(rulesContext(), unitId, targetHex, options);
}

function reachableHexes(unitId, options = {}) {
  return RulesEngine.reachableHexes(rulesContext(), unitId, options);
}

function hexDistance(a, b) {
  const [ac, ar] = splitHex(a);
  const [bc, br] = splitHex(b);
  return Math.abs(ac - bc) + Math.abs(ar - br);
}

function checkScenarioMoveRestriction(unit, path) {
  const scenario = state.scenario || "";
  if (scenario === "october" && unit.side === "axis" && Number(state.turn || 1) <= 10) {
    const crossedWest = path.some((hex) => Number(hex.slice(0, 2)) < 18);
    if (crossedWest) return { legal: false, reason: "October 特殊规则：前 10 回合 Axis 不能越过撤退线向西移动" };
  }
  if (scenario === "july" && unit.side === "allies" && isInActiveBox(unit.hex)) {
    const leavesBox = path.some((hex) => !isInActiveBox(hex));
    if (leavesBox) return { legal: false, reason: "July Boxed Area：Box 内 Allied 单位不能自愿离开" };
  }
  return { legal: true };
}

function isInActiveBox(hex) {
  const tags = hexTags(hex);
  return tags.includes("alamein_box") && state.boxed_areas_active !== false;
}

function checkSupply(side = state.active_side) {
  return RulesEngine.checkSupply(rulesContext(), side);
}

function isSupplied(unitId) {
  return supplyState(unitId) === "supplied";
}

function supplyState(unitId, network = null) {
  return RulesEngine.supplyState(rulesContext(), unitId, network);
}

function aiScoreSupplyState(unitId) {
  return aiScoreSupplyCache?.[unitId] || supplyState(unitId);
}

function aiSupplyScoreMap(side = state.active_side) {
  const key = `${state.scenario || "custom"}:${Number(state.turn || 1)}:${state.phase}:${side}`;
  if (aiSupplyScorePhaseCache?.key === key) return aiSupplyScorePhaseCache.map;
  const map = checkSupply(side);
  aiSupplyScorePhaseCache = { key, map };
  return map;
}

function buildSupplyNetwork(side) {
  return RulesEngine.buildSupplyNetwork(rulesContext(), side);
}

function supplyDistancesFromSources(side, sources) {
  const blocked = supplyBlockedHexes(side);
  const distances = new Map();
  const queue = [];
  for (const source of sources) {
    if (!onMap(source)) continue;
    distances.set(source, 0);
    queue.push(source);
  }
  while (queue.length) {
    const hex = queue.shift();
    const distance = distances.get(hex);
    for (const nb of neighbors(hex)) {
      if (distances.has(nb)) continue;
      if (blocked.has(nb) && !sources.has(nb)) continue;
      distances.set(nb, distance + 1);
      queue.push(nb);
    }
  }
  return distances;
}

function traceSupplyPath(unitId) {
  return RulesEngine.traceSupplyPath(rulesContext(), unitId);
}

function supplyBlockedHexes(side) {
  return RulesEngine.supplyBlockedHexes(rulesContext(), side);
}

function combatOddsColumn(attack, defense) {
  return RulesEngine.combatOddsColumn(rulesContext(), attack, defense);
}

function adjacentCombats(side = state.active_side) {
  return RulesEngine.adjacentCombats(rulesContext(), side);
}

function previewSelectedCombat() {
  const unit = selectedUnit();
  if (!unit || !isCombatUnit({ id: selectedUnitId, ...unit })) return null;
  const pairs = adjacentCombats(unit.side).filter((pair) => pair.attacker === selectedUnitId);
  if (!pairs.length) return { allowed: false, reason: "选中单位没有相邻敌军" };
  const target = pairs[0];
  const defenders = target.defenders.map((id) => state.units[id]).filter(Boolean);
  const attack = Number(unit.attack || 0);
  const defense = defenders.reduce((sum, item) => sum + Number(item.defense || item.attack || 0), 0);
  const column = combatOddsColumn(attack, defense);
  const die = el("combatDieSelect")?.value;
  const outcome = column && die ? rules.combat?.crt?.[die]?.[(rules.combat?.odds_columns || []).indexOf(column)] : null;
  return { allowed: !!column, attacker: selectedUnitId, defender_hex: target.defender_hex, defenders: target.defenders, attack, defense, odds_column: column, die: die || null, outcome, reason: column ? "战斗预览" : "低于 1-4，不能攻击" };
}

function parseCombatAction() {
  return {
    attackers: parsePathInput(el("combatAttackersInput")?.value || ""),
    defender_hexes: parsePathInput(el("combatDefendersInput")?.value || "").map(normalizeHex),
    die: el("combatResolveDieSelect")?.value ? Number(el("combatResolveDieSelect").value) : null,
    no_retreat_order: !!el("noRetreatOrderToggle")?.checked
  };
}

function checkCombat(action) {
  return RulesEngine.checkCombat(rulesContext(), action);
}

function terrainDefenseBonus(hex) {
  const tags = hexTags(hex);
  if (tags.includes("alamein_box")) return 3;
  if (tags.includes("hill_or_ridge") || tags.includes("depression")) return 1;
  return 0;
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

function resolveCombat(action) {
  const verdict = checkCombat(action);
  if (!verdict.legal) return verdict;
  if (!action.die) return { legal: false, reason: "结算战斗需要选择骰子" };
  pushHistory("combat");
  const result = RulesEngine.resolveCombat(rulesContext(), action);
  if (result.legal) {
    state.combat_log ||= [];
    state.combat_log.push({ turn: state.turn, phase: state.phase, action, verdict: result.details });
    logEvent("combat", `战斗 ${result.details.attackers.join(", ")} -> ${result.details.defender_hexes.join(", ")}：${result.details.outcome}`, { action, verdict: result.details });
    renderStateAfterAction();
  }
  return result;
}

function retreatUnits(unitIds, count, enemySide) {
  for (const id of unitIds) {
    const unit = state.units[id];
    if (!unit || unit.eliminated) continue;
    let current = normalizeHex(unit.hex);
    let failed = false;
    for (let step = 0; step < count; step++) {
      const next = neighbors(current).find((hex) => legalRetreatHex(unit, hex, enemySide));
      if (!next) {
        failed = true;
        break;
      }
      current = next;
    }
    if (failed) {
      unit.eliminated = true;
      unit.eliminated_reason = "blocked_retreat";
    }
    else unit.hex = current;
  }
}

function legalRetreatHex(unit, hex, enemySide) {
  return RulesEngine.legalRetreatHex(rulesContext(), unit, hex, enemySide);
}

function eliminateUnits(unitIds, reason) {
  for (const id of unitIds) {
    if (!state.units[id]) continue;
    state.units[id].eliminated = true;
    state.units[id].eliminated_reason = reason;
    state.units[id].eliminated_turn = Number(state.turn || 1);
    state.units[id].eliminated_phase = state.phase;
  }
}

function exchangeLosses(attackerIds, defenderIds) {
  const defenderStrength = defenderIds.reduce((sum, id) => sum + Number(state.units[id]?.defense || state.units[id]?.attack || 0), 0);
  eliminateUnits(defenderIds, "exchange");
  let removed = 0;
  for (const id of attackerIds.sort((a, b) => Number(state.units[b]?.attack || 0) - Number(state.units[a]?.attack || 0))) {
    if (removed >= defenderStrength) break;
    removed += Number(state.units[id]?.attack || 0);
    eliminateUnits([id], "exchange");
  }
}

function advanceAfterCombat(attackerIds, targetHex) {
  const first = attackerIds.find((id) => state.units[id] && !state.units[id].eliminated && neighbors(state.units[id].hex).includes(targetHex));
  if (first) state.units[first].hex = targetHex;
}

function scenarioFinalTurn(scenario = state.scenario) {
  return RulesEngine.scenarioFinalTurn(scenario);
}

function scenarioStartingVp(scenario = state.scenario) {
  return RulesEngine.scenarioStartingVp(scenario, Number(state.victory_points || 0));
}

function isVictoryCombatUnit(unit) {
  return isMapCounter(unit) && unit.side === "allies" && (unit.kind || "ground") === "ground";
}

function unitExitEdge(unit) {
  return unit.exited_edge || unit.exit_edge || unit.exited || "";
}

function unitExitTurn(unit) {
  return Number(unit.exit_turn || unit.exited_turn || unit.exit_game_turn || 0);
}

function calculateVictoryPoints() {
  return RulesEngine.calculateVictoryPoints(rulesContext());
}

function isFinalVictoryCheck() {
  return state.phase === "end_game_turn" && Number(state.turn || 1) >= scenarioFinalTurn(state.scenario);
}

function checkVictory() {
  return RulesEngine.checkVictory(rulesContext());
}

function stopAiAtFinalVictory(log = []) {
  if (!isFinalVictoryCheck()) return false;
  const victory = checkVictory();
  state.ai_autoplay = false;
  syncAiAutoControls();
  logEvent("victory", `最终结算：${victory.reason}`, victory);
  renderStateAfterAction();
  return victory;
}

function victoryLevel(vp) {
  return RulesEngine.victoryLevel(vp);
}

function hexToPoint(hex) {
  const [col, row] = splitHex(hex);
  const rawCol = col;
  let rawRow = row;
  if (rawCol % 2 !== 0) rawRow -= 1;
  const x = settings.originX + rawCol * settings.colStep;
  const y = settings.originY + rawRow * settings.rowStep + (rawCol % 2 === 0 ? 0 : settings.rowOffset);
  return { x, y };
}

function isInsideMapZone(x, y) {
  let inside = false;
  for (let i = 0, j = MAP_ZONE_POLYGON.length - 1; i < MAP_ZONE_POLYGON.length; j = i++) {
    const [xi, yi] = MAP_ZONE_POLYGON[i];
    const [xj, yj] = MAP_ZONE_POLYGON[j];
    const intersects = ((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function terrainClass(tags) {
  if (tags.includes("alamein_box")) return "alamein_box";
  if (tags.includes("hill_or_ridge")) return "hill_or_ridge";
  if (tags.includes("depression")) return "depression";
  return "road";
}

function mineClass(mines) {
  const sides = new Set(mines.map((mine) => mine.side));
  if (sides.has(state.active_side === "axis" ? "allies" : "axis")) return "enemy";
  if (sides.has(state.active_side)) return "friendly";
  return "neutral";
}

function mineSummary(side = state.active_side) {
  const enemy = side === "axis" ? "allies" : "axis";
  const summary = { enemy: 0, friendly: 0, total: 0 };
  for (const mines of Object.values(minesByHex())) {
    const sides = new Set(mines.map((mine) => mine.side));
    if (sides.has(enemy)) summary.enemy += 1;
    else if (sides.has(side)) summary.friendly += 1;
    summary.total += 1;
  }
  return summary;
}

function switchTab(name) {
  document.querySelectorAll(".tab, .tab-panel").forEach((node) => node.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${name}"]`)?.classList.add("active");
  el(`tab-${name}`)?.classList.add("active");
  const modeByTab = { move: "move", combat: "combat", judge: "all", state: "command" };
  if (modeByTab[name] && el("mapViewModeSelect")) el("mapViewModeSelect").value = modeByTab[name];
  renderOperationHint();
  renderActionControls();
  renderMap();
}

function selectedUnit() {
  return selectedUnitId ? state.units?.[selectedUnitId] : null;
}

function currentMoveUnitId() {
  const select = el("moveUnitSelect");
  return select ? (select.value || "") : (selectedUnitId || "");
}

function currentMoveUnit() {
  const unitId = currentMoveUnitId();
  return unitId && state.units?.[unitId] ? { id: unitId, ...state.units[unitId] } : null;
}

function syncMoveDraftToUnit(unitId) {
  const unit = unitId ? state.units?.[unitId] : null;
  if (!unit?.hex) return null;
  const start = normalizeHex(unit.hex);
  if (!movePathDraft.length || movePathDraft[0] !== start) {
    movePathDraft = [start];
    syncMovePathInput();
  }
  return { id: unitId, ...unit };
}

function setMapViewMode(mode) {
  const select = el("mapViewModeSelect");
  if (select) select.value = mode;
}

function activateMoveForSelectedUnit() {
  const unit = selectedUnit();
  if (!selectedUnitId || !unit || !canMoveUnitNow({ id: selectedUnitId, ...unit })) return;
  setMapViewMode("move");
  movePathDraft = [normalizeHex(unit.hex)];
  syncMovePathInput();
  const moveSelect = el("moveUnitSelect");
  if (moveSelect) moveSelect.value = selectedUnitId;
  switchTab("move");
  renderRouteStatus();
  focusMapOnHex(unit.hex);
}

function activateCombatForSelectedUnit() {
  const unit = selectedUnit();
  if (!selectedUnitId || !unit || !canCombatUnitNow({ id: selectedUnitId, ...unit })) return;
  setMapViewMode("combat");
  const input = el("combatAttackersInput");
  if (input) input.value = selectedUnitId;
  const target = adjacentCombats(unit.side).find((pair) => pair.attacker === selectedUnitId);
  if (target) {
    selectedCombatDefenderHex = target.defender_hex;
    const defenderInput = el("combatDefendersInput");
    if (defenderInput) defenderInput.value = target.defender_hex;
  }
  switchTab("combat");
  setOutput("combatOutput", checkCombat(parseCombatAction()));
  renderMap();
  focusMapOnHex(unit.hex);
}

function activateSupplyForSelectedUnit() {
  const unit = selectedUnit();
  if (!selectedUnitId || !unit) return;
  highlightedSupplyPath = traceSupplyPath(selectedUnitId);
  switchTab("state");
  setMapViewMode("supply");
  renderSelectedUnit();
  renderMap();
  focusMapOnHex(unit.hex);
}

function isMovableUnit(unit) {
  return isCombatUnit(unit) || isSupplyUnit(unit) || (isMapCounter(unit) && isEngineer(unit) && !unit.eliminated);
}

function selectUnit(unitId, options = {}) {
  if (!state.units?.[unitId]) return;
  selectedUnitId = unitId;
  const unit = state.units[unitId];
  const viewMode = el("mapViewModeSelect")?.value || "";
  const switchedTab = !!options.showStateTab;
  if (isMovableUnit({ id: unitId, ...unit })) {
    syncMoveDraftToUnit(unitId);
    const select = el("moveUnitSelect");
    if (select) select.value = unitId;
  }
  highlightedSupplyPath = switchedTab || viewMode === "supply" || viewMode === "all"
    ? traceSupplyPath(unitId)
    : [];
  if (switchedTab) switchTab("state");
  renderSelectedUnit();
  renderOperationHint();
  renderActionControls();
  const moveSelect = el("moveUnitSelect");
  if (moveSelect && [...moveSelect.options].some((option) => option.value === unitId)) moveSelect.value = unitId;
  renderCombatControls();
  if (el("tab-move")?.classList.contains("active")) renderRouteStatus();
  if (!switchedTab) renderMap();
}

function selectHex(hex) {
  selectedHexId = normalizeHex(hex);
  renderSelectedHex();
  renderOperationHint();
  renderMap();
}

function pushHistory(type) {
  actionLog.push({ type, state: structuredClone(state) });
  if (actionLog.length > 20) actionLog.shift();
}

function undoLastAction() {
  const last = actionLog.pop();
  if (!last) {
    setOutput("combatOutput", "没有可撤销动作");
    return;
  }
  state = last.state;
  selectedUnitId = null;
  movePathDraft = [];
  syncMovePathInput();
  renderState();
  setOutput("combatOutput", { undone: last.type });
}

function clearMine(engineerId, rawHex) {
  const unit = state.units[engineerId];
  if (!unit) return { legal: false, reason: "请选择清雷单位" };
  pushHistory("clear_mine");
  const die = el("combatResolveDieSelect")?.value ? Number(el("combatResolveDieSelect").value) : null;
  const result = RulesEngine.clearMine(rulesContext(), engineerId, rawHex, die);
  if (!result.legal) {
    actionLog.pop();
    return result;
  }
  const cleared = result.details?.cleared !== false;
  logEvent("clear_mine", cleared ? `${engineerId} 清除 ${normalizeHex(rawHex)} 敌方雷区` : `${engineerId} 清雷失败：${normalizeHex(rawHex)}`, result.details);
  renderState();
  return result;
}

function syncMovePathInput() {
  const input = el("movePathInput");
  if (input) input.value = movePathDraft.join(" ");
}

function moveOptions() {
  return { mode: el("moveModeSelect")?.value || "normal" };
}

function routeVerdict() {
  const unitId = currentMoveUnitId();
  if (!unitId || movePathDraft.length < 2) return null;
  return checkMove(unitId, movePathDraft, moveOptions());
}

function autoJudgeReport() {
  const phase = state.phase;
  const activeSide = state.active_side;
  const scenarioMeta = { ...(RulesEngine.SCENARIO_META[state.scenario] || {}), ...(state.scenario_meta || {}) };
  return {
    turn: Number(state.turn || 1),
    phase,
    active_side: activeSide,
    scenario_meta: scenarioMeta,
    rule_review: {
      needs_review: !!scenarioMeta.needs_review,
      notes: scenarioMeta.review_notes || []
    },
    phase_rule: phaseKind(phase),
    stacking: checkStacking(),
    zoc: zocSummary(),
    mines: mineSummary(activeSide),
    supply: {
      axis: checkSupply("axis"),
      allies: checkSupply("allies")
    },
    adjacent_combats: adjacentCombats(activeSide),
    selected_combat: previewSelectedCombat(),
    victory: checkVictory(),
    movement: selectedUnitId && movePathDraft.length > 1
      ? {
          unit: selectedUnitId,
          path: [...movePathDraft],
          verdict: routeVerdict()
        }
      : null
  };
}

function zocSummary() {
  const result = { axis: 0, allies: 0, contested: 0 };
  const seen = {};
  for (const unit of combatUnitsArray()) {
    for (const hx of zocHexes(unit)) {
      seen[hx] ||= new Set();
      seen[hx].add(unit.side);
    }
  }
  for (const sides of Object.values(seen)) {
    if (sides.has("axis")) result.axis += 1;
    if (sides.has("allies")) result.allies += 1;
    if (sides.size > 1) result.contested += 1;
  }
  return result;
}

function renderAutoJudge() {
  const report = autoJudgeReport();
  const summary = el("judgeSummary");
  if (summary) {
    const supply = report.supply[state.active_side] || {};
    const supplied = Object.values(supply).filter((value) => value === "supplied").length;
    const partial = Object.values(supply).filter((value) => value === "partially_supplied").length;
    const unsupplied = Object.values(supply).filter((value) => value === "unsupplied").length;
    const isolated = Object.values(supply).filter((value) => value === "isolated").length;
    const reviewNotes = report.rule_review.notes.length
      ? report.rule_review.notes.join("；")
      : "当前标准场景数据无需额外提示";
    summary.innerHTML = `
      <div class="judge-card ${report.stacking.legal ? "ok-card" : "bad-card"}">
        <b>堆叠</b><span>${report.stacking.reason}</span>
      </div>
      <div class="judge-card">
        <b>雷区</b><span>敌方 ${report.mines.enemy} / 己方 ${report.mines.friendly}</span>
      </div>
      <div class="judge-card">
        <b>补给</b><span>${state.active_side}: ${supplied} / ${partial} partial / ${unsupplied} unsup / ${isolated} iso</span>
      </div>
      <div class="judge-card">
        <b>ZOC</b><span>Axis ${report.zoc.axis} / Allies ${report.zoc.allies} / 争夺 ${report.zoc.contested}</span>
      </div>
      <div class="judge-card">
        <b>相邻战斗</b><span>${report.adjacent_combats.length} 组可检查</span>
      </div>
      <div class="judge-card ${report.victory.winner ? "ok-card" : ""}">
        <b>胜负</b><span>${report.victory.reason}</span>
      </div>
      <div class="judge-card">
        <b>VP 明细</b><span>${report.victory.breakdown.map((item) => `${item.points >= 0 ? "+" : ""}${item.points} ${item.label}`).join("；")}</span>
      </div>
      <div class="judge-card ${report.rule_review.needs_review ? "bad-card" : "ok-card"}">
        <b>待核对</b><span>${reviewNotes}</span>
      </div>
    `;
  }
  const judge = el("judgeOutput");
  if (judge) judge.textContent = JSON.stringify(report, null, 2);
  const move = el("moveOutput");
  if (!move) return;
  const verdict = routeVerdict();
  move.textContent = verdict
    ? JSON.stringify(verdict, null, 2)
    : "选择单位并点击地图绘制路线后，移动裁判会自动显示。";
  renderActionControls();
}

function renderRouteStatus() {
  const target = el("routeStatus");
  if (!target) return;
  const unit = currentMoveUnit();
  if (!unit || !isMovableUnit(unit)) {
    target.className = "route-status muted";
    target.textContent = "先点击一个可移动单位";
    renderActionControls();
    return;
  }
  if (movePathDraft.length < 2) {
    target.className = "route-status muted";
    target.textContent = `${unit.name || unit.id}: 点击地图相邻 hex 画路线`;
    renderActionControls();
    return;
  }
  const verdict = routeVerdict();
  target.className = `route-status ${verdict?.legal ? "ok" : "bad"}`;
  target.textContent = verdict?.details
    ? `${verdict.reason}：${verdict.details.spent}/${verdict.details.allowance} MP，${verdict.details.mode === "road" ? "道路模式" : "普通移动"}`
    : verdict ? verdict.reason : "";
  renderAutoJudge();
}

function unitDisplayRows(unit) {
  const supply = unit.id && isPlayableSide(unit.side) ? supplyState(unit.id) : "";
  return [
    ["id", unit.id],
    ["名称", unit.name || ""],
    ["阵营", unit.side || ""],
    ["hex", unit.hex || ""],
    ["类型", unit.kind || ""],
    ["编制", unit.size || ""],
    ["状态", unit.state || ""],
    ["战力", unit.attack ?? ""],
    ["防御", unit.defense ?? ""],
    ["移动", unit.movement ?? ""],
    ["补给", supply],
    ["补给路径", highlightedSupplyPath.length ? highlightedSupplyPath.join(" -> ") : ""],
    ["机械化", isMechanized(unit) ? "yes" : "no"],
    ["道路模式", unit.road_mode ? "yes" : "no"],
    ["棋子类型", unit.piece_type || ""],
    ["图片", counterImageFor(unit) || ""],
    ["原始像素", unit.x != null && unit.y != null ? `${unit.x}, ${unit.y}` : ""],
    ["数值来源", unit.stats_status || ""]
  ].filter(([, value]) => value !== "" && value != null);
}

function renderSelectedUnit() {
  const panel = el("selectedUnitPanel");
  if (!panel) return;
  const unit = selectedUnitId ? unitsArray().find((item) => item.id === selectedUnitId) : null;
  if (!unit) {
    panel.className = "selected-unit empty";
    panel.textContent = "点击地图上的棋子查看属性";
    return;
  }
  panel.className = `selected-unit ${unit.side || ""}`;
  panel.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "selected-unit-shell";
  const imagePath = counterImageFor(unit);
  if (imagePath) {
    const image = document.createElement("img");
    image.className = "selected-unit-image";
    image.src = imagePath;
    image.alt = "";
    shell.append(image);
  }
  const content = document.createElement("div");
  const header = document.createElement("div");
  header.className = "selected-unit-header";
  const title = document.createElement("div");
  title.textContent = unit.name || unit.id;
  const meta = document.createElement("span");
  meta.textContent = `${unit.side || "unknown"} ${unit.hex || ""}`;
  header.append(title, meta);

  const chips = document.createElement("div");
  chips.className = "unit-stat-chips";
  const supplyChip = isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit)
    ? supplyState(unit.id)
    : "marker";
  chips.innerHTML = `
    <span>战力 <b>${unit.attack ?? 0}</b></span>
    <span>防御 <b>${unit.defense ?? unit.attack ?? 0}</b></span>
    <span>移动 <b>${unit.movement ?? 0}</b></span>
    <span>${supplyChip}</span>
  `;

  const actions = document.createElement("div");
  actions.className = "selected-unit-actions";
  if (canMoveUnitNow(unit)) {
    const moveButton = document.createElement("button");
    moveButton.type = "button";
    moveButton.textContent = "移动";
    moveButton.addEventListener("click", () => activateMoveForSelectedUnit());
    actions.append(moveButton);
  }
  if (canCombatUnitNow(unit)) {
    const combatButton = document.createElement("button");
    combatButton.type = "button";
    combatButton.textContent = "战斗";
    combatButton.addEventListener("click", () => activateCombatForSelectedUnit());
    actions.append(combatButton);
  }
  if ((isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit)) && isPlayableSide(unit.side)) {
    const supplyButton = document.createElement("button");
    supplyButton.type = "button";
    supplyButton.textContent = "补给";
    supplyButton.addEventListener("click", () => activateSupplyForSelectedUnit());
    actions.append(supplyButton);
  }
  const centerButton = document.createElement("button");
  centerButton.type = "button";
  centerButton.textContent = "居中";
  centerButton.addEventListener("click", () => focusMapOnHex(unit.hex));
  actions.append(centerButton);

  const body = document.createElement("dl");
  for (const [label, value] of unitDisplayRows(unit)) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    body.append(dt, dd);
  }
  content.append(header, chips, actions, body);
  shell.append(content);
  panel.append(shell);
}

function renderSelectedHex() {
  const panel = el("selectedHexPanel");
  if (!panel) return;
  if (!selectedHexId) {
    panel.className = "selected-unit empty";
    panel.textContent = "点击地图 hex 查看地形、雷区、ZOC 和单位";
    return;
  }
  const units = unitsByHex()[selectedHexId] || [];
  const mines = minesAt(selectedHexId);
  const tags = hexTags(selectedHexId);
  const zocSides = [];
  if (enemyZocSources("allies", selectedHexId).size) zocSides.push("axis");
  if (enemyZocSources("axis", selectedHexId).size) zocSides.push("allies");
  const blockedFor = ["axis", "allies"].filter((side) => supplyBlockedHexes(side).has(selectedHexId));
  panel.className = "selected-unit";
  panel.innerHTML = `
    <div class="selected-unit-header">
      <div>Hex ${selectedHexId}</div>
      <span>${tags.length ? tags.join(", ") : "clear"}</span>
    </div>
    <dl>
      <dt>雷区</dt><dd>${mines.length ? mines.map((mine) => `${mine.side} ${mine.name || mine.id}`).join("; ") : "无"}</dd>
      <dt>ZOC</dt><dd>${zocSides.join(", ") || "无"}</dd>
      <dt>补给阻断</dt><dd>${blockedFor.length ? blockedFor.join(", ") : "无"}</dd>
      <dt>单位</dt><dd>${units.length ? units.map((unit) => `${unit.side} ${unit.name || unit.id}`).join("; ") : "无"}</dd>
    </dl>
  `;
}

function renderOperationHint() {
  const target = el("operationHint");
  if (!target) return;
  const viewMode = el("mapViewModeSelect")?.value || "command";
  const unit = selectedUnitId ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  let text = `${phaseLabel(state.phase)}：`;
  if (viewMode === "move") {
    text += unit && isMovableUnit(unit)
      ? `已选择 ${unit.name || unit.id}，点击地图目标 hex 或输入目标自动寻路。`
      : "选择一个当前方可移动单位，再点击地图目标 hex。";
  }
  else if (viewMode === "combat") {
    text += unit && isCombatUnit(unit)
      ? `已选择 ${unit.name || unit.id}，红色 hex 是可攻击目标。`
      : "在 Combat Phase 选择己方作战单位查看可攻击目标。";
  }
  else if (viewMode === "supply") {
    text += unit ? "绿色虚线是选中棋子的补给线。" : "点击一个棋子，在地图上显示它的补给线。";
  }
  else if (viewMode === "terrain") text += "显示地形和 hex 标签，用于校对地图。";
  else if (viewMode === "zoc") text += "显示双方 ZOC 控制范围。";
  else if (viewMode === "all") text += "显示所有辅助层，适合调试。";
  else text += "选择单位或 hex 查看属性；切换查看模式进入移动、战斗或补给视图。";
  target.textContent = text;
}

function setActionVisible(id, visible) {
  const node = el(id);
  if (!node) return;
  node.classList.toggle("action-hidden", !visible);
  if ("disabled" in node) node.disabled = !visible;
}

function canMoveUnitNow(unit) {
  return !!(
    unit &&
    isMovableUnit(unit) &&
    unit.side === state.active_side &&
    canMoveInCurrentPhase(unit) &&
    (unit.state || "fresh") === "fresh"
  );
}

function hasLegalRoadMoveFromHere(unit) {
  if (!unit?.id || !unit.hex || unit.road_mode || !canMoveUnitNow(unit)) return false;
  const start = normalizeHex(unit.hex);
  if (movePathDraft.length > 1 && movePathDraft[0] === start) {
    return !!checkMove(unit.id, movePathDraft, { mode: "road" })?.legal;
  }
  return neighbors(start).some((hex) => checkMove(unit.id, [start, hex], { mode: "road" })?.legal);
}

function canEnterRoadModeNow(unit) {
  return !!(unit && !unit.road_mode && hasLegalRoadMoveFromHere(unit));
}

function canLeaveRoadModeNow(unit) {
  return !!(unit?.road_mode && canMoveUnitNow(unit));
}

function canCombatUnitNow(unit) {
  return !!(
    unit &&
    isCombatUnit(unit) &&
    unit.side === state.active_side &&
    phaseKind() === "combat" &&
    (unit.state || "fresh") === "fresh" &&
    !unit.attacked_this_phase &&
    !unit.attacked_this_turn &&
    adjacentCombats(unit.side).some((pair) => pair.attacker === unit.id)
  );
}

function syncMoveModeAvailability(unit = currentMoveUnit()) {
  const select = el("moveModeSelect");
  if (!select) return;
  const normalOption = [...select.options].find((option) => option.value === "normal");
  const roadOption = [...select.options].find((option) => option.value === "road");
  if (!unit) {
    if (normalOption) {
      normalOption.hidden = false;
      normalOption.disabled = false;
    }
    if (roadOption) {
      roadOption.hidden = true;
      roadOption.disabled = true;
    }
    select.value = "normal";
    return;
  }
  const inRoadMode = !!unit.road_mode;
  const roadAvailable = !!(unit.road_mode || canEnterRoadModeNow(unit));
  if (normalOption) {
    normalOption.hidden = inRoadMode;
    normalOption.disabled = inRoadMode;
  }
  if (roadOption) {
    roadOption.hidden = !roadAvailable;
    roadOption.disabled = !roadAvailable;
  }
  if (inRoadMode) select.value = "road";
  else if (select.value === "road" && !roadAvailable) select.value = "normal";
}

function hasSelectedSaveSlot() {
  const selected = el("saveSlotSelect")?.value;
  return !!selected && saveSlots().some((slot) => slot.id === selected);
}

function safeCombatVerdict() {
  try {
    const action = parseCombatAction();
    if (!action.attackers.length || !action.defender_hexes.length) return null;
    return checkCombat(action);
  }
  catch {
    return null;
  }
}

function renderActionControls() {
  const moveUnit = currentMoveUnit();
  syncMoveModeAvailability(moveUnit);
  const selected = selectedUnitId && state.units?.[selectedUnitId]
    ? { id: selectedUnitId, ...state.units[selectedUnitId] }
    : null;
  const movable = canMoveUnitNow(moveUnit);
  const currentMode = el("moveModeSelect")?.value || "normal";
  const route = routeVerdict();
  const hasRoute = movePathDraft.length > 1;
  const hasTarget = !!el("moveTargetInput")?.value.trim();
  setActionVisible("autoRouteBtn", movable && hasTarget);
  setActionVisible("enterRoadModeBtn", movable && canEnterRoadModeNow(moveUnit) && currentMode !== "road");
  setActionVisible("leaveRoadModeBtn", movable && canLeaveRoadModeNow(moveUnit) && currentMode === "road");
  setActionVisible("applyMoveBtn", movable && hasRoute && !!route?.legal);
  setActionVisible("exitWestBtn", !!(moveUnit?.id && canExitWest(moveUnit.id).legal));
  setActionVisible("undoRouteBtn", hasRoute);
  setActionVisible("clearRouteBtn", hasRoute);
  setActionVisible("moveCombatPreviewControl", phaseKind() === "combat" && canCombatUnitNow(selected));

  const combatPhase = phaseKind() === "combat";
  const combatVerdict = safeCombatVerdict();
  const hasCombatSelection = !!combatVerdict;
  const combatDie = !!el("combatResolveDieSelect")?.value;
  setActionVisible("useSelectedCombatBtn", canCombatUnitNow(selected));
  setActionVisible("previewCombatBtn", combatPhase && hasCombatSelection);
  setActionVisible("resolveCombatBtn", combatPhase && !!combatVerdict?.legal && combatDie);
  setActionVisible("undoActionBtn", actionLog.length > 0);
  const hasMineClearTarget = combatPhase && !!el("engineerSelect")?.value && !!el("mineHexInput")?.value.trim();
  setActionVisible("clearMineSection", combatPhase && !!el("engineerSelect")?.options?.length);
  setActionVisible("clearMineBtn", hasMineClearTarget);

  const aiControlled = currentPhaseIsAiControlled();
  setActionVisible("aiSuggestBtn", aiControlled);
  setActionVisible("aiApplyBtn", !!aiSuggestion?.action);
  setActionVisible("aiPlayCurrentBtn", aiControlled && !state.ai_autoplay);
  setActionVisible("aiAutoRunBtn", anySideAiControlled() && !state.ai_autoplay);
  setActionVisible("aiAutoStopBtn", anySideAiControlled() && !!state.ai_autoplay);

  const selectedSlot = hasSelectedSaveSlot();
  setActionVisible("loadSlotBtn", selectedSlot);
  setActionVisible("deleteSlotBtn", selectedSlot);
}

function phaseLabel(phase) {
  const labels = {
    axis_initial_movement: "Axis Initial Movement",
    axis_combat: "Axis Combat",
    axis_mechanized_movement: "Axis Mechanized Movement",
    axis_supply_movement: "Axis Supply Movement",
    allies_initial_movement: "Allies Initial Movement",
    allies_combat: "Allies Combat",
    allies_mechanized_movement: "Allies Mechanized Movement",
    allies_supply_movement: "Allies Supply Movement",
    end_game_turn: "End of Game-Turn"
  };
  return labels[phase] || String(phase || "").replaceAll("_", " ");
}

function syncActiveSideFromPhase() {
  const side = phaseSide(state.phase);
  if (isPlayableSide(side)) state.active_side = side;
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

function advancePhase() {
  pushHistory("advance_phase");
  const fromPhase = state.phase;
  const fromTurn = Number(state.turn || 1);
  applyPhaseEndEffects();
  const next = RulesEngine.nextPhase(rulesContext());
  if (next.turn_increment) {
    state.turn = Number(state.turn || 1) + next.turn_increment;
    recoverSpentForSide("axis");
    recoverSpentForSide("allies");
  }
  state.phase = next.phase;
  syncActiveSideFromPhase();
  if (phaseKind(state.phase) === "combat") recoverMovementSpentForSide(state.active_side);
  selectedUnitId = null;
  movePathDraft = [];
  syncMovePathInput();
  logEvent("phase", `阶段推进：${phaseLabel(fromPhase)} -> ${phaseLabel(state.phase)}`, { from_turn: fromTurn, to_turn: state.turn, from_phase: fromPhase, to_phase: state.phase });
  renderState();
  scheduleAiAutoplay();
}

function advancePhaseForAi() {
  suppressAiActionRender = true;
  try {
    advancePhase();
  }
  finally {
    suppressAiActionRender = false;
  }
}

function applyPhaseEndEffects() {
  updateSupplyStates();
  eliminatePersistentIsolated();
  if (phaseKind(state.phase) === "combat") removeClearedMineMarkers();
  if (state.scenario === "july") updateJulyBoxes();
}

function removeClearedMineMarkers() {
  for (const unit of Object.values(state.units || {})) {
    if (unit.kind === "mine" && unit.cleared && unit.eliminated_reason === "mine_cleared") {
      unit.eliminated = true;
      unit.off_map = true;
    }
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
    if (unit.supply_state === "isolated" && unit.isolated_since && unit.isolated_since !== `${state.turn}:${state.phase}`) {
      unit.eliminated = true;
      unit.eliminated_reason = "isolation";
      unit.eliminated_turn = Number(state.turn || 1);
      unit.eliminated_phase = state.phase;
      logEvent("isolation_elimination", `${id} 因持续孤立被消灭`, { unit: id, isolated_since: unit.isolated_since });
    }
  }
}

function updateJulyBoxes() {
  if (state.boxed_areas_active === false) return;
  const axisInBox = friendlyUnits("axis").some((unit) => isInActiveBox(unit.hex));
  if (axisInBox) state.boxed_areas_active = false;
}

function renderTurnBanner() {
  const banner = el("turnBanner");
  if (!banner) return;
  const side = state.active_side === "allies" ? "allies" : "axis";
  const controller = playerControllerLabel(playerController(side));
  banner.className = `turn-banner ${side}`;
  banner.innerHTML = `
    <div>
      <span class="turn-kicker">当前回合</span>
      <strong>${side === "axis" ? "Axis" : "Allies"}</strong>
      <span class="turn-controller">${controller}</span>
    </div>
    <div>
      <span class="turn-kicker">Turn</span>
      <strong>${state.turn || 1}</strong>
    </div>
    <div class="turn-phase">
      <span class="turn-kicker">Phase</span>
      <strong>${phaseLabel(state.phase)}</strong>
    </div>
  `;
}

function playerController(side = state.active_side) {
  return state.player_control?.[side] || "human";
}

function isAiController(value) {
  return value === "rules_ai" || value === "heuristic_ai" || value === "external_ai";
}

function anySideAiControlled() {
  return isAiController(state.player_control?.axis) || isAiController(state.player_control?.allies);
}

function playerControllerLabel(value) {
  if (value === "rules_ai") return "规则 AI";
  if (value === "heuristic_ai") return "本地 AI";
  if (value === "external_ai") return "外部 AI";
  return "人类";
}

function aiModeForSide(side = state.active_side) {
  const controller = playerController(side);
  if (controller === "external_ai") return "external";
  if (controller === "rules_ai") return "rules";
  if (controller === "heuristic_ai") return "heuristic";
  return el("aiModeSelect")?.value || "heuristic";
}

function syncPlayerControls() {
  if (!state.player_control) state.player_control = { axis: "human", allies: "human" };
  if (el("axisPlayerSelect")) el("axisPlayerSelect").value = state.player_control.axis || "human";
  if (el("alliesPlayerSelect")) el("alliesPlayerSelect").value = state.player_control.allies || "human";
  syncAiAutoControls();
}

function syncAiAutoControls() {
  if (el("aiAutoToggleBtn")) el("aiAutoToggleBtn").textContent = state.ai_autoplay ? "暂停 AI" : "恢复 AI";
}

function setupScenarioTurnDefault(scenario) {
  if (scenario === "july") return 7;
  return 1;
}

function setupScenarioPhaseDefault(scenario) {
  if (scenario === "october") return "allies_initial_movement";
  return "axis_initial_movement";
}

function showSetupScreen() {
  setupMode = "home";
  syncSetupControls();
  el("setupScreen")?.classList.remove("hidden");
}

function hideSetupScreen() {
  el("setupScreen")?.classList.add("hidden");
}

function setSetupMode(mode) {
  setupMode = mode === "new" ? "new" : "home";
  el("setupHomePanel")?.classList.toggle("hidden", setupMode !== "home");
  el("setupNewGamePanel")?.classList.toggle("hidden", setupMode !== "new");
  renderSaveSlots();
}

function syncSetupControls() {
  renderSaveSlots();
  setSetupMode(setupMode);
  if (el("setupScenarioSelect")) el("setupScenarioSelect").value = state.scenario || el("scenarioSelect")?.value || "july";
  if (el("setupTurnInput")) el("setupTurnInput").value = state.turn || setupScenarioTurnDefault(el("setupScenarioSelect")?.value || "july");
  if (el("setupPhaseSelect")) el("setupPhaseSelect").value = state.phase || setupScenarioPhaseDefault(el("setupScenarioSelect")?.value || "july");
  if (el("setupAxisRoleSelect")) el("setupAxisRoleSelect").value = state.player_control?.axis || "human";
  if (el("setupAlliesRoleSelect")) el("setupAlliesRoleSelect").value = state.player_control?.allies || "human";
  if (el("setupAiModeSelect")) el("setupAiModeSelect").value = el("aiModeSelect")?.value || "rules";
  if (el("setupAiTargetInput")) el("setupAiTargetInput").value = el("aiTargetInput")?.value || fixedAiTarget(state.active_side || "axis");
  renderSetupSummary();
}

function renderSetupSummary() {
  const target = el("setupSummary");
  if (!target) return;
  const scenario = el("setupScenarioSelect")?.value || "july";
  const turn = Number(el("setupTurnInput")?.value || setupScenarioTurnDefault(scenario));
  const phase = el("setupPhaseSelect")?.value || setupScenarioPhaseDefault(scenario);
  const axis = el("setupAxisRoleSelect")?.value || "human";
  const allies = el("setupAlliesRoleSelect")?.value || "human";
  const aiMode = el("setupAiModeSelect")?.value || "rules";
  const auto = isAiController(axis) || isAiController(allies);
  target.innerHTML = `
    <div><span>战役</span><b>${scenario}</b></div>
    <div><span>回合 / 阶段</span><b>T${turn} · ${phaseLabel(phase)}</b></div>
    <div><span>Axis</span><b>${playerControllerLabel(axis)}</b></div>
    <div><span>Allies</span><b>${playerControllerLabel(allies)}</b></div>
    <div><span>默认 AI</span><b>${aiMode === "external" ? "外部 API" : aiMode === "heuristic" ? "本地启发式" : "规则 AI"}</b></div>
    <div><span>AI 行动</span><b>${auto ? "轮到 AI 自动执行" : "无 AI 方"}</b></div>
  `;
}

function applySetupOptionsToState() {
  const phase = el("setupPhaseSelect")?.value || setupScenarioPhaseDefault(state.scenario || "july");
  state.turn = Number(el("setupTurnInput")?.value || setupScenarioTurnDefault(state.scenario || "july"));
  state.phase = phase;
  syncActiveSideFromPhase();
  state.player_control ||= { axis: "human", allies: "human" };
  state.player_control.axis = el("setupAxisRoleSelect")?.value || "human";
  state.player_control.allies = el("setupAlliesRoleSelect")?.value || "human";
  state.ai_autoplay = anySideAiControlled();
  if (el("aiModeSelect") && el("setupAiModeSelect")) el("aiModeSelect").value = el("setupAiModeSelect").value;
  if (el("aiTargetInput") && el("setupAiTargetInput")) el("aiTargetInput").value = el("setupAiTargetInput").value;
  syncAiAutoControls();
}

async function startFromSetup() {
  const scenario = el("setupScenarioSelect")?.value || "july";
  const nextState = await loadJson(SCENARIO_URLS[scenario] || SCENARIO_URLS.july, FALLBACK_STATE);
  applyStateDefaults(nextState);
  applySetupOptionsToState();
  logEvent("setup", `开局配置：${scenario} T${state.turn} ${phaseLabel(state.phase)}`, { scenario, player_control: state.player_control, ai_autoplay: state.ai_autoplay });
  if (el("scenarioSelect")) el("scenarioSelect").value = state.scenario || scenario;
  hideSetupScreen();
  renderState();
  renderDataOutput();
  focusMapOnUnits();
  renderAutoJudge();
  scheduleAiAutoplay();
}

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : structuredClone(fallback);
  }
  catch {
    return structuredClone(fallback);
  }
}

function writeLocalJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function saveSlots() {
  return readLocalJson(SAVE_SLOTS_STORAGE_KEY, []);
}

function writeSaveSlots(slots) {
  writeLocalJson(SAVE_SLOTS_STORAGE_KEY, slots.slice(0, MAX_SAVE_SLOTS));
}

function slotLabel(slot) {
  if (!slot) return "";
  const when = slot.saved_at ? new Date(slot.saved_at).toLocaleString() : "";
  const title = slot.name || `${slot.scenario || "custom"} Turn ${slot.turn || 1}`;
  return `${title} · ${slot.scenario || "custom"} T${slot.turn || 1} · ${phaseLabel(slot.phase)}${when ? ` · ${when}` : ""}`;
}

function renderSaveSlotSelect(selectId, emptyLabel = "新存档槽") {
  const select = el(selectId);
  if (!select) return;
  const selected = select.value;
  select.innerHTML = "";
  const slots = saveSlots();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = slots.length ? emptyLabel : "暂无存档";
  select.append(empty);
  for (const slot of slots) {
    const option = document.createElement("option");
    option.value = slot.id;
    option.textContent = slotLabel(slot);
    select.append(option);
  }
  if (selected && slots.some((slot) => slot.id === selected)) select.value = selected;
}

function renderSaveSlots() {
  renderSaveSlotSelect("saveSlotSelect", "新存档槽");
  renderSaveSlotSelect("setupSaveSlotSelect", "选择一个存档");
  renderActionControls();
}

function currentSaveSlotName() {
  return el("saveSlotNameInput")?.value.trim() || `${state.scenario || "custom"} Turn ${state.turn || 1} ${phaseLabel(state.phase)}`;
}

function saveCurrentSlot() {
  const slots = saveSlots();
  const selectedId = el("saveSlotSelect")?.value;
  const id = selectedId || `slot-${Date.now()}`;
  logEvent("save", `保存局面到槽位：${currentSaveSlotName()}`, { slot_id: id });
  const slot = {
    id,
    name: currentSaveSlotName(),
    saved_at: new Date().toISOString(),
    scenario: state.scenario || "custom",
    turn: Number(state.turn || 1),
    phase: state.phase,
    state: structuredClone(state)
  };
  const next = [slot, ...slots.filter((item) => item.id !== id)];
  writeSaveSlots(next);
  renderSaveSlots();
  if (el("saveSlotSelect")) el("saveSlotSelect").value = id;
  setOutput("saveOutput", { saved: slotLabel(slot), slots: next.length });
}

function loadSlotById(id, options = {}) {
  const slot = saveSlots().find((item) => item.id === id);
  if (!slot) {
    setOutput(options.outputId || "saveOutput", { legal: false, reason: "请选择一个存档槽" });
    return;
  }
  applyStateDefaults(structuredClone(slot.state));
  logEvent("load", `读取存档槽位：${slot.name || slot.id}`, { slot_id: slot.id, saved_at: slot.saved_at });
  if (el("scenarioSelect")) el("scenarioSelect").value = state.scenario || "july";
  renderState();
  renderDataOutput();
  focusMapOnUnits();
  renderAutoJudge();
  syncSetupControls();
  if (options.hideSetup) hideSetupScreen();
  setOutput(options.outputId || "saveOutput", { loaded: slotLabel(slot) });
  scheduleAiAutoplay();
}

function loadSelectedSlot() {
  loadSlotById(el("saveSlotSelect")?.value, { outputId: "saveOutput" });
}

function loadSetupSelectedSlot() {
  const slots = saveSlots();
  if (!slots.length) {
    alert("还没有可加载的存档。进入游戏后可在设置页保存局面。");
    return;
  }
  const selectedId = el("setupSaveSlotSelect")?.value || slots[0].id;
  loadSlotById(selectedId, { outputId: "setupSaveOutput", hideSetup: true });
}

function deleteSelectedSlot() {
  const id = el("saveSlotSelect")?.value;
  if (!id) {
    setOutput("saveOutput", { legal: false, reason: "请选择一个存档槽" });
    return;
  }
  const next = saveSlots().filter((slot) => slot.id !== id);
  writeSaveSlots(next);
  renderSaveSlots();
  setOutput("saveOutput", { deleted: id, slots: next.length });
}

function aiProfiles() {
  return readLocalJson(AI_PROFILES_STORAGE_KEY, []);
}

function writeAiProfiles(profiles) {
  writeLocalJson(AI_PROFILES_STORAGE_KEY, profiles);
}

function renderAiProfiles() {
  const select = el("aiProfileSelect");
  if (!select) return;
  const selected = select.value;
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "手动配置";
  select.append(empty);
  for (const profile of aiProfiles()) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name || profile.model || "API 配置"}${profile.model ? ` · ${profile.model}` : ""}`;
    select.append(option);
  }
  if (selected && aiProfiles().some((profile) => profile.id === selected)) select.value = selected;
}

function applyAiProfile(profileId) {
  const profile = aiProfiles().find((item) => item.id === profileId);
  if (!profile) return;
  if (el("aiProfileNameInput")) el("aiProfileNameInput").value = profile.name || "";
  if (el("aiApiUrlInput")) el("aiApiUrlInput").value = profile.url || "";
  if (el("aiModelInput")) el("aiModelInput").value = profile.model || "";
  if (el("aiApiKeyInput")) el("aiApiKeyInput").value = profile.key || "";
  if (el("aiTimeoutInput")) el("aiTimeoutInput").value = profile.timeout || 20;
  if (el("aiMaxToolRoundsInput")) el("aiMaxToolRoundsInput").value = profile.max_tool_rounds ?? 4;
}

function saveAiProfile() {
  const selectedId = el("aiProfileSelect")?.value;
  const id = selectedId || `api-${Date.now()}`;
  const profile = {
    id,
    name: el("aiProfileNameInput")?.value.trim() || el("aiModelInput")?.value.trim() || "API 配置",
    url: el("aiApiUrlInput")?.value.trim() || "",
    model: el("aiModelInput")?.value.trim() || "",
    key: el("aiApiKeyInput")?.value || "",
    timeout: Number(el("aiTimeoutInput")?.value || 20),
    max_tool_rounds: Number(el("aiMaxToolRoundsInput")?.value || 4),
    updated_at: new Date().toISOString()
  };
  const profiles = aiProfiles();
  writeAiProfiles([profile, ...profiles.filter((item) => item.id !== id)]);
  renderAiProfiles();
  if (el("aiProfileSelect")) el("aiProfileSelect").value = id;
  setOutput("aiOutput", { saved_api_profile: profile.name, note: "API Key 仅保存在当前浏览器本地存储中" });
}

function deleteAiProfile() {
  const id = el("aiProfileSelect")?.value;
  if (!id) {
    setOutput("aiOutput", { legal: false, reason: "请选择一个 API 配置" });
    return;
  }
  const next = aiProfiles().filter((profile) => profile.id !== id);
  writeAiProfiles(next);
  renderAiProfiles();
  setOutput("aiOutput", { deleted_api_profile: id });
}

function hexPolygonPoints(x, y) {
  const width = settings.colStep / 0.75;
  const height = settings.rowStep;
  const points = [
    [x - width / 2, y],
    [x - width / 4, y - height / 2],
    [x + width / 4, y - height / 2],
    [x + width / 2, y],
    [x + width / 4, y + height / 2],
    [x - width / 4, y + height / 2]
  ];
  return points.map((point) => point.join(",")).join(" ");
}

function visibleStackUnits(units, showMarkers) {
  return units
    .filter((unit) => isCombatUnit(unit) || showMarkers)
    .sort((a, b) => {
      const aMarker = isCombatUnit(a) ? 1 : 0;
      const bMarker = isCombatUnit(b) ? 1 : 0;
      return aMarker - bMarker || String(a.id).localeCompare(String(b.id));
    });
}

function stackLayout(units, centerX, centerY, expandStacks) {
  const count = units.length;
  if (!count) return [];
  const baseSize = Number(settings.unitSize);
  if (!expandStacks || count === 1) {
    return units.map((unit, index) => {
      const marker = !isCombatUnit(unit);
      const actualSize = marker ? Math.round(baseSize * 0.76) : baseSize;
      const offset = expandStacks ? 0 : index * Math.max(5, baseSize * 0.12);
      return { unit, size: actualSize, x: centerX - actualSize / 2 + offset, y: centerY - actualSize / 2 + offset };
    });
  }

  const spread = Number(settings.stackSpread || 38);
  const cols = Math.min(3, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  const stackSize = Math.max(30, Math.min(baseSize * 0.78, spread * 1.18));
  return units.map((unit, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const marker = !isCombatUnit(unit);
    const actualSize = Math.round((marker ? 0.8 : 1) * stackSize);
    const x = centerX + (col - (cols - 1) / 2) * spread - actualSize / 2;
    const y = centerY + (row - (rows - 1) / 2) * spread - actualSize / 2;
    return { unit, size: actualSize, x, y };
  });
}

function drawMoveRoute(svg) {
  if (!selectedUnitId || movePathDraft.length === 0) return;
  const points = movePathDraft.map((hex) => hexToPoint(hex));
  if (points.length > 1) {
    const verdict = routeVerdict();
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", points.map(({ x, y }) => `${x},${y}`).join(" "));
    line.setAttribute("class", `move-route ${verdict?.legal ? "legal" : "illegal"}`);
    svg.append(line);
  }
  points.forEach(({ x, y }, index) => {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "g");
    dot.setAttribute("class", `route-node ${index === 0 ? "start" : index === points.length - 1 ? "end" : ""}`);
    dot.setAttribute("transform", `translate(${x} ${y})`);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", index === 0 ? 8 : 7);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("y", 1);
    text.textContent = index;
    dot.append(circle, text);
    svg.append(dot);
  });
}

function drawZoc(svg) {
  const zocs = {};
  for (const unit of combatUnitsArray()) {
    for (const hx of zocHexes(unit)) {
      zocs[hx] ||= new Set();
      zocs[hx].add(unit.side);
    }
  }
  for (const [hex, sides] of Object.entries(zocs)) {
    const { x, y } = hexToPoint(hex);
    if (!isInsideMapZone(x, y)) continue;
    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("points", hexPolygonPoints(x, y));
    polygon.setAttribute("class", `zoc-hex ${sides.has("axis") ? "axis" : ""} ${sides.has("allies") ? "allies" : ""}`);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${hex}: ZOC ${[...sides].join(", ")}`;
    polygon.append(title);
    svg.append(polygon);
  }
}

function drawReachableHexes(svg) {
  const unit = selectedUnitId ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  if (!unit || !isMovableUnit(unit) || !canMoveInCurrentPhase(unit, moveOptions()) || unit.state !== "fresh") return;
  const reachable = reachableHexes(selectedUnitId, moveOptions());
  for (const [hex, info] of reachable.entries()) {
    if (hex === normalizeHex(unit.hex)) continue;
    const { x, y } = hexToPoint(hex);
    if (!isInsideMapZone(x, y)) continue;
    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("points", hexPolygonPoints(x, y));
    polygon.setAttribute("class", "reachable-hex");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${hex}: ${info.cost} MP`;
    polygon.append(title);
    svg.append(polygon);
  }
}

function drawCombatTargets(svg) {
  const unit = selectedUnitId ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  if (!unit || !isCombatUnit(unit) || unit.side !== state.active_side || phaseKind() !== "combat") return;
  const enemyByHex = unitsByHex(enemyUnits(unit.side));
  for (const hex of neighbors(unit.hex)) {
    if (!enemyByHex[hex]) continue;
    const { x, y } = hexToPoint(hex);
    if (!isInsideMapZone(x, y)) continue;
    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("points", hexPolygonPoints(x, y));
    polygon.setAttribute("class", `combat-target-hex ${selectedCombatDefenderHex === hex ? "selected" : ""}`);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${hex}: 可攻击 ${enemyByHex[hex].map((u) => u.name || u.id).join(", ")}`;
    polygon.append(title);
    svg.append(polygon);
  }
}

function drawSupplyPath(svg) {
  if (!highlightedSupplyPath.length) return;
  const points = highlightedSupplyPath.map(hexToPoint);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", points.map(({ x, y }) => `${x},${y}`).join(" "));
  line.setAttribute("class", "supply-route");
  svg.append(line);
  for (const [index, point] of points.entries()) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", point.x);
    circle.setAttribute("cy", point.y);
    circle.setAttribute("r", index === 0 ? 7 : 4);
    circle.setAttribute("class", `supply-node ${index === 0 ? "unit-end" : index === points.length - 1 ? "source-end" : ""}`);
    svg.append(circle);
  }
}

function clickRouteHex(hex) {
  const unit = selectedUnit();
  if (!unit || !canMoveUnitNow({ id: selectedUnitId, ...unit })) return;
  const hx = normalizeHex(hex);
  const autoPath = findLegalPath(selectedUnitId, hx, moveOptions());
  if (autoPath) {
    movePathDraft = autoPath;
    syncMovePathInput();
    renderRouteStatus();
    renderMap();
    switchTab("move");
    return;
  }
  if (!movePathDraft.length || movePathDraft[0] !== normalizeHex(unit.hex)) {
    movePathDraft = [normalizeHex(unit.hex)];
  }
  const existing = movePathDraft.indexOf(hx);
  if (existing >= 0) {
    movePathDraft = movePathDraft.slice(0, existing + 1);
  }
  else {
    movePathDraft.push(hx);
  }
  syncMovePathInput();
  renderRouteStatus();
  renderMap();
  switchTab("move");
}

function drawHexClickZones(svg) {
  const unit = selectedUnit();
  const routing = !!(selectedUnitId && unit && canMoveUnitNow({ id: selectedUnitId, ...unit }));
  const combatPicking = !!(selectedUnitId && unit && canCombatUnitNow({ id: selectedUnitId, ...unit }));
  for (let col = 1; col <= 49; col++) {
    const [minRow, maxRow] = COLUMN_ROW_BOUNDS[col];
    for (let row = minRow; row <= maxRow; row++) {
      const hex = `${String(col).padStart(2, "0")}${String(row).padStart(2, "0")}`;
      const { x, y } = hexToPoint(hex);
      if (!isInsideMapZone(x, y)) continue;
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", hexPolygonPoints(x, y));
      polygon.setAttribute("class", `hex-click-zone ${movePathDraft.includes(hex) ? "in-route" : ""} ${selectedHexId === hex ? "selected-hex" : ""}`);
      polygon.setAttribute("data-hex", hex);
      polygon.addEventListener("click", (event) => {
        event.stopPropagation();
        if (combatPicking && unitsByHex(enemyUnits(unit.side))[hex]) {
          selectedCombatDefenderHex = hex;
          el("combatDefendersInput").value = hex;
          el("combatAttackersInput").value = selectedUnitId;
          switchTab("combat");
          setOutput("combatOutput", checkCombat(parseCombatAction()));
          renderActionControls();
          renderMap();
        }
        else if (routing) clickRouteHex(hex);
        else selectHex(hex);
      });
      svg.append(polygon);
    }
  }
}

function renderMap() {
  const svg = el("mapOverlay");
  svg.innerHTML = "";
  const viewMode = el("mapViewModeSelect")?.value || "command";
  const showTerrain = el("showTerrainToggle").checked || viewMode === "terrain" || viewMode === "all";
  const showUnits = el("showUnitsToggle").checked;
  const showMarkers = el("showMarkersToggle").checked;
  const showMines = el("showMinesToggle").checked;
  const showZoc = el("showZocToggle").checked || viewMode === "zoc" || viewMode === "all";
  const expandStacks = el("expandStacksToggle").checked;
  const showHex = el("showHexToggle").checked || viewMode === "terrain";

  if (showTerrain) {
    for (const [hex, tags] of Object.entries(terrain.hexes || {})) {
      const { x, y } = hexToPoint(hex);
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", hexPolygonPoints(x, y));
      polygon.setAttribute("class", `terrain-hex ${terrainClass(tags)}`);
      polygon.append(document.createElementNS("http://www.w3.org/2000/svg", "title"));
      polygon.querySelector("title").textContent = `${hex}: ${tags.join(", ")}`;
      svg.append(polygon);
    }
  }

  if (showMines) {
    for (const [hex, mines] of Object.entries(minesByHex())) {
      const { x, y } = hexToPoint(hex);
      if (!isInsideMapZone(x, y)) continue;
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("class", `mine-zone ${mineClass(mines)}`);
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", hexPolygonPoints(x, y));
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", x);
      text.setAttribute("y", y + 4);
      text.textContent = "Mine";
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${hex}: ${mines.map((mine) => `${mine.side} ${mine.name || mine.id}`).join("; ")}`;
      group.append(polygon, text, title);
      svg.append(group);
    }
  }

  if (showZoc) drawZoc(svg);
  const showReachable = el("showReachableToggle")?.checked;
  if (showReachable && (viewMode === "move" || viewMode === "all")) drawReachableHexes(svg);
  if (viewMode === "combat" || viewMode === "all") drawCombatTargets(svg);
  drawSupplyPath(svg);

  if (showHex) {
    for (let col = 1; col <= 49; col++) {
      const [minRow, maxRow] = COLUMN_ROW_BOUNDS[col];
      for (let row = minRow; row <= maxRow; row++) {
        const hex = `${String(col).padStart(2, "0")}${String(row).padStart(2, "0")}`;
        const { x, y } = hexToPoint(hex);
        if (!isInsideMapZone(x, y)) continue;
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", x);
        text.setAttribute("y", y + 4);
        text.setAttribute("class", "hex-label");
        text.textContent = hex;
        svg.append(text);
      }
    }
  }

  drawHexClickZones(svg);
  drawMoveRoute(svg);

  if (showUnits) {
    const stacked = unitsByHex();
    for (const [hex, units] of Object.entries(stacked)) {
      const { x, y } = hexToPoint(hex);
      const visibleUnits = visibleStackUnits(units, showMarkers);
      stackLayout(visibleUnits, x, y, expandStacks).forEach(({ unit, size, x: unitX, y: unitY }) => {
        const marker = !isCombatUnit(unit);
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("class", `unit-marker ${unit.side} ${marker ? "marker" : "counter"} ${unit.id === selectedUnitId ? "selected" : ""}`);
        g.setAttribute("data-unit-id", unit.id);
        g.setAttribute("transform", `translate(${unitX} ${unitY})`);
        g.addEventListener("click", (event) => {
          event.stopPropagation();
          selectUnit(unit.id, { showStateTab: phaseKind() !== "combat" });
          if (phaseKind() === "combat" && isCombatUnit(unit) && unit.side === state.active_side) {
            switchTab("combat");
            el("combatAttackersInput").value = unit.id;
            renderActionControls();
          }
        });
        const imagePath = counterImageFor(unit);
        const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
        image.setAttribute("href", imagePath);
        image.setAttribute("width", size);
        image.setAttribute("height", size);
        image.setAttribute("preserveAspectRatio", "xMidYMid meet");
        g.append(image);
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = `${unit.name || unit.id} ${unit.side} ${hex}`;
        g.append(title);
        svg.append(g);
      });
    }
  }
}

function renderState() {
  renderTurnBanner();
  el("turnInput").value = state.turn || 1;
  el("activeSideSelect").value = state.active_side || "axis";
  el("phaseSelect").value = state.phase || rules.turn_sequence[0];
  const units = unitsArray().filter(isMapCounter);
  const combat = combatUnitsArray();
  const engineers = units.filter((u) => isEngineer(u) && isPlayableSide(u.side) && !u.eliminated);
  const axis = combat.filter((u) => u.side === "axis").length;
  const allies = combat.filter((u) => u.side === "allies").length;
  const markers = units.length - combat.length - engineers.length;
  const stacking = checkStacking();
  const supply = checkSupply(state.active_side || "axis");
  const unsupplied = Object.values(supply).filter((value) => value !== "supplied").length;
  el("stateStats").innerHTML = `
    <div class="stat"><b>${combat.length}</b>作战单位</div>
    <div class="stat"><b>${engineers.length}</b>工程兵</div>
    <div class="stat"><b>${axis} / ${allies}</b>Axis / Allies</div>
    <div class="stat"><b>${markers}</b>标记</div>
    <div class="stat"><b>${unsupplied}</b>缺补给</div>
    <div class="stat"><b class="${stacking.legal ? "ok" : "bad"}">${stacking.legal ? "OK" : "问题"}</b>堆叠</div>
  `;
  renderUnitList();
  renderMoveUnits();
  renderSelectedUnit();
  renderSelectedHex();
  renderOperationHint();
  renderCombatControls();
  renderCalibration();
  syncPlayerControls();
  renderAiConfig();
  renderGameLog();
  renderMap();
  renderAutoJudge();
  renderActionControls();
}

function renderStateAfterAction() {
  if (!suppressAiActionRender) renderState();
}

function renderUnitList() {
  const filter = el("unitSearch").value.trim().toLowerCase();
  const list = el("unitList");
  list.innerHTML = "";
  const sideLabels = { axis: "Axis", allies: "Allies", neutral: "Neutral" };
  const sideOrder = ["axis", "allies", "neutral"];
  const units = unitsArray()
    .filter((unit) => isMapCounter(unit) && (isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit) || unit.kind === "mine"))
    .filter((unit) => {
      const haystack = `${unit.id} ${unit.name || ""} ${unit.side} ${unit.hex || ""} ${unit.piece_type || ""} ${unitTypeGroup(unit).label}`.toLowerCase();
      return !filter || haystack.includes(filter);
    });

  if (!units.length) {
    list.innerHTML = `<div class="unit-list-empty">没有匹配的地图棋子</div>`;
    return;
  }

  for (const side of sideOrder) {
    const sideUnits = units.filter((unit) => unit.side === side);
    if (!sideUnits.length) continue;
    const sideSection = document.createElement("details");
    sideSection.className = `unit-side-section ${side}`;
    sideSection.open = !!filter;
    sideSection.innerHTML = `
      <summary class="unit-side-header">
        <span>${sideLabels[side] || side}</span>
        <b>${sideUnits.length}</b>
      </summary>
    `;

    const groups = new Map();
    for (const unit of sideUnits) {
      const group = unitTypeGroup(unit);
      if (!groups.has(group.key)) groups.set(group.key, { ...group, units: [] });
      groups.get(group.key).units.push(unit);
    }

    const sortedGroups = [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    for (const group of sortedGroups) {
      const typeSection = document.createElement("details");
      typeSection.className = "unit-type-section";
      typeSection.open = !!filter;
      typeSection.innerHTML = `
        <summary class="unit-type-header">
          <span>${group.label}</span>
          <b>${group.units.length}</b>
        </summary>
      `;
      const typeList = document.createElement("div");
      typeList.className = "unit-type-list";
      for (const unit of group.units.sort((a, b) => (a.hex || "").localeCompare(b.hex || "") || a.id.localeCompare(b.id))) {
        typeList.append(renderUnitCard(unit));
      }
      typeSection.append(typeList);
      sideSection.append(typeSection);
    }
    list.append(sideSection);
  }
}

function renderUnitCard(unit) {
    const card = document.createElement("div");
    card.className = `unit-card ${unit.side} ${unit.id === selectedUnitId ? "selected" : ""}`;
    card.innerHTML = `
      <div class="unit-title">
        <span>${unit.name || unit.id}</span>
        <span>${unitTypeGroup(unit).label} ${unit.hex || ""}</span>
      </div>
      <div class="unit-subtitle">${unit.id}</div>
      <div class="unit-meta">
        <label>hex <input data-unit="${unit.id}" data-field="hex" value="${unit.hex || ""}"></label>
        <label>阵营
          <select data-unit="${unit.id}" data-field="side">
            <option value="axis" ${unit.side === "axis" ? "selected" : ""}>axis</option>
            <option value="allies" ${unit.side === "allies" ? "selected" : ""}>allies</option>
          </select>
        </label>
        <label>战力 <input data-unit="${unit.id}" data-field="attack" type="number" value="${unit.attack || 0}"></label>
        <label>移动 <input data-unit="${unit.id}" data-field="movement" type="number" value="${unit.movement || 0}"></label>
      </div>
    `;
    card.addEventListener("click", (event) => {
      if (event.target.matches("input, select, option")) return;
      selectUnit(unit.id);
    });
    card.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("change", () => {
        const target = state.units[input.dataset.unit];
        const field = input.dataset.field;
        target[field] = input.type === "number" ? Number(input.value) : input.value;
        if (field === "attack" && !target.defense) target.defense = target.attack;
        renderState();
      });
    });
    return card;
}

function renderMoveUnits() {
  const select = el("moveUnitSelect");
  const selected = select.value;
  select.innerHTML = "";
  for (const unit of unitsArray().filter(canMoveUnitNow)) {
    const option = document.createElement("option");
    option.value = unit.id;
    option.textContent = `${unit.name || unit.id} (${unit.hex}, ${unit.attack}-${unit.movement})`;
    select.append(option);
  }
  if (selectedUnitId && [...select.options].some((option) => option.value === selectedUnitId)) select.value = selectedUnitId;
  else if (selected && [...select.options].some((option) => option.value === selected)) select.value = selected;
  if ((!selectedUnitId || !state.units[selectedUnitId] || el("tab-move")?.classList.contains("active")) && select.value) {
    selectedUnitId = select.value;
  }
  const fullUnit = syncMoveDraftToUnit(select.value);
  syncMoveModeAvailability(fullUnit);
  renderRouteStatus();
}

function renderCombatControls() {
  const engineerSelect = el("engineerSelect");
  if (engineerSelect) {
    const selected = engineerSelect.value;
    engineerSelect.innerHTML = "";
    const candidates = unitsArray().filter((u) => (
      u.side === state.active_side &&
      !u.eliminated &&
      (isEngineer(u) || (isCombatUnit(u) && enemyMinesAt(u.side, u.hex).length))
    ));
    for (const unit of candidates) {
      const option = document.createElement("option");
      option.value = unit.id;
      option.textContent = `${isEngineer(unit) ? "工兵" : "战斗单位"} · ${unit.name || unit.id} (${unit.hex})`;
      engineerSelect.append(option);
    }
    if (selected && state.units[selected]) engineerSelect.value = selected;
  }
  if (selectedUnitId && state.units[selectedUnitId] && isCombatUnit({ id: selectedUnitId, ...state.units[selectedUnitId] })) {
    const input = el("combatAttackersInput");
    if (input && !input.value.trim()) input.value = selectedUnitId;
  }
}

function renderCalibration() {
  const list = el("calibrationList");
  if (!list) return;
  const status = el("calibrationStatusFilter")?.value || "needs_manual_review";
  const filter = (el("calibrationSearch")?.value || "").trim().toLowerCase();
  const units = unitsArray().filter((unit) => isCombatUnit(unit) || isEngineer(unit) || isSupplyUnit(unit));
  const counts = {
    total: units.length,
    pending: units.filter((unit) => unit.stats_status === "needs_manual_review" || unit.stats_status === "needs_counter_read").length,
    verified: units.filter((unit) => unit.stats_status === "verified").length
  };
  const stats = el("calibrationStats");
  if (stats) {
    stats.innerHTML = `
      <div class="stat"><b>${counts.total}</b>单位</div>
      <div class="stat"><b class="${counts.pending ? "bad" : "ok"}">${counts.pending}</b>待确认</div>
      <div class="stat"><b>${counts.verified}</b>已确认</div>
    `;
  }
  list.innerHTML = "";
  for (const unit of units.sort((a, b) => String(a.stats_status).localeCompare(String(b.stats_status)) || a.hex.localeCompare(b.hex))) {
    const pending = unit.stats_status === "needs_manual_review" || unit.stats_status === "needs_counter_read";
    if (status === "needs_manual_review" && !pending) continue;
    if (status === "verified" && unit.stats_status !== "verified") continue;
    const haystack = `${unit.id} ${unit.name || ""} ${unit.hex} ${unit.side}`.toLowerCase();
    if (filter && !haystack.includes(filter)) continue;
    const card = document.createElement("div");
    card.className = `calibration-card ${pending ? "pending" : ""}`;
    card.innerHTML = `
      ${counterImageFor(unit) ? `<img src="${counterImageFor(unit)}" alt="">` : ""}
      <div>
        <div class="unit-title"><span>${unit.name || unit.id}</span><span>${unit.side} ${unit.hex}</span></div>
        <div class="unit-subtitle">${unit.id}</div>
        <div class="unit-meta">
          <label>战力 <input data-unit="${unit.id}" data-field="attack" type="number" value="${unit.attack || 0}"></label>
          <label>防御 <input data-unit="${unit.id}" data-field="defense" type="number" value="${unit.defense ?? unit.attack ?? 0}"></label>
          <label>移动 <input data-unit="${unit.id}" data-field="movement" type="number" value="${unit.movement || 0}"></label>
          <label>状态
            <select data-unit="${unit.id}" data-field="stats_status">
              <option value="needs_manual_review" ${pending ? "selected" : ""}>needs_manual_review</option>
              <option value="from_name" ${unit.stats_status === "from_name" ? "selected" : ""}>from_name</option>
              <option value="verified" ${unit.stats_status === "verified" ? "selected" : ""}>verified</option>
            </select>
          </label>
        </div>
        <div class="button-row calibration-actions">
          <button data-action="verify" data-unit="${unit.id}">标为已确认</button>
        </div>
      </div>
    `;
    card.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("change", () => {
        const target = state.units[input.dataset.unit];
        target[input.dataset.field] = input.type === "number" ? Number(input.value) : input.value;
        renderState();
      });
    });
    card.querySelector("[data-action='verify']")?.addEventListener("click", () => {
      state.units[unit.id].stats_status = "verified";
      if (state.units[unit.id].defense == null) state.units[unit.id].defense = state.units[unit.id].attack || 0;
      renderState();
    });
    list.append(card);
  }
}

function renderDataOutput() {
  const counts = {};
  for (const tags of Object.values(terrain.hexes || {})) {
    for (const tag of tags) counts[tag] = (counts[tag] || 0) + 1;
  }
  const edgeCounts = {};
  for (const tags of Object.values(terrain.edges || {})) {
    for (const tag of tags) edgeCounts[tag] = (edgeCounts[tag] || 0) + 1;
  }
  el("dataOutput").textContent = JSON.stringify({
    terrain_status: "human_reviewed",
    terrain_hex_tags: counts,
    edge_tags: edgeCounts,
    units: Object.keys(state.units || {}).length,
    scenario: state.scenario || "custom",
    calibration: settings
  }, null, 2);
}

function setOutput(id, value) {
  const target = el(id);
  if (!target) return;
  target.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function compactDetails(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  }
  catch {
    return String(value);
  }
}

function logEvent(type, summary, details = {}) {
  state.game_log ||= [];
  const entry = {
    id: `log-${Date.now()}-${state.game_log.length + 1}`,
    time: new Date().toISOString(),
    turn: Number(state.turn || 1),
    phase: state.phase,
    side: state.active_side,
    type,
    summary,
    details: compactDetails(details)
  };
  state.game_log.push(entry);
  renderGameLog();
  return entry;
}

function logLine(entry) {
  return `T${entry.turn} ${phaseLabel(entry.phase)} [${entry.side || "-"}] ${entry.type}: ${entry.summary}`;
}

function gameLogText() {
  return (state.game_log || []).map(logLine).join("\n");
}

function renderGameLog() {
  const list = el("gameLogList");
  if (!list) return;
  const entries = (state.game_log || []).slice(-80).reverse();
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<div class="unit-list-empty">还没有对局日志</div>`;
    setOutput("logOutput", "");
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("article");
    item.className = `game-log-entry ${entry.type || ""}`;
    item.innerHTML = `
      <h3>${entry.summary || entry.type}<span>T${entry.turn} · ${phaseLabel(entry.phase)}</span></h3>
      <p>${entry.side || ""} · ${new Date(entry.time).toLocaleTimeString()} · ${entry.type}</p>
    `;
    list.append(item);
  }
  setOutput("logOutput", {
    entries: state.game_log.length,
    latest: (state.game_log || []).slice(-12)
  });
}

function downloadTextFile(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function parsePathInput(value) {
  return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function applyZoom() {
  const scale = Number(settings.zoom) / 100;
  el("mapStage").style.transform = `scale(${scale})`;
  el("mapStage").style.width = `${4100 * scale}px`;
  el("mapStage").style.height = `${3275 * scale}px`;
}

function focusMapOnUnits() {
  const positioned = unitsArray().filter((unit) => unit.hex && !unit.eliminated);
  if (!positioned.length) return;
  const points = positioned.map((unit) => hexToPoint(unit.hex));
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const scale = Number(settings.zoom) / 100;
  const viewport = el("mapViewport");
  viewport.scrollLeft = ((minX + maxX) / 2) * scale - viewport.clientWidth / 2;
  viewport.scrollTop = ((minY + maxY) / 2) * scale - viewport.clientHeight / 2;
}

function focusMapOnHex(hex) {
  if (!hex || !onMap(hex)) return;
  const { x, y } = hexToPoint(hex);
  const scale = Number(settings.zoom) / 100;
  const viewport = el("mapViewport");
  if (!viewport) return;
  viewport.scrollTo({
    left: x * scale - viewport.clientWidth / 2,
    top: y * scale - viewport.clientHeight / 2,
    behavior: "smooth"
  });
}

function distance(a, b) {
  const [ac, ar] = splitHex(a);
  const [bc, br] = splitHex(b);
  return Math.abs(ac - bc) + Math.abs(ar - br);
}

function enumerateMoveActions(unitId, mode = "normal", limit = 80) {
  const unit = state.units[unitId];
  if (!unit || unit.side !== state.active_side || unit.state !== "fresh") return [];
  const options = { mode };
  if (!canMoveInCurrentPhase({ id: unitId, ...unit }, options)) return [];
  const allowance = movementAllowance(unit, options);
  const maxDepth = Math.min(14, Math.max(2, allowance + 2));
  const queue = [[normalizeHex(unit.hex)]];
  const seen = new Map([[normalizeHex(unit.hex), 0]]);
  const actions = [];
  while (queue.length) {
    const path = queue.shift();
    const current = path[path.length - 1];
    if (path.length > 1) {
      const verdict = checkMove(unitId, path, options);
      if (verdict.legal) {
        actions.push({ type: "move", unit: unitId, path, mode, verdict });
        if (actions.length >= limit) return actions;
      }
    }
    if (path.length - 1 >= maxDepth) continue;
    for (const next of neighbors(current)) {
      if (path.includes(next)) continue;
      const nextDepth = path.length;
      if ((seen.get(next) ?? Infinity) <= nextDepth) continue;
      const nextPath = [...path, next];
      const verdict = checkMove(unitId, nextPath, options);
      if (verdict.legal) {
        seen.set(next, nextDepth);
        queue.push(nextPath);
      }
    }
  }
  return actions;
}

function enumerateStrategicMoveActions(unitId, mode = "normal", limit = 10) {
  const unit = state.units[unitId];
  if (!unit || unit.side !== state.active_side || unit.state !== "fresh") return [];
  const options = { mode };
  if (!canMoveInCurrentPhase({ id: unitId, ...unit }, options)) return [];
  const start = normalizeHex(unit.hex);
  const actions = [];
  const pushPath = (path) => {
    if (path.length < 2) return;
    const verdict = checkMove(unitId, path, options);
    if (!verdict.legal) return;
    const action = { type: "move", unit: unitId, path, mode, verdict };
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
  let path = [start];
  const maxDepth = Math.min(8, Math.max(2, Math.ceil(movementAllowance(unit, options))));
  for (let depth = 0; depth < maxDepth; depth++) {
    const current = path[path.length - 1];
    const nextSteps = neighbors(current)
      .filter((hex) => !path.includes(hex))
      .map((hex) => {
        const nextPath = [...path, hex];
        const verdict = checkMove(unitId, nextPath, options);
        if (!verdict.legal) return null;
        const action = { type: "move", unit: unitId, path: nextPath, mode, verdict };
        return { score: rulesAiScore(action), ...action };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    if (!nextSteps.length) break;
    const best = nextSteps[0];
    actions.push(best);
    path = best.path;
    if (enemyZocSources(unit.side, path[path.length - 1]).size) break;
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
  const roadPath = rulesContext().roadPath || [];
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
  const options = { mode };
  if (!canMoveInCurrentPhase({ id: unitId, ...unit }, options)) return [];
  const start = normalizeHex(unit.hex);
  const target = rulesAiMoveTarget({ id: unitId, ...unit });
  const actions = [];
  let beam = [{ path: [start] }];
  const maxDepth = Math.min(8, Math.max(2, Math.ceil(movementAllowance(unit, options))));
  for (let depth = 0; depth < maxDepth; depth++) {
    const nextBeam = [];
    for (const branch of beam) {
      const current = branch.path[branch.path.length - 1];
      for (const nb of neighbors(current)) {
        if (branch.path.includes(nb)) continue;
        const path = [...branch.path, nb];
        const verdict = checkMove(unitId, path, options);
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
  if (!canMoveInCurrentPhase({ id: unitId, ...unit }, { mode: "road" })) return [];
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

function readyAttackersForAi() {
  return friendlyUnits(state.active_side).filter((unit) => {
    if (unit.state !== "fresh" || unit.attacked_this_turn || unit.attacked_this_phase) return false;
    if (aiScoreSupplyState(unit.id) === "isolated") return false;
    if (enemyMinesAt(unit.side, unit.hex).length && !unit.mine_cleared_entry) return false;
    return true;
  });
}

function crtColumn(column) {
  const columns = rules.combat?.odds_columns || DEFAULT_RULES.combat?.odds_columns || ["1-4", "1-3", "1-2", "1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"];
  const index = columns.indexOf(column);
  if (index < 0) return {};
  const result = {};
  for (let die = 1; die <= 6; die++) {
    result[String(die)] = rules.combat?.crt?.[String(die)]?.[index] || null;
  }
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
      .filter((u) => u.side === state.active_side && isMovableUnit(u) && u.state === "fresh" && canMoveInCurrentPhase(u))
      .filter((u) => !octoberWithdrawal || octoberAxisWithdrawalCandidate(u))
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
  actions.push({ type: "pass", reason: "不行动" });
  return actions.slice(0, limit);
}

function compactAction(action) {
  if (!action) return null;
  if (action.type === "exit_west") return { type: "exit_west", unit: action.unit };
  if (action.type === "move") {
    return {
      type: "move",
      unit: action.unit,
      path: action.path,
      mode: action.mode || "normal",
      destination: action.path?.[action.path.length - 1],
      spent: action.verdict?.details?.spent,
      allowance: action.verdict?.details?.allowance
    };
  }
  if (action.type === "combat") {
    return {
      type: "combat",
      attackers: action.attackers,
      defender_hexes: action.defender_hexes,
      odds_column: action.verdict?.details?.odds_column,
      attack: action.verdict?.details?.attack,
      defense: action.verdict?.details?.defense,
      crt_column: action.verdict?.details?.crt_column
    };
  }
  return { type: "pass", reason: action.reason || "不行动" };
}

function combatRiskScore(crtColumnMap) {
  const values = Object.values(crtColumnMap || {});
  if (!values.length) return 0;
  const weights = { De: 8, Ex: 3, D3: 5, D2: 4, D1: 3, A1: -2, A2: -4, A3: -5, Ae: -8 };
  return values.reduce((sum, outcome) => sum + (weights[outcome] || 0), 0) / values.length;
}

function scoreAiAction(action) {
  if (action.type === "pass") return -999;
  const target = normalizeHex(el("aiTargetInput").value || "3711");
  const goalWeight = Number(el("aiGoalWeight").value || 5);
  const zocPenalty = Number(el("aiZocPenalty").value || 3);
  if (action.type === "combat") {
    const details = action.verdict?.details || {};
    const oddsIndex = (rules.combat?.odds_columns || []).indexOf(details.odds_column);
    const attackers = action.attackers.map((id) => state.units[id]).filter(Boolean);
    const strength = attackers.reduce((sum, unit) => sum + Number(unit.attack || 0), 0);
    return combatRiskScore(details.crt_column) + oddsIndex * 1.5 + strength * 0.2;
  }
  const unit = state.units[action.unit];
  const destination = action.path[action.path.length - 1];
  let score = (distance(unit.hex, target) - distance(destination, target)) * goalWeight;
  if (enemyZocSources(unit.side, destination).size) score -= zocPenalty;
  const supply = aiScoreSupplyState(action.unit);
  if (supply === "unsupplied") score -= 2;
  if (supply === "isolated") score -= 5;
  const tags = terrain.hexes?.[destination] || [];
  if (tags.includes("alamein_box")) score += 8;
  if (tags.includes("hill_or_ridge")) score += 1;
  if (action.mode === "road") score += 0.5;
  score += Number(unit.attack || 0) * 0.15;
  return score;
}

function fixedAiTarget(side = state.active_side) {
  if (side === "axis" && state.scenario === "october" && Number(state.turn || 1) > 10) return "0101";
  if (side === "axis") return normalizeHex(rules.game?.alamein_hex || "3711");
  return normalizeHex(rules.game?.alamein_hex || "3711");
}

function canExitWest(unitId) {
  const unit = state.units?.[unitId];
  if (!unit) return { legal: false, reason: "未知单位" };
  if (state.scenario !== "october") return { legal: false, reason: "只有 October 场景使用西边撤出 VP" };
  if (unit.side !== "axis" || state.active_side !== "axis") return { legal: false, reason: "只有 Axis 当前方单位可从西边撤出" };
  if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind())) return { legal: false, reason: "只能在移动阶段撤出" };
  if (Number(state.turn || 1) <= 10) return { legal: false, reason: "October 第 10 回合结束后才可撤出" };
  if (!unit.hex || hexColumn(unit.hex) !== 1) return { legal: false, reason: "单位必须位于西边缘" };
  if (!(isCombatUnit({ id: unitId, ...unit }) || isSupplyUnit({ id: unitId, ...unit }))) return { legal: false, reason: "只有作战或补给单位计撤出 VP" };
  return { legal: true, reason: "可从西边撤出", action: { type: "exit_west", unit: unitId } };
}

function exitWestUnit(unitId, source = "manual") {
  const validation = canExitWest(unitId);
  if (!validation.legal) return validation;
  const action = validation.action;
  pushHistory(source === "ai" ? "ai_exit_west" : "exit_west");
  const unit = state.units[action.unit];
  unit.exited_edge = "west";
  unit.exit_edge = "west";
  unit.exited_turn = Number(state.turn || 1);
  unit.exit_turn = Number(state.turn || 1);
  unit.off_map = true;
  unit.state = "spent";
  logEvent(source === "ai" ? "ai_exit_west" : "exit_west", `${source === "ai" ? "AI " : ""}撤出西边 ${action.unit}`, { action, turn: state.turn });
  renderState();
  return { legal: true, reason: source === "ai" ? "AI 已从西边撤出单位" : "已从西边撤出单位", action, verdict: validation };
}

function hexColumn(hex) {
  return Number(normalizeHex(hex).slice(0, 2));
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

function scenarioFinalTurnForAi() {
  return Number(state.scenario_meta?.final_turn || RulesEngine.SCENARIO_META?.[state.scenario]?.final_turn || 7);
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

function octoberAxisStagingTarget(unit) {
  if (!unit?.hex) return "1809";
  const [, row] = splitHex(unit.hex);
  if (hexColumn(unit.hex) <= 18) return normalizeHex(unit.hex);
  const candidate = `18${String(row).padStart(2, "0")}`;
  try { return normalizeHex(candidate); }
  catch { return "1809"; }
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

function rulesAiScore(action) {
  if (!action || action.type === "pass") return -10000;
  if (action.type === "exit_west") {
    const unit = state.units[action.unit];
    return 500 + (unit?.kind === "supply" ? 80 : Number(unit?.attack || unit?.defense || 0) * 12);
  }
  if (action.type === "combat") {
    const details = action.verdict?.details || {};
    const columns = rules.combat?.odds_columns || DEFAULT_RULES.combat?.odds_columns || ["1-4", "1-3", "1-2", "1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"];
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

function suggestRulesAction() {
  aiScoreSupplyCache = aiSupplyScoreMap(state.active_side);
  try {
    const candidates = enumerateLegalAiActions(Math.max(80, Number(el("aiMaxActionsInput")?.value || 80)))
      .map((action) => ({ score: rulesAiScore(action), ...action }))
      .sort((a, b) => b.score - a.score);
    const kind = phaseKind();
    const minimumScore = kind === "combat" ? 165 : kind === "supply_movement" ? 2 : state.active_side === "axis" ? 4 : 6;
    const best = candidates.find((action) => action.type !== "pass" && action.score >= minimumScore);
    return {
      type: "rules",
      policy: "固定规则：Axis 向 Alamein/东方推进；Allies 防守关键区并只就近截击，不以 Axis 后方补给源为全局目标；战斗阶段优先公开 CRT 期望值高的合法攻击。",
      target: fixedAiTarget(state.active_side),
      action: best || { type: "pass", reason: "规则 AI 没有找到值得执行的合法动作" },
      candidates: candidates.slice(0, 10).map((action) => ({ score: action.score, action: compactAction(action) }))
    };
  }
  finally {
    aiScoreSupplyCache = null;
  }
}

function suggestHeuristicAction() {
  aiScoreSupplyCache = aiSupplyScoreMap(state.active_side);
  try {
    const maxActions = Number(el("aiMaxActionsInput")?.value || 50);
    const candidates = [];
    for (const action of enumerateLegalAiActions(maxActions)) candidates.push({ score: scoreAiAction(action), ...action });
    candidates.sort((a, b) => b.score - a.score);
    return {
      type: "heuristic",
      action: candidates[0] || { type: "pass", reason: "没有合法动作" },
      candidates: candidates.slice(0, 10).map((action) => ({ score: action.score, action: compactAction(action) }))
    };
  }
  finally {
    aiScoreSupplyCache = null;
  }
}

function normalizeAiAction(raw) {
  const action = raw?.action || raw;
  if (!action || typeof action !== "object") return { type: "pass", reason: "空动作" };
  if (action.type === "exit_west") return { type: "exit_west", unit: action.unit };
  if (action.type === "move") return { type: "move", unit: action.unit, path: (action.path || []).map(normalizeHex), mode: action.mode || "normal" };
  if (action.type === "combat") return { type: "combat", attackers: action.attackers || [], defender_hexes: (action.defender_hexes || []).map(normalizeHex), no_retreat_order: !!action.no_retreat_order };
  return { type: "pass", reason: action.reason || raw?.reason || "不行动" };
}

function validateAiAction(rawAction) {
  let action;
  try {
    action = normalizeAiAction(rawAction);
  }
  catch (error) {
    return { legal: false, reason: error.message };
  }
  if (action.type === "pass") return { legal: true, reason: "AI 选择不行动", action };
  if (action.type === "exit_west") return canExitWest(action.unit);
  if (action.type === "move") return { ...checkMove(action.unit, action.path, { mode: action.mode || "normal" }), action };
  if (action.type === "combat") return { ...publicCombatVerdict(action), action };
  return { legal: false, reason: `未知 AI 动作 ${action.type}`, action };
}

function applyAiAction(rawAction) {
  const validation = validateAiAction(rawAction);
  if (!validation.legal) return validation;
  const action = validation.action;
  if (action.type === "pass") return validation;
  if (action.type === "exit_west") {
    return exitWestUnit(action.unit, "ai");
  }
  if (action.type === "move") {
    pushHistory("ai_move");
    const unit = state.units[action.unit];
    const fromHex = normalizeHex(unit.hex);
    unit.hex = normalizeHex(action.path[action.path.length - 1]);
    unit.road_mode = action.mode === "road";
    unit.road_facing = action.path.length > 1 ? hexDirection(action.path[action.path.length - 2], action.path[action.path.length - 1]) : unit.road_facing;
    unit.facing = unit.road_facing;
    unit.state = "spent";
    if (isEngineer({ id: action.unit, ...unit }) && phaseKind() === "initial_movement" && enemyMinesAt(unit.side, unit.hex).length) {
      RulesEngine.clearMine(rulesContext(), action.unit, unit.hex);
    }
    selectedUnitId = action.unit;
    movePathDraft = [unit.hex];
    syncMovePathInput();
    logEvent("ai_move", `AI 移动 ${action.unit}：${fromHex} -> ${unit.hex}`, { action, verdict: validation });
    renderStateAfterAction();
    return { legal: true, reason: "AI 移动已执行", action, verdict: validation };
  }
  if (action.type === "combat") {
    logEvent("ai_combat_choice", `AI 选择攻击 ${action.defender_hexes.join(", ")}`, { action });
    const userDie = Number(el("combatResolveDieSelect")?.value || 0);
    const die = userDie >= 1 && userDie <= 6 ? userDie : Math.floor(Math.random() * 6) + 1;
    const result = resolveCombat({ attackers: action.attackers, defender_hexes: action.defender_hexes, die, no_retreat_order: !!action.no_retreat_order });
    return { ...result, action, die, source: userDie ? "user" : "frontend_random" };
  }
  return { legal: false, reason: `不能执行未知动作 ${action.type}`, action };
}

function aiToolsSchema() {
  return [
    { name: "list_legal_actions", arguments: { limit: "number" } },
    { name: "check_move", arguments: { unit: "string", path: ["hex"], mode: "normal|road" } },
    { name: "find_path", arguments: { unit: "string", target: "hex", mode: "normal|road" } },
    { name: "check_combat", arguments: { attackers: ["unit-id"], defender_hexes: ["hex"] } },
    { name: "inspect_unit", arguments: { unit: "unit-id" } },
    { name: "inspect_hex", arguments: { hex: "hex" } },
    { name: "trace_supply", arguments: { unit: "unit-id" } },
    { name: "evaluate_action", arguments: { action: { type: "move|combat|pass" } } }
  ];
}

function aiStateSummary() {
  return {
    scenario: state.scenario || "custom",
    turn: Number(state.turn || 1),
    phase: state.phase,
    active_side: state.active_side,
    victory_points: Number(state.victory_points || 0),
    units: unitsArray()
      .filter((unit) => isMapCounter(unit) && !unit.eliminated)
      .map((unit) => ({
        id: unit.id,
        name: unit.name || unit.id,
        side: unit.side,
        hex: unit.hex,
        kind: unit.kind || "ground",
        attack: unit.attack || 0,
        defense: unit.defense ?? unit.attack ?? 0,
        movement: unit.movement || 0,
        state: unit.state || "fresh",
        supply_state: unit.supply_state || "supplied",
        road_mode: !!unit.road_mode,
        piece_type: unit.piece_type || ""
      }))
  };
}

function inspectUnitForAi(unitId) {
  const unit = state.units[unitId];
  if (!unit) return { legal: false, reason: `未知单位 ${unitId}` };
  const full = { id: unitId, ...unit };
  return {
    legal: true,
    unit: {
      id: unitId,
      name: unit.name || unitId,
      side: unit.side,
      hex: unit.hex,
      kind: unit.kind || "ground",
      attack: unit.attack || 0,
      defense: unit.defense ?? unit.attack ?? 0,
      movement: unit.movement || 0,
      effective_attack: isCombatUnit(full) ? effectiveAttack(full) : 0,
      effective_defense: isCombatUnit(full) ? effectiveDefense(full) : 0,
      effective_movement: effectiveMovement(full),
      supply_state: isPlayableSide(unit.side) ? supplyState(unitId) : "",
      zoc_hexes: zocHexes(full),
      terrain: unit.hex ? hexTags(unit.hex) : [],
      can_move_now: isMovableUnit(full) && canMoveInCurrentPhase(full, { mode: "normal" }) && unit.state === "fresh",
      can_attack_now: phaseKind() === "combat" && isCombatUnit(full) && unit.side === state.active_side && unit.state === "fresh" && !unit.attacked_this_turn
    }
  };
}

function inspectHexForAi(rawHex) {
  const hex = normalizeHex(rawHex);
  const unitList = (unitsByHex()[hex] || []).map((unit) => ({ id: unit.id, name: unit.name || unit.id, side: unit.side, kind: unit.kind || "ground" }));
  return {
    legal: true,
    hex,
    terrain: hexTags(hex),
    units: unitList,
    mines: minesAt(hex).map((mine) => ({ id: mine.id, side: mine.side, name: mine.name || mine.id })),
    zoc: {
      axis: enemyZocSources("allies", hex).size > 0,
      allies: enemyZocSources("axis", hex).size > 0
    },
    road_neighbors: neighbors(hex).filter((nb) => edgeTags(normalizeEdge(hex, nb)).includes("road"))
  };
}

function traceSupplyForAi(unitId) {
  const unit = state.units[unitId];
  if (!unit) return { legal: false, reason: `未知单位 ${unitId}` };
  const path = traceSupplyPath(unitId);
  return {
    legal: true,
    unit: unitId,
    supply_state: isPlayableSide(unit.side) ? supplyState(unitId) : "",
    path,
    blocked: path.length ? [] : [...supplyBlockedHexes(unit.side)].slice(0, 80)
  };
}

function runAiTool(tool, args = {}) {
  try {
    if (tool === "list_legal_actions") return { legal: true, actions: enumerateLegalAiActions(Number(args.limit || 50)).map(compactAction) };
    if (tool === "check_move") return checkMove(args.unit, args.path || [], { mode: args.mode || "normal" });
    if (tool === "find_path") {
      const path = findLegalPath(args.unit, args.target, { mode: args.mode || "normal" });
      return path ? { legal: true, path, verdict: checkMove(args.unit, path, { mode: args.mode || "normal" }) } : { legal: false, reason: "找不到合法路径" };
    }
    if (tool === "check_combat") return publicCombatVerdict({ attackers: args.attackers || [], defender_hexes: (args.defender_hexes || []).map(normalizeHex), no_retreat_order: !!args.no_retreat_order });
    if (tool === "inspect_unit") return inspectUnitForAi(args.unit);
    if (tool === "inspect_hex") return inspectHexForAi(args.hex);
    if (tool === "trace_supply") return traceSupplyForAi(args.unit);
    if (tool === "evaluate_action") return validateAiAction(args.action);
    return { legal: false, reason: `未知工具 ${tool}` };
  }
  catch (error) {
    return { legal: false, reason: error.message };
  }
}

function aiRulesSummary() {
  return "你是 El Alamein 外部 AI。你可以调用只读工具查询规则结果。最终只能返回 move/combat/pass。combat 不允许包含 die；骰点由前端裁判在结算时产生。所有最终动作都会被前端裁判二次验证。";
}

function externalAiPayload(toolResults = []) {
  const limit = Number(el("aiMaxActionsInput")?.value || 50);
  return {
    model: el("aiModelInput")?.value || "",
    side: state.active_side,
    turn: Number(state.turn || 1),
    phase: state.phase,
    scenario: state.scenario || "custom",
    state_summary: aiStateSummary(),
    legal_actions: enumerateLegalAiActions(limit).map(compactAction),
    tools: aiToolsSchema(),
    tool_results: toolResults,
    rules_summary: aiRulesSummary()
  };
}

async function requestExternalAiAction() {
  const url = el("aiApiUrlInput")?.value.trim();
  if (!url) return { type: "external", error: "请填写 API URL" };
  const maxRounds = Number(el("aiMaxToolRoundsInput")?.value || 4);
  const timeoutMs = Number(el("aiTimeoutInput")?.value || 20) * 1000;
  const toolResults = [];
  const calls = [];
  for (let round = 0; round <= maxRounds; round++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let json;
    try {
      const headers = { "Content-Type": "application/json" };
      const key = el("aiApiKeyInput")?.value;
      if (key) headers.Authorization = `Bearer ${key}`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(externalAiPayload(toolResults)),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`API ${response.status} ${response.statusText}`);
      json = await response.json();
    }
    catch (error) {
      return { type: "external", error: error.name === "AbortError" ? "API 请求超时" : error.message, tool_results: toolResults };
    }
    finally {
      clearTimeout(timer);
    }

    if (json.type === "tool_call") {
      if (round >= maxRounds) return { type: "external", error: "超过最大工具轮数", response: json, tool_results: toolResults };
      const result = runAiTool(json.tool, json.arguments || {});
      const record = { tool: json.tool, arguments: json.arguments || {}, result };
      toolResults.push(record);
      calls.push(record);
      continue;
    }

    const finalAction = json.type === "final_action" ? json.action : json.action || json;
    const validation = validateAiAction(finalAction);
    return { type: "external", action: validation.action || finalAction, reason: json.reason || "", validation, tool_results: toolResults, raw_response: json };
  }
  return { type: "external", error: "外部 AI 未返回最终动作", tool_results: toolResults, calls };
}

async function suggestAiAction() {
  const mode = aiModeForSide(state.active_side);
  if (mode === "external") return requestExternalAiAction();
  if (mode === "rules") return suggestRulesAction();
  return suggestHeuristicAction();
}

function renderAiConfig() {
  const config = el("aiExternalConfig");
  if (!config) return;
  config.classList.toggle("active", aiModeForSide(state.active_side) === "external" || el("aiModeSelect")?.value === "external");
  renderAiProfiles();
  syncAiAutoControls();
  renderActionControls();
}

async function playAiForCurrentSide() {
  const controller = playerController(state.active_side);
  if (controller === "human") {
    const result = { legal: false, reason: `${state.active_side} 当前由人类玩家控制` };
    setOutput("aiOutput", result);
    return result;
  }
  setOutput("aiOutput", { status: "thinking", side: state.active_side, controller });
  aiSuggestion = await suggestAiAction();
  if (aiSuggestion.error || !aiSuggestion.action) {
    setOutput("aiOutput", { error: aiSuggestion.error || "AI 没有返回最终动作", suggestion: aiSuggestion });
    return aiSuggestion;
  }
  const result = applyAiAction(aiSuggestion.action);
  setOutput("aiOutput", { applied: result, suggestion: aiSuggestion });
  aiSuggestion = null;
  return result;
}

function currentPhaseIsAiControlled() {
  if (state.phase === "end_game_turn") return true;
  const side = phaseSide(state.phase);
  return isPlayableSide(side) && isAiController(playerController(side));
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

function scheduleAiAutoplay() {
  syncAiAutoControls();
  if (!state.ai_autoplay || aiAutoRunning || !currentPhaseIsAiControlled()) return;
  setTimeout(() => autoPlayAi(), 30);
}

function setAiAutoplay(value) {
  state.ai_autoplay = !!value && anySideAiControlled();
  syncAiAutoControls();
  renderActionControls();
  if (state.ai_autoplay) scheduleAiAutoplay();
  else setOutput("aiOutput", { status: anySideAiControlled() ? "AI 已暂停" : "当前没有 AI 控制方" });
}

async function autoPlayAi(maxSteps = 80) {
  if (aiAutoRunning) return { legal: false, reason: "AI 自动推进已经在运行" };
  aiAutoRunning = true;
  const log = [];
  let finalVictory = null;
  try {
    for (let step = 0; step < maxSteps && state.ai_autoplay; step++) {
      if (state.phase === "end_game_turn") {
        finalVictory = stopAiAtFinalVictory(log);
        if (finalVictory) break;
        const from = state.phase;
        advancePhase();
        log.push({ step: step + 1, action: "advance_phase", from, to: state.phase });
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const side = phaseSide(state.phase);
      if (!isPlayableSide(side) || !isAiController(playerController(side))) break;
      state.active_side = side;
      if (shouldAdvanceAiPhaseByBudget(side)) {
        const from = state.phase;
        const count = aiPhaseActionCount();
        const limit = aiPhaseActionLimit(side);
        advancePhase();
        log.push({ step: step + 1, side, action: "budget_then_advance", count, limit, from, to: state.phase });
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      setOutput("aiOutput", { status: "auto_running", step: step + 1, side, phase: state.phase, log: log.slice(-8) });
      const suggestion = await suggestAiAction();
      if (suggestion.error || !suggestion.action) {
        log.push({ step: step + 1, side, phase: state.phase, error: suggestion.error || "AI 没有动作" });
        state.ai_autoplay = false;
        break;
      }
      const action = normalizeAiAction(suggestion.action);
      if (action.type === "pass") {
        const from = state.phase;
        advancePhase();
        log.push({ step: step + 1, side, action: "pass_then_advance", from, to: state.phase });
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      let result;
      suppressAiActionRender = true;
      try {
        result = applyAiAction(action);
      }
      finally {
        suppressAiActionRender = false;
      }
      if (result.legal) incrementAiPhaseActionCount();
      log.push({ step: step + 1, side, phase: state.phase, action: compactAction(action), result: { legal: result.legal, reason: result.reason, die: result.die } });
      if (!result.legal) {
        state.ai_autoplay = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  finally {
    aiAutoRunning = false;
    syncAiAutoControls();
  }
  const stillCanRun = state.ai_autoplay && currentPhaseIsAiControlled();
  setOutput("aiOutput", finalVictory
    ? { status: "final_victory", victory: finalVictory, log }
    : {
      status: stillCanRun ? "auto_paused_at_step_limit" : state.ai_autoplay ? "auto_waiting_for_human" : "auto_stopped",
      max_steps: maxSteps,
      log
    });
  if (stillCanRun) setTimeout(() => autoPlayAi(maxSteps), 30);
  return { legal: true, log };
}

async function loadJson(url, fallback) {
  try {
    const response = await fetch(versionedLocalUrl(url), { cache: "no-store" });
    if (!response.ok) throw new Error(response.statusText);
    return await response.json();
  }
  catch {
    return structuredClone(fallback);
  }
}

function applyStateDefaults(nextState) {
  state = nextState || structuredClone(FALLBACK_STATE);
  RulesEngine.applyStateDefaults(state);
  const legacyPhases = {
    axis_operational_movement: "axis_initial_movement",
    allies_operational_movement: "allies_initial_movement",
    axis_attack: "axis_combat",
    allies_attack: "allies_combat"
  };
  state.phase = legacyPhases[state.phase] || state.phase || "axis_initial_movement";
  state.active_side ||= state.activeSide || "axis";
  syncActiveSideFromPhase();
  state.units ||= {};
  state.player_control ||= { axis: "human", allies: "human" };
  state.player_control.axis ||= "human";
  state.player_control.allies ||= "human";
  state.ai_autoplay = anySideAiControlled();
  state.victory_points ||= 0;
  state.boxed_areas_active ??= true;
  state.rules_version ||= "first-alamein-standard-v1";
  state.app_version = APP_VERSION;
  state.scenario_meta = { ...(RulesEngine.SCENARIO_META[state.scenario] || {}), ...(state.scenario_meta || {}), standard_scenario_only: true };
  state.road_supply_markers ||= {};
  state.combat_log ||= [];
  state.game_log ||= [];
  state.ai_phase_action_counts ||= {};
  for (const unit of Object.values(state.units)) {
    if (isTrackMarker(unit)) {
      unit.kind = "marker";
      unit.side = "neutral";
      unit.off_map = true;
      unit.stats_status = "marker";
      unit.attack = 0;
      unit.defense = 0;
      unit.movement = 0;
    }
    if (unit.stats_status === "needs_counter_read") unit.stats_status = "needs_manual_review";
    unit.supply_state ||= "supplied";
    unit.road_mode = !!unit.road_mode;
    unit.road_facing ??= unit.facing ?? null;
    unit.facing ??= unit.road_facing ?? null;
    unit.attacked_this_turn = !!unit.attacked_this_turn;
    unit.attacked_this_phase = !!unit.attacked_this_phase;
    unit.defended_this_phase = !!unit.defended_this_phase;
    unit.mine_cleared_this_turn = !!(unit.mine_cleared_this_turn || unit.cleared_mine_this_turn);
    unit.cleared_mine_this_turn = unit.mine_cleared_this_turn;
    unit.engineer_assisted_this_turn = !!unit.engineer_assisted_this_turn;
    if (isMapCounter(unit) && !unit.image) unit.image = defaultCounterImage(unit);
  }
  if (selectedUnitId && !state.units[selectedUnitId]) selectedUnitId = null;
  selectedHexId = null;
  actionLog = [];
  aiSupplyScorePhaseCache = null;
  movePathDraft = [];
  const grid = state.map_grid;
  if (grid) {
    settings.originX = Number(grid.x0 ?? settings.originX);
    settings.originY = Number(grid.y0 ?? settings.originY);
    settings.colStep = Number(grid.dx ?? settings.colStep);
    settings.rowStep = Number(grid.dy ?? settings.rowStep);
    settings.rowOffset = Number(grid.even_column_y_offset ?? settings.rowOffset);
  }
  syncSettingsInputs();
  syncPlayerControls();
  renderGameLog();
}

function syncSettingsInputs() {
  const values = {
    originXInput: settings.originX,
    originYInput: settings.originY,
    colStepInput: settings.colStep,
    rowStepInput: settings.rowStep,
    rowOffsetInput: settings.rowOffset,
    unitSizeInput: settings.unitSize,
    stackSpreadInput: settings.stackSpread
  };
  for (const [id, value] of Object.entries(values)) {
    const input = el(id);
    if (input) input.value = value;
  }
}

async function loadScenario(name) {
  const nextState = await loadJson(SCENARIO_URLS[name] || SCENARIO_URLS.july, FALLBACK_STATE);
  applyStateDefaults(nextState);
  logEvent("load_scenario", `加载战役场景：${state.scenario || name}`, { scenario: state.scenario || name });
  el("scenarioSelect").value = state.scenario || name;
  renderState();
  renderDataOutput();
  focusMapOnUnits();
  renderAutoJudge();
  scheduleAiAutoplay();
}

async function initData() {
  rules = await loadJson("./rules_first_alamein.json", DEFAULT_RULES);
  terrain = await loadJson("./terrain.json", { hexes: {}, edges: {} });
  applyStateDefaults(await loadJson(SCENARIO_URLS.july, FALLBACK_STATE));
}

function initControls() {
  for (const phase of rules.turn_sequence || DEFAULT_RULES.turn_sequence) {
    const option = document.createElement("option");
    option.value = phase;
    option.textContent = phaseLabel(phase);
    el("phaseSelect").append(option);
    const setupOption = option.cloneNode(true);
    el("setupPhaseSelect")?.append(setupOption);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      switchTab(tab.dataset.tab);
    });
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target?.matches?.("input, select, textarea, button")) return;
    const key = event.key.toLowerCase();
    if (key === "m") {
      activateMoveForSelectedUnit();
      event.preventDefault();
    }
    else if (key === "c") {
      activateCombatForSelectedUnit();
      event.preventDefault();
    }
    else if (key === "s") {
      activateSupplyForSelectedUnit();
      event.preventDefault();
    }
    else if (event.key === "Escape") {
      selectedUnitId = null;
      selectedHexId = null;
      selectedCombatDefenderHex = null;
      highlightedSupplyPath = [];
      movePathDraft = [];
      syncMovePathInput();
      renderState();
      movePathDraft = [];
      syncMovePathInput();
      renderRouteStatus();
      renderMap();
      event.preventDefault();
    }
  });

  el("turnInput").addEventListener("change", () => { state.turn = Number(el("turnInput").value); renderState(); });
  el("activeSideSelect").addEventListener("change", () => { state.active_side = el("activeSideSelect").value; renderState(); });
  el("phaseSelect").addEventListener("change", () => {
    state.phase = el("phaseSelect").value;
    syncActiveSideFromPhase();
    renderState();
    scheduleAiAutoplay();
  });
  el("axisPlayerSelect")?.addEventListener("change", () => {
    state.player_control ||= { axis: "human", allies: "human" };
    state.player_control.axis = el("axisPlayerSelect").value;
    state.ai_autoplay = anySideAiControlled();
    renderState();
    scheduleAiAutoplay();
  });
  el("alliesPlayerSelect")?.addEventListener("change", () => {
    state.player_control ||= { axis: "human", allies: "human" };
    state.player_control.allies = el("alliesPlayerSelect").value;
    state.ai_autoplay = anySideAiControlled();
    renderState();
    scheduleAiAutoplay();
  });
  el("aiModeSelect")?.addEventListener("change", renderAiConfig);
  el("aiProfileSelect")?.addEventListener("change", () => applyAiProfile(el("aiProfileSelect").value));
  el("saveAiProfileBtn")?.addEventListener("click", saveAiProfile);
  el("deleteAiProfileBtn")?.addEventListener("click", deleteAiProfile);
  el("openSetupBtn")?.addEventListener("click", showSetupScreen);
  el("setupModeNewBtn")?.addEventListener("click", () => setSetupMode("new"));
  el("setupModeLoadBtn")?.addEventListener("click", loadSetupSelectedSlot);
  el("setupBackHomeBtn")?.addEventListener("click", () => setSetupMode("home"));
  el("setupStartBtn")?.addEventListener("click", startFromSetup);
  ["setupScenarioSelect", "setupTurnInput", "setupPhaseSelect", "setupAxisRoleSelect", "setupAlliesRoleSelect", "setupAiModeSelect", "setupAiTargetInput"].forEach((id) => {
    el(id)?.addEventListener("input", () => {
      if (id === "setupScenarioSelect") {
        const scenario = el("setupScenarioSelect").value;
        el("setupTurnInput").value = setupScenarioTurnDefault(scenario);
        el("setupPhaseSelect").value = setupScenarioPhaseDefault(scenario);
      }
      renderSetupSummary();
    });
    el(id)?.addEventListener("change", () => {
      if (id === "setupScenarioSelect") {
        const scenario = el("setupScenarioSelect").value;
        el("setupTurnInput").value = setupScenarioTurnDefault(scenario);
        el("setupPhaseSelect").value = setupScenarioPhaseDefault(scenario);
      }
      renderSetupSummary();
    });
  });
  el("setupRefreshSlotsBtn")?.addEventListener("click", () => {
    renderSaveSlots();
    setOutput("setupSaveOutput", { slots: saveSlots().map(slotLabel) });
  });
  el("setupSaveSlotSelect")?.addEventListener("change", () => {
    const slot = saveSlots().find((item) => item.id === el("setupSaveSlotSelect").value);
    setOutput("setupSaveOutput", slot ? { selected: slotLabel(slot) } : { reason: "请选择一个存档槽" });
  });
  el("nextPhaseBtn").addEventListener("click", advancePhase);
  el("unitSearch").addEventListener("input", renderUnitList);
  ["showUnitsToggle", "showMarkersToggle", "expandStacksToggle", "showMinesToggle", "showReachableToggle", "showZocToggle", "showTerrainToggle", "showHexToggle", "mapViewModeSelect"].forEach((id) => el(id).addEventListener("change", () => { renderOperationHint(); renderMap(); }));
  el("moveUnitSelect").addEventListener("change", () => selectUnit(el("moveUnitSelect").value, { showStateTab: false }));
  el("moveModeSelect").addEventListener("change", () => { renderRouteStatus(); renderActionControls(); renderMap(); });
  el("combatDieSelect").addEventListener("change", renderAutoJudge);
  el("useSelectedCombatBtn").addEventListener("click", () => {
    if (selectedUnitId) el("combatAttackersInput").value = selectedUnitId;
    if (selectedCombatDefenderHex) el("combatDefendersInput").value = selectedCombatDefenderHex;
    setOutput("combatOutput", checkCombat(parseCombatAction()));
    renderActionControls();
  });
  el("previewCombatBtn").addEventListener("click", () => setOutput("combatOutput", checkCombat(parseCombatAction())));
  el("resolveCombatBtn").addEventListener("click", () => {
    setOutput("combatOutput", resolveCombat(parseCombatAction()));
    renderActionControls();
  });
  el("undoActionBtn").addEventListener("click", undoLastAction);
  el("clearMineBtn").addEventListener("click", () => {
    setOutput("combatOutput", clearMine(el("engineerSelect").value, el("mineHexInput").value));
    renderActionControls();
  });
  ["combatAttackersInput", "combatDefendersInput", "combatResolveDieSelect", "engineerSelect", "mineHexInput"].forEach((id) => {
    el(id)?.addEventListener("input", renderActionControls);
    el(id)?.addEventListener("change", renderActionControls);
  });
  el("calibrationStatusFilter").addEventListener("change", renderCalibration);
  el("calibrationSearch").addEventListener("input", renderCalibration);
  el("moveTargetInput")?.addEventListener("input", renderActionControls);
  el("movePathInput").addEventListener("input", () => {
    try {
      movePathDraft = parsePathInput(el("movePathInput").value).map(normalizeHex);
    }
    catch {
      movePathDraft = parsePathInput(el("movePathInput").value);
    }
    renderRouteStatus();
    renderActionControls();
    renderMap();
  });
  el("autoRouteBtn").addEventListener("click", () => {
    const unitId = el("moveUnitSelect").value;
    const target = el("moveTargetInput").value;
    const path = findLegalPath(unitId, target, moveOptions());
    if (!path) {
      setOutput("moveOutput", { legal: false, reason: "找不到合法自动路线", target });
      return;
    }
    movePathDraft = path;
    syncMovePathInput();
    renderRouteStatus();
    renderActionControls();
    renderMap();
  });
  el("enterRoadModeBtn").addEventListener("click", () => {
    el("moveModeSelect").value = "road";
    renderRouteStatus();
    renderActionControls();
    renderMap();
  });
  el("leaveRoadModeBtn").addEventListener("click", () => {
    const unitId = el("moveUnitSelect").value;
    if (!unitId || !state.units[unitId]) return;
    const unit = { id: unitId, ...state.units[unitId] };
    if (!canLeaveRoadModeNow(unit)) {
      setOutput("moveOutput", { legal: false, reason: "当前不能离开道路模式" });
      renderActionControls();
      return;
    }
    pushHistory("leave_road_mode");
    state.units[unitId].road_mode = false;
    state.units[unitId].facing = null;
    el("moveModeSelect").value = "normal";
    renderState();
    setOutput("moveOutput", { legal: true, reason: `${unitId} 已离开道路模式` });
  });
  el("exitWestBtn").addEventListener("click", () => {
    const unitId = el("moveUnitSelect").value;
    const result = exitWestUnit(unitId, "manual");
    setOutput("moveOutput", result);
    renderState();
  });

  el("loadScenarioBtn").addEventListener("click", () => loadScenario(el("scenarioSelect").value));
  el("scenarioSelect").addEventListener("change", () => loadScenario(el("scenarioSelect").value));
  el("loadExampleBtn").addEventListener("click", async () => {
    applyStateDefaults(await loadJson("./example_state.json", FALLBACK_STATE));
    logEvent("load_example", "加载示例局面", {});
    renderState();
    renderDataOutput();
    focusMapOnUnits();
    scheduleAiAutoplay();
  });
  el("importBtn").addEventListener("click", () => el("fileInput").click());
  el("fileInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    applyStateDefaults(JSON.parse(await file.text()));
    logEvent("import", `导入局面 JSON：${file.name}`, { file: file.name });
    renderState();
    renderDataOutput();
    focusMapOnUnits();
    scheduleAiAutoplay();
  });
  el("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `alamein-state-turn-${state.turn || 1}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
  el("exportLogJsonBtn")?.addEventListener("click", () => {
    downloadTextFile(`alamein-log-turn-${state.turn || 1}.json`, JSON.stringify(state.game_log || [], null, 2), "application/json");
  });
  el("exportLogTextBtn")?.addEventListener("click", () => {
    downloadTextFile(`alamein-log-turn-${state.turn || 1}.txt`, gameLogText());
  });
  el("clearLogBtn")?.addEventListener("click", () => {
    state.game_log = [];
    logEvent("log", "清空并重新开始日志", {});
    renderGameLog();
  });
  el("saveSlotBtn")?.addEventListener("click", saveCurrentSlot);
  el("loadSlotBtn")?.addEventListener("click", loadSelectedSlot);
  el("deleteSlotBtn")?.addEventListener("click", deleteSelectedSlot);
  el("refreshSlotsBtn")?.addEventListener("click", () => {
    renderSaveSlots();
    setOutput("saveOutput", { slots: saveSlots().map(slotLabel) });
  });
  el("saveSlotSelect")?.addEventListener("change", () => {
    const slot = saveSlots().find((item) => item.id === el("saveSlotSelect").value);
    if (slot && el("saveSlotNameInput")) el("saveSlotNameInput").value = slot.name || "";
    renderActionControls();
  });
  el("addUnitBtn").addEventListener("click", () => {
    const id = `unit-${Date.now()}`;
    state.units[id] = { side: state.active_side, hex: "3711", state: "fresh", attack: 1, defense: 1, movement: 4, size: "regiment", kind: "ground" };
    state.units[id].image = defaultCounterImage(state.units[id]);
    renderState();
  });

  el("applyMoveBtn").addEventListener("click", () => {
    const unitId = el("moveUnitSelect").value;
    const path = parsePathInput(el("movePathInput").value);
    const verdict = checkMove(unitId, path, moveOptions());
    if (verdict.legal) {
      pushHistory("move");
      const fromHex = normalizeHex(state.units[unitId].hex);
      state.units[unitId].hex = normalizeHex(path[path.length - 1]);
      state.units[unitId].road_mode = moveOptions().mode === "road";
      state.units[unitId].road_facing = path.length > 1 ? hexDirection(path[path.length - 2], path[path.length - 1]) : state.units[unitId].road_facing;
      state.units[unitId].facing = state.units[unitId].road_facing;
      state.units[unitId].state = "spent";
      if (isEngineer({ id: unitId, ...state.units[unitId] }) && phaseKind() === "initial_movement" && enemyMinesAt(state.units[unitId].side, state.units[unitId].hex).length) {
        RulesEngine.clearMine(rulesContext(), unitId, state.units[unitId].hex);
      }
      selectedUnitId = unitId;
      movePathDraft = [state.units[unitId].hex];
      syncMovePathInput();
      logEvent("move", `移动 ${unitId}：${fromHex} -> ${state.units[unitId].hex}`, { unit: unitId, path, mode: moveOptions().mode, verdict });
      renderState();
    }
    renderAutoJudge();
    el("moveOutput").textContent = JSON.stringify(verdict, null, 2);
  });
  el("undoRouteBtn").addEventListener("click", () => {
    if (movePathDraft.length > 1) movePathDraft.pop();
    syncMovePathInput();
    renderRouteStatus();
    renderMap();
  });
  el("clearRouteBtn").addEventListener("click", () => {
    const unit = selectedUnit();
    movePathDraft = unit?.hex ? [normalizeHex(unit.hex)] : [];
    syncMovePathInput();
    renderRouteStatus();
    renderMap();
  });
  el("aiSuggestBtn").addEventListener("click", async () => {
    setOutput("aiOutput", { status: "thinking", mode: aiModeForSide(state.active_side), side: state.active_side });
    aiSuggestion = await suggestAiAction();
    setOutput("aiOutput", aiSuggestion || "没有找到合法 AI 动作");
    renderActionControls();
  });
  el("aiApplyBtn").addEventListener("click", () => {
    if (!aiSuggestion) {
      setOutput("aiOutput", "请先点击“建议一步”生成 AI 动作");
      return;
    }
    if (aiSuggestion.error || !aiSuggestion.action) {
      setOutput("aiOutput", { error: aiSuggestion.error || "AI 没有返回最终动作", suggestion: aiSuggestion });
      return;
    }
    const action = aiSuggestion.action || aiSuggestion;
    const result = applyAiAction(action);
    setOutput("aiOutput", { applied: result, suggestion: aiSuggestion });
    aiSuggestion = null;
    renderActionControls();
  });
  el("aiPlayCurrentBtn")?.addEventListener("click", playAiForCurrentSide);
  el("aiAutoRunBtn")?.addEventListener("click", () => setAiAutoplay(true));
  el("aiAutoStopBtn")?.addEventListener("click", () => setAiAutoplay(false));
  el("aiAutoToggleBtn")?.addEventListener("click", () => setAiAutoplay(!state.ai_autoplay));

  el("zoomSlider").addEventListener("input", () => { settings.zoom = Number(el("zoomSlider").value); applyZoom(); });
  el("zoomOutBtn").addEventListener("click", () => { settings.zoom = Math.max(35, settings.zoom - 10); el("zoomSlider").value = settings.zoom; applyZoom(); });
  el("zoomInBtn").addEventListener("click", () => { settings.zoom = Math.min(180, settings.zoom + 10); el("zoomSlider").value = settings.zoom; applyZoom(); });
  el("fitBtn").addEventListener("click", () => { settings.zoom = 60; el("zoomSlider").value = settings.zoom; applyZoom(); });

  const calibration = [
    ["originXInput", "originX"],
    ["originYInput", "originY"],
    ["colStepInput", "colStep"],
    ["rowStepInput", "rowStep"],
    ["rowOffsetInput", "rowOffset"],
    ["unitSizeInput", "unitSize"],
    ["stackSpreadInput", "stackSpread"]
  ];
  for (const [id, key] of calibration) {
    el(id).addEventListener("change", () => {
      settings[key] = Number(el(id).value);
      renderMap();
      renderDataOutput();
    });
  }
  renderSaveSlots();
  renderAiConfig();
  syncSetupControls();
}

async function main() {
  syncVersionLabels();
  await initData();
  initControls();
  applyZoom();
  renderState();
  renderDataOutput();
  focusMapOnUnits();
  renderAutoJudge();
}

globalThis.AlameinStudioDebug = {
  getState: () => structuredClone(state),
  aiStateSummary: () => aiStateSummary(),
  checkVictory: () => checkVictory(),
  suggestRulesAction: () => suggestRulesAction(),
  enumerateLegalAiActions: (limit = 50) => enumerateLegalAiActions(limit).map(compactAction),
  autoPlayAi: (maxSteps = 80) => autoPlayAi(maxSteps)
};

main();
