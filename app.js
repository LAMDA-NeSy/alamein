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

const APP_VERSION = "v2026.07.12.13";
const ASSET_VERSION = "20260712-13";
const SAVE_SLOTS_STORAGE_KEY = "alamein_judge_studio.save_slots.v1";
const AI_PROFILES_STORAGE_KEY = "alamein_judge_studio.ai_profiles.v1";
const SIDE_PANEL_COLLAPSED_KEY = "alamein_judge_studio.side_panel_collapsed.v1";
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
let pendingPhaseEndKey = null;
let setupMode = "home";
let gameUiReady = false;
let saveSlotsCache = null;
let gameMapPreloadScheduled = false;
let aiScoreSupplyCache = null;
let aiVictoryImpactCache = null;
let aiSupplyScorePhaseCache = null;
let aiContextSupplyCache = null;
let activeSaveSlotId = null;

const el = (id) => document.getElementById(id);
const RulesEngine = globalThis.AlameinRules;
const AiDefaults = globalThis.ALAMEIN_AI_CONFIG || {};

function aiApiDefaults() {
  return AiDefaults.api || {};
}

function aiContextDefaults() {
  return AiDefaults.context || {};
}

function aiStrategyDefaults() {
  return AiDefaults.strategy || {};
}

function aiDefaultNumber(section, key, fallback) {
  const value = Number((AiDefaults[section] || {})[key]);
  return Number.isFinite(value) ? value : fallback;
}

function setInputDefault(id, value, { force = false, secret = false } = {}) {
  const node = el(id);
  if (!node || value == null || value === "") return;
  if (!force && node.value) return;
  node.value = String(value);
  if (!secret) node.placeholder = String(value);
}

function syncExternalAiDefaults({ force = false } = {}) {
  const api = aiApiDefaults();
  setInputDefault("aiApiUrlInput", api.url, { force });
  setInputDefault("aiModelInput", api.model, { force });
  setInputDefault("aiTimeoutInput", api.timeoutSeconds, { force });
  setInputDefault("aiMaxToolRoundsInput", api.maxToolRounds, { force });
  setInputDefault("aiMaxActionsInput", aiContextDefaults().maxLegalActions, { force });
  setInputDefault("aiApiKeyInput", api.apiKey, { force, secret: true });
}

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

function enemySide(side) {
  return side === "axis" ? "allies" : "axis";
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

function unitSizeLabel(size = "") {
  const labels = {
    division: "师",
    regiment: "团",
    battalion: "营",
    brigade: "旅"
  };
  return labels[size] || String(size || "");
}

function pieceTypeLabel(value = "") {
  const text = String(value || "");
  if (!text || /^\d+$/.test(text)) return "";
  const labels = {
    Mech: "机械化",
    "Non-Mech": "非机械化",
    Supply: "补给",
    "Ramcke Recon Btln/Mech": "Ramcke 侦察营 / 机械化"
  };
  return labels[text] || text;
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

function mapAreaForAi(hex) {
  const hx = normalizeHex(hex);
  const [col, row] = splitHex(hx);
  const tags = hexTags(hx);
  const areas = [];
  if (tags.includes("alamein_box")) areas.push("Alamein box");
  if (tags.includes("hill_or_ridge")) areas.push("ridge line");
  if (tags.includes("depression")) areas.push("depression");
  if (tags.includes("minefield") || minesAt(hx).length) areas.push("minefield belt");
  if (neighbors(hx).some((nb) => edgeTags(normalizeEdge(hx, nb)).includes("road"))) areas.push("road corridor");
  if (row <= 12) areas.push("northern coastal sector");
  else if (row <= 22) areas.push("central desert sector");
  else areas.push("southern desert sector");
  if (col <= 20) areas.push("western approach");
  else if (col >= 36) areas.push("eastern objective area");
  else areas.push("middle battlefield");
  return [...new Set(areas)];
}

function operationalAreaCodeForAi(hex) {
  const hx = normalizeHex(hex);
  const [col, row] = splitHex(hx);
  const sector = row <= 12 ? "N" : row <= 22 ? "C" : "S";
  const depth = col <= 20 ? "W" : col >= 36 ? "E" : "M";
  return `${sector}/${depth}`;
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

function supplyStateLabel(value = "") {
  const labels = {
    supplied: "有补给",
    partially_supplied: "部分补给",
    unsupplied: "无补给",
    isolated: "孤立"
  };
  return labels[value] || String(value || "");
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

function aiSupplyStateForAi(unitId) {
  const unit = state.units?.[unitId];
  if (!unit || !isPlayableSide(unit.side)) return "";
  if (aiContextSupplyCache) {
    aiContextSupplyCache[unit.side] ||= aiSupplyScoreMap(unit.side);
    return aiContextSupplyCache[unit.side]?.[unitId] || supplyState(unitId);
  }
  return aiScoreSupplyCache?.[unitId] || supplyState(unitId);
}

function withAiContextSupplyCache(callback) {
  const previous = aiContextSupplyCache;
  aiContextSupplyCache ||= {};
  try {
    return callback();
  }
  finally {
    aiContextSupplyCache = previous;
  }
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
  const die = el("combatResolveDieSelect")?.value;
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

function scenarioShortName(scenario = state.scenario) {
  const labels = {
    july: "July",
    september: "September",
    october: "October"
  };
  return labels[scenario] || String(scenario || "Custom");
}

function scenarioDisplayName(scenario = state.scenario) {
  const labels = {
    july: "July 18.1 - First Battle",
    september: "September 18.2 - Alam Halfa",
    october: "October 18.3 - Second Battle"
  };
  return labels[scenario] || String(scenario || "Custom");
}

function victoryStatusSummary() {
  const victory = checkVictory();
  return {
    vp: Number(victory.victory_points || 0),
    level: victory.level || "",
    finalTurn: victory.final_turn || scenarioFinalTurn(state.scenario),
    final: !!victory.final
  };
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

function setSidePanelCollapsed(collapsed, options = {}) {
  const app = document.querySelector(".app");
  app?.classList.toggle("side-panel-collapsed", !!collapsed);
  const button = el("sidePanelToggleBtn");
  if (button) {
    button.setAttribute("aria-pressed", collapsed ? "true" : "false");
    button.setAttribute("aria-label", collapsed ? "展开右侧面板" : "收起右侧面板");
    button.title = collapsed ? "展开右侧面板" : "收起右侧面板";
    const icon = button.querySelector("span");
    if (icon) icon.textContent = collapsed ? "◧" : "◨";
  }
  if (options.persist !== false) localStorage.setItem(SIDE_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
}

function sidePanelCollapsed() {
  return document.querySelector(".app")?.classList.contains("side-panel-collapsed");
}

function toggleSidePanel() {
  setSidePanelCollapsed(!sidePanelCollapsed());
}

function switchTab(name, options = {}) {
  if (options.expandPanel) setSidePanelCollapsed(false);
  document.querySelectorAll(".tab, .tab-panel").forEach((node) => node.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${name}"]`)?.classList.add("active");
  el(`tab-${name}`)?.classList.add("active");
  const modeByTab = { move: "move", combat: "combat", judge: "all", state: "command" };
  if (modeByTab[name] && el("mapViewModeSelect")) setMapViewMode(modeByTab[name]);
  syncPhaseRecommendedTab();
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
  syncMapModeButtons();
}

function syncMapModeButtons() {
  const mode = el("mapViewModeSelect")?.value || "command";
  document.querySelectorAll("[data-map-mode]").forEach((button) => {
    const active = button.dataset.mapMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const labels = { command: "指挥", move: "移动", combat: "战斗", supply: "补给", terrain: "地形", zoc: "ZOC", all: "全部" };
  if (el("viewModeBadge")) {
    el("viewModeBadge").textContent = labels[mode] || mode;
    el("viewModeBadge").title = `当前视图：${labels[mode] || mode}`;
  }
}

function activateMoveForSelectedUnit() {
  const unit = selectedUnit();
  if (!selectedUnitId || !unit || !canMoveUnitNow({ id: selectedUnitId, ...unit })) return;
  setMapViewMode("move");
  movePathDraft = [normalizeHex(unit.hex)];
  syncMovePathInput();
  const moveSelect = el("moveUnitSelect");
  if (moveSelect) moveSelect.value = selectedUnitId;
  switchTab("move", { expandPanel: true });
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
  switchTab("combat", { expandPanel: true });
  setOutput("combatOutput", checkCombat(parseCombatAction()));
  renderMap();
  focusMapOnHex(unit.hex);
}

function selectCombatTarget(defenderHex, attackerId = selectedUnitId) {
  if (!attackerId || !state.units?.[attackerId]) return;
  selectedUnitId = attackerId;
  selectedCombatDefenderHex = normalizeHex(defenderHex);
  const attackerInput = el("combatAttackersInput");
  const defenderInput = el("combatDefendersInput");
  if (attackerInput) attackerInput.value = attackerId;
  if (defenderInput) defenderInput.value = selectedCombatDefenderHex;
  setMapViewMode("combat");
  switchTab("combat", { expandPanel: true });
  setOutput("combatOutput", checkCombat(parseCombatAction()));
  renderActionControls();
  renderMap();
}

function activateSupplyForSelectedUnit() {
  const unit = selectedUnit();
  if (!selectedUnitId || !unit) return;
  highlightedSupplyPath = traceSupplyPath(selectedUnitId);
  switchTab("state", { expandPanel: true });
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
  selectedHexId = null;
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
  renderSelectedHex();
  renderMapSelectionHud();
  renderOperationHint();
  renderActionableUnits();
  renderActionControls();
  const moveSelect = el("moveUnitSelect");
  if (moveSelect && [...moveSelect.options].some((option) => option.value === unitId)) moveSelect.value = unitId;
  renderCombatControls();
  if (el("tab-move")?.classList.contains("active")) renderRouteStatus();
  if (!switchedTab) renderMap();
}

function selectHex(hex) {
  selectedHexId = normalizeHex(hex);
  selectedUnitId = null;
  selectedCombatDefenderHex = null;
  highlightedSupplyPath = [];
  movePathDraft = [];
  syncMovePathInput();
  renderSelectedHex();
  renderSelectedUnit();
  renderMapSelectionHud();
  renderActionableUnits();
  renderActionControls();
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
    const warnings = ruleWarnings();
    const severe = warnings.find((item) => item.tone === "bad") || warnings.find((item) => item.tone === "warn");
    const judgeTone = report.victory.winner ? "final" : severe ? severe.tone : "ok";
    const judgeTitle = report.victory.winner
      ? "场景胜负已判定"
      : severe
      ? `${severe.label}需要处理`
      : "当前裁判未发现阻断问题";
    const judgeDetail = report.victory.winner
      ? report.victory.reason
      : severe
      ? severe.text
      : phaseGuide(state.phase).action;
    const actionableCount = actionableUnitsForCurrentPhase().length;
    const victory = victoryStatusSummary();
    const vpBreakdown = report.victory.breakdown.map((item) => `${item.points >= 0 ? "+" : ""}${item.points} ${item.label}`).join("；");
    summary.innerHTML = `
      <section class="judge-overview ${escapeHtml(judgeTone)}">
        <div class="judge-overview-main">
          <span>${escapeHtml(phaseDisplayName(state.phase))}</span>
          <strong>${escapeHtml(judgeTitle)}</strong>
          <small>${escapeHtml(judgeDetail)}</small>
        </div>
        <div class="judge-overview-facts">
          <span><b>${escapeHtml(actionableCount)}</b> 可行动</span>
          <span><b>VP ${escapeHtml(victory.vp)}</b> ${escapeHtml(victory.level)}</span>
          <span><b>T${escapeHtml(state.turn || 1)}</b> / T${escapeHtml(victory.finalTurn)}</span>
        </div>
      </section>
      ${warnings.length ? `
        <section class="judge-alert-list" aria-label="裁判关注项">
          ${warnings.map((item) => `
            <div class="${escapeHtml(item.tone)}">
              <span>${escapeHtml(item.label)}</span>
              <b>${escapeHtml(item.text)}</b>
            </div>
          `).join("")}
        </section>
      ` : ""}
      <section class="judge-card-grid">
      <div class="judge-card ${report.stacking.legal ? "ok-card" : "bad-card"}">
        <b>堆叠</b><span>${report.stacking.reason}</span>
      </div>
      <div class="judge-card">
        <b>雷区</b><span>敌方 ${report.mines.enemy} / 己方 ${report.mines.friendly}</span>
      </div>
      <div class="judge-card">
        <b>补给</b><span>${sideDisplayName(state.active_side)}: 有 ${supplied} / 部分 ${partial} / 无 ${unsupplied} / 孤立 ${isolated}</span>
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
        <b>VP 明细</b><span>${vpBreakdown || "暂无特殊 VP 变化"}</span>
      </div>
      <div class="judge-card ${report.rule_review.needs_review ? "bad-card" : "ok-card"}">
        <b>待核对</b><span>${reviewNotes}</span>
      </div>
      </section>
    `;
  }
  const move = el("moveOutput");
  if (!move) return;
  const verdict = routeVerdict();
  setOutput("moveOutput", verdict || "");
  renderActionControls();
}

function renderRouteStatus() {
  const target = el("routeStatus");
  if (!target) return;
  renderRouteStepList();
  renderRouteOverview();
  const unit = currentMoveUnit();
  if (!unit || !isMovableUnit(unit)) {
    target.className = "route-status empty";
    target.textContent = "";
    renderActionControls();
    return;
  }
  if (movePathDraft.length < 2) {
    target.className = "route-status muted";
    target.textContent = `${unit.name || unit.id}: 点击地图相邻格画路线`;
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

function renderRouteOverview() {
  const panel = el("routeOverview");
  if (!panel) return;
  const unit = currentMoveUnit();
  if (!unit || !isMovableUnit(unit)) {
    panel.className = "route-overview empty";
    panel.innerHTML = "";
    return;
  }
  const start = normalizeHex(unit.hex || movePathDraft[0] || "");
  const end = movePathDraft.length > 1 ? movePathDraft.at(-1) : "";
  const verdict = routeVerdict();
  const legal = !!verdict?.legal;
  const bad = verdict?.legal === false;
  const spent = verdict?.details ? `${verdict.details.spent}/${verdict.details.allowance}` : "未规划";
  const mode = verdict?.details?.mode === "road" ? "道路" : (el("moveModeSelect")?.value === "road" ? "道路" : "普通");
  const result = legal ? "可执行" : bad ? "不可执行" : "待规划";
  panel.className = `route-overview ${legal ? "ok" : bad ? "bad" : "muted"}`;
  panel.innerHTML = `
    <div><span>起点</span><b>${escapeHtml(start || "-")}</b></div>
    <div><span>终点</span><b>${escapeHtml(end || "点击地图")}</b></div>
    <div><span>MP</span><b>${escapeHtml(spent)}</b><small>${escapeHtml(mode)}</small></div>
    <div><span>裁判</span><b>${escapeHtml(result)}</b></div>
  `;
}

function renderRouteStepList() {
  const panel = el("routeStepList");
  if (!panel) return;
  const unit = currentMoveUnit();
  if (!unit || !movePathDraft.length) {
    panel.className = "route-step-list empty";
    panel.innerHTML = "";
    return;
  }
  const verdict = routeVerdict();
  const status = verdict?.details
    ? `${verdict.details.spent}/${verdict.details.allowance} MP`
    : movePathDraft.length > 1
    ? (verdict?.reason || "等待裁判")
    : "起点";
  const label = movePathDraft.length > 1 ? `${movePathDraft.length} 个路线点` : "路线起点";
  panel.className = `route-step-list ${verdict?.legal === false ? "bad" : verdict?.legal ? "ok" : ""}`;
  panel.innerHTML = `
    <div class="route-step-head">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(status)}</b>
    </div>
    <div class="route-step-track">
      ${movePathDraft.map((hex, index) => `
        <button class="route-step ${index === 0 ? "start" : ""} ${index === movePathDraft.length - 1 ? "end" : ""}" type="button" data-route-index="${escapeHtml(index)}">
          <small>${escapeHtml(index === 0 ? "起" : index === movePathDraft.length - 1 ? "终" : String(index))}</small>
          <b>${escapeHtml(hex)}</b>
        </button>
      `).join("")}
    </div>
  `;
}

function handleRouteStepListClick(event) {
  const button = event.target.closest?.("[data-route-index]");
  if (!button) return;
  const index = Number(button.dataset.routeIndex);
  if (!Number.isInteger(index) || index < 0 || index >= movePathDraft.length) return;
  movePathDraft = movePathDraft.slice(0, index + 1);
  syncMovePathInput();
  renderRouteStatus();
  renderActionControls();
  renderMap();
}

function unitDisplayRows(unit) {
  const supply = unit.id && isPlayableSide(unit.side) ? supplyStateLabel(supplyState(unit.id)) : "";
  return [
    ["编号", unit.id],
    ["名称", unit.name || ""],
    ["阵营", sideDisplayName(unit.side)],
    ["坐标", unit.hex || ""],
    ["类型", unitTypeGroup(unit).label],
    ["编制", unitSizeLabel(unit.size)],
    ["状态", unitStateLabel(unit.state || "fresh")],
    ["战力", unit.attack ?? ""],
    ["防御", unit.defense ?? ""],
    ["移动", unit.movement ?? ""],
    ["补给", supply],
    ["补给路径", highlightedSupplyPath.length ? highlightedSupplyPath.join(" -> ") : ""],
    ["机械化", isMechanized(unit) ? "是" : "否"],
    ["道路模式", unit.road_mode ? "是" : "否"],
    ["棋子类型", pieceTypeLabel(unit.piece_type)]
  ].filter(([, value]) => value !== "" && value != null);
}

function unitStackSummary(unit) {
  const type = unitTypeGroup(unit).label;
  const values = [];
  if (isCombatUnit(unit)) values.push(`A${unit.attack ?? 0}`, `D${unit.defense ?? unit.attack ?? 0}`);
  if (isMovableUnit(unit)) values.push(`MP${unit.movement ?? 0}`);
  if (isPlayableSide(unit.side) && (isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit))) values.push(supplyStateLabel(supplyState(unit.id)));
  return `${sideDisplayName(unit.side)} · ${type}${values.length ? ` · ${values.join(" · ")}` : ""}`;
}

function createStackUnitButton(unit, compact = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `stack-unit-button ${unit.side || ""} ${compact ? "compact" : ""} ${unit.id === selectedUnitId ? "selected" : ""}`;
  button.innerHTML = `
    <span>
      <b>${escapeHtml(unit.name || unit.id)}</b>
      <small>${escapeHtml(unitStackSummary(unit))}</small>
    </span>
    <em>${escapeHtml(unit.hex || "")}</em>
  `;
  button.addEventListener("click", () => selectUnit(unit.id, { showStateTab: false }));
  return button;
}

function unitActionHint(unit) {
  if (!unit) return { label: "未选择", detail: "点击地图棋子查看可执行动作。", tone: "idle" };
  if (unit.eliminated || unit.off_map) return { label: "已离场", detail: "该棋子不在地图上，不能执行地图动作。", tone: "idle" };
  if (!isPlayableSide(unit.side)) return { label: "标记", detail: "这是地图标记或规则对象，用于裁判显示。", tone: "idle" };
  if (state.phase === "end_game_turn") return { label: "等待结算", detail: "当前是回合结束阶段，系统处理补给、孤立和胜负。", tone: "idle" };
  if (unit.side !== state.active_side) {
    const sideName = state.active_side === "axis" ? "Axis" : "Allies";
    return { label: "等待", detail: `现在是 ${sideName} 阶段，该单位暂不能行动。`, tone: "idle" };
  }
  if (currentPhaseIsAiControlled()) return { label: "AI 接管", detail: "当前方由 AI 控制，系统会自动选择并执行合法行动。", tone: "ai" };
  const kind = phaseKind();
  if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) {
    if (canMoveUnitNow(unit)) {
      const roadText = unit.road_mode ? "道路模式中，移动会受道路朝向限制。" : canEnterRoadModeNow(unit) ? "可进入道路模式。" : "普通移动。";
      return { label: "可以移动", detail: `点击“移动”，再在地图上点相邻格绘制路线。${roadText}`, tone: "ready" };
    }
    return { label: "本阶段不能移动", detail: phaseGuide(state.phase).detail, tone: "idle" };
  }
  if (kind === "combat") {
    if (canCombatUnitNow(unit)) {
      const targets = adjacentCombats(unit.side).filter((pair) => pair.attacker === unit.id).length;
      return { label: "可以战斗", detail: `点击“战斗”，选择相邻防御格。当前有 ${targets} 个可攻击目标。`, tone: "ready" };
    }
    return { label: "无可攻击目标", detail: "战斗阶段只能选择相邻敌方作战单位作为目标。", tone: "idle" };
  }
  return { label: "查看", detail: phaseGuide(state.phase).action, tone: "idle" };
}

function unitActionFacts(unit) {
  if (!unit || !unit.id) return [];
  const facts = [];
  const kind = phaseKind();
  if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind) && canMoveUnitNow(unit)) {
    facts.push(["可达", `${reachableHexes(unit.id, moveOptions()).size} 格`]);
    facts.push(["道路", unit.road_mode ? "道路模式" : canEnterRoadModeNow(unit) ? "可进入" : "普通"]);
  }
  if (kind === "combat" && isCombatUnit(unit)) {
    const targets = adjacentCombats(unit.side).filter((pair) => pair.attacker === unit.id);
    facts.push(["目标", `${targets.length} 个`]);
    if (targets[0]) facts.push(["最近", targets[0].defender_hex]);
  }
  if (isPlayableSide(unit.side) && (isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit))) {
    facts.push(["补给", supplyStateLabel(supplyState(unit.id))]);
  }
  if (unit.road_mode) facts.push(["朝向", unit.road_facing || "道路"]);
  if (unit.state && unit.state !== "fresh") facts.push(["状态", unitStateLabel(unit.state)]);
  return facts.slice(0, 4);
}

function renderUnitActionFacts(unit, className = "unit-action-facts") {
  const facts = unitActionFacts(unit);
  if (!facts.length) return "";
  return `
    <div class="${escapeHtml(className)}">
      ${facts.map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join("")}
    </div>
  `;
}

function renderSelectionSummary() {
  const panel = el("selectionSummaryPanel");
  if (!panel) return;
  const unit = selectedUnitId ? unitsArray().find((item) => item.id === selectedUnitId) : null;
  const hex = selectedHexId ? normalizeHex(selectedHexId) : "";
  if (unit) {
    const hint = unitActionHint(unit);
    panel.className = `selection-summary compact ${unit.side || ""}`;
    panel.innerHTML = `
      <div>
        <span>单位</span>
        <strong>${escapeHtml(unit.name || unit.id)}</strong>
        <small>${escapeHtml(sideDisplayName(unit.side))} · ${escapeHtml(unit.hex || "未部署")} · ${escapeHtml(hint.label)}</small>
      </div>
      <div class="selection-summary-actions">
        ${canMoveUnitNow(unit) ? `<button type="button" class="primary-action" data-selection-command="move">移动</button>` : ""}
        ${canCombatUnitNow(unit) ? `<button type="button" class="primary-action" data-selection-command="combat">战斗</button>` : ""}
        ${(isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit)) && isPlayableSide(unit.side) ? `<button type="button" class="secondary-action" data-selection-command="supply">补给线</button>` : ""}
        <button type="button" class="quiet-action" data-selection-command="clear">清除</button>
      </div>
    `;
    return;
  }
  if (hex) {
    const units = unitsByHex()[hex] || [];
    panel.className = "selection-summary compact";
    panel.innerHTML = `
      <div>
        <span>坐标</span>
        <strong>坐标 ${escapeHtml(hex)}</strong>
        <small>${escapeHtml(terrainSummaryLabel(hexTags(hex)))} · ${escapeHtml(units.length)} 个单位</small>
      </div>
      <div class="selection-summary-actions">
        <button type="button" class="secondary-action" data-selection-command="center">居中</button>
        <button type="button" class="quiet-action" data-selection-command="clear">清除</button>
      </div>
    `;
    return;
  }
  const context = actionableUnitContext();
  panel.className = "selection-summary empty";
  panel.innerHTML = `
    <div>
      <span>选择</span>
      <strong>点选棋子或地图格</strong>
      <small>${escapeHtml(context.detail)}</small>
    </div>
    <div class="selection-summary-actions">
      <button type="button" class="secondary-action" data-selection-command="focus-first">推荐单位</button>
      <button type="button" class="quiet-action" data-selection-command="open-phase">当前面板</button>
    </div>
  `;
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
  meta.textContent = `${sideDisplayName(unit.side)} ${unit.hex || ""}`;
  header.append(title, meta);
  const hint = unitActionHint(unit);

  const chips = document.createElement("div");
  chips.className = "unit-stat-chips";
  const supplyChip = isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit)
    ? supplyStateLabel(supplyState(unit.id))
    : "标记";
  chips.innerHTML = `
    <span>战力 <b>${unit.attack ?? 0}</b></span>
    <span>防御 <b>${unit.defense ?? unit.attack ?? 0}</b></span>
    <span>移动 <b>${unit.movement ?? 0}</b></span>
    <span>${supplyChip}</span>
  `;

  const focus = document.createElement("div");
  focus.className = `selected-unit-focus ${hint.tone}`;
  focus.innerHTML = `
    <span>下一步</span>
    <strong>${escapeHtml(hint.label)}</strong>
    <small>${escapeHtml(hint.detail)}</small>
  `;
  const factRail = document.createElement("div");
  factRail.innerHTML = renderUnitActionFacts(unit);

  const actions = document.createElement("div");
  actions.className = "selected-unit-actions";
  if (canMoveUnitNow(unit)) {
    const moveButton = document.createElement("button");
    moveButton.type = "button";
    moveButton.textContent = "移动";
    moveButton.className = "primary-action";
    moveButton.addEventListener("click", () => activateMoveForSelectedUnit());
    actions.append(moveButton);
  }
  if (canCombatUnitNow(unit)) {
    const combatButton = document.createElement("button");
    combatButton.type = "button";
    combatButton.textContent = "战斗";
    combatButton.className = "primary-action";
    combatButton.addEventListener("click", () => activateCombatForSelectedUnit());
    actions.append(combatButton);
  }
  if ((isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit)) && isPlayableSide(unit.side)) {
    const supplyButton = document.createElement("button");
    supplyButton.type = "button";
    supplyButton.textContent = "补给线";
    supplyButton.className = "secondary-action";
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
  const details = document.createElement("details");
  details.className = "unit-detail-drawer";
  const summary = document.createElement("summary");
  summary.textContent = "详细属性";
  details.append(summary, body);
  content.append(header, chips, focus);
  if (factRail.firstElementChild) content.append(factRail.firstElementChild);
  content.append(actions);
  const sameHexUnits = unit.hex ? (unitsByHex()[normalizeHex(unit.hex)] || []) : [];
  if (sameHexUnits.length > 1) {
    const stack = document.createElement("div");
    stack.className = "hex-stack-picker unit-stack-peers";
    const stackTitle = document.createElement("div");
    stackTitle.className = "hex-stack-title";
    stackTitle.innerHTML = `<span>同格堆叠</span><b>${escapeHtml(sameHexUnits.length)} 个单位</b>`;
    stack.append(stackTitle);
    sameHexUnits.forEach((stackUnit) => stack.append(createStackUnitButton(stackUnit, true)));
    content.append(stack);
  }
  content.append(details);
  shell.append(content);
  panel.append(shell);
}

function renderSelectedHex() {
  const panel = el("selectedHexPanel");
  if (!panel) return;
  if (selectedUnitId || !selectedHexId) {
    panel.className = "selected-unit empty";
    panel.textContent = "点击地图格查看地形、雷区、ZOC 和单位";
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
  panel.innerHTML = "";
  const header = document.createElement("div");
  header.className = "selected-unit-header";
  header.innerHTML = `<div>坐标 ${escapeHtml(selectedHexId)}</div><span>${escapeHtml(terrainSummaryLabel(tags))}</span>`;
  const facts = document.createElement("div");
  facts.className = "selected-hex-facts";
  facts.innerHTML = [
    ["雷区", mines.length ? mines.map((mine) => `${sideDisplayName(mine.side)} ${mine.name || mine.id}`).join("; ") : "无"],
    ["ZOC", zocSides.map(sideDisplayName).join(", ") || "无"],
    ["补给阻断", blockedFor.map(sideDisplayName).join(", ") || "无"]
  ].map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`).join("");
  panel.append(header, facts);
  const stack = document.createElement("div");
  stack.className = `hex-stack-picker ${units.length ? "" : "empty"}`;
  const stackTitle = document.createElement("div");
  stackTitle.className = "hex-stack-title";
  stackTitle.innerHTML = `<span>堆叠</span><b>${escapeHtml(units.length)} 个单位</b>`;
  stack.append(stackTitle);
  if (units.length) units.forEach((unit) => stack.append(createStackUnitButton(unit, true)));
  else {
    const empty = document.createElement("p");
    empty.textContent = "该格没有单位。";
    stack.append(empty);
  }
  panel.append(stack);
}

function hudButton(label, onClick, className = "", title = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  if (title) {
    button.title = title;
    button.setAttribute("aria-label", title);
  }
  button.addEventListener("click", onClick);
  return button;
}

function handleSelectionSummaryClick(event) {
  const button = event.target.closest?.("button[data-selection-command]");
  if (!button) return;
  const command = button.dataset.selectionCommand;
  if (command === "move") activateMoveForSelectedUnit();
  else if (command === "combat") activateCombatForSelectedUnit();
  else if (command === "supply") activateSupplyForSelectedUnit();
  else if (command === "center") {
    const targetHex = selectedUnitId && state.units?.[selectedUnitId]?.hex ? state.units[selectedUnitId].hex : selectedHexId;
    if (targetHex) focusMapOnHex(targetHex);
  }
  else if (command === "clear") {
    selectedUnitId = null;
    selectedHexId = null;
    selectedCombatDefenderHex = null;
    highlightedSupplyPath = [];
    movePathDraft = [];
    syncMovePathInput();
    renderState();
  }
  else if (command === "focus-first") {
    focusActionableUnit(sortedActionableUnits()[0]);
  }
  else if (command === "open-phase") {
    focusCurrentPhaseTab({ expandPanel: true });
  }
}

function renderMapSelectionHud() {
  const hud = el("mapSelectionHud");
  if (!hud) return;
  hud.innerHTML = "";
  const unit = selectedUnitId ? unitsArray().find((item) => item.id === selectedUnitId) : null;
  if (unit) {
    const hint = unitActionHint(unit);
    hud.className = `map-selection-hud ${unit.side || ""}`;
    const title = document.createElement("div");
    title.className = "map-hud-title";
    title.innerHTML = `<b>${escapeHtml(unit.name || unit.id)}</b><span>${escapeHtml(sideDisplayName(unit.side))} ${escapeHtml(unit.hex || "")}</span>`;
    const next = document.createElement("div");
    next.className = `map-hud-next ${hint.tone}`;
    next.innerHTML = `<b>${escapeHtml(hint.label)}</b><span>${escapeHtml(hint.detail)}</span>`;
    const chips = document.createElement("div");
    chips.className = "map-hud-chips";
    const supplyChip = isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit) ? supplyStateLabel(supplyState(unit.id)) : "标记";
    chips.innerHTML = `
      <span>A ${escapeHtml(unit.attack ?? 0)}</span>
      <span>D ${escapeHtml(unit.defense ?? unit.attack ?? 0)}</span>
      <span>MP ${escapeHtml(unit.movement ?? 0)}</span>
      <span>${escapeHtml(supplyChip)}</span>
    `;
    const factRail = document.createElement("div");
    factRail.innerHTML = renderUnitActionFacts(unit, "map-hud-facts");
    const actions = document.createElement("div");
    actions.className = "map-hud-actions";
    if (canMoveUnitNow(unit)) actions.append(hudButton("移动", activateMoveForSelectedUnit, "primary-action"));
    if (canCombatUnitNow(unit)) actions.append(hudButton("战斗", activateCombatForSelectedUnit, "primary-action"));
    if ((isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit)) && isPlayableSide(unit.side)) {
      actions.append(hudButton("补给线", activateSupplyForSelectedUnit, "secondary-action"));
    }
    actions.append(hudButton("居中", () => focusMapOnHex(unit.hex), "quiet-action"));
    actions.append(hudButton("×", () => {
      selectedUnitId = null;
      renderState();
    }, "quiet-action", "关闭"));
    hud.append(title, next, chips);
    if (factRail.firstElementChild) hud.append(factRail.firstElementChild);
    hud.append(actions);
    return;
  }
  if (selectedHexId) {
    const units = unitsByHex()[selectedHexId] || [];
    const tags = hexTags(selectedHexId);
    hud.className = "map-selection-hud";
    const title = document.createElement("div");
    title.className = "map-hud-title";
    title.innerHTML = `<b>坐标 ${escapeHtml(selectedHexId)}</b><span>${escapeHtml(terrainSummaryLabel(tags))}</span>`;
    const summary = document.createElement("div");
    summary.className = "map-hud-summary";
    summary.textContent = units.length ? units.map((item) => `${sideDisplayName(item.side)} ${item.name || item.id}`).join("; ") : "无单位";
    const stack = document.createElement("div");
    stack.className = `map-hud-stack ${units.length ? "" : "empty"}`;
    if (units.length) units.slice(0, 4).forEach((item) => stack.append(createStackUnitButton(item, true)));
    if (units.length > 4) {
      const more = document.createElement("span");
      more.textContent = `还有 ${units.length - 4} 个`;
      stack.append(more);
    }
    const actions = document.createElement("div");
    actions.className = "map-hud-actions";
    actions.append(hudButton("居中", () => focusMapOnHex(selectedHexId), "quiet-action"));
    actions.append(hudButton("×", () => {
      selectedHexId = null;
      renderState();
    }, "quiet-action", "关闭"));
    hud.append(title, summary, stack, actions);
    return;
  }
  hud.className = "map-selection-hud hidden";
}

function renderMapActionHint() {
  const target = el("mapActionHint");
  if (!target) return;
  const viewMode = el("mapViewModeSelect")?.value || "command";
  const unit = selectedUnitId && state.units?.[selectedUnitId] ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  const kind = phaseKind();
  let tone = "idle";
  let title = "";
  let detail = "";
  if (phaseEndConfirmationPending()) {
    tone = "bad";
    title = state.phase === "end_game_turn" ? "确认进入下一回合" : "确认结束阶段";
    detail = "再点一次确认按钮才会推进；点击其他行动可继续操作。";
  }
  else if (viewMode === "move" && unit && canMoveUnitNow(unit)) {
    const route = routeVerdict();
    const reachable = reachableHexes(selectedUnitId, moveOptions()).size;
    tone = route?.legal === false ? "bad" : "move";
    title = route?.legal ? "路线可执行" : movePathDraft.length > 1 ? "检查路线" : "选择目的地";
    detail = route?.legal
      ? `${unit.name || unit.id}：${route.details?.spent ?? "?"}/${route.details?.allowance ?? "?"} MP，点击执行移动。`
      : movePathDraft.length > 1
      ? (route?.reason || "路线等待裁判。")
      : `绿色格可点击，当前约 ${Math.max(0, reachable - 1)} 个可达格。`;
  }
  else if (viewMode === "combat" && unit && kind === "combat" && isCombatUnit(unit) && unit.side === state.active_side) {
    const targets = adjacentCombats(unit.side).filter((pair) => pair.attacker === unit.id);
    tone = targets.length ? "combat" : "idle";
    title = targets.length ? "选择攻击目标" : "没有相邻目标";
    detail = targets.length
      ? `红色格可攻击。${selectedCombatDefenderHex ? `已选择 ${selectedCombatDefenderHex}，可预览或结算。` : `当前有 ${targets.length} 个目标格。`}`
      : "战斗阶段需要相邻敌方作战单位。";
  }
  else if (viewMode === "supply" && unit && highlightedSupplyPath.length) {
    tone = "supply";
    title = "补给线";
    detail = `绿色虚线显示 ${unit.name || unit.id} 的补给路径，共 ${highlightedSupplyPath.length} 格。`;
  }
  else if (currentPhaseIsAiControlled()) {
    tone = "ai";
    title = "AI 自动行动";
    detail = "当前方由 AI 控制，地图会随着 AI 执行动作更新。";
  }
  if (!title) {
    target.className = "map-action-hint hidden";
    target.innerHTML = "";
    return;
  }
  target.className = `map-action-hint ${tone}`;
  target.innerHTML = `<b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span>`;
}

function mapLegendItems(viewMode = el("mapViewModeSelect")?.value || "command") {
  if (viewMode === "move") {
    return [
      ["unit", "可行动"],
      ["reach", "可达"],
      ["cost", "MP"],
      ["route", "路线"]
    ];
  }
  if (viewMode === "combat") {
    return [
      ["unit", "可攻击"],
      ["target", "目标"],
      ["odds", "赔率"],
      ["blocked", "受阻"]
    ];
  }
  if (viewMode === "supply") return [["supply", "补给线"], ["unit", "选中单位"]];
  if (viewMode === "zoc") return [["axis", "Axis ZOC"], ["allies", "Allies ZOC"], ["contested", "争夺"]];
  if (viewMode === "terrain") return [["terrain", "地形"], ["mine", "雷区"], ["hex", "坐标"]];
  if (viewMode === "all") return [["unit", "可行动"], ["reach", "可达"], ["target", "目标"], ["supply", "补给"], ["mine", "雷区"]];
  return [["axis", "Axis 棋子"], ["allies", "Allies 棋子"]];
}

function renderMapLegend() {
  const target = el("mapLegend");
  if (!target) return;
  const items = mapLegendItems();
  if (!items.length) {
    target.className = "map-legend hidden";
    target.innerHTML = "";
    return;
  }
  target.className = "map-legend";
  target.innerHTML = items.map(([key, label]) => `
    <span class="${escapeHtml(key)}"><i></i>${escapeHtml(label)}</span>
  `).join("");
}

function dockButton(label, command, options = {}) {
  const classes = ["phase-dock-button"];
  if (options.primary) classes.push("primary");
  if (options.quiet) classes.push("quiet");
  if (options.warning) classes.push("warning");
  const disabled = options.disabled ? " disabled" : "";
  return `<button class="${classes.join(" ")}" type="button" data-command="${escapeHtml(command)}"${disabled}>${escapeHtml(label)}</button>`;
}

function phaseEndKey() {
  return `${state.turn || 1}:${state.phase || ""}:${state.active_side || ""}`;
}

function phaseEndConfirmationPending() {
  return pendingPhaseEndKey === phaseEndKey();
}

function phaseEndButtonLabel(defaultLabel) {
  return phaseEndConfirmationPending() ? (defaultLabel.includes("跳过") ? "确认跳过" : "确认结束") : defaultLabel;
}

function dockOpenPanelButton(label = "打开当前面板", options = {}) {
  const tab = activeTabName();
  const kind = phaseKind();
  const desired = kind === "combat"
    ? "combat"
    : ["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)
    ? "move"
    : state.phase === "end_game_turn"
    ? "judge"
    : "";
  if (desired && tab === desired) return "";
  return dockButton(label, "open-phase-panel", options);
}

function renderDockActions(buttons) {
  buttons = buttons.filter(Boolean);
  if (!buttons.length) return "";
  const endButtons = buttons.filter((button) => button.includes('data-command="end-phase"'));
  const actionButtons = buttons.filter((button) => !button.includes('data-command="end-phase"'));
  let primaryButtons = actionButtons.filter((button) => button.includes(" primary"));
  let secondaryButtons = actionButtons.filter((button) => !button.includes(" primary"));
  if (!primaryButtons.length && actionButtons.length) {
    primaryButtons = [actionButtons[0]];
    secondaryButtons = actionButtons.slice(1);
  }
  return `
    ${primaryButtons.length ? `<div class="phase-dock-primary-actions">${primaryButtons.join("")}</div>` : ""}
    ${endButtons.length ? `<div class="phase-dock-end-actions">${endButtons.join("")}</div>` : ""}
    ${secondaryButtons.length ? `
      <details class="phase-dock-more">
        <summary>更多</summary>
        <div>${secondaryButtons.join("")}</div>
      </details>
    ` : ""}
  `;
}

function renderPhaseDockUnitFocus() {
  const units = sortedActionableUnits();
  if (!units.length) return "";
  const context = actionableUnitContext();
  const unit = units.find((item) => item.id === selectedUnitId) || units[0];
  const type = unitTypeGroup(unit).label;
  const chips = actionableUnitChips(unit, context).slice(0, 4);
  return `
    <div class="phase-dock-unit">
      <button class="phase-dock-unit-main" type="button" data-command="focus-actionable" data-unit-id="${escapeHtml(unit.id)}">
        <span>当前单位</span>
        <b>${escapeHtml(unit.name || unit.id)}</b>
        <small>${escapeHtml(unit.hex || "未部署")} · ${escapeHtml(type)} · ${escapeHtml(unit.id)}</small>
      </button>
      <div class="phase-dock-unit-chips">
        ${chips.map((chip) => `<i>${escapeHtml(chip)}</i>`).join("")}
      </div>
      ${units.length > 1 ? `<button class="phase-dock-unit-next" type="button" data-command="next-actionable">下一个</button>` : ""}
    </div>
  `;
}

function closeDockMenus(except = null) {
  document.querySelectorAll(".phase-dock-more[open]").forEach((details) => {
    if (details !== except) details.open = false;
  });
}

function closeMapToolMenus(except = null) {
  document.querySelectorAll(".map-view-menu[open], .map-layer-menu[open]").forEach((details) => {
    if (details !== except) details.open = false;
  });
}

function clearInteractionFocus() {
  selectedUnitId = null;
  selectedHexId = null;
  selectedCombatDefenderHex = null;
  highlightedSupplyPath = [];
  movePathDraft = [];
  syncMovePathInput();
}

function renderPhaseActionDock() {
  const dock = el("phaseActionDock");
  if (!dock) return;
  const guide = phaseGuide(state.phase);
  const side = state.active_side === "allies" ? "allies" : "axis";
  const sideDisplay = state.phase === "end_game_turn" ? "End Turn" : (side === "axis" ? "Axis" : "Allies");
  const kind = phaseKind();
  const aiControlled = currentPhaseIsAiControlled();
  const buttons = [];
  const notes = [];
  const progress = phaseProgressMeta();
  const progressPercent = Math.round((progress.current / Math.max(1, progress.total)) * 100);
  const confirmEnd = phaseEndConfirmationPending();
  let focus = guide.action;
  let dockMode = kind || "state";

  if (state.phase === "end_game_turn") {
    dockMode = "end";
    focus = confirmEnd ? "再次确认进入下一回合" : "回合结束结算";
    notes.push(confirmEnd ? "会处理补给、孤立、胜负并推进回合" : "检查补给、孤立和胜负");
    buttons.push(dockOpenPanelButton("打开裁判"));
    buttons.push(dockButton(confirmEnd ? "确认进入下一回合" : "进入下一回合", "end-phase", { primary: true, warning: confirmEnd }));
  }
  else if (aiControlled) {
    dockMode = "ai";
    focus = state.ai_autoplay ? "AI 正在接管当前阶段" : "AI 已暂停";
    notes.push(playerControllerLabel(playerController(side)));
    buttons.push(dockButton(state.ai_autoplay ? "暂停 AI" : "恢复 AI", state.ai_autoplay ? "pause-ai" : "resume-ai", { primary: true }));
    buttons.push(dockButton("打开 AI 设置", "open-ai-panel"));
    buttons.push(dockButton(phaseEndButtonLabel("结束阶段"), "end-phase", { quiet: !confirmEnd, warning: confirmEnd }));
  }
  else if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) {
    dockMode = "move";
    const unit = currentMoveUnit();
    const actionableCount = actionableUnitsForCurrentPhase().length;
    const route = routeVerdict();
    const hasRoute = movePathDraft.length > 1;
    const hasTarget = !!el("moveTargetInput")?.value.trim();
    if (!unit || !canMoveUnitNow(unit)) {
      focus = "选择当前方可移动单位";
      notes.push(actionableCount ? `${actionableCount} 个单位可移动` : "没有可移动单位");
      if (actionableCount) buttons.push(dockButton("选择推荐单位", "focus-first-actionable", { primary: true }));
      buttons.push(dockOpenPanelButton("打开移动", { primary: !actionableCount }));
    }
    else if (!hasRoute) {
      focus = `${unit.name || unit.id} 准备移动`;
      notes.push("点击相邻格绘制路线");
      if (hasTarget) buttons.push(dockButton("自动路线", "auto-route", { primary: true }));
      buttons.push(dockOpenPanelButton("打开移动"));
    }
    else {
      focus = route?.legal
        ? `${unit.name || unit.id} 路线可执行`
        : `${unit.name || unit.id} 路线不可执行`;
      notes.push(route?.details ? `${route.details.spent}/${route.details.allowance} MP` : (route?.reason || "等待裁判"));
      if (route?.legal) buttons.push(dockButton("执行移动", "apply-move", { primary: true }));
      buttons.push(dockButton("撤销一步", "undo-route"));
      buttons.push(dockButton("清空路线", "clear-route", { quiet: true }));
    }
    buttons.push(dockButton(phaseEndButtonLabel("结束阶段"), "end-phase", { quiet: !confirmEnd, warning: confirmEnd }));
  }
  else if (kind === "combat") {
    dockMode = "combat";
    const selected = selectedUnitId && state.units?.[selectedUnitId] ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
    const verdict = safeCombatVerdict();
    const actionableCount = actionableUnitsForCurrentPhase().length;
    const action = (() => {
      try { return parseCombatAction(); }
      catch { return { attackers: [], defender_hexes: [] }; }
    })();
    const attackers = action.attackers || [];
    const defenders = action.defender_hexes || [];
    if (!attackers.length || !defenders.length) {
      focus = "选择攻击单位和目标格";
      notes.push(canCombatUnitNow(selected) ? "可使用当前选中单位" : actionableCount ? `${actionableCount} 个单位可攻击` : "没有可攻击单位");
      if (canCombatUnitNow(selected)) buttons.push(dockButton("使用选中", "use-selected-combat", { primary: true }));
      else if (actionableCount) buttons.push(dockButton("选择推荐单位", "focus-first-actionable", { primary: true }));
      buttons.push(dockOpenPanelButton("打开战斗", { primary: !canCombatUnitNow(selected) && !actionableCount }));
    }
    else {
      focus = verdict?.legal ? "战斗可结算" : "战斗不可执行";
      notes.push(`${attackers.length} 个攻击单位 · ${defenders.join(", ")}`);
      if (verdict) buttons.push(dockButton("预览", "preview-combat"));
      if (verdict?.legal) buttons.push(dockButton("掷骰结算", "roll-combat", { primary: true }));
      buttons.push(dockOpenPanelButton("打开战斗"));
    }
    buttons.push(dockButton(phaseEndButtonLabel("跳过战斗"), "end-phase", { quiet: !confirmEnd, warning: confirmEnd }));
  }
  else {
    buttons.push(dockOpenPanelButton(`打开${guide.tabLabel}`, { primary: true }));
    buttons.push(dockButton(phaseEndButtonLabel("结束阶段"), "end-phase", { quiet: !confirmEnd, warning: confirmEnd }));
  }
  if (actionLog.length) buttons.push(dockButton("撤销最近", "undo-action", { quiet: true }));

  dock.className = `phase-action-dock ${side} ${dockMode}`;
  dock.innerHTML = `
    <div class="phase-dock-head">
      <span>${escapeHtml(sideDisplay)}</span>
      <b>${escapeHtml(phaseShortLabel(state.phase))}</b>
      <em>T${escapeHtml(state.turn || 1)} · ${escapeHtml(progress.current)}/${escapeHtml(progress.total)}</em>
      <div class="phase-mini-progress" style="--phase-progress:${escapeHtml(progressPercent)}%"></div>
    </div>
    <div class="phase-dock-main">
      <strong>${escapeHtml(focus)}</strong>
      <small>${escapeHtml(notes.filter(Boolean).join(" · ") || guide.detail)}</small>
    </div>
    ${renderPhaseDockUnitFocus()}
    <div class="phase-dock-actions">${renderDockActions(buttons)}</div>
  `;
}

function renderOperationHint() {
  const target = el("operationHint");
  if (!target) return;
  const viewMode = el("mapViewModeSelect")?.value || "command";
  const unit = selectedUnitId ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  let text = `${phaseShortLabel(state.phase)}：`;
  if (viewMode === "move") {
    text += unit && isMovableUnit(unit)
      ? `已选择 ${unit.name || unit.id}，点击地图目标格或输入坐标自动寻路。`
      : "选择一个当前方可移动单位，再点击地图目标格。";
  }
  else if (viewMode === "combat") {
    text += unit && isCombatUnit(unit)
      ? `已选择 ${unit.name || unit.id}，红色格是可攻击目标。`
      : "在战斗阶段选择己方作战单位查看可攻击目标。";
  }
  else if (viewMode === "supply") {
    text += unit ? "绿色虚线是选中棋子的补给线。" : "点击一个棋子，在地图上显示它的补给线。";
  }
  else if (viewMode === "terrain") text += "显示地形和坐标标签，用于校对地图。";
  else if (viewMode === "zoc") text += "显示双方 ZOC 控制范围。";
  else if (viewMode === "all") text += "显示所有辅助层，适合调试。";
  else text += "选择单位或地图格查看属性；切换查看模式进入移动、战斗或补给视图。";
  target.textContent = text;
}

function actionableUnitsForCurrentPhase() {
  const kind = phaseKind();
  if (state.phase === "end_game_turn") return [];
  if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) {
    return unitsArray().filter(canMoveUnitNow);
  }
  if (kind === "combat") {
    return unitsArray().filter(canCombatUnitNow);
  }
  return [];
}

function sortedActionableUnits(limit = null) {
  const units = actionableUnitsForCurrentPhase()
    .sort((a, b) => Number(b.movement || 0) - Number(a.movement || 0) || String(a.hex || "").localeCompare(String(b.hex || "")) || a.id.localeCompare(b.id));
  return limit ? units.slice(0, limit) : units;
}

function focusActionableUnit(unit) {
  if (!unit) return;
  selectedUnitId = unit.id;
  selectedHexId = unit.hex || selectedHexId;
  selectedCombatDefenderHex = null;
  if (["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind())) {
    setMapViewMode("move");
    syncMoveDraftToUnit(unit.id);
    if (el("moveUnitSelect")) el("moveUnitSelect").value = unit.id;
    switchTab("move", { expandPanel: true });
  }
  else if (phaseKind() === "combat") {
    setMapViewMode("combat");
    if (el("combatAttackersInput")) el("combatAttackersInput").value = unit.id;
    if (el("combatDefendersInput")) el("combatDefendersInput").value = "";
    switchTab("combat", { expandPanel: true });
  }
  renderSelectedUnit();
  renderSelectedHex();
  renderActionableUnits();
  renderActionControls();
  renderMap();
  focusMapOnHex(unit.hex);
}

function cycleActionableUnit(direction = 1) {
  const units = sortedActionableUnits();
  if (!units.length) return;
  const current = Math.max(0, units.findIndex((unit) => unit.id === selectedUnitId));
  const nextIndex = selectedUnitId && units.some((unit) => unit.id === selectedUnitId)
    ? (current + direction + units.length) % units.length
    : 0;
  focusActionableUnit(units[nextIndex]);
}

function phaseDirective() {
  const kind = phaseKind();
  const guide = phaseGuide(state.phase);
  const confirmEnd = phaseEndConfirmationPending();
  const endLabel = phaseEndButtonLabel(state.phase === "end_game_turn" ? "进入下一回合" : kind === "combat" ? "跳过战斗" : "结束阶段");
  const base = {
    tone: kind || "state",
    label: phaseShortLabel(state.phase),
    title: guide.action,
    detail: guide.detail,
    primaryCommand: "open-phase-panel",
    primaryLabel: `打开${guide.tabLabel}`,
    endLabel
  };
  if (state.phase === "end_game_turn") {
    return {
      ...base,
      tone: "end",
      title: confirmEnd ? "再次确认进入下一回合" : "处理回合结束结算",
      detail: confirmEnd ? "将更新补给、孤立、胜负并推进回合。" : "检查补给、孤立和胜负后进入下一回合。",
      primaryCommand: "open-phase-panel",
      primaryLabel: "打开裁判",
      endLabel: confirmEnd ? "确认进入下一回合" : "进入下一回合"
    };
  }
  if (currentPhaseIsAiControlled()) {
    return {
      ...base,
      tone: "ai",
      title: state.ai_autoplay ? "AI 正在自动执行当前阶段" : "AI 已配置但暂停",
      detail: playerControllerLabel(playerController(state.active_side)),
      primaryCommand: state.ai_autoplay ? "pause-ai" : "resume-ai",
      primaryLabel: state.ai_autoplay ? "暂停 AI" : "恢复 AI"
    };
  }
  if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) {
    const unit = currentMoveUnit();
    const route = routeVerdict();
    const hasRoute = movePathDraft.length > 1;
    const actionableCount = actionableUnitsForCurrentPhase().length;
    if (!unit || !canMoveUnitNow(unit)) {
      return {
        ...base,
        tone: "move",
        title: actionableCount ? "先选择一个可移动单位" : "本阶段没有可移动单位",
        detail: actionableCount ? `${actionableCount} 个单位可行动，选中后在地图上画路线。` : "可以直接结束阶段。",
        primaryCommand: actionableCount ? "focus-first-actionable" : "open-phase-panel",
        primaryLabel: actionableCount ? "选择推荐单位" : "打开移动"
      };
    }
    if (!hasRoute) {
      return {
        ...base,
        tone: "move",
        title: `给 ${unit.name || unit.id} 规划路线`,
        detail: "点击地图相邻格绘制路线，或输入目标格自动寻路。",
        primaryCommand: "open-phase-panel",
        primaryLabel: "打开移动"
      };
    }
    return {
      ...base,
      tone: route?.legal ? "move" : "bad",
      title: route?.legal ? "路线合法，可以执行移动" : "路线不合法，需要调整",
      detail: route?.details ? `${unit.name || unit.id} · ${route.details.spent}/${route.details.allowance} MP` : (route?.reason || "等待裁判结果"),
      primaryCommand: route?.legal ? "apply-move" : "open-phase-panel",
      primaryLabel: route?.legal ? "执行移动" : "查看移动"
    };
  }
  if (kind === "combat") {
    let action = { attackers: [], defender_hexes: [] };
    try { action = parseCombatAction(); }
    catch { action = { attackers: [], defender_hexes: [] }; }
    const attackers = action.attackers || [];
    const defenders = action.defender_hexes || [];
    const verdict = safeCombatVerdict();
    const actionableCount = actionableUnitsForCurrentPhase().length;
    if (!attackers.length || !defenders.length) {
      return {
        ...base,
        tone: "combat",
        title: actionableCount ? "先选择攻击单位和目标格" : "没有可攻击单位",
        detail: actionableCount ? `${actionableCount} 个单位可攻击，选择后预览战斗。` : "战斗是自愿的，可以跳过。",
        primaryCommand: actionableCount ? "focus-first-actionable" : "open-phase-panel",
        primaryLabel: actionableCount ? "选择推荐单位" : "打开战斗"
      };
    }
    return {
      ...base,
      tone: verdict?.legal ? "combat" : "bad",
      title: verdict?.legal ? "战斗合法，可以掷骰结算" : "战斗不合法，需要调整",
      detail: verdict?.legal ? `${attackers.length} 个攻击单位 · ${defenders.join(", ")}` : (verdict?.reason || "等待裁判结果"),
      primaryCommand: verdict?.legal ? "roll-combat" : "open-phase-panel",
      primaryLabel: verdict?.legal ? "掷骰结算" : "查看战斗"
    };
  }
  return base;
}

function renderPhaseDirective(item = phaseDirective(), meta = {}) {
  return `
    <div class="phase-directive ${escapeHtml(item.tone)}">
      <div>
        <span>${escapeHtml(meta.label || item.label)}</span>
        <b>${escapeHtml(item.title)}</b>
        <small>${escapeHtml(item.detail)}</small>
      </div>
      ${meta.next ? `
        <div class="phase-directive-meta">
          <span>${escapeHtml(meta.status || "")}</span>
          <b>${escapeHtml(meta.next)}</b>
        </div>
      ` : ""}
      <div class="phase-directive-actions">
        <button type="button" class="primary-action" data-command="${escapeHtml(item.primaryCommand)}">${escapeHtml(item.primaryLabel)}</button>
        <button type="button" class="secondary-action" data-command="end-phase">${escapeHtml(item.endLabel)}</button>
      </div>
    </div>
  `;
}

function actionableUnitContext() {
  const kind = phaseKind();
  if (state.phase === "end_game_turn") {
    return { title: "回合结束", detail: "确认后进入下一回合。", empty: "本阶段由系统结算，没有可手动操作的棋子。", command: "open-phase-panel", commandLabel: "裁判" };
  }
  if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) {
    return { title: "本阶段可移动", detail: "点一个单位后，在地图上点击目的地或画路线。", empty: "当前阶段没有可移动单位。", command: "move", commandLabel: "移动" };
  }
  if (kind === "combat") {
    return { title: "本阶段可攻击", detail: "点攻击单位，再点红色目标格预览并结算。", empty: "当前没有可攻击目标的单位，可以跳过战斗。", command: "combat", commandLabel: "战斗" };
  }
  return { title: "本阶段可行动", detail: "选择棋子或地图格查看裁判信息。", empty: "当前阶段没有可列出的单位。", command: "select", commandLabel: "选择" };
}

function renderActionableUnitsPanel(panelId, options = {}) {
  const panel = el(panelId);
  if (!panel) return;
  const context = actionableUnitContext();
  const units = sortedActionableUnits();
  const shown = units.slice(0, options.limit || 8);
  const more = Math.max(0, units.length - shown.length);
  panel.className = `actionable-units ${state.active_side || ""} ${units.length ? "" : "empty"}`;
  panel.innerHTML = `
    <div class="actionable-head">
      <div>
        <span>${escapeHtml(phaseShortLabel(state.phase))}</span>
        <b>${escapeHtml(context.title)}</b>
        <small>${escapeHtml(context.detail)}</small>
      </div>
      <em>${escapeHtml(units.length)} 个</em>
    </div>
    ${shown.length ? `
      <div class="actionable-list">
        ${shown.map((unit) => actionableUnitCard(unit, context)).join("")}
      </div>
      ${more ? `<button class="actionable-more" type="button" data-actionable-command="open-roster">还有 ${escapeHtml(more)} 个，打开编成</button>` : ""}
    ` : `<p>${escapeHtml(context.empty)}</p>`}
  `;
}

function actionableUnitChips(unit, context) {
  const chips = [];
  const kind = phaseKind();
  chips.push(unit.hex || "未部署");
  if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) {
    chips.push(`${unit.movement ?? 0} MP`);
    if (unit.road_mode) chips.push("道路模式");
    else if (canEnterRoadModeNow(unit)) chips.push("可入道路");
    if (isMechanized(unit)) chips.push("机械化");
  }
  else if (kind === "combat") {
    const targets = adjacentCombats(unit.side).filter((pair) => pair.attacker === unit.id);
    chips.push(`${targets.length} 目标`);
    chips.push(`A${unit.attack ?? 0}`);
  }
  if (isPlayableSide(unit.side) && (isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit))) chips.push(supplyStateLabel(supplyState(unit.id)));
  if (unit.state && unit.state !== "fresh") chips.push(unitStateLabel(unit.state));
  if (unit.attacked_this_phase || unit.attacked_this_turn) chips.push("已攻击");
  if (unit.defended_this_phase) chips.push("已防御");
  return chips.filter(Boolean).slice(0, context.command === "combat" ? 4 : 4);
}

function actionableUnitCard(unit, context) {
  const selected = unit.id === selectedUnitId ? " selected" : "";
  const type = unitTypeGroup(unit).label;
  const chips = actionableUnitChips(unit, context);
  const stats = [];
  if (isCombatUnit(unit)) {
    stats.push(`A${unit.attack ?? 0}`);
    stats.push(`D${unit.defense ?? unit.attack ?? 0}`);
  }
  if (isMovableUnit(unit)) stats.push(`MP${unit.movement ?? 0}`);
  return `
    <button class="actionable-unit${selected}" type="button" data-unit-id="${escapeHtml(unit.id)}" data-actionable-command="${escapeHtml(context.command)}">
      <span class="actionable-unit-command">${escapeHtml(context.commandLabel)}</span>
      <span class="actionable-unit-main">
        <b>${escapeHtml(unit.name || unit.id)}</b>
        <small>${escapeHtml(unit.hex || "未部署")} · ${escapeHtml(type)}</small>
        <span class="actionable-unit-chips">
          ${chips.map((chip) => `<i>${escapeHtml(chip)}</i>`).join("")}
        </span>
      </span>
      <span class="actionable-unit-stats">
        ${stats.slice(0, 3).map((stat) => `<i>${escapeHtml(stat)}</i>`).join("")}
      </span>
    </button>
  `;
}

function renderActionableUnits() {
  renderActionableUnitsPanel("stateActionableUnits", { limit: 6 });
  renderActionableUnitsPanel("moveActionableUnits", { limit: 4 });
  renderActionableUnitsPanel("combatActionableUnits", { limit: 4 });
}

function workflowCueHtml({ tone = "idle", step = "", title = "", detail = "", facts = [] } = {}) {
  const detailHtml = tone === "bad" && detail ? `<p>${escapeHtml(detail)}</p>` : "";
  return `
    <div class="workflow-cue-card ${escapeHtml(tone)}">
      <span>${escapeHtml(step)}</span>
      <strong>${escapeHtml(title)}</strong>
      ${facts.length ? `<div>${facts.map((fact) => `<i>${escapeHtml(fact)}</i>`).join("")}</div>` : ""}
      ${detailHtml}
    </div>
  `;
}

function renderMoveWorkflowCue() {
  const target = el("moveWorkflowCue");
  if (!target) return;
  if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind())) {
    target.className = "workflow-cue hidden";
    target.innerHTML = "";
    return;
  }
  const unit = currentMoveUnit();
  const actionableCount = actionableUnitsForCurrentPhase().length;
  const route = routeVerdict();
  const hasRoute = movePathDraft.length > 1;
  const hasTarget = !!el("moveTargetInput")?.value.trim();
  target.className = "workflow-cue";
  if (!unit || !canMoveUnitNow(unit)) {
    target.innerHTML = workflowCueHtml({
      tone: actionableCount ? "ready" : "idle",
      step: "下一步",
      title: actionableCount ? "选择一个可移动单位" : "本阶段没有可移动单位",
      detail: actionableCount ? "从上方列表点单位，或直接在地图上点发光的棋子。" : "可以结束阶段，或检查是否有单位已经行动。",
      facts: [`${actionableCount} 个可移动`]
    });
    return;
  }
  if (!hasRoute) {
    target.innerHTML = workflowCueHtml({
      tone: "move",
      step: "待路线",
      title: `${unit.name || unit.id}`,
      detail: hasTarget ? "可以点“自动路线”，也可以直接在地图上点击目标格。" : "在地图上点击相邻格绘制路线；要输入坐标时展开“坐标寻路”。",
      facts: [unit.hex || "未部署", `${unit.movement ?? 0} MP`, el("moveModeSelect")?.value === "road" ? "道路模式" : "普通移动"]
    });
    return;
  }
  if (route?.legal) {
    target.innerHTML = workflowCueHtml({
      tone: "ready",
      step: "可执行",
      title: `移动到 ${movePathDraft.at(-1) || ""}`,
      detail: "点击底部行动卡的“执行移动”。执行后单位会变为已行动。",
      facts: [`${route.details?.spent ?? "?"}/${route.details?.allowance ?? "?"} MP`, movePathDraft.at(-1) || ""]
    });
    return;
  }
  target.innerHTML = workflowCueHtml({
    tone: "bad",
    step: "路线受阻",
    title: route?.reason || "路线当前不合法",
    detail: route?.reason || "裁判没有接受这条路线，请撤销一步或清空路线重画。",
    facts: [movePathDraft.join(" -> ")]
  });
}

function renderCombatWorkflowCue() {
  const target = el("combatWorkflowCue");
  if (!target) return;
  if (phaseKind() !== "combat") {
    target.className = "workflow-cue hidden";
    target.innerHTML = "";
    return;
  }
  let action = { attackers: [], defender_hexes: [] };
  try { action = parseCombatAction(); }
  catch { action = { attackers: [], defender_hexes: [] }; }
  const selected = selectedUnitId && state.units?.[selectedUnitId] ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  const attackers = action.attackers || [];
  const defenders = action.defender_hexes || [];
  const actionableCount = actionableUnitsForCurrentPhase().length;
  const verdict = safeCombatVerdict();
  target.className = "workflow-cue";
  if (!attackers.length) {
    target.innerHTML = workflowCueHtml({
      tone: actionableCount ? "ready" : "idle",
      step: "下一步",
      title: actionableCount ? "选择攻击单位" : "当前没有可攻击单位",
      detail: actionableCount ? "从上方列表选择，或在地图战斗视图中点可攻击单位。" : "可以跳过战斗阶段，或检查相邻敌方单位。",
      facts: [`${actionableCount} 个可攻击`]
    });
    return;
  }
  if (!defenders.length) {
    const targets = selected && canCombatUnitNow(selected) ? combatTargetOptionsForSelectedUnit().length : 0;
    target.innerHTML = workflowCueHtml({
      tone: "combat",
      step: "待目标",
      title: attackers.length === 1 ? (state.units?.[attackers[0]]?.name || attackers[0]) : `${attackers.length} 个攻击单位`,
      detail: "点击下方目标卡，或在地图上点红色目标格。防御格内所有单位会共同防御。",
      facts: [`攻击 ${attackers.length} 个单位`, `${targets} 个目标格`]
    });
    return;
  }
  if (verdict?.legal) {
    target.innerHTML = workflowCueHtml({
      tone: "ready",
      step: "可结算",
      title: `${verdict.details?.odds_column || "赔率待定"} · ${defenders.join(", ")}`,
      detail: "底部行动卡可直接随机掷骰结算；需要指定骰点时使用右侧骰子选择。",
      facts: [verdict.details?.odds_column || "赔率待定", defenders.join(", ")]
    });
    return;
  }
  target.innerHTML = workflowCueHtml({
    tone: "bad",
    step: "战斗受阻",
    title: verdict?.reason || "战斗当前不合法",
    detail: verdict?.reason || "请调整攻击单位或目标格。",
    facts: [`攻击 ${attackers.length}`, defenders.join(", ")]
  });
}

function handleActionableUnitsClick(event) {
  const button = event.target.closest?.("[data-actionable-command]");
  if (!button) return;
  const command = button.dataset.actionableCommand;
  if (command === "open-roster") {
    switchTab("roster", { expandPanel: true });
    return;
  }
  const unitId = button.dataset.unitId;
  if (unitId) selectUnit(unitId, { showStateTab: false });
  if (command === "move") activateMoveForSelectedUnit();
  else if (command === "combat") activateCombatForSelectedUnit();
  else if (command === "open-phase-panel") focusCurrentPhaseTab({ expandPanel: true });
  else if (unitId && state.units?.[unitId]?.hex) focusMapOnHex(state.units[unitId].hex);
}

function handleCombatTargetListClick(event) {
  const button = event.target.closest?.("[data-action='select-combat-target']");
  if (!button) return;
  selectCombatTarget(button.dataset.defender, button.dataset.attacker);
}

function setActionVisible(id, visible) {
  const node = el(id);
  if (!node) return;
  node.classList.toggle("action-hidden", !visible);
  if ("disabled" in node) node.disabled = !visible;
}

function syncActionGroupVisible(containerId, actionIds = []) {
  const container = el(containerId);
  if (!container) return;
  const visible = actionIds.some((id) => {
    const node = el(id);
    return node && !node.classList.contains("action-hidden");
  });
  container.classList.toggle("action-hidden", !visible);
  if (!visible && "open" in container) container.open = false;
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

function renderCombatSelectionSummary() {
  const target = el("combatSelectionSummary");
  if (!target) return;
  let action;
  try {
    action = parseCombatAction();
  }
  catch {
    action = { attackers: [], defender_hexes: [] };
  }
  const attackers = action.attackers || [];
  const defenderHexes = action.defender_hexes || [];
  if (!attackers.length && !defenderHexes.length) {
    target.className = "combat-selection-summary empty hidden";
    target.innerHTML = "";
    return;
  }
  const attackerText = attackers.length
    ? attackers.map((id) => state.units?.[id]?.name || id).join(", ")
    : "未选择";
  const defenderText = defenderHexes.length ? defenderHexes.join(", ") : "未选择";
  let status = "等待选择";
  let ready = false;
  if (attackers.length && defenderHexes.length) {
    const verdict = safeCombatVerdict();
    ready = !!verdict?.legal;
    status = verdict?.reason || (ready ? "可结算" : "不能执行");
  }
  target.className = `combat-selection-summary ${ready ? "ready" : "empty"}`;
  target.innerHTML = `
    <dl>
      <div><dt>攻击</dt><dd>${escapeHtml(attackerText)}</dd></div>
      <div><dt>目标</dt><dd>${escapeHtml(defenderText)}</dd></div>
    </dl>
    <span>${escapeHtml(status)}</span>
  `;
}

function renderCombatOverview() {
  const panel = el("combatOverview");
  if (!panel) return;
  let action;
  try {
    action = parseCombatAction();
  }
  catch {
    action = { attackers: [], defender_hexes: [] };
  }
  const attackers = action.attackers || [];
  const defenderHexes = action.defender_hexes || [];
  if (!attackers.length && !defenderHexes.length) {
    panel.className = "combat-overview empty";
    panel.innerHTML = "";
    return;
  }
  const verdict = attackers.length && defenderHexes.length ? safeCombatVerdict() : null;
  const details = verdict?.details || {};
  const attack = details.attack_strength ?? attackers.reduce((sum, id) => sum + Number(state.units?.[id]?.attack || 0), 0);
  const defense = details.defense_strength ?? defenderHexes.reduce((sum, hex) => {
    const defenders = unitsArray().filter((unit) => isMapCounter(unit) && unit.hex === hex && unit.side !== state.active_side && isCombatUnit(unit));
    return sum + defenders.reduce((unitSum, unit) => unitSum + Number(unit.defense || unit.attack || 0), 0);
  }, 0);
  const odds = details.odds_column || (attack && defense ? combatOddsColumn(attack, defense) : "-");
  const result = verdict?.legal ? "可结算" : verdict ? "需调整" : "待选择";
  panel.className = `combat-overview ${verdict?.legal ? "ok" : verdict ? "bad" : "muted"}`;
  panel.innerHTML = `
    <div><span>攻击</span><b>${escapeHtml(attack || "-")}</b><small>${escapeHtml(attackers.length)} 单位</small></div>
    <div><span>防御</span><b>${escapeHtml(defense || "-")}</b><small>${escapeHtml(defenderHexes.length)} 格</small></div>
    <div><span>赔率</span><b>${escapeHtml(odds || "-")}</b></div>
    <div><span>裁判</span><b>${escapeHtml(result)}</b></div>
  `;
}

function combatTargetOptionsForSelectedUnit() {
  if (!selectedUnitId || !state.units?.[selectedUnitId]) return [];
  const unit = { id: selectedUnitId, ...state.units[selectedUnitId] };
  if (!canCombatUnitNow(unit)) return [];
  return adjacentCombats(unit.side).filter((pair) => pair.attacker === selectedUnitId);
}

function combatTargetPreview(pair) {
  const defenders = (pair.defenders || []).map((id) => ({ id, ...(state.units?.[id] || {}) })).filter((unit) => state.units?.[unit.id]);
  const verdict = checkCombat({ attackers: [pair.attacker], defender_hexes: [pair.defender_hex], die: null, no_retreat_order: false });
  return {
    legal: verdict.legal,
    reason: verdict.reason,
    attack: verdict.details?.attack,
    defense: verdict.details?.defense,
    column: verdict.details?.odds_column,
    defenders
  };
}

function renderCombatTargetList() {
  const panel = el("combatTargetList");
  if (!panel) return;
  const selected = selectedUnitId && state.units?.[selectedUnitId] ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  if (phaseKind() !== "combat") {
    panel.className = "combat-target-list empty hidden";
    panel.innerHTML = "";
    return;
  }
  if (!selected || !isCombatUnit(selected)) {
    panel.className = "combat-target-list empty hidden";
    panel.innerHTML = "";
    return;
  }
  const targets = combatTargetOptionsForSelectedUnit();
  if (!targets.length) {
    panel.className = "combat-target-list empty";
    panel.innerHTML = `<p>${escapeHtml(selected.name || selected.id)} 没有可攻击目标。</p>`;
    return;
  }
  panel.className = "combat-target-list";
  panel.innerHTML = `
    <div class="combat-target-head">
      <span>可攻击目标</span>
      <b>${escapeHtml(selected.name || selected.id)}</b>
    </div>
    <div class="combat-target-cards">
      ${targets.map((pair) => {
        const preview = combatTargetPreview(pair);
        const selectedTarget = selectedCombatDefenderHex === pair.defender_hex;
        const defenderText = preview.defenders.map((unit) => unit.name || unit.id).join(", ");
        return `
          <button class="combat-target-card ${selectedTarget ? "selected" : ""} ${preview.legal ? "" : "blocked"}" type="button" data-action="select-combat-target" data-attacker="${escapeHtml(pair.attacker)}" data-defender="${escapeHtml(pair.defender_hex)}">
            <span>
              <b>${escapeHtml(pair.defender_hex)}</b>
              <small>${escapeHtml(preview.legal ? (defenderText || "敌方堆叠") : preview.reason)}</small>
            </span>
            <em>${escapeHtml(preview.column || "?")}</em>
          </button>
        `;
      }).join("")}
    </div>
  `;
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
  syncActionGroupVisible("moveSpareActions", ["enterRoadModeBtn", "leaveRoadModeBtn", "exitWestBtn"]);
  const combatPhase = phaseKind() === "combat";
  const combatVerdict = safeCombatVerdict();
  const hasCombatSelection = !!combatVerdict;
  const combatDie = !!el("combatResolveDieSelect")?.value;
  renderCombatSelectionSummary();
  renderCombatOverview();
  renderCombatTargetList();
  renderMoveWorkflowCue();
  renderCombatWorkflowCue();
  setActionVisible("combatResolveSection", combatPhase && hasCombatSelection);
  setActionVisible("useSelectedCombatBtn", canCombatUnitNow(selected));
  setActionVisible("previewCombatBtn", combatPhase && hasCombatSelection);
  setActionVisible("randomCombatBtn", combatPhase && !!combatVerdict?.legal);
  setActionVisible("resolveCombatBtn", combatPhase && !!combatVerdict?.legal && combatDie);
  setActionVisible("undoActionBtn", actionLog.length > 0);
  const hasMineClearTarget = combatPhase && !!el("engineerSelect")?.value && !!el("mineHexInput")?.value.trim();
  setActionVisible("clearMineSection", combatPhase && !!el("engineerSelect")?.options?.length);
  setActionVisible("clearMineBtn", hasMineClearTarget);

  const aiControlled = currentPhaseIsAiControlled();
  const canSuggestAi = isPlayableSide(state.active_side) && !!(el("aiModeSelect")?.value || aiModeForSide(state.active_side));
  syncAiAutoControls();
  setActionVisible("aiSuggestBtn", canSuggestAi);
  setActionVisible("aiApplyBtn", !!aiSuggestion?.action);
  setActionVisible("aiPlayCurrentBtn", aiControlled && !state.ai_autoplay);
  setActionVisible("aiAutoRunBtn", anySideAiControlled() && !state.ai_autoplay);
  setActionVisible("aiAutoStopBtn", anySideAiControlled() && !!state.ai_autoplay);

  const selectedSlot = hasSelectedSaveSlot();
  setActionVisible("loadSlotBtn", selectedSlot);
  setActionVisible("deleteSlotBtn", selectedSlot);
  renderSideCommandBar();
  renderPhaseActionDock();
}

function resolveCombatWithRandomDie() {
  const verdict = safeCombatVerdict();
  if (!verdict?.legal) {
    setOutput("combatOutput", verdict || { legal: false, reason: "请先选择攻击单位和防御格" });
    switchTab("combat", { expandPanel: true });
    return;
  }
  const die = String(Math.floor(Math.random() * 6) + 1);
  if (el("combatResolveDieSelect")) el("combatResolveDieSelect").value = die;
  setOutput("combatOutput", resolveCombat(parseCombatAction()));
  renderActionControls();
}

function runAutoRouteFromTarget() {
  const unitId = el("moveUnitSelect")?.value;
  const rawTarget = el("moveTargetInput")?.value || "";
  let target;
  try {
    target = normalizeHex(rawTarget);
  }
  catch {
    setOutput("moveOutput", { legal: false, reason: "请输入有效目标格", target: rawTarget });
    renderActionControls();
    return false;
  }
  if (el("moveTargetInput")) el("moveTargetInput").value = target;
  const path = findLegalPath(unitId, target, moveOptions());
  if (!path) {
    setOutput("moveOutput", { legal: false, reason: "找不到合法自动路线", target });
    renderActionControls();
    return false;
  }
  movePathDraft = path;
  syncMovePathInput();
  renderRouteStatus();
  renderActionControls();
  renderMap();
  return true;
}

function previewCombatFromInputs() {
  setOutput("combatOutput", checkCombat(parseCombatAction()));
  renderActionControls();
}

function handlePhaseActionDockClick(event) {
  const button = event.target.closest?.("button[data-command]");
  if (!button || button.disabled) return;
  closeDockMenus();
  const command = button.dataset.command;
  if (command !== "end-phase") pendingPhaseEndKey = null;
  if (command === "open-phase-panel") {
    focusCurrentPhaseTab({ expandPanel: true });
    return;
  }
  if (command === "open-ai-panel") {
    switchTab("ai", { expandPanel: true });
    return;
  }
  if (command === "resume-ai") {
    setAiAutoplay(true);
    return;
  }
  if (command === "pause-ai") {
    setAiAutoplay(false);
    return;
  }
  if (command === "end-phase") {
    if (!phaseEndConfirmationPending()) {
      pendingPhaseEndKey = phaseEndKey();
      renderState();
      return;
    }
    pendingPhaseEndKey = null;
    advancePhase();
    return;
  }
  if (command === "auto-route") {
    el("autoRouteBtn")?.click();
    return;
  }
  if (command === "apply-move") {
    el("applyMoveBtn")?.click();
    return;
  }
  if (command === "undo-route") {
    el("undoRouteBtn")?.click();
    return;
  }
  if (command === "clear-route") {
    el("clearRouteBtn")?.click();
    return;
  }
  if (command === "undo-action") {
    undoLastAction();
    return;
  }
  if (command === "next-actionable") {
    cycleActionableUnit(1);
    return;
  }
  if (command === "focus-first-actionable") {
    focusActionableUnit(sortedActionableUnits()[0]);
    return;
  }
  if (command === "focus-actionable") {
    const unitId = button.dataset.unitId;
    focusActionableUnit(sortedActionableUnits().find((unit) => unit.id === unitId));
    return;
  }
  if (command === "use-selected-combat") {
    el("useSelectedCombatBtn")?.click();
    return;
  }
  if (command === "preview-combat") {
    el("previewCombatBtn")?.click();
    return;
  }
  if (command === "roll-combat") {
    resolveCombatWithRandomDie();
  }
}

function phaseLabel(phase) {
  const labels = {
    axis_initial_movement: "Axis 初始移动",
    axis_combat: "Axis 战斗",
    axis_mechanized_movement: "Axis 机械化移动",
    axis_supply_movement: "Axis 补给移动",
    allies_initial_movement: "Allies 初始移动",
    allies_combat: "Allies 战斗",
    allies_mechanized_movement: "Allies 机械化移动",
    allies_supply_movement: "Allies 补给移动",
    end_game_turn: "回合结束结算"
  };
  return labels[phase] || String(phase || "").replaceAll("_", " ");
}

function phaseShortLabel(phase) {
  const labels = {
    axis_initial_movement: "初始移动",
    axis_combat: "战斗",
    axis_mechanized_movement: "机械化移动",
    axis_supply_movement: "补给移动",
    allies_initial_movement: "初始移动",
    allies_combat: "战斗",
    allies_mechanized_movement: "机械化移动",
    allies_supply_movement: "补给移动",
    end_game_turn: "回合结束"
  };
  return labels[phase] || phaseLabel(phase);
}

function phaseDisplayName(phase) {
  if (phase === "end_game_turn") return "回合结束结算";
  const side = phase?.startsWith?.("axis_") ? "Axis" : phase?.startsWith?.("allies_") ? "Allies" : "";
  const label = phaseShortLabel(phase);
  return side ? `${side} ${label}` : label;
}

function phaseGuide(phase = state.phase) {
  const kind = phaseKind(phase);
  if (phase === "end_game_turn") {
    return {
      tab: "judge",
      tabLabel: "裁判",
      action: "结算补给、孤立、胜负和回合结束效果。",
      detail: "确认后点“结束当前阶段”进入下一回合。"
    };
  }
  if (kind === "initial_movement") {
    return {
      tab: "move",
      tabLabel: "移动",
      action: "移动当前方单位，处理必须修复的堆叠。",
      detail: "完成所有想移动的单位后结束阶段。"
    };
  }
  if (kind === "combat") {
    return {
      tab: "combat",
      tabLabel: "战斗",
      action: "选择攻击单位和防御格，先预览再结算。",
      detail: "不想攻击时可以直接结束阶段。"
    };
  }
  if (kind === "mechanized_movement") {
    return {
      tab: "move",
      tabLabel: "移动",
      action: "只移动合格且本回合未攻击的机械化单位。",
      detail: "普通步兵和已攻击机械化单位不能在此阶段移动。"
    };
  }
  if (kind === "supply_movement") {
    return {
      tab: "move",
      tabLabel: "移动",
      action: "移动当前方补给单位，调整补给链。",
      detail: "补给单位移动完后结束玩家回合。"
    };
  }
  return {
    tab: "state",
    tabLabel: "局面",
    action: "查看当前局面。",
    detail: "按规则状态选择下一步。"
  };
}

function activeTabName() {
  return document.querySelector(".tab.active")?.dataset.tab || "state";
}

function focusCurrentPhaseTab(options = {}) {
  const guide = phaseGuide(state.phase);
  const targetTab = guide.tab || "state";
  const utilityTabs = new Set(["roster", "rulebook", "ai", "settings", "calibration"]);
  if (options.respectUtility && utilityTabs.has(activeTabName())) return;
  switchTab(targetTab, { expandPanel: !!options.expandPanel });
}

function tabBaseLabel(tabName = "") {
  const labels = {
    state: "局面",
    move: "移动",
    combat: "战斗",
    judge: "裁判",
    log: "日志",
    roster: "编成",
    rulebook: "规则书",
    ai: "AI",
    calibration: "校准",
    settings: "设置"
  };
  return labels[tabName] || tabName;
}

function phaseTabBadge(tabName = "") {
  const targetTab = phaseGuide(state.phase).tab || "state";
  if (tabName !== targetTab) return "";
  const count = actionableUnitsForCurrentPhase().length;
  if (tabName === "move" || tabName === "combat") return String(count);
  if (state.phase === "end_game_turn") return "结算";
  return "";
}

function syncPhaseRecommendedTab() {
  const targetTab = phaseGuide(state.phase).tab || "state";
  document.querySelectorAll(".tab").forEach((tab) => {
    const tabName = tab.dataset.tab || "";
    const recommended = tab.closest(".play-tabs") && tabName === targetTab;
    const badge = phaseTabBadge(tabName);
    tab.classList.toggle("phase-recommended", recommended);
    tab.classList.toggle("has-tab-badge", !!badge);
    tab.innerHTML = `${escapeHtml(tabBaseLabel(tabName))}${badge ? ` <span>${escapeHtml(badge)}</span>` : ""}`;
    if (recommended) {
      tab.title = (tabName === "move" || tabName === "combat") && badge
        ? `当前阶段推荐面板，${badge} 个可行动单位`
        : "当前阶段推荐面板";
    }
    else tab.removeAttribute("title");
  });
}

function syncActiveSideFromPhase() {
  const side = phaseSide(state.phase);
  if (isPlayableSide(side)) state.active_side = side;
}

function phaseStepShortLabel(phase) {
  if (phase === "end_game_turn") return "结算";
  const side = phase.startsWith("axis_") ? "轴" : phase.startsWith("allies_") ? "盟" : "";
  const kind = phaseKind(phase);
  const labels = {
    initial_movement: "移",
    combat: "战",
    mechanized_movement: "机",
    supply_movement: "补"
  };
  return `${side}${labels[kind] || "?"}`;
}

function phaseStepUiParts(phase) {
  if (phase === "end_game_turn") return { side: "End", action: "结算" };
  const side = phase.startsWith("axis_") ? "Axis" : phase.startsWith("allies_") ? "Allies" : "";
  const labels = {
    initial_movement: "初移",
    combat: "战斗",
    mechanized_movement: "机动",
    supply_movement: "补给"
  };
  return { side, action: labels[phaseKind(phase)] || phaseShortLabel(phase) };
}

function phaseProgressMeta() {
  const sequence = rules.turn_sequence?.length ? rules.turn_sequence : DEFAULT_RULES.turn_sequence;
  const index = Math.max(0, sequence.indexOf(state.phase));
  return {
    sequence,
    index,
    current: index + 1,
    total: sequence.length || 1
  };
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

function advancePhase(options = {}) {
  pushHistory("advance_phase");
  pendingPhaseEndKey = null;
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
  logEvent("phase", `阶段推进：${phaseDisplayName(fromPhase)} -> ${phaseDisplayName(state.phase)}`, { from_turn: fromTurn, to_turn: state.turn, from_phase: fromPhase, to_phase: state.phase });
  renderState();
  const shouldFocus = options.focusPhaseTab ?? !state.ai_autoplay;
  if (shouldFocus) focusCurrentPhaseTab();
  scheduleAiAutoplay();
}

function advancePhaseForAi() {
  suppressAiActionRender = true;
  try {
    advancePhase({ focusPhaseTab: false });
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

function renderTurnPhaseFlow() {
  const { sequence, index: currentIndex } = phaseProgressMeta();
  const slots = [
    { key: "prev", label: "上一", phase: sequence[currentIndex - 1] || null },
    { key: "current", label: "当前", phase: sequence[currentIndex] || state.phase },
    { key: "next", label: "下一", phase: sequence[currentIndex + 1] || null }
  ];
  return `
    <div class="turn-flow" aria-label="本回合阶段轨道">
      ${slots.map((slot) => {
        const phase = slot.phase;
        const parts = phase ? phaseStepUiParts(phase) : null;
        const phaseSideName = phase === "end_game_turn"
          ? "end"
          : phase?.startsWith?.("axis_")
          ? "axis"
          : phase?.startsWith?.("allies_")
          ? "allies"
          : "";
        const classes = [
          "turn-flow-step",
          slot.key,
          phaseSideName,
          slot.key === "current" ? "current" : "",
          slot.key === "prev" && phase ? "done" : "",
          phase ? "" : "missing"
        ].filter(Boolean).join(" ");
        const text = phase ? phaseDisplayName(phase) : (slot.key === "prev" ? "起始" : "下一回合");
        return `
          <span class="${classes}" title="${escapeHtml(text)}" aria-current="${slot.key === "current" ? "step" : "false"}">
            <i>${escapeHtml(slot.label)}</i>
            <b>${escapeHtml(phase ? `${parts.side} ${parts.action}` : text)}</b>
          </span>
        `;
      }).join("")}
    </div>
  `;
}

function renderTurnBanner() {
  const banner = el("turnBanner");
  if (!banner) return;
  const guide = phaseGuide(state.phase);
  const side = state.active_side === "allies" ? "allies" : "axis";
  const isEndTurn = state.phase === "end_game_turn";
  const sideDisplay = isEndTurn ? "End Turn" : (side === "axis" ? "Axis" : "Allies");
  const controller = playerControllerLabel(playerController(side));
  const progress = phaseProgressMeta();
  const victory = victoryStatusSummary();
  let nextPhaseText = "下一回合";
  try {
    nextPhaseText = phaseDisplayName(RulesEngine.nextPhase(rulesContext()).phase);
  }
  catch {
    nextPhaseText = "下一阶段";
  }
  const aiControlled = currentPhaseIsAiControlled();
  const aiState = isEndTurn
    ? "系统结算阶段"
    : aiControlled
    ? (state.ai_autoplay ? "AI 会自动执行" : "AI 已暂停")
    : "等待玩家操作";
  banner.className = `turn-banner ${side}`;
  banner.innerHTML = `
    <div class="turn-focus">
      <span>${escapeHtml(sideDisplay)} · ${escapeHtml(isEndTurn ? "系统" : controller)}</span>
      <strong>Turn ${escapeHtml(state.turn || 1)} · ${escapeHtml(phaseDisplayName(state.phase))}</strong>
      <small>${escapeHtml(guide.action)}</small>
    </div>
    ${renderTurnPhaseFlow()}
    <div class="turn-status">
      <span>${escapeHtml(scenarioShortName(state.scenario))}</span>
      <span>VP ${escapeHtml(victory.vp)}</span>
      <span>${escapeHtml(progress.current)}/${escapeHtml(progress.total)}</span>
      <span>${escapeHtml(nextPhaseText)}</span>
      <span>${escapeHtml(aiState)}</span>
    </div>
  `;
}

function renderPhaseTrail() {
  const { sequence, index: currentIndex } = phaseProgressMeta();
  const items = sequence.map((phase, index) => {
    const phaseSideName = phase === "end_game_turn"
      ? "end"
      : phase.startsWith("axis_")
      ? "axis"
      : phase.startsWith("allies_")
      ? "allies"
      : "";
    const classes = [
      "phase-trail-step",
      phaseSideName,
      index === currentIndex ? "current" : "",
      currentIndex >= 0 && index < currentIndex ? "done" : ""
    ].filter(Boolean).join(" ");
    return `
      <span class="${classes}" title="${escapeHtml(phaseDisplayName(phase))}" aria-label="${escapeHtml(phaseDisplayName(phase))}">
        <em>${escapeHtml(index + 1)}</em>
        <b>${escapeHtml(phaseStepShortLabel(phase))}</b>
      </span>
    `;
  }).join("");
  return `<div class="phase-trail" aria-label="本回合阶段进度">${items}</div>`;
}

function renderSideCommandBar() {
  const bar = el("sideCommandBar");
  if (!bar) return;
  const side = state.active_side === "allies" ? "allies" : "axis";
  const isEndTurn = state.phase === "end_game_turn";
  const sideDisplay = isEndTurn ? "End Turn" : (side === "axis" ? "Axis" : "Allies");
  const controller = isEndTurn ? "系统" : playerControllerLabel(playerController(side));
  const aiControlled = currentPhaseIsAiControlled();
  const aiState = isEndTurn
    ? "系统结算"
    : aiControlled
    ? (state.ai_autoplay ? "AI 自动" : "AI 暂停")
    : "玩家操作";
  const progress = phaseProgressMeta();
  let nextPhaseText = "下一回合";
  try {
    nextPhaseText = phaseDisplayName(RulesEngine.nextPhase(rulesContext()).phase);
  }
  catch {
    nextPhaseText = "下一阶段";
  }
  const directive = phaseDirective();
  bar.className = `side-command-bar ${side}`;
  bar.innerHTML = `
    <div class="side-command-head">
      <span>${escapeHtml(sideDisplay)} · ${escapeHtml(controller)}</span>
      <b>Turn ${escapeHtml(state.turn || 1)} · ${escapeHtml(progress.current)}/${escapeHtml(progress.total)}</b>
    </div>
    ${renderPhaseDirective(directive, {
      label: `当前 · ${phaseDisplayName(state.phase)}`,
      status: aiState,
      next: `下一 · ${nextPhaseText}`
    })}
    ${renderRecentEvent()}
    ${renderRuleWarnings()}
  `;
}

function ruleWarnings() {
  const warnings = [];
  const stacking = checkStacking();
  if (stacking.legal === false) warnings.push({ tone: "bad", label: "堆叠", text: stacking.reason || "存在超堆叠或非法堆叠。" });
  const supply = checkSupply(state.active_side || "axis");
  const unsupplied = Object.entries(supply).filter(([, value]) => value !== "supplied");
  const isolated = unsupplied.filter(([, value]) => value === "isolated");
  if (isolated.length) warnings.push({ tone: "bad", label: "孤立", text: `${isolated.length} 个当前方单位孤立。` });
  else if (unsupplied.length) warnings.push({ tone: "warn", label: "补给", text: `${unsupplied.length} 个当前方单位缺补给。` });
  const scenarioMeta = { ...(RulesEngine.SCENARIO_META[state.scenario] || {}), ...(state.scenario_meta || {}) };
  if (scenarioMeta.needs_review) warnings.push({ tone: "warn", label: "待核对", text: (scenarioMeta.review_notes || ["该场景有待核对数据。"])[0] });
  if (!warnings.length && state.phase !== "end_game_turn" && !actionableUnitsForCurrentPhase().length) {
    warnings.push({ tone: "idle", label: "行动", text: "当前阶段没有可列出的单位，可以结束阶段。" });
  }
  return warnings.slice(0, 3);
}

function renderRuleWarnings() {
  const warnings = ruleWarnings();
  if (!warnings.length) return "";
  return `
    <div class="side-rule-warnings" aria-label="裁判提示">
      ${warnings.map((item) => `
        <div class="${escapeHtml(item.tone)}">
          <span>${escapeHtml(item.label)}</span>
          <b>${escapeHtml(item.text)}</b>
        </div>
      `).join("")}
    </div>
  `;
}

function eventTypeLabel(type = "") {
  const labels = {
    move: "移动",
    combat: "战斗",
    phase: "阶段",
    clear_mine: "清雷",
    ai_move: "AI 移动",
    ai_combat_choice: "AI 战斗",
    ai_exit_west: "AI 撤出",
    exit_west: "撤出",
    save: "保存",
    load: "读取",
    load_scenario: "场景",
    setup: "开局",
    victory: "胜负",
    isolation_elimination: "孤立"
  };
  return labels[type] || String(type || "事件");
}

function sideDisplayName(side = "") {
  const labels = {
    axis: "Axis",
    allies: "Allies",
    neutral: "中立"
  };
  return labels[side] || (side ? String(side) : "系统");
}

function unitStateLabel(value = "") {
  const labels = {
    fresh: "待命",
    spent: "已行动"
  };
  return labels[value] || String(value || "");
}

function statsStatusLabel(value = "") {
  const labels = {
    needs_manual_review: "待确认",
    from_name: "来自名称",
    verified: "已确认",
    marker: "标记"
  };
  return labels[value] || String(value || "");
}

function terrainTagLabel(tag = "") {
  const labels = {
    clear: "平地",
    hill_or_ridge: "山脊/高地",
    depression: "洼地",
    sea: "海面",
    all_sea: "全海",
    alamein_box: "方框区域",
    road: "道路",
    track: "小路",
    impassable: "不可通行"
  };
  return labels[tag] || String(tag || "");
}

function terrainSummaryLabel(tags = []) {
  const labels = (tags || []).map(terrainTagLabel).filter(Boolean);
  return labels.length ? labels.join(", ") : terrainTagLabel("clear");
}

function renderRecentEvent() {
  const latest = (state.game_log || []).at(-1);
  if (!latest) {
    return `
      <div class="side-command-recent empty">
        <span>最近行动</span>
        <b>暂无</b>
      </div>
    `;
  }
  const time = latest.time ? new Date(latest.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const focusTarget = logEntryFocusTarget(latest);
  return `
    <div class="side-command-recent ${escapeHtml(latest.type || "")}">
      <div>
        <span>${escapeHtml(eventTypeLabel(latest.type))}</span>
        <b>${escapeHtml(latest.summary || latest.type || "事件")}</b>
        <small>T${escapeHtml(latest.turn || state.turn || 1)} · ${escapeHtml(phaseDisplayName(latest.phase))}${time ? ` · ${escapeHtml(time)}` : ""}</small>
      </div>
      ${(actionLog.length || focusTarget) ? `
        <div class="side-command-recent-actions">
          ${focusTarget ? `<button type="button" data-log-focus-type="${escapeHtml(focusTarget.type)}" data-log-focus-value="${escapeHtml(focusTarget.id || focusTarget.hex)}">${escapeHtml(focusTarget.label)}</button>` : ""}
          ${actionLog.length ? `<button type="button" data-command="undo-action">撤销</button>` : ""}
        </div>
      ` : ""}
    </div>
  `;
}

function renderStateBrief(summary = {}) {
  const target = el("stateBrief");
  if (!target) return;
  const side = state.active_side === "allies" ? "Allies" : "Axis";
  const guide = phaseGuide(state.phase);
  const progress = phaseProgressMeta();
  const victory = victoryStatusSummary();
  const actionableCount = actionableUnitsForCurrentPhase().length;
  const supplyText = Number(summary.unsupplied || 0) > 0 ? `${summary.unsupplied} 个缺补给` : "补给正常";
  const stackingOk = summary.stacking?.legal !== false;
  const primaryLabel = state.phase === "end_game_turn"
    ? "打开裁判"
    : currentPhaseIsAiControlled()
    ? (state.ai_autoplay ? "查看 AI" : "恢复 AI")
    : `进入${guide.tabLabel}`;
  const primaryCommand = state.phase === "end_game_turn"
    ? "open-phase-panel"
    : currentPhaseIsAiControlled()
    ? (state.ai_autoplay ? "open-ai-panel" : "resume-ai")
    : "open-phase-panel";
  const endLabel = state.phase === "end_game_turn" ? "下一回合" : phaseKind() === "combat" ? "跳过战斗" : "结束阶段";
  const selectionText = selectedUnitId && state.units?.[selectedUnitId]
    ? `${state.units[selectedUnitId].name || selectedUnitId} · ${state.units[selectedUnitId].hex || ""}`
    : selectedHexId
    ? `坐标 ${selectedHexId}`
    : "未选择";
  target.className = `state-brief ${state.active_side || ""} ${stackingOk ? "" : "warning"}`;
  target.innerHTML = `
    <div class="state-brief-main">
      <span>${escapeHtml(side)} · Turn ${escapeHtml(state.turn || 1)} · ${escapeHtml(progress.current)}/${escapeHtml(progress.total)}</span>
      <strong>${escapeHtml(phaseShortLabel(state.phase))}</strong>
      <div class="state-brief-actions">
        <button class="primary-action" type="button" data-command="${escapeHtml(primaryCommand)}">${escapeHtml(primaryLabel)}</button>
        <button class="quiet-action" type="button" data-command="end-phase">${escapeHtml(phaseEndButtonLabel(endLabel))}</button>
      </div>
    </div>
    <div class="state-brief-facts" aria-label="局面摘要">
      <span><b>${escapeHtml(actionableCount)}</b> 可行动</span>
      <span><b>VP ${escapeHtml(victory.vp)}</b> ${escapeHtml(victory.level)}</span>
      <span><b>${escapeHtml(scenarioShortName(state.scenario))}</b> 终局 T${escapeHtml(victory.finalTurn)}</span>
      <span><b>${escapeHtml(supplyText)}</b></span>
      <span><b class="${stackingOk ? "ok" : "bad"}">${escapeHtml(stackingOk ? "堆叠 OK" : "堆叠问题")}</b></span>
      <span><b>${escapeHtml(selectionText)}</b></span>
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
  if (value === "heuristic_ai") return "简单规则 AI";
  if (value === "rules_ai") return "复杂规则 AI";
  if (value === "external_ai") return "模型指挥官 AI";
  return "玩家";
}

function aiModeLabel(value) {
  if (value === "heuristic") return "简单规则";
  if (value === "rules") return "复杂规则";
  if (value === "external") return "模型指挥官";
  return "简单规则";
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
  const side = phaseSide(state.phase) || state.active_side;
  const controller = playerController(side);
  const controlled = isPlayableSide(side) && isAiController(controller);
  const board = document.querySelector(".ai-control-board");
  if (board) {
    board.className = [
      "ai-control-board",
      state.phase === "end_game_turn" ? "end" : "",
      controlled ? "controlled" : "human",
      controlled && state.ai_autoplay ? "auto" : "paused"
    ].filter(Boolean).join(" ");
  }
  const status = el("aiControlStatusText");
  const detail = el("aiControlDetailText");
  if (status) {
    status.textContent = state.phase === "end_game_turn"
      ? "回合结束结算"
      : `${sideDisplayName(side)} · ${controlled ? playerControllerLabel(controller) : "玩家"}`;
  }
  if (detail) {
    if (state.phase === "end_game_turn") detail.textContent = "系统会处理补给、孤立、胜负和下一回合。";
    else if (!controlled) detail.textContent = "当前阶段由玩家操作，AI 按钮会收起。";
    else if (state.ai_autoplay) detail.textContent = "AI 正在自动执行合法行动，会在需要玩家时停下。";
    else detail.textContent = "AI 已暂停，可恢复自动推进，或只让它执行当前方一步。";
  }
}

function setupScenarioTurnDefault(scenario) {
  if (scenario === "july") return 7;
  return 1;
}

function setupScenarioPhaseDefault(scenario) {
  if (scenario === "october") return "allies_initial_movement";
  return "axis_initial_movement";
}

function setupScenarioBrief(scenario = "july") {
  const data = {
    july: {
      role: "Axis 先手，战役中段开局",
      vp: "初始胜利点 25",
      note: "轴心国继续东进，盟军固守阿拉曼防线。"
    },
    september: {
      role: "Axis 先手，盟军第 1 回合跳过初始移动",
      vp: "初始胜利点 35",
      note: "轴心国集中突破，盟军依托雷区防守。"
    },
    october: {
      role: "Allies 先手，Axis 后期撤退计分",
      vp: "初始胜利点 -20",
      note: "盟军全面进攻，轴心国坚守并组织撤退。"
    }
  };
  return data[scenario] || data.july;
}

function renderSetupScenarioCard() {
  const target = el("setupScenarioCard");
  if (!target) return;
  const scenario = el("setupScenarioSelect")?.value || "july";
  const turn = Number(el("setupTurnInput")?.value || setupScenarioTurnDefault(scenario));
  const phase = el("setupPhaseSelect")?.value || setupScenarioPhaseDefault(scenario);
  const brief = setupScenarioBrief(scenario);
  target.innerHTML = `
    <div class="setup-scenario-head">
      <span>战役概览</span>
      <strong>${escapeHtml(scenarioDisplayName(scenario))}</strong>
      <small>${escapeHtml(brief.note)}</small>
    </div>
    <div class="setup-scenario-facts">
      <span><b>开局</b>${escapeHtml(brief.role)}</span>
      <span><b>胜利点</b>${escapeHtml(brief.vp)}</span>
      <span><b>开始</b>T${escapeHtml(turn)} · ${escapeHtml(phaseDisplayName(phase))}</span>
    </div>
  `;
}

function showSetupScreen() {
  setupMode = "home";
  syncSetupControls();
  el("setupScreen")?.classList.remove("hidden");
}

function hideSetupScreen() {
  el("setupScreen")?.classList.add("hidden");
}

function renderSetupHero() {
  const home = setupMode === "home";
  if (el("setupHeroTitle")) el("setupHeroTitle").textContent = home ? "Alamein" : "开局配置";
  if (el("setupHeroSubtitle")) {
    el("setupHeroSubtitle").textContent = home
      ? "North African Campaign"
      : "战役、阶段、双方角色";
  }
}

function openSetupScenario(scenario) {
  const select = el("setupScenarioSelect");
  if (!select || !SCENARIO_URLS[scenario]) return;
  select.value = scenario;
  if (el("setupTurnInput")) el("setupTurnInput").value = setupScenarioTurnDefault(scenario);
  if (el("setupPhaseSelect")) el("setupPhaseSelect").value = setupScenarioPhaseDefault(scenario);
  setSetupMode("new");
  renderSetupSummary();
}

function scheduleGameMapPreload() {
  if (gameMapPreloadScheduled) return;
  gameMapPreloadScheduled = true;
  const preload = () => {
    const image = el("mapImage");
    if (!image) return;
    image.loading = "eager";
    image.decode?.().catch(() => {});
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(preload, { timeout: 1200 });
  else setTimeout(preload, 80);
}

function setSetupMode(mode) {
  setupMode = mode === "new" ? "new" : "home";
  el("setupHomePanel")?.classList.toggle("hidden", setupMode !== "home");
  el("setupNewGamePanel")?.classList.toggle("hidden", setupMode !== "new");
  renderSetupHero();
  if (setupMode === "new") scheduleGameMapPreload();
}

function syncSetupControls() {
  setSetupMode(setupMode);
  renderSetupLatestSave();
  if (el("setupScenarioSelect")) el("setupScenarioSelect").value = state.scenario || el("scenarioSelect")?.value || "july";
  if (el("setupTurnInput")) el("setupTurnInput").value = state.turn || setupScenarioTurnDefault(el("setupScenarioSelect")?.value || "july");
  if (el("setupPhaseSelect")) el("setupPhaseSelect").value = state.phase || setupScenarioPhaseDefault(el("setupScenarioSelect")?.value || "july");
  if (el("setupAxisRoleSelect")) el("setupAxisRoleSelect").value = state.player_control?.axis || "human";
  if (el("setupAlliesRoleSelect")) el("setupAlliesRoleSelect").value = state.player_control?.allies || "human";
  if (el("setupAiTargetInput")) el("setupAiTargetInput").value = el("aiTargetInput")?.value || fixedAiTarget(state.active_side || "axis");
  renderSetupScenarioCard();
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
  const auto = isAiController(axis) || isAiController(allies);
  renderSetupScenarioCard();
  target.innerHTML = `
    <div><span>战役</span><b>${escapeHtml(scenarioDisplayName(scenario))}</b></div>
    <div><span>回合 / 阶段</span><b>T${turn} · ${phaseDisplayName(phase)}</b></div>
    <div><span>Axis</span><b>${playerControllerLabel(axis)}</b></div>
    <div><span>Allies</span><b>${playerControllerLabel(allies)}</b></div>
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
  if (el("aiTargetInput") && el("setupAiTargetInput")) el("aiTargetInput").value = el("setupAiTargetInput").value;
  syncAiAutoControls();
}

async function startFromSetup() {
  const startButton = el("setupStartBtn");
  if (startButton?.disabled) return;
  const originalLabel = startButton?.textContent || "开始游戏";
  if (startButton) {
    startButton.disabled = true;
    startButton.textContent = "正在进入...";
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const scenario = el("setupScenarioSelect")?.value || "july";
  try {
    const nextState = await loadJson(SCENARIO_URLS[scenario] || SCENARIO_URLS.july, FALLBACK_STATE);
    applyStateDefaults(nextState);
    applySetupOptionsToState();
    logEvent("setup", `开局配置：${scenarioDisplayName(scenario)} T${state.turn} ${phaseDisplayName(state.phase)}`, { scenario, player_control: state.player_control, ai_autoplay: state.ai_autoplay });
    persistCurrentGameSlot({
      id: `slot-${Date.now()}`,
      name: autoSaveSlotName(),
      autoSave: true,
      render: false
    });
    if (el("scenarioSelect")) el("scenarioSelect").value = state.scenario || scenario;
    gameUiReady = true;
    applyZoom();
    renderState();
    renderDataOutput();
    renderSaveSlots({ renderGameUi: false });
    renderAutoJudge();
    hideSetupScreen();
    focusOpeningView({ phaseTab: true });
    scheduleAiAutoplay();
  }
  finally {
    if (startButton) {
      startButton.disabled = false;
      startButton.textContent = originalLabel;
    }
  }
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
  if (!saveSlotsCache) saveSlotsCache = readLocalJson(SAVE_SLOTS_STORAGE_KEY, []);
  return saveSlotsCache;
}

function writeSaveSlots(slots) {
  saveSlotsCache = slots.slice(0, MAX_SAVE_SLOTS);
  writeLocalJson(SAVE_SLOTS_STORAGE_KEY, saveSlotsCache);
}

function autoSaveSlotName() {
  return `${scenarioShortName(state.scenario)} 自动存档`;
}

function buildSaveSlot(id, name, options = {}) {
  const previous = options.previous || {};
  const savedAt = new Date().toISOString();
  return {
    ...previous,
    id,
    name,
    auto_save: options.autoSave == null ? !!previous.auto_save : !!options.autoSave,
    created_at: previous.created_at || savedAt,
    saved_at: savedAt,
    scenario: state.scenario || "custom",
    turn: Number(state.turn || 1),
    phase: state.phase,
    state: structuredClone(state)
  };
}

function persistCurrentGameSlot(options = {}) {
  const slots = saveSlots();
  const id = options.id || activeSaveSlotId || `slot-${Date.now()}`;
  const previous = slots.find((item) => item.id === id);
  const name = options.name || previous?.name || currentSaveSlotName();
  const slot = buildSaveSlot(id, name, { previous, autoSave: !!options.autoSave });
  const next = [slot, ...slots.filter((item) => item.id !== id)];
  writeSaveSlots(next);
  activeSaveSlotId = id;
  if (options.render !== false) {
    renderSaveSlots();
    if (el("saveSlotSelect")) el("saveSlotSelect").value = id;
  }
  if (options.outputId) setOutput(options.outputId, { saved: slotLabel(slot), slots: next.length });
  return { slot, slots: next };
}

function saveCurrentGameOnExit() {
  if (!activeSaveSlotId) return;
  try {
    persistCurrentGameSlot({ id: activeSaveSlotId, render: false });
  }
  catch (error) {
    console.warn("Auto save on exit failed", error);
  }
}

function slotLabel(slot) {
  if (!slot) return "";
  const when = slot.saved_at ? new Date(slot.saved_at).toLocaleString() : "";
  const title = slot.name || `${scenarioDisplayName(slot.scenario)} Turn ${slot.turn || 1}`;
  return `${title} · ${scenarioDisplayName(slot.scenario)} T${slot.turn || 1} · ${phaseDisplayName(slot.phase)}${when ? ` · ${when}` : ""}`;
}

function latestSaveSummary() {
  const latest = saveSlots()[0];
  if (!latest) return "暂无本地存档，进入游戏后可在设置里保存。";
  const when = latest.saved_at ? new Date(latest.saved_at).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  const title = latest.name || `${scenarioShortName(latest.scenario)} Turn ${latest.turn || 1}`;
  return `最近：${title} · ${scenarioDisplayName(latest.scenario)} · T${latest.turn || 1} · ${phaseShortLabel(latest.phase)}${when ? ` · ${when}` : ""}`;
}

function renderSetupLatestSave() {
  const target = el("setupLatestSaveText");
  const button = el("setupModeLoadBtn");
  const hasSaves = saveSlots().length > 0;
  if (target) target.textContent = latestSaveSummary();
  if (button) {
    button.disabled = !hasSaves;
    button.classList.toggle("disabled", !hasSaves);
    button.title = hasSaves ? "读取最近保存的局面" : "暂无可加载的本地存档";
  }
}

function renderSettingsLatestSave() {
  const target = el("settingsLatestSave");
  if (!target) return;
  const latest = saveSlots()[0];
  target.className = `latest-save-card ${latest ? "" : "empty"}`;
  if (!latest) {
    target.innerHTML = `
      <span>最近存档</span>
      <b>暂无本地存档</b>
      <small>保存当前局面后，这里会显示最近一次保存。</small>
    `;
    return;
  }
  const when = latest.saved_at ? new Date(latest.saved_at).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  target.innerHTML = `
    <span>最近存档</span>
    <b>${escapeHtml(latest.name || `${scenarioShortName(latest.scenario)} Turn ${latest.turn || 1}`)}</b>
    <small>${escapeHtml(scenarioDisplayName(latest.scenario))} · T${escapeHtml(latest.turn || 1)} · ${escapeHtml(phaseDisplayName(latest.phase))}${when ? ` · ${escapeHtml(when)}` : ""}</small>
    <button id="loadLatestSlotBtn" type="button" class="secondary-action">读取最近存档</button>
  `;
}

function renderSettingsCurrentGame() {
  const target = el("settingsCurrentGame");
  if (!target) return;
  const victory = victoryStatusSummary();
  const latest = saveSlots()[0];
  const latestText = latest
    ? `${latest.name || scenarioShortName(latest.scenario)} · T${latest.turn || 1} · ${phaseShortLabel(latest.phase)}`
    : "暂无本地存档";
  const aiText = anySideAiControlled()
    ? (state.ai_autoplay ? "AI 自动推进已开启" : "AI 已配置但暂停")
    : "双方由玩家操作";
  target.innerHTML = `
    <div class="settings-current-main">
      <span>当前局面</span>
      <strong>${escapeHtml(scenarioDisplayName(state.scenario))}</strong>
      <small>T${escapeHtml(state.turn || 1)} · ${escapeHtml(phaseDisplayName(state.phase))} · ${escapeHtml(aiText)}</small>
    </div>
    <div class="settings-current-facts">
      <span><b>VP ${escapeHtml(victory.vp)}</b>${escapeHtml(victory.level)}</span>
      <span><b>终局</b>T${escapeHtml(victory.finalTurn)}</span>
      <span><b>最近存档</b>${escapeHtml(latestText)}</span>
    </div>
  `;
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

function renderSaveSlots(options = {}) {
  renderSaveSlotSelect("saveSlotSelect", "新存档槽");
  renderSaveSlotSelect("setupSaveSlotSelect", "选择一个存档");
  if (activeSaveSlotId && el("saveSlotSelect") && saveSlots().some((slot) => slot.id === activeSaveSlotId)) {
    el("saveSlotSelect").value = activeSaveSlotId;
  }
  renderSetupLatestSave();
  if (options.renderGameUi ?? gameUiReady) {
    renderSettingsLatestSave();
    renderSettingsCurrentGame();
    renderActionControls();
  }
}

function currentSaveSlotName() {
  return el("saveSlotNameInput")?.value.trim() || `${scenarioShortName(state.scenario)} Turn ${state.turn || 1} ${phaseDisplayName(state.phase)}`;
}

function saveCurrentSlot() {
  const selectedId = el("saveSlotSelect")?.value;
  const id = selectedId || `slot-${Date.now()}`;
  logEvent("save", `保存局面到槽位：${currentSaveSlotName()}`, { slot_id: id });
  persistCurrentGameSlot({ id, name: currentSaveSlotName(), outputId: "saveOutput" });
}

function loadSlotById(id, options = {}) {
  const slot = saveSlots().find((item) => item.id === id);
  if (!slot) {
    setOutput(options.outputId || "saveOutput", { legal: false, reason: "请选择一个存档槽" });
    return;
  }
  applyStateDefaults(structuredClone(slot.state));
  gameUiReady = true;
  activeSaveSlotId = slot.id;
  logEvent("load", `读取存档槽位：${slot.name || slot.id}`, { slot_id: slot.id, saved_at: slot.saved_at });
  if (el("scenarioSelect")) el("scenarioSelect").value = state.scenario || "july";
  renderState();
  renderDataOutput();
  renderAutoJudge();
  syncSetupControls();
  if (options.hideSetup) hideSetupScreen();
  focusOpeningView({ phaseTab: true, expandPanel: !!options.hideSetup });
  setOutput(options.outputId || "saveOutput", { loaded: slotLabel(slot) });
  scheduleAiAutoplay();
}

function loadSelectedSlot() {
  loadSlotById(el("saveSlotSelect")?.value, { outputId: "saveOutput" });
}

function loadLatestSlot() {
  const latest = saveSlots()[0];
  loadSlotById(latest?.id, { outputId: "saveOutput" });
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
  if (activeSaveSlotId === id) activeSaveSlotId = null;
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
    title.textContent = `${hex}: ZOC ${[...sides].map(sideDisplayName).join(", ")}`;
    polygon.append(title);
    svg.append(polygon);
  }
}

function drawReachableHexes(svg) {
  const unit = selectedUnitId ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  if (!unit || !isMovableUnit(unit) || !canMoveInCurrentPhase(unit, moveOptions()) || unit.state !== "fresh") return;
  const reachable = reachableHexes(selectedUnitId, moveOptions());
  const showCostLabels = reachable.size <= 72;
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
    if (showCostLabels) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "g");
      label.setAttribute("class", "reachable-cost-label");
      label.setAttribute("transform", `translate(${x} ${y - 18})`);
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", -15);
      rect.setAttribute("y", -9);
      rect.setAttribute("width", 30);
      rect.setAttribute("height", 18);
      rect.setAttribute("rx", 9);
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("y", 1);
      text.textContent = `${info.cost}`;
      label.append(rect, text);
      svg.append(label);
    }
  }
}

function drawCombatTargets(svg) {
  const unit = selectedUnitId ? { id: selectedUnitId, ...state.units[selectedUnitId] } : null;
  if (!unit || !isCombatUnit(unit) || unit.side !== state.active_side || phaseKind() !== "combat") return;
  const enemyByHex = unitsByHex(enemyUnits(unit.side));
  const targetPairs = new Map(combatTargetOptionsForSelectedUnit().map((pair) => [pair.defender_hex, pair]));
  for (const hex of neighbors(unit.hex)) {
    if (!enemyByHex[hex]) continue;
    const { x, y } = hexToPoint(hex);
    if (!isInsideMapZone(x, y)) continue;
    const pair = targetPairs.get(hex);
    const preview = pair ? combatTargetPreview(pair) : null;
    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    polygon.setAttribute("points", hexPolygonPoints(x, y));
    polygon.setAttribute("class", `combat-target-hex ${selectedCombatDefenderHex === hex ? "selected" : ""} ${preview?.legal === false ? "blocked" : ""}`);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${hex}: ${preview?.legal === false ? preview.reason : `可攻击 ${enemyByHex[hex].map((u) => u.name || u.id).join(", ")}`}`;
    polygon.append(title);
    svg.append(polygon);
    if (preview) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "g");
      label.setAttribute("class", `combat-odds-label ${preview.legal ? "" : "blocked"}`);
      label.setAttribute("transform", `translate(${x} ${y - 18})`);
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", -22);
      rect.setAttribute("y", -10);
      rect.setAttribute("width", 44);
      rect.setAttribute("height", 20);
      rect.setAttribute("rx", 10);
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("y", 1);
      text.textContent = preview.legal ? (preview.column || "?") : "阻止";
      label.append(rect, text);
      svg.append(label);
    }
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
  if (el("moveTargetInput")) el("moveTargetInput").value = hx;
  const autoPath = findLegalPath(selectedUnitId, hx, moveOptions());
  if (autoPath) {
    movePathDraft = autoPath;
    syncMovePathInput();
    renderRouteStatus();
    renderActionControls();
    renderMap();
    switchTab("move", { expandPanel: true });
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
  renderActionControls();
  renderMap();
  switchTab("move", { expandPanel: true });
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
          selectCombatTarget(hex, selectedUnitId);
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
  renderMapLegend();
  syncLayerCountBadge();
  const showTerrain = el("showTerrainToggle").checked || viewMode === "terrain" || viewMode === "all";
  const showUnits = el("showUnitsToggle").checked;
  const showMarkers = el("showMarkersToggle").checked;
  const showMines = el("showMinesToggle").checked;
  const showZoc = el("showZocToggle").checked || viewMode === "zoc" || viewMode === "all";
  const expandStacks = el("expandStacksToggle").checked;
  const showHex = el("showHexToggle").checked || viewMode === "terrain";
  const selectedForMove = selectedUnitId && state.units?.[selectedUnitId]
    ? { id: selectedUnitId, ...state.units[selectedUnitId] }
    : null;
  const actionableUnitIds = new Set(actionableUnitsForCurrentPhase().map((unit) => unit.id));
  const focusUnitsOnMap = viewMode === "move" || viewMode === "combat";

  if (showTerrain) {
    for (const [hex, tags] of Object.entries(terrain.hexes || {})) {
      const { x, y } = hexToPoint(hex);
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", hexPolygonPoints(x, y));
      polygon.setAttribute("class", `terrain-hex ${terrainClass(tags)}`);
      polygon.append(document.createElementNS("http://www.w3.org/2000/svg", "title"));
      polygon.querySelector("title").textContent = `${hex}: ${terrainSummaryLabel(tags)}`;
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
      text.textContent = "雷区";
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${hex}: ${mines.map((mine) => `${sideDisplayName(mine.side)} ${mine.name || mine.id}`).join("; ")}`;
      group.append(polygon, text, title);
      svg.append(group);
    }
  }

  if (showZoc) drawZoc(svg);
  const showReachable = el("showReachableToggle")?.checked || (viewMode === "move" && !!selectedForMove && canMoveUnitNow(selectedForMove));
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
        const actionable = actionableUnitIds.has(unit.id);
        const muted = focusUnitsOnMap && isPlayableSide(unit.side) && !actionable && unit.id !== selectedUnitId;
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("class", `unit-marker ${unit.side} ${marker ? "marker" : "counter"} ${unit.id === selectedUnitId ? "selected" : ""} ${actionable ? "actionable" : ""} ${muted ? "phase-muted" : ""}`);
        g.setAttribute("data-unit-id", unit.id);
        g.setAttribute("transform", `translate(${unitX} ${unitY})`);
        g.addEventListener("click", (event) => {
          event.stopPropagation();
          selectUnit(unit.id, { showStateTab: phaseKind() !== "combat" });
          if (phaseKind() === "combat" && isCombatUnit(unit) && unit.side === state.active_side) {
            switchTab("combat", { expandPanel: true });
            el("combatAttackersInput").value = unit.id;
            renderActionControls();
          }
        });
        const imagePath = counterImageFor(unit);
        if (isPlayableSide(unit.side)) {
          const frame = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          frame.setAttribute("class", "unit-side-frame");
          frame.setAttribute("x", -3);
          frame.setAttribute("y", -3);
          frame.setAttribute("width", size + 6);
          frame.setAttribute("height", size + 6);
          frame.setAttribute("rx", 3);
          g.append(frame);
        }
        const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
        image.setAttribute("href", imagePath);
        image.setAttribute("width", size);
        image.setAttribute("height", size);
        image.setAttribute("preserveAspectRatio", "xMidYMid meet");
        g.append(image);
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = `${unit.name || unit.id} ${sideDisplayName(unit.side)} ${hex}`;
        g.append(title);
        svg.append(g);
      });
    }
  }
  renderMapActionHint();
}

function renderState() {
  renderTurnBanner();
  renderSideCommandBar();
  syncPhaseRecommendedTab();
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
  renderStateBrief({ unsupplied, stacking });
  renderSettingsCurrentGame();
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
  renderSelectionSummary();
  renderSelectedUnit();
  renderSelectedHex();
  renderMapSelectionHud();
  renderOperationHint();
  renderActionableUnits();
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
    const activeSideRoster = side === state.active_side || (side === "neutral" && !isPlayableSide(state.active_side));
    const sideSection = document.createElement("details");
    sideSection.className = `unit-side-section ${side}`;
    sideSection.open = !!filter || activeSideRoster;
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
      typeSection.open = !!filter || activeSideRoster;
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
    const supply = isPlayableSide(unit.side) && (isCombatUnit(unit) || isSupplyUnit(unit) || isEngineer(unit))
      ? supplyStateLabel(supplyState(unit.id))
      : unitTypeGroup(unit).label;
    card.className = `unit-card ${unit.side} ${unit.id === selectedUnitId ? "selected" : ""}`;
    card.innerHTML = `
      <div class="unit-title">
        <span>${unit.name || unit.id}</span>
        <span>${unitTypeGroup(unit).label} ${unit.hex || ""}</span>
      </div>
      <div class="unit-meta readonly">
        <span><b>ID</b>${escapeHtml(unit.id)}</span>
        <span><b>坐标</b>${escapeHtml(unit.hex || "未部署")}</span>
        <span><b>A/D</b>${escapeHtml(unit.attack ?? 0)}/${escapeHtml(unit.defense ?? unit.attack ?? 0)}</span>
        <span><b>MP</b>${escapeHtml(unit.movement ?? 0)}</span>
        <span><b>补给</b>${escapeHtml(supply)}</span>
      </div>
    `;
    card.addEventListener("click", (event) => {
      selectUnit(unit.id);
    });
    return card;
}

function filterRulebook() {
  const input = el("ruleSearch");
  const status = el("ruleSearchStatus");
  if (!input) return;
  const query = input.value.trim().toLowerCase();
  const sections = [...document.querySelectorAll("#tab-rulebook .rule-section")];
  let visible = 0;
  for (const section of sections) {
    const text = section.textContent.toLowerCase();
    const matched = !query || text.includes(query);
    section.classList.toggle("hidden", !matched);
    if (matched) visible += 1;
    if (query && matched) section.open = true;
    else if (!query) section.open = section.matches("#tab-rulebook .rule-section:nth-of-type(-n + 2)");
  }
  if (status) status.textContent = query ? `${visible} / ${sections.length} 条` : "全部规则";
}

function setRulebookOpen(open) {
  document.querySelectorAll("#tab-rulebook .rule-section:not(.hidden)").forEach((section) => {
    section.open = !!open;
  });
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
        <div class="unit-title"><span>${unit.name || unit.id}</span><span>${sideDisplayName(unit.side)} ${unit.hex}</span></div>
        <div class="unit-subtitle">${unit.id}</div>
        <div class="unit-meta">
          <label>战力 <input data-unit="${unit.id}" data-field="attack" type="number" value="${unit.attack || 0}"></label>
          <label>防御 <input data-unit="${unit.id}" data-field="defense" type="number" value="${unit.defense ?? unit.attack ?? 0}"></label>
          <label>移动 <input data-unit="${unit.id}" data-field="movement" type="number" value="${unit.movement || 0}"></label>
          <label>状态
            <select data-unit="${unit.id}" data-field="stats_status">
              <option value="needs_manual_review" ${pending ? "selected" : ""}>待确认</option>
              <option value="from_name" ${unit.stats_status === "from_name" ? "selected" : ""}>来自名称</option>
              <option value="verified" ${unit.stats_status === "verified" ? "selected" : ""}>已确认</option>
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
  const target = el("dataOutput");
  if (!target) return;
  const terrainTagCount = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const edgeTagCount = Object.values(edgeCounts).reduce((sum, value) => sum + value, 0);
  target.innerHTML = `
    <div><span>地形标签</span><b>${escapeHtml(terrainTagCount)}</b><small>${escapeHtml(Object.keys(counts).length)} 类</small></div>
    <div><span>边标签</span><b>${escapeHtml(edgeTagCount)}</b><small>${escapeHtml(Object.keys(edgeCounts).length)} 类</small></div>
    <div><span>单位</span><b>${escapeHtml(Object.keys(state.units || {}).length)}</b><small>${escapeHtml(scenarioShortName(state.scenario))}</small></div>
    <div><span>地图校准</span><b>${escapeHtml(Math.round(Number(settings.zoom) || 0))}%</b><small>${escapeHtml(settings.unitSize)}px 单位</small></div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function feedbackTone(value) {
  if (feedbackNeedsAttention(value)) return "bad";
  if (value && typeof value === "object" && value.legal !== false) return "ok";
  return "idle";
}

function feedbackSummaryText(value) {
  if (feedbackNeedsAttention(value)) return "裁判反馈：需要处理";
  if (value && typeof value === "object" && value.legal !== false) return "裁判反馈：可执行";
  if (typeof value === "string" && value.trim()) return "裁判反馈：提示";
  return "裁判反馈";
}

function formatFeedbackOutput(value) {
  if (typeof value === "string" || !value || typeof value !== "object") {
    const text = String(value ?? "");
    const bad = feedbackNeedsAttention(text);
    return `
      <div class="feedback-card ${bad ? "bad" : "idle"}">
        <div class="feedback-card-head">
          <span>${bad ? "注意" : "提示"}</span>
          <strong>${escapeHtml(text || "暂无裁判反馈")}</strong>
        </div>
      </div>
    `;
  }
  const legal = value.legal !== false;
  const status = legal ? "裁判通过" : "裁判阻止";
  const details = value.details || {};
  const headline = value.reason || value.status || (legal ? "规则允许" : "规则阻止");
  const chips = [];
  if (details.destination) chips.push(["目标", details.destination]);
  if (details.spent != null || details.allowance != null) chips.push(["MP", `${details.spent ?? "?"}/${details.allowance ?? "?"}`]);
  if (details.mode) chips.push(["模式", details.mode === "road" ? "道路" : "普通"]);
  if (details.odds_column) chips.push(["赔率", details.odds_column]);
  if (details.die) chips.push(["骰子", details.die]);
  if (details.outcome) chips.push(["结果", details.outcome]);
  const lines = [];
  if (details.spent != null || details.allowance != null) lines.push(["移动力", `${details.spent ?? "?"} / ${details.allowance ?? "?"}`]);
  if (details.mode) lines.push(["移动方式", details.mode === "road" ? "道路模式" : "普通"]);
  if (details.attack != null || details.defense != null) lines.push(["战力比", `${details.attack ?? "?"} : ${details.defense ?? "?"}`]);
  if (details.defender_hexes?.length) lines.push(["防御格", details.defender_hexes.join(", ")]);
  if (details.effects?.eliminated?.length) lines.push(["消灭", details.effects.eliminated.join(", ")]);
  if (details.effects?.retreated?.retreated?.length) lines.push(["撤退", details.effects.retreated.retreated.join(", ")]);
  if (details.effects?.advanced) lines.push(["战后推进", `${details.effects.advanced.unit} -> ${details.effects.advanced.to}`]);
  if (details.missing?.length) lines.push(["还需攻击", details.missing.join(", ")]);
  if (value.undone) lines.push(["撤销", value.undone]);
  const body = lines.length
    ? `<dl>${lines.map(([key, val]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(val)}</dd>`).join("")}</dl>`
    : "";
  return `
    <div class="feedback-card ${legal ? "ok" : "bad"}">
      <div class="feedback-card-head">
        <span>${escapeHtml(status)}</span>
        <strong>${escapeHtml(headline)}</strong>
      </div>
      ${chips.length ? `<div class="feedback-chips">${chips.map(([key, val]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(val)}</span>`).join("")}</div>` : ""}
      ${body}
    </div>
  `;
}

function feedbackNeedsAttention(value) {
  if (typeof value === "string") return /不能|阻止|失败|错误|没有|找不到|请先/.test(value);
  if (!value || typeof value !== "object") return false;
  return value.legal === false || !!value.error || value.status === "error";
}

function feedbackPresenceText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value.reason || value.status || value.legal || value.details || value.error || "";
}

function syncWorkflowFeedback(target, value) {
  const shell = target.closest(".workflow-feedback");
  const drawer = target.closest(".feedback-drawer");
  const container = shell || drawer;
  if (!container) return;
  const needsAttention = feedbackNeedsAttention(value);
  const hasFeedback = !!String(feedbackPresenceText(value) ?? "").trim();
  container.classList.toggle("empty", !hasFeedback);
  container.classList.toggle("needs-attention", needsAttention);
  container.classList.toggle("has-feedback", hasFeedback);
  container.classList.toggle("feedback-ok", feedbackTone(value) === "ok");
  const summary = drawer?.querySelector("summary");
  if (summary) summary.textContent = feedbackSummaryText(value);
  if (needsAttention && drawer) drawer.open = true;
}

function formatSaveOutput(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return `<div class="feedback-card idle"><div class="feedback-card-head"><span>提示</span><strong>${escapeHtml(value)}</strong></div></div>`;
  }
  const bad = feedbackNeedsAttention(value);
  let status = bad ? "需要处理" : "已更新";
  let headline = value.reason || value.note || "存档状态已更新";
  const chips = [];
  if (value.saved) {
    status = "已保存";
    headline = value.saved;
  }
  else if (value.loaded) {
    status = "已读取";
    headline = value.loaded;
  }
  else if (value.deleted) {
    status = "已删除";
    headline = value.deleted;
  }
  else if (Array.isArray(value.slots)) {
    status = "存档列表";
    headline = value.slots.length ? `${value.slots.length} 个本地存档` : "暂无本地存档";
  }
  if (value.slots != null && !Array.isArray(value.slots)) chips.push(["槽位", value.slots]);
  if (value.selected_scenario) chips.push(["场景", scenarioDisplayName(value.selected_scenario)]);
  return `
    <div class="feedback-card ${bad ? "bad" : "ok"}">
      <div class="feedback-card-head">
        <span>${escapeHtml(status)}</span>
        <strong>${escapeHtml(headline)}</strong>
      </div>
      ${chips.length ? `<div class="feedback-chips">${chips.map(([key, val]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(val)}</span>`).join("")}</div>` : ""}
    </div>
  `;
}

function aiStatusLabel(status) {
  const labels = {
    thinking: "思考中",
    auto_running: "自动推进",
    auto_paused_at_step_limit: "暂时停顿",
    auto_waiting_for_human: "等待玩家",
    auto_stopped: "已停止",
    final_victory: "最终胜负",
    "AI 已暂停": "AI 已暂停",
    "当前没有 AI 控制方": "没有 AI 方"
  };
  return labels[status] || status || "AI 状态";
}

function actionSummary(action) {
  if (!action || typeof action !== "object") return "";
  if (action.type === "move") return `移动 ${action.unit || "单位"}${action.to ? ` -> ${action.to}` : ""}`;
  if (action.type === "combat") {
    const targets = action.defender_hexes?.length ? action.defender_hexes.join(", ") : action.defender_hex || "目标";
    return `攻击 ${targets}`;
  }
  if (action.type === "exit_west") return `撤出 ${action.unit || "单位"}`;
  if (action.type === "pass") return "跳过当前阶段";
  return action.type ? String(action.type).replaceAll("_", " ") : "";
}

function formatAiOutput(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const bad = feedbackNeedsAttention(value);
    return `<div class="feedback-card ${bad ? "bad" : "idle"}"><div class="feedback-card-head"><span>${bad ? "注意" : "AI"}</span><strong>${escapeHtml(value)}</strong></div></div>`;
  }
  const bad = feedbackNeedsAttention(value);
  let status = value.error ? "AI 受阻" : aiStatusLabel(value.status);
  let headline = value.reason || value.error || value.note || "AI 状态已更新";
  const chips = [];
  const lines = [];
  if (value.side) chips.push(["阵营", sideDisplayName(value.side)]);
  if (value.phase) chips.push(["阶段", phaseLabel(value.phase)]);
  if (value.controller) chips.push(["控制", playerControllerLabel(value.controller)]);
  if (value.mode) chips.push(["模式", aiModeLabel(value.mode)]);
  if (value.step != null) chips.push(["步数", value.step]);
  if (value.max_steps != null) chips.push(["上限", value.max_steps]);
  if (value.applied) {
    const applied = value.applied;
    status = applied.legal === false ? "执行失败" : "已执行";
    headline = applied.reason || actionSummary(applied.action) || "AI 已执行动作";
    if (applied.action) lines.push(["动作", actionSummary(applied.action)]);
  }
  if (value.suggestion?.action) {
    lines.push(["建议", actionSummary(value.suggestion.action)]);
    if (!headline || headline === "AI 状态已更新") headline = actionSummary(value.suggestion.action);
  }
  if (value.action) {
    lines.push(["动作", actionSummary(value.action)]);
    if (!headline || headline === "AI 状态已更新") headline = actionSummary(value.action);
  }
  const aiDetail = value.suggestion || value;
  if (aiDetail?.type === "external") {
    const match = aiDetail.assessment?.candidate_match;
    if (match) {
      const rank = match.exact_candidate ? `#${match.candidate_rank}` : "非候选";
      const score = aiDetail.assessment?.score ?? match.candidate_score;
      const delta = match.score_delta_from_best;
      lines.push(["外部评估", `候选 ${rank}${score != null ? ` · 分数 ${Number(score).toFixed(1)}` : ""}${delta != null ? ` · 差值 ${Number(delta).toFixed(1)}` : ""}`]);
    }
    const reviewRecord = (aiDetail.tool_results || []).find((item) => item.tool === "final_action_review");
    const review = aiDetail.final_review || reviewRecord?.result;
    if (review) {
      const rejected = reviewRecord && reviewRecord.result?.accept === false;
      lines.push(["纠偏", `${rejected ? "已打回一次" : "已检查"} · ${review.accept ? "最终接受" : "最终仍有风险"}`]);
      if (review.issues?.length) lines.push(["纠偏原因", review.issues.join("; ")]);
    }
    if (aiDetail.tool_results?.length) lines.push(["工具", `${aiDetail.tool_results.length} 次调用/检查`]);
  }
  if (value.victory) {
    status = "最终胜负";
    headline = value.victory.level || "场景结束";
    lines.push(["VP", value.victory.victory_points ?? ""]);
  }
  if (Array.isArray(value.log)) {
    const last = value.log[value.log.length - 1];
    lines.push(["记录", `${value.log.length} 条 AI 记录`]);
    if (last) lines.push(["最近", last.error || last.reason || actionSummary(last.action) || last.to || last.phase || "阶段更新"]);
  }
  const body = lines.length
    ? `<dl>${lines.map(([key, val]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(val)}</dd>`).join("")}</dl>`
    : "";
  return `
    <div class="feedback-card ${bad ? "bad" : "ok"} ai-feedback-card">
      <div class="feedback-card-head">
        <span>${escapeHtml(status)}</span>
        <strong>${escapeHtml(headline)}</strong>
      </div>
      ${chips.length ? `<div class="feedback-chips">${chips.map(([key, val]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(val)}</span>`).join("")}</div>` : ""}
      ${body}
    </div>
  `;
}

function setOutput(id, value) {
  const target = el(id);
  if (!target) return;
  if (id === "moveOutput" || id === "combatOutput") {
    target.innerHTML = formatFeedbackOutput(value);
    syncWorkflowFeedback(target, value);
    return;
  }
  if (id === "saveOutput") {
    target.innerHTML = formatSaveOutput(value);
    return;
  }
  if (id === "logOutput") {
    if (!value) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML = formatFeedbackOutput(value);
    return;
  }
  if (id === "aiOutput") {
    target.innerHTML = formatAiOutput(value);
    return;
  }
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
  renderSideCommandBar();
  return entry;
}

function logLine(entry) {
  return `T${entry.turn} ${phaseDisplayName(entry.phase)} [${sideDisplayName(entry.side)}] ${eventTypeLabel(entry.type)}: ${entry.summary}`;
}

function gameLogText() {
  return (state.game_log || []).map(logLine).join("\n");
}

function logEntryFocusTarget(entry = {}) {
  const details = entry.details || {};
  const action = details.action || details.verdict?.action || {};
  const unitId = details.unit || action.unit || action.attackers?.[0] || details.attackers?.[0];
  if (unitId && state.units?.[unitId]?.hex) return { type: "unit", id: unitId, label: "定位单位" };
  const path = details.path || action.path || [];
  const pathHex = Array.isArray(path) && path.length ? path[path.length - 1] : "";
  const defenderHex = details.defender_hex || action.defender_hexes?.[0] || details.defender_hexes?.[0] || details.defender_hex;
  const hex = pathHex || defenderHex || details.destination || details.to || "";
  if (hex && onMap(hex)) return { type: "hex", hex: normalizeHex(hex), label: "定位格" };
  return null;
}

function renderGameLog() {
  const list = el("gameLogList");
  if (!list) return;
  renderLogOverview();
  const entries = (state.game_log || []).slice(-80).reverse();
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `
      <div class="log-empty-state">
        <b>还没有行动记录</b>
        <span>移动、战斗、AI 和阶段推进会自动记录在这里。</span>
      </div>
    `;
    setOutput("logOutput", "");
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("article");
    const focusTarget = logEntryFocusTarget(entry);
    const time = entry.time ? new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    item.className = `game-log-entry ${entry.type || ""}`;
    item.innerHTML = `
      <div class="game-log-meta">
        <b>${escapeHtml(eventTypeLabel(entry.type))}</b>
        <span>T${escapeHtml(entry.turn || state.turn || 1)}</span>
      </div>
      <div class="game-log-body">
        <strong>${escapeHtml(entry.summary || eventTypeLabel(entry.type))}</strong>
        <small>${escapeHtml(sideDisplayName(entry.side))} · ${escapeHtml(phaseDisplayName(entry.phase))}${time ? ` · ${escapeHtml(time)}` : ""}</small>
      </div>
      ${focusTarget ? `<button class="log-focus-button" type="button" data-log-focus-type="${escapeHtml(focusTarget.type)}" data-log-focus-value="${escapeHtml(focusTarget.id || focusTarget.hex)}">${escapeHtml(focusTarget.label)}</button>` : ""}
    `;
    list.append(item);
  }
  setOutput("logOutput", "");
}

function logTypeCounts(entries = []) {
  const counts = {};
  for (const entry of entries) {
    const key = eventTypeLabel(entry.type);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
}

function renderLogOverview() {
  const panel = el("logOverview");
  if (!panel) return;
  const entries = state.game_log || [];
  const latest = entries.at(-1);
  const counts = logTypeCounts(entries);
  const focusTarget = latest ? logEntryFocusTarget(latest) : null;
  panel.className = `log-overview ${entries.length ? "" : "empty"}`;
  panel.innerHTML = `
    <div class="log-overview-main">
      <span>行动历史</span>
      <strong>${escapeHtml(entries.length ? `${entries.length} 条记录` : "暂无记录")}</strong>
      <small>${escapeHtml(entries.length ? `最近：${latest.summary || eventTypeLabel(latest.type)}` : "开始游戏后，移动、战斗、阶段推进都会记录在这里。")}</small>
    </div>
    ${counts.length ? `<div class="log-overview-chips">${counts.map(([key, count]) => `<span><b>${escapeHtml(count)}</b>${escapeHtml(key)}</span>`).join("")}</div>` : ""}
    ${focusTarget ? `<button class="log-focus-button" type="button" data-log-focus-type="${escapeHtml(focusTarget.type)}" data-log-focus-value="${escapeHtml(focusTarget.id || focusTarget.hex)}">${escapeHtml(focusTarget.label)}</button>` : ""}
  `;
}

function handleGameLogClick(event) {
  const button = event.target.closest?.("[data-log-focus-type]");
  if (!button) return;
  const type = button.dataset.logFocusType;
  const value = button.dataset.logFocusValue;
  if (type === "unit" && state.units?.[value]) {
    selectUnit(value, { showStateTab: true });
    focusMapOnHex(state.units[value].hex);
  }
  else if (type === "hex" && value) {
    selectHex(value);
    focusMapOnHex(value);
  }
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
  if (el("zoomValue")) el("zoomValue").textContent = `${Math.round(Number(settings.zoom) || 0)}%`;
}

function syncLayerCountBadge() {
  const badge = el("layerCountBadge");
  if (!badge) return;
  const ids = ["showUnitsToggle", "showMarkersToggle", "expandStacksToggle", "showMinesToggle", "showReachableToggle", "showZocToggle", "showTerrainToggle", "showHexToggle"];
  const count = ids.filter((id) => el(id)?.checked).length;
  badge.textContent = String(count);
  badge.title = `已开启 ${count} 个图层`;
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

function preferredOpeningUnit() {
  const actionable = actionableUnitsForCurrentPhase().filter((unit) => unit.hex && !unit.eliminated);
  if (actionable.length) return actionable[0];
  return unitsArray().find((unit) => unit.side === state.active_side && unit.hex && !unit.eliminated && isMapCounter(unit));
}

function focusOpeningView(options = {}) {
  const unit = preferredOpeningUnit();
  if (unit) {
    selectedUnitId = unit.id;
    selectedHexId = unit.hex || null;
    if (isMovableUnit(unit)) syncMoveDraftToUnit(unit.id);
    if (options.phaseTab !== false) focusCurrentPhaseTab({ expandPanel: !!options.expandPanel });
    renderState();
    setTimeout(() => focusMapOnHex(unit.hex), 40);
    return;
  }
  focusMapOnUnits();
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
  if (full.side === "allies" && !isSupplyUnit(full) && normalizeHex(target) === normalizeHex(full.hex)) return -999;
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

function combatTargetIntelForAi(action) {
  const defenderHexes = (action.defender_hexes || []).map(normalizeHex);
  const attackerSide = state.active_side;
  const defenderSide = enemySide(attackerSide);
  const alamein = rules.game?.alamein_hex || "3711";
  return defenderHexes.map((hex) => {
    const defenders = (unitsByHex()[hex] || [])
      .filter((unit) => unit.side === defenderSide && isCombatUnit(unit))
      .map((unit) => ({
        id: unit.id,
        name: unit.name || unit.id,
        atk: Number(unit.attack || 0),
        def: Number(unit.defense ?? unit.attack ?? 0),
        effective_defense: effectiveDefense(unit, hex),
        supply: aiSupplyStateForAi(unit.id)
      }));
    const terrainTags = hexTags(hex);
    return {
      hex,
      terrain: terrainTags,
      control: state.control?.[hex] || "",
      defenders,
      defender_supply_states: [...new Set(defenders.map((unit) => unit.supply).filter(Boolean))],
      friendly_mines: friendlyMinesAt(defenderSide, hex).map((mine) => mine.id),
      enemy_mines: enemyMinesAt(attackerSide, hex).map((mine) => mine.id),
      terrain_defense_bonus: terrainDefenseBonus(hex),
      is_primary_objective: hex === alamein,
      distance_to_axis_objective: distance(hex, fixedAiTarget("axis")),
      distance_to_allies_objective: distance(hex, fixedAiTarget("allies")),
      retreat_options_estimate: defenders.reduce((sum, defender) => {
        const unit = state.units[defender.id];
        if (!unit) return sum;
        return sum + neighbors(hex).filter((nb) => legalRetreatHex({ ...unit, id: defender.id }, nb, attackerSide)).length;
      }, 0)
    };
  });
}

function combatStrategicValue(action) {
  if (!action || action.type !== "combat") return 0;
  const details = action.verdict?.details || {};
  const stats = combatOutcomeStats(details.crt_column || {});
  const targetIntel = combatTargetIntelForAi(action);
  const objectiveBonus = targetIntel.some((target) => target.is_primary_objective) ? 28 : 0;
  const terrainBonus = targetIntel.some((target) => target.terrain.includes("alamein_box")) ? 12 : 0;
  const supplyTargetBonus = targetIntel.reduce((sum, target) => (
    sum + target.defenders.filter((defender) => /supply/i.test(defender.name)).length * 18
  ), 0);
  const blockedRetreatBonus = targetIntel.some((target) => target.retreat_options_estimate <= target.defenders.length) ? 16 : 0;
  const defenderStrength = Number(details.defense || 0);
  const attackerStrength = Number(details.attack || 0);
  return stats.defender_harm * 9 + stats.defender_eliminated * 8 - stats.attacker_harm * 7
    + objectiveBonus + terrainBonus + supplyTargetBonus + blockedRetreatBonus
    + Math.max(0, attackerStrength - defenderStrength) * 1.5;
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
    const awayPenalty = after > before ? (after - before) * 16 : 0;
    const alamein = fixedAiTarget("allies");
    const abandonsBoxPenalty = distance(start, alamein) <= 4 && distance(destination, alamein) > distance(start, alamein) ? 10 : 0;
    return (before - after) * 8 - awayPenalty - abandonsBoxPenalty - Math.max(0, hexColumn(destination) - 38) * 2;
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
    const stats = combatOutcomeStats(details.crt_column);
    const strategic = combatStrategicValue(action);
    const badOddsPenalty = oddsIndex >= 0 && oddsIndex < 3 ? (3 - oddsIndex) * 20 : 0;
    const exchangeRisk = stats.exchange + stats.attacker_harm;
    return 110 + oddsIndex * 14 + crtScore * 10 + strategic - exchangeRisk * 5 - badOddsPenalty + Number(details.attack || 0) - Number(details.defense || 0);
  }
  if (action.type === "move") {
    const unit = state.units[action.unit];
    if (!unit) return -10000;
    const full = { id: action.unit, ...unit };
    const start = normalizeHex(unit.hex);
    const destination = normalizeHex(action.path[action.path.length - 1]);
    const target = rulesAiMoveTarget(unit);
    const progress = distance(start, target) - distance(destination, target);
    const direction = rulesAiDirectionScore(unit, start, destination);
    const targetDistance = distance(destination, target);
    const zocSources = enemyZocSources(unit.side, destination);
    const mineCount = enemyMinesAt(unit.side, destination).length;
    const adjacentEnemyStrength = enemyUnits(unit.side)
      .filter((enemy) => enemy.hex && distance(destination, enemy.hex) <= 1)
      .reduce((sum, enemy) => sum + Number(enemy.attack || enemy.defense || 0), 0);
    const defense = Math.max(1, Number(unit.defense ?? unit.attack ?? 1));
    const zocPenalty = zocSources.size ? 10 + zocSources.size * 6 : 0;
    const minePenalty = mineCount ? (isEngineer(full) ? 6 : 26 + mineCount * 4) : 0;
    const overmatchPenalty = zocSources.size ? Math.max(0, adjacentEnemyStrength - defense) * 3 : 0;
    const fragileContactPenalty = zocSources.size && defense <= 1 ? 12 : 0;
    const supply = aiScoreSupplyState(action.unit);
    const supplyPenalty = supply === "isolated" ? 20 : supply === "unsupplied" ? 8 : supply === "partially_supplied" ? 3 : 0;
    const roadBonus = action.mode === "road" && !zocSources.size ? (isSupplyUnit(unit) ? 8 : 2) : 0;
    const terrainBonus = hexTags(destination).includes("hill_or_ridge") ? 2 : hexTags(destination).includes("alamein_box") ? 3 : 0;
    const spentPenalty = Number(action.verdict?.details?.spent || 0) * 0.25;
    const strength = Number(unit.attack || 0) + Number(unit.movement || 0) * 0.2;
    const usefulProgress = Math.max(0, progress);
    const progressScore = Math.min(usefulProgress, 8) * (unit.side === "axis" ? 18 : isSupplyUnit(unit) ? 12 : 8)
      + Math.max(0, usefulProgress - 8) * (unit.side === "axis" ? 6 : 3);
    const negativeProgressPenalty = unit.side !== "axis" && !isSupplyUnit(unit) && progress < 0 ? Math.abs(progress) * 12 : 0;
    const farFromTargetPenalty = unit.side === "axis" || isSupplyUnit(unit)
      ? targetDistance * 2
      : Math.max(0, targetDistance - 2);
    const turnsRemaining = Math.max(0, scenarioFinalTurnForAi() - Number(state.turn || 1) + 1);
    const finalThreatBonus = turnsRemaining <= 1 && unit.side === "axis"
      ? targetDistance <= 2 ? 45 : targetDistance <= 4 ? 20 : targetDistance <= 6 ? 6 : -12
      : targetDistance <= 2 ? 12 : targetDistance <= 4 ? 5 : 0;
    const formationPenalty = isSupplyUnit(unit) && zocSources.size ? 40 : 0;
    const interceptionBonus = unit.side !== "axis" && !isSupplyUnit(unit) && progress > 0
      ? 14 + Math.min(progress, 3) * 6
      : 0;
    return progressScore + direction + finalThreatBonus + interceptionBonus - negativeProgressPenalty - farFromTargetPenalty - zocPenalty - minePenalty - overmatchPenalty - fragileContactPenalty - supplyPenalty - formationPenalty - spentPenalty + roadBonus + terrainBonus + strength;
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
      action: best || { type: "pass", reason: "复杂规则 AI 没有找到值得执行的合法动作" },
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

function resolveMoveIntent(rawAction = {}) {
  const intent = rawAction?.action || rawAction;
  const unitId = intent?.unit;
  const destination = intent?.destination || intent?.target || intent?.hex;
  if (!unitId || !destination) return { legal: false, reason: "move_intent 需要 unit 和 destination", action: intent };
  let target;
  try {
    target = normalizeHex(destination);
  }
  catch (error) {
    return { legal: false, reason: error.message, action: intent };
  }
  const modes = intent.mode && intent.mode !== "auto" ? [intent.mode] : ["normal", "road"];
  const plans = [];
  for (const mode of modes) {
    const path = findLegalPath(unitId, target, { mode });
    if (!path || path.length <= 1) continue;
    const verdict = checkMove(unitId, path, { mode });
    if (!verdict.legal) continue;
    const action = {
      type: "move",
      unit: unitId,
      path,
      mode,
      destination: target,
      spent: verdict.details?.spent,
      verdict
    };
    plans.push({ action, verdict, score: rulesAiScore(action) });
  }
  plans.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const best = plans[0];
  if (!best) return { legal: false, reason: `找不到 ${unitId} 到 ${target} 的合法路径`, action: intent };
  return {
    legal: true,
    reason: `move_intent 已规划为 ${best.action.mode} 路径`,
    details: best.verdict.details,
    action: best.action,
    verdict: best.verdict,
    planned_from_intent: { unit: unitId, destination: target, requested_mode: intent.mode || "auto" },
    plan_score: best.score
  };
}

function normalizeAiAction(raw) {
  const action = raw?.action || raw;
  if (!action || typeof action !== "object") return { type: "pass", reason: "空动作" };
  if (action.type === "exit_west") return { type: "exit_west", unit: action.unit };
  if (action.type === "move_intent") return { type: "move_intent", unit: action.unit, destination: action.destination || action.target || action.hex, mode: action.mode || "auto" };
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
  if (action.type === "move_intent") return resolveMoveIntent(action);
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
    { name: "list_legal_actions", arguments: { limit: "number" }, returns: "scored actions with evaluation summaries, risks, and tactical tags" },
    { name: "check_move", arguments: { unit: "string", path: ["hex"], mode: "normal|road" } },
    { name: "find_path", arguments: { unit: "string", target: "hex", mode: "normal|road" } },
    { name: "check_combat", arguments: { attackers: ["unit-id"], defender_hexes: ["hex"] } },
    { name: "inspect_unit", arguments: { unit: "unit-id" } },
    { name: "inspect_hex", arguments: { hex: "hex" } },
    { name: "trace_supply", arguments: { unit: "unit-id" } },
    { name: "evaluate_action", arguments: { action: { type: "move_intent|move|combat|exit_west|pass" } }, returns: "front-end legality plus score, planned route for move_intent, candidate rank, evaluation, risks, and tactical tags" }
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
      supply_state: isPlayableSide(unit.side) ? aiSupplyStateForAi(unitId) : "",
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
    supply_state: isPlayableSide(unit.side) ? aiSupplyStateForAi(unitId) : "",
    path,
    blocked: path.length ? [] : [...supplyBlockedHexes(unit.side)].slice(0, 80)
  };
}

function sameAiAction(a, b) {
  let left;
  let right;
  try {
    left = normalizeAiAction(a);
    right = normalizeAiAction(b);
  }
  catch {
    return false;
  }
  if (left.type !== right.type) return false;
  if (left.type === "pass") return true;
  if (left.type === "exit_west") return left.unit === right.unit;
  if (left.type === "move") {
    return left.unit === right.unit &&
      (left.mode || "normal") === (right.mode || "normal") &&
      (left.path || []).join("-") === (right.path || []).join("-");
  }
  if (left.type === "combat") {
    return [...(left.attackers || [])].sort().join(",") === [...(right.attackers || [])].sort().join(",") &&
      [...(left.defender_hexes || [])].sort().join(",") === [...(right.defender_hexes || [])].sort().join(",") &&
      !!left.no_retreat_order === !!right.no_retreat_order;
  }
  return false;
}

function actionWithVerdictForAi(validation) {
  const action = validation?.action || {};
  if (action.type === "move" || action.type === "combat") return { ...action, verdict: validation };
  return action;
}

function candidateMatchForAi(action, candidates = candidateActionsForAi()) {
  const index = candidates.findIndex((item) => sameAiAction(action, item.action));
  const best = candidates[0] || null;
  const matched = index >= 0 ? candidates[index] : null;
  return {
    exact_candidate: index >= 0,
    candidate_rank: index >= 0 ? index + 1 : null,
    candidate_score: matched?.score ?? null,
    best_score: best?.score ?? null,
    score_delta_from_best: matched && best ? Number((matched.score - best.score).toFixed(2)) : null,
    best_action: best?.action || null
  };
}

function evaluateActionForAi(rawAction, candidates = null) {
  const validation = validateAiAction(rawAction);
  const candidateList = candidates || candidateActionsForAi();
  const match = validation.action ? candidateMatchForAi(validation.action, candidateList) : candidateMatchForAi(rawAction, candidateList);
  if (!validation.legal) return { ...validation, candidate_match: match };
  const previousSupplyCache = aiScoreSupplyCache;
  aiScoreSupplyCache ||= aiSupplyScoreMap(state.active_side);
  try {
    const action = actionWithVerdictForAi(validation);
    const score = Number(rulesAiScore(action).toFixed(2));
    return {
      ...validation,
      score,
      evaluation: actionEvaluationForAi(action),
      candidate_match: match,
      note: match.exact_candidate
        ? "Action matches a scored candidate."
        : "Legal but not an exact candidate; compare score/evaluation against best_action before using."
    };
  }
  finally {
    aiScoreSupplyCache = previousSupplyCache;
  }
}

function finalActionReviewForAi(rawAction, assessment) {
  const action = assessment?.action || assessment?.validation?.action || rawAction || {};
  const match = assessment?.candidate_match || {};
  const bestAction = match.best_action || null;
  const bestScore = Number(match.best_score);
  const score = Number(assessment?.score);
  const issues = [];
  if (!assessment?.legal) issues.push(assessment?.reason || "final action is illegal");
  if (isNoOpAiAction(action)) issues.push("final action is a no-op move");
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

function runAiTool(tool, args = {}) {
  try {
    if (tool === "list_legal_actions") {
      const actions = enumerateLegalAiActions(Number(args.limit || 50))
        .map((action) => ({ score: rulesAiScore(action), action: compactAction(action), evaluation: actionEvaluationForAi(action) }))
        .sort((a, b) => b.score - a.score);
      return { legal: true, actions };
    }
    if (tool === "check_move") return checkMove(args.unit, args.path || [], { mode: args.mode || "normal" });
    if (tool === "find_path") {
      const path = findLegalPath(args.unit, args.target, { mode: args.mode || "normal" });
      return path ? { legal: true, path, verdict: checkMove(args.unit, path, { mode: args.mode || "normal" }) } : { legal: false, reason: "找不到合法路径" };
    }
    if (tool === "check_combat") return publicCombatVerdict({ attackers: args.attackers || [], defender_hexes: (args.defender_hexes || []).map(normalizeHex), no_retreat_order: !!args.no_retreat_order });
    if (tool === "inspect_unit") return inspectUnitForAi(args.unit);
    if (tool === "inspect_hex") return inspectHexForAi(args.hex);
    if (tool === "trace_supply") return traceSupplyForAi(args.unit);
    if (tool === "evaluate_action") return evaluateActionForAi(args.action);
    return { legal: false, reason: `未知工具 ${tool}` };
  }
  catch (error) {
    return { legal: false, reason: error.message };
  }
}

function aiRulesSummary() {
  return "你是 El Alamein 外部 game agent，目标是让当前阵营赢得剧本。你可以调用只读工具查询规则结果。移动时优先返回 move_intent，只给 unit、destination、mode:auto；前端会规划完整合法路线。最终只能返回当前阶段允许的 move_intent/move/combat/exit_west/pass。combat 不允许包含 die；骰点由前端裁判在结算时产生。所有最终动作都会被前端裁判二次验证。";
}

function nearestEnemiesForAi(unit, limit = 3) {
  if (!unit?.hex || !isPlayableSide(unit.side)) return [];
  return enemyUnits(unit.side)
    .filter((enemy) => enemy.hex && !enemy.eliminated)
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

function unitContextPriorityForAi(unit) {
  const full = { id: unit.id, ...unit };
  const target = fixedAiTarget(unit.side);
  const nearest = nearestEnemiesForAi(full, 1)[0];
  const nearEnemyScore = nearest ? Math.max(0, 12 - nearest.distance) * 3 : 0;
  const objectiveScore = unit.hex ? Math.max(0, 18 - distance(unit.hex, target)) : 0;
  const actionScore = unit.side === state.active_side && unit.state === "fresh" ? 18 : 0;
  const contactScore = unit.hex && enemyZocSources(unit.side, unit.hex).size ? 20 : 0;
  const combatScore = isCombatUnit(full) ? Number(unit.attack || 0) + Number(unit.defense ?? unit.attack ?? 0) : 0;
  return actionScore + contactScore + nearEnemyScore + objectiveScore + combatScore;
}

function nearbyDetailUnitIdsForAi(side, limit) {
  return new Set(unitsArray()
    .filter((unit) => unit.side === side && isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map((unit) => ({ id: unit.id, score: unitContextPriorityForAi(unit) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Number(limit || 0)))
    .map((item) => item.id));
}

function compactUnitForAi(unit, options = {}) {
  const full = { id: unit.id, ...unit };
  const target = isPlayableSide(unit.side) && unit.hex ? fixedAiTarget(unit.side) : "";
  const includeNearby = options.includeNearby !== false;
  const nearbyLimit = Number(options.nearbyLimit || aiContextDefaults().maxNearbyEnemiesPerUnit || 3);
  const supply = isPlayableSide(unit.side) ? aiSupplyStateForAi(unit.id) : "";
  const suppliedFull = supply ? { ...full, supply_state: supply } : full;
  return {
    id: unit.id,
    name: unit.name || unit.id,
    side: unit.side,
    hex: unit.hex,
    kind: unit.kind || "ground",
    atk: Number(unit.attack || 0),
    def: Number(unit.defense ?? unit.attack ?? 0),
    mp: Number(unit.movement || 0),
    state: unit.state || "fresh",
    supply,
    road: !!unit.road_mode,
    mech: isMechanized(unit),
    terrain: unit.hex ? hexTags(unit.hex) : [],
    map_area: unit.hex ? mapAreaForAi(unit.hex) : [],
    effective_attack: isCombatUnit(full) ? effectiveAttack(suppliedFull) : 0,
    effective_defense: isCombatUnit(full) ? effectiveDefense(suppliedFull) : Number(unit.defense ?? unit.attack ?? 0),
    effective_movement: isMapCounter(full) ? effectiveMovement(suppliedFull) : Number(unit.movement || 0),
    distance_to_objective: target && unit.hex ? distance(unit.hex, target) : null,
    enemy_zoc_here: unit.hex && isPlayableSide(unit.side) ? enemyZocSources(unit.side, unit.hex).size > 0 : false,
    zoc_hexes: isCombatUnit(full) ? zocHexes(full) : [],
    can_move_now: unit.side === state.active_side && isMovableUnit(full) && canMoveInCurrentPhase(full, { mode: "normal" }) && unit.state === "fresh",
    can_attack_now: unit.side === state.active_side && phaseKind() === "combat" && isCombatUnit(full) && unit.state === "fresh" && !unit.attacked_this_turn,
    nearby_enemies: includeNearby ? nearestEnemiesForAi(full, nearbyLimit) : []
  };
}

function forceDigestForAi(side) {
  const context = aiContextDefaults();
  const limit = Number(context.maxUnitsPerSide || 28);
  const nearbyLimit = Number(context.maxNearbyEnemiesPerUnit || 3);
  const detailIds = nearbyDetailUnitIdsForAi(side, context.maxNearbyEnemyDetailUnitsPerSide ?? 18);
  const units = unitsArray()
    .filter((unit) => unit.side === side && isMapCounter(unit) && !unit.eliminated)
    .sort((a, b) => {
      const aFresh = a.state === "fresh" ? 0 : 1;
      const bFresh = b.state === "fresh" ? 0 : 1;
      if (aFresh !== bFresh) return aFresh - bFresh;
      return String(a.hex || "").localeCompare(String(b.hex || ""));
    });
  const combat = units.filter(isCombatUnit);
  const supply = units.filter(isSupplyUnit);
  return {
    side,
    total_units: units.length,
    fresh_units: units.filter((unit) => unit.state === "fresh").length,
    combat_units: combat.length,
    supply_units: supply.length,
    sample_units: units.slice(0, limit).map((unit) => compactUnitForAi(unit, { includeNearby: detailIds.has(unit.id), nearbyLimit })),
    omitted_units: Math.max(0, units.length - limit)
  };
}

function unitIndexForAi(side) {
  const limit = Number(aiContextDefaults().maxUnitIndexPerSide || 160);
  return unitsArray()
    .filter((unit) => unit.side === side && isMapCounter(unit) && !unit.eliminated && unit.hex)
    .sort((a, b) => String(a.hex || "").localeCompare(String(b.hex || "")) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map((unit) => ({
      id: unit.id,
      h: unit.hex,
      k: unit.kind || "ground",
      a: Number(unit.attack || 0),
      d: Number(unit.defense ?? unit.attack ?? 0),
      m: Number(unit.movement || 0),
      s: unit.state || "fresh",
      sup: isPlayableSide(unit.side) ? aiSupplyStateForAi(unit.id) : "",
      area: operationalAreaCodeForAi(unit.hex)
    }));
}

function primaryOperationalAreaForAi(hex) {
  const areas = mapAreaForAi(hex);
  const sector = areas.find((item) => /sector$/.test(item)) || "unknown sector";
  const depth = areas.find((item) => /approach|battlefield|objective area/.test(item)) || "unknown depth";
  return `${sector} / ${depth}`;
}

function compactBattleUnitForAi(unit, objective = fixedAiTarget(unit.side)) {
  return {
    id: unit.id,
    name: unit.name || unit.id,
    side: unit.side,
    hex: unit.hex,
    kind: unit.kind || "ground",
    atk: Number(unit.attack || 0),
    def: Number(unit.defense ?? unit.attack ?? 0),
    mp: Number(unit.movement || 0),
    supply: isPlayableSide(unit.side) ? aiSupplyStateForAi(unit.id) : "",
    map_area: unit.hex ? mapAreaForAi(unit.hex) : [],
    distance_to_objective: unit.hex ? distance(unit.hex, objective) : null
  };
}

function emptyAreaSideForAi() {
  return { units: 0, combat_units: 0, attack: 0, defense: 0, fresh: 0, supplied: 0, partial: 0, isolated: 0 };
}

function addAreaSideStatsForAi(stats, unit) {
  stats.units += 1;
  if (isCombatUnit(unit)) stats.combat_units += 1;
  stats.attack += Number(unit.attack || 0);
  stats.defense += Number(unit.defense ?? unit.attack ?? 0);
  if (unit.state === "fresh") stats.fresh += 1;
  const supply = isPlayableSide(unit.side) ? aiSupplyStateForAi(unit.id) : "";
  if (supply === "supplied") stats.supplied += 1;
  else if (supply === "partially_supplied") stats.partial += 1;
  else if (supply === "isolated") stats.isolated += 1;
}

function battlefieldSummaryForAi() {
  const activeSide = state.active_side;
  const opposingSide = enemySide(activeSide);
  const objective = rules.game?.alamein_hex || "3711";
  const areaMap = new Map();
  const areaFor = (hex) => {
    const label = primaryOperationalAreaForAi(hex);
    if (!areaMap.has(label)) {
      areaMap.set(label, {
        area: label,
        active: emptyAreaSideForAi(),
        enemy: emptyAreaSideForAi(),
        active_nearest_objective_unit: null,
        enemy_nearest_objective_unit: null,
        contact_hexes: []
      });
    }
    return areaMap.get(label);
  };
  const mapUnits = unitsArray().filter((unit) => isMapCounter(unit) && unit.hex && !unit.eliminated);
  for (const unit of mapUnits) {
    const area = areaFor(unit.hex);
    const sideKey = unit.side === activeSide ? "active" : unit.side === opposingSide ? "enemy" : "";
    if (!sideKey) continue;
    addAreaSideStatsForAi(area[sideKey], unit);
    const compact = compactBattleUnitForAi(unit, objective);
    const nearestKey = `${sideKey}_nearest_objective_unit`;
    if (!area[nearestKey] || Number(compact.distance_to_objective ?? 99) < Number(area[nearestKey].distance_to_objective ?? 99)) {
      area[nearestKey] = compact;
    }
    if (enemyZocSources(unit.side, unit.hex).size || enemyMinesAt(unit.side, unit.hex).length) area.contact_hexes.push(unit.hex);
  }
  const byObjectiveDistance = (a, b) => distance(a.hex, objective) - distance(b.hex, objective) || a.id.localeCompare(b.id);
  const unitsNearObjective = mapUnits
    .filter((unit) => distance(unit.hex, objective) <= 4)
    .sort(byObjectiveDistance)
    .slice(0, 12)
    .map((unit) => compactBattleUnitForAi(unit, objective));
  const closestActive = mapUnits
    .filter((unit) => unit.side === activeSide)
    .sort(byObjectiveDistance)
    .slice(0, 5)
    .map((unit) => compactBattleUnitForAi(unit, objective));
  const closestEnemy = mapUnits
    .filter((unit) => unit.side === opposingSide)
    .sort(byObjectiveDistance)
    .slice(0, 5)
    .map((unit) => compactBattleUnitForAi(unit, objective));
  const regionalBalance = [...areaMap.values()]
    .map((area) => ({ ...area, contact_hexes: [...new Set(area.contact_hexes)].slice(0, 8) }))
    .sort((a, b) => (b.active.attack + b.enemy.attack + b.active.units + b.enemy.units) - (a.active.attack + a.enemy.attack + a.active.units + a.enemy.units))
    .slice(0, 8);
  return {
    description: "Operational board summary by region: force density, supply health, contact, and objective pressure.",
    active_side: activeSide,
    enemy_side: opposingSide,
    primary_objective_hex: objective,
    objective_zone: {
      radius_hexes: 4,
      control: state.control?.[objective] || "",
      zoc_by_axis: enemyZocSources("allies", objective).size > 0,
      zoc_by_allies: enemyZocSources("axis", objective).size > 0,
      units: unitsNearObjective
    },
    closest_active_to_objective: closestActive,
    closest_enemy_to_objective: closestEnemy,
    regional_balance: regionalBalance
  };
}

function phaseStrategyForAi() {
  const strategy = aiStrategyDefaults();
  const kind = phaseKind();
  return {
    doctrine: strategy.doctrine || "",
    active_phase_objective: strategy.phaseObjectives?.[kind] || strategy.phaseObjectives?.[state.phase] || "",
    priorities: strategy.priorities || [],
    action_contract: strategy.actionContract || ""
  };
}

function recentLogForAi() {
  const limit = Number(aiContextDefaults().maxRecentLogItems || 8);
  return actionLog.slice(-limit).map((item) => ({
    type: item.type,
    text: item.text,
    turn: item.turn,
    phase: item.phase
  }));
}

function objectiveHexesForAi() {
  return {
    axis_primary: fixedAiTarget("axis"),
    allies_primary: fixedAiTarget("allies"),
    alamein: rules.game?.alamein_hex || "3711",
    axis_supply_sources: rules.game?.axis_supply_sources || [],
    allies_supply_sources: rules.game?.allies_supply_sources || []
  };
}

function phaseAllowedActionsForAi(kind = phaseKind()) {
  if (kind === "combat") return ["combat", "pass"];
  if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) return ["pass"];
  const actions = ["move_intent", "move", "pass"];
  if (state.scenario === "october" && state.active_side === "axis" && Number(state.turn || 1) > 10) actions.splice(1, 0, "exit_west");
  return actions;
}

function decisionBriefForAi(candidateActions = []) {
  const nonPass = candidateActions.filter((item) => item.action?.type !== "pass");
  const top = candidateActions[0] || null;
  const bestNonPass = nonPass[0] || null;
  const kind = phaseKind();
  return {
    read_first: true,
    side: state.active_side,
    phase: state.phase,
    allowed: phaseAllowedActionsForAi(kind),
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

function rulesBriefForAi() {
  const movement = rules.movement || {};
  const stacking = rules.stacking || {};
  const combat = rules.combat || {};
  return {
    game: rules.game?.title || "First Alamein",
    role: "You are the active side's game agent. Your job is to win the scenario, using only legal actions accepted by the front-end judge.",
    turn_sequence: rules.turn_sequence || DEFAULT_RULES.turn_sequence,
    movement: [
      "Units move only in movement phases for their side and become spent after moving.",
      `Enemy occupied hexes are ${movement.enemy_occupied_hex || "forbidden"}.`,
      movement.enter_enemy_zoc_must_stop ? "Entering enemy ZOC requires stopping." : "Enemy ZOC does not force a stop.",
      movement.cannot_move_directly_between_zocs_of_same_enemy_unit ? "Do not move directly between ZOCs of the same enemy unit." : "",
      "Road mode is faster but must still pass the judge's check_move validation."
    ].filter(Boolean),
    combat: [
      combat.attacker_must_be_fresh ? "Attackers must be fresh." : "",
      combat.must_attack_adjacent_fresh_enemy_units ? "Combat targets are adjacent enemy defender hexes required by the rules." : "",
      `Minimum odds ${combat.minimum_odds || "1-4"}, maximum odds ${combat.maximum_odds || "7-1"}.`,
      "Do not include die in combat actions; the front-end judge rolls or uses the selected die.",
      "Prefer attacks with good odds and useful positional or supply consequences."
    ].filter(Boolean),
    stacking: {
      axis_max_units_per_hex: stacking.axis_max_units_per_hex,
      allied_max_units_per_hex: stacking.allied_max_units_per_hex,
      one_side_per_hex: stacking.one_side_per_hex
    },
    supply: {
      axis_sources: rules.game?.axis_supply_sources || [],
      allies_sources: rules.game?.allies_supply_sources || [],
      note: "Supplied and partially supplied units are much more valuable for victory and survival."
    }
  };
}

function victoryBriefForAi() {
  const victory = checkVictory();
  const scenario = state.scenario || "custom";
  const alamein = rules.game?.alamein_hex || "3711";
  const brief = {
    current_vp: Number(victory.victory_points || 0),
    current_level: victory.level || "",
    final_turn: victory.final_turn || scenarioFinalTurnForAi(),
    final_check: "Winner is decided at End of Game-Turn on the final scenario turn.",
    vp_scale: [
      "60+ Axis Decisive",
      "50-59 Axis Substantive",
      "40-49 Axis Marginal",
      "30-39 Draw",
      "20-29 Allied Marginal",
      "10-19 Allied Substantive",
      "0-9 Allied Decisive"
    ],
    side_goals: {
      axis: [
        `Increase VP and pressure/capture ${alamein} with supplied or partially supplied combat units.`,
        "Destroy Allied combat units, isolate them, and push the farthest supplied Axis combat unit east when the scenario awards it.",
        scenario === "october" ? "After Turn 10, withdraw valuable Axis units west when exit_west is legal." : ""
      ].filter(Boolean),
      allies: [
        `Deny Axis VP, hold or contest ${alamein}, preserve combat units, and keep supply open.`,
        "Use terrain, mines, ZOC, and counterattacks to slow Axis tempo.",
        "A supplied Allied unit threatening Axis entry/source hexes is strategically valuable when legal."
      ]
    },
    scoring_breakdown: (victory.breakdown || []).slice(-8)
  };
  return brief;
}

function missionForAi() {
  const side = state.active_side;
  const opponent = enemySide(side);
  const victory = victoryBriefForAi();
  const sideGoals = victory.side_goals?.[side] || [];
  return {
    identity: "game_agent",
    side,
    opponent,
    objective: side === "axis"
      ? "Win as Axis by raising VP, maintaining supply, pressuring Alamein/eastern routes, and avoiding wasteful losses."
      : "Win as Allies by keeping VP low, holding the Alamein position, preserving units, and disrupting Axis supply/tempo.",
    immediate_phase_goal: phaseStrategyForAi().active_phase_objective,
    current_phase_allowed_actions: phaseAllowedActionsForAi(),
    win_guidance: sideGoals,
    decision_rule: "Choose the legal action that most improves your chance to win the scenario. Use tools when legality, supply, pathing, or combat odds are uncertain."
  };
}

function compactHexUnitsForAi(hex) {
  return (unitsByHex()[normalizeHex(hex)] || []).map((unit) => ({
    id: unit.id,
    name: unit.name || unit.id,
    side: unit.side,
    kind: unit.kind || "ground",
    atk: Number(unit.attack || 0),
    def: Number(unit.defense ?? unit.attack ?? 0),
    state: unit.state || "fresh",
    supply: isPlayableSide(unit.side) ? aiSupplyStateForAi(unit.id) : ""
  }));
}

function hexIntelForAi(rawHex, label = "") {
  let hex;
  try {
    hex = normalizeHex(rawHex);
  }
  catch {
    return null;
  }
  const units = compactHexUnitsForAi(hex);
  const mineList = minesAt(hex).map((mine) => ({ id: mine.id, side: mine.side, name: mine.name || mine.id }));
  return {
    hex,
    label,
    terrain: hexTags(hex),
    map_area: mapAreaForAi(hex),
    control: state.control?.[hex] || "",
    units,
    mines: mineList,
    zoc_by_axis: enemyZocSources("allies", hex).size > 0,
    zoc_by_allies: enemyZocSources("axis", hex).size > 0,
    road_neighbors: neighbors(hex).filter((nb) => edgeTags(normalizeEdge(hex, nb)).includes("road")),
    distance_from_axis_objective: distance(hex, fixedAiTarget("axis")),
    distance_from_allies_objective: distance(hex, fixedAiTarget("allies"))
  };
}

function keyHexesForAi(candidateActions = []) {
  const context = aiContextDefaults();
  const limit = Number(context.maxMapIntelHexes || 16);
  const labeled = new Map();
  const add = (hex, label) => {
    if (!hex) return;
    try {
      const normalized = normalizeHex(hex);
      if (!labeled.has(normalized)) labeled.set(normalized, label);
    }
    catch {}
  };
  const objectives = objectiveHexesForAi();
  add(objectives.alamein, "Alamein / primary victory hex");
  add(objectives.axis_primary, "Axis primary objective");
  add(objectives.allies_primary, "Allied primary objective");
  for (const hex of objectives.axis_supply_sources || []) add(hex, "Axis supply source");
  for (const hex of objectives.allies_supply_sources || []) add(hex, "Allied supply source");
  for (const item of candidateActions) {
    const action = item.action || item;
    if (action.type === "move") add(action.destination || action.path?.at(-1), "candidate destination");
    if (action.type === "combat") for (const hex of action.defender_hexes || []) add(hex, "candidate combat target");
  }
  for (const unit of unitsArray().filter((item) => isMapCounter(item) && item.hex && !item.eliminated)) {
    if (enemyZocSources(unit.side, unit.hex).size || enemyMinesAt(unit.side, unit.hex).length) add(unit.hex, "contact / hazard");
  }
  return [...labeled.entries()]
    .slice(0, limit)
    .map(([hex, label]) => hexIntelForAi(hex, label))
    .filter(Boolean);
}

function frontlineUnitsForAi() {
  const context = aiContextDefaults();
  const limit = Number(context.maxFrontlineUnits || 10);
  const side = state.active_side;
  const activeTarget = fixedAiTarget(side);
  return unitsArray()
    .filter((unit) => unit.side === side && isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map((unit) => {
      const full = { id: unit.id, ...unit };
      const nearest = nearestEnemiesForAi(full, Number(context.maxNearbyEnemiesPerUnit || 3));
      const closestEnemyDistance = nearest[0]?.distance ?? 99;
      return {
        pressure_score: Math.max(0, 12 - closestEnemyDistance) + Math.max(0, 12 - distance(unit.hex, activeTarget)),
        unit: compactUnitForAi(full),
        nearest_enemies: nearest,
        friendly_stack: compactHexUnitsForAi(unit.hex).filter((item) => item.side === side).map((item) => item.id),
        enemy_zoc_sources: [...enemyZocSources(side, unit.hex)],
        enemy_mines_here: enemyMinesAt(side, unit.hex).map((mine) => mine.id)
      };
    })
    .sort((a, b) => b.pressure_score - a.pressure_score || a.unit.id.localeCompare(b.unit.id))
    .slice(0, limit)
    .map(({ pressure_score, ...item }) => item);
}

function mapIntelForAi(candidateActions = []) {
  return {
    description: "Compressed board intel: key geography, front-line units, ZOC, mines, roads, and distances. Use inspect_hex/find_path/trace_supply for details.",
    key_hexes: keyHexesForAi(candidateActions),
    frontline: frontlineUnitsForAi()
  };
}

function victoryImpactForAi(action) {
  const finalTurn = scenarioFinalTurnForAi();
  const turnsRemaining = Math.max(0, finalTurn - Number(state.turn || 1) + 1);
  const alamein = rules.game?.alamein_hex || "3711";
  const victory = aiVictoryImpactCache || checkVictory();
  const base = {
    turns_remaining: turnsRemaining,
    final_turn: finalTurn,
    urgency: turnsRemaining <= 1 ? "final turn or final check imminent" : turnsRemaining <= 2 ? "late scenario" : "developing scenario",
    current_vp: Number(victory.victory_points || 0),
    current_level: victory.level || ""
  };
  if (!action) return base;
  if (action.type === "pass") {
    return { ...base, summary: "Pass has no direct VP effect and may waste tempo if useful candidates exist." };
  }
  if (action.type === "exit_west") {
    const unit = state.units[action.unit];
    return {
      ...base,
      summary: "October Axis west exit can directly affect withdrawal VP when legal.",
      vp_relevance: "direct",
      unit: action.unit,
      unit_value_hint: unit?.kind === "supply" ? "supply unit" : Number(unit?.attack || unit?.defense || 0)
    };
  }
  if (action.type === "combat") {
    const targets = (action.defender_hexes || []).map((hex) => normalizeHex(hex));
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
    const unit = state.units[action.unit];
    const start = unit?.hex ? normalizeHex(unit.hex) : "";
    const destination = normalizeHex(action.destination || action.path?.at(-1) || start);
    const before = start ? distance(start, alamein) : null;
    const after = destination ? distance(destination, alamein) : null;
    const supplied = unit && isPlayableSide(unit.side) ? aiSupplyStateForAi(action.unit) : "";
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

function actionEvaluationForAi(action) {
  if (!action) return { summary: "missing action" };
  if (action.type === "pass") {
    return {
      summary: "Pass ends the current phase. Use only when no useful legal action remains.",
      victory_impact: victoryImpactForAi(action),
      risks: ["cedes tempo"]
    };
  }
  if (action.type === "exit_west") {
    const unit = state.units[action.unit];
    return {
      summary: "Withdraws a unit west for October scenario VP when legal.",
      unit: action.unit,
      victory_impact: victoryImpactForAi(action),
      value_hint: unit?.kind === "supply" ? "high value supply exit" : `combat value ${Number(unit?.attack || unit?.defense || 0)}`,
      risks: []
    };
  }
  if (action.type === "combat") {
    const details = action.verdict?.details || {};
    const crt = details.crt_column || {};
    const stats = combatOutcomeStats(crt);
    const targetIntel = combatTargetIntelForAi(action);
    const attackerBad = stats.attacker_harm;
    const defenderBad = stats.defender_harm;
    const strategic = combatStrategicValue(action);
    const attackers = (action.attackers || []).map((id) => {
      const unit = state.units[id];
      return unit ? {
        id,
        name: unit.name || id,
        hex: unit.hex,
        atk: Number(unit.attack || 0),
        supply: aiSupplyStateForAi(id)
      } : { id };
    });
    return {
      summary: `Combat at ${details.odds_column || "unknown odds"} against ${action.defender_hexes?.join(", ") || "unknown target"}.`,
      odds_column: details.odds_column,
      attack: details.attack,
      defense: details.defense,
      expected_crt_score: Number(combatRiskScore(crt).toFixed(2)),
      strategic_value: Number(strategic.toFixed(2)),
      victory_impact: victoryImpactForAi(action),
      outcome_faces: stats,
      attackers,
      targets: targetIntel,
      defender_damage_faces: defenderBad,
      attacker_loss_faces: attackerBad,
      tactical_tags: [
        defenderBad >= 4 ? "high defender pressure" : "",
        stats.defender_eliminated >= 2 ? "elimination chance" : "",
        stats.defender_retreat >= 3 ? "retreat pressure" : "",
        targetIntel.some((target) => target.is_primary_objective) ? "primary objective target" : "",
        targetIntel.some((target) => target.retreat_options_estimate <= target.defenders.length) ? "limited defender retreat" : "",
        attackerBad >= 3 ? "meaningful attacker risk" : "",
        (details.attack || 0) >= (details.defense || 0) * 2 ? "strong odds" : ""
      ].filter(Boolean),
      risks: [
        attackerBad >= 3 ? "attacker losses likely on several die faces" : "",
        stats.exchange >= 2 ? "exchange risk" : "",
        targetIntel.some((target) => target.terrain.includes("hill_or_ridge")) ? "rugged defense may cancel defender retreat" : "",
        (details.attack || 0) < (details.defense || 1) ? "low odds attack" : ""
      ].filter(Boolean)
    };
  }
  if (action.type === "move") {
    const unit = state.units[action.unit];
    if (!unit || !action.path?.length) return { summary: "Move action has unknown unit or path." };
    const start = normalizeHex(unit.hex);
    const destination = normalizeHex(action.path[action.path.length - 1]);
    const target = rulesAiMoveTarget(unit);
    const before = distance(start, target);
    const after = distance(destination, target);
    const progress = before - after;
    const zocSources = [...enemyZocSources(unit.side, destination)];
    const mines = enemyMinesAt(unit.side, destination).map((mine) => mine.id);
    const terrainTags = hexTags(destination);
    const nearest = nearestEnemiesForAi({ id: action.unit, ...unit, hex: destination }, 3);
    const risks = [
      zocSources.length ? `enters enemy ZOC from ${zocSources.join(", ")}` : "",
      mines.length ? `enters enemy mines ${mines.join(", ")}` : "",
      isSupplyUnit({ id: action.unit, ...unit }) && zocSources.length ? "supply unit exposed in enemy ZOC" : "",
      aiScoreSupplyState(action.unit) === "isolated" ? "unit is isolated before move" : "",
      progress < 0 ? "moves away from primary objective" : ""
    ].filter(Boolean);
    const tags = [
      progress > 0 ? "objective progress" : "",
      action.mode === "road" ? "road movement" : "",
      terrainTags.includes("alamein_box") ? "Alamein box" : "",
      terrainTags.includes("hill_or_ridge") ? "defensive terrain" : "",
      zocSources.length ? "contact" : "",
      nearest[0]?.distance <= 2 ? "near enemy" : ""
    ].filter(Boolean);
    return {
      summary: `${action.unit} ${start} -> ${destination}; objective distance ${before} -> ${after}.`,
      start,
      destination,
      objective: target,
      distance_before: before,
      distance_after: after,
      progress,
      victory_impact: victoryImpactForAi(action),
      spent: action.verdict?.details?.spent,
      allowance: action.verdict?.details?.allowance,
      terrain: terrainTags,
      map_area: mapAreaForAi(destination),
      enemy_zoc_sources: zocSources,
      enemy_mines: mines,
      nearest_enemies: nearest,
      tactical_tags: tags,
      risks
    };
  }
  return { summary: `Unsupported action type ${action.type}` };
}

function isNoOpAiAction(action) {
  if (!action || action.type !== "move") return false;
  const unit = state.units[action.unit];
  const start = unit?.hex ? normalizeHex(unit.hex) : "";
  const destination = action.destination || action.path?.at(-1);
  return !!start && normalizeHex(destination || start) === start && (action.path || []).length <= 1;
}

function isUsefulAiMoveCandidate(action) {
  if (!action || action.type !== "move") return true;
  const unit = state.units[action.unit];
  if (!unit || unit.side !== "allies" || isSupplyUnit({ id: action.unit, ...unit })) return true;
  const start = normalizeHex(unit.hex);
  const destination = normalizeHex(action.destination || action.path?.at(-1) || start);
  const target = rulesAiMoveTarget({ id: action.unit, ...unit });
  return distance(start, target) - distance(destination, target) > 0;
}

function candidateActionsForAi() {
  const context = aiContextDefaults();
  const limit = Number(context.maxLegalActions || el("aiMaxActionsInput")?.value || 50);
  const candidateLimit = Number(context.maxCandidateActions || 12);
  const previousSupplyCache = aiScoreSupplyCache;
  const previousVictoryCache = aiVictoryImpactCache;
  aiScoreSupplyCache ||= aiSupplyScoreMap(state.active_side);
  aiVictoryImpactCache ||= checkVictory();
  try {
    const candidates = enumerateLegalAiActions(limit)
      .map((action) => ({
        score: Number(rulesAiScore(action).toFixed(2)),
        action: compactAction(action),
        evaluation: actionEvaluationForAi(action)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(candidateLimit * 2, candidateLimit));
    const meaningful = candidates.filter((item) => !isNoOpAiAction(item.action) && isUsefulAiMoveCandidate(item.action));
    const passItem = candidates.find((item) => item.action?.type === "pass") || {
      score: -999,
      action: { type: "pass", reason: "No useful legal action" },
      evaluation: actionEvaluationForAi({ type: "pass" })
    };
    const selected = (meaningful.length ? meaningful : candidates)
      .filter((item) => item.action?.type !== "pass")
      .slice(0, Math.max(0, candidateLimit - 1));
    if (candidateLimit > 0) selected.push(passItem);
    return selected;
  }
  finally {
    aiScoreSupplyCache = previousSupplyCache;
    aiVictoryImpactCache = previousVictoryCache;
  }
}

function compactExternalAiContext(toolResults = []) {
  return withAiContextSupplyCache(() => {
    const finalTurn = scenarioFinalTurnForAi();
    const toolLimit = Number(aiContextDefaults().maxToolResults || 6);
    const candidateActions = candidateActionsForAi();
    const payload = {
      protocol: {
        response_json_only: true,
        allowed_final_actions: ["move_intent", "move", "combat", "exit_west", "pass"],
        current_phase_allowed_actions: phaseAllowedActionsForAi(),
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
        tool_call_shape: { type: "tool_call", tool: "inspect_unit", arguments: {} },
        final_action_shape: { type: "final_action", reason: "short reason", action: { type: "move_intent", unit: "unit-id", destination: "hex", mode: "auto" } }
      },
      game: {
        scenario: state.scenario || "custom",
        turn: Number(state.turn || 1),
        final_turn: finalTurn,
        turns_remaining: Math.max(0, finalTurn - Number(state.turn || 1) + 1),
        phase: state.phase,
        phase_kind: phaseKind(),
        active_side: state.active_side,
        victory_points: Number(state.victory_points || 0)
      },
      decision_brief: decisionBriefForAi(candidateActions),
      mission: missionForAi(),
      rules_brief: rulesBriefForAi(),
      victory: victoryBriefForAi(),
      strategy: phaseStrategyForAi(),
      objectives: objectiveHexesForAi(),
      forces: {
        active: forceDigestForAi(state.active_side),
        enemy: forceDigestForAi(enemySide(state.active_side))
      },
      unit_index: {
        active: unitIndexForAi(state.active_side),
        enemy: unitIndexForAi(enemySide(state.active_side))
      },
      battlefield_summary: battlefieldSummaryForAi(),
      map_intel: mapIntelForAi(candidateActions),
      candidate_actions: candidateActions,
      recent_log: recentLogForAi(),
      tools: aiToolsSchema(),
      tool_results: toolResults.slice(-toolLimit)
    };
    if (aiContextDefaults().includeFullStateSummary) payload.full_state_summary = aiStateSummary();
    return payload;
  });
}

function externalAiPayload(toolResults = []) {
  const api = aiApiDefaults();
  return {
    provider: AiDefaults.provider || "custom",
    model: el("aiModelInput")?.value || api.model || "",
    rules_summary: aiRulesSummary(),
    context: compactExternalAiContext(toolResults)
  };
}

function externalAiSystemPrompt() {
  const strategy = aiStrategyDefaults();
  return [
    "You are the game agent for the active side in El Alamein. Your objective is to win the scenario, not merely to output any legal move.",
    aiRulesSummary(),
    strategy.doctrine || "",
    strategy.actionContract || "",
    ...(strategy.priorities || []).map((item) => `Priority: ${item}`),
    "Read decision_brief first, then mission, rules_brief, victory, game, forces, battlefield_summary, map_intel, candidate_actions, and recent_log before choosing.",
    "Only return final actions allowed by protocol.current_phase_allowed_actions.",
    "You are playing a hex-and-counter wargame through a validating front end.",
    "For movement, prefer move_intent with unit + destination + mode:auto. The local planner will choose the full legal route. Use full move only when you intentionally need a specific path.",
    "Prefer candidate_actions from the user context. Read each candidate's score and evaluation.risks/tactical_tags before choosing. If you choose a movement candidate, you may return move_intent with the same unit and destination.",
    "Before returning a non-candidate final_action, call evaluate_action and compare its score/risk to the best candidate.",
    "If tool_results contains final_action_review with accept=false, do not repeat that action; choose the recommended best_action or another stronger legal candidate.",
    "Use tool_call when a unit, hex, route, supply path, or combat verdict is uncertain.",
    "Return compact JSON only. Do not wrap it in Markdown. Never include die rolls in combat."
  ].filter(Boolean).join("\n");
}

function externalAiUserPrompt(toolResults = []) {
  return JSON.stringify(externalAiPayload(toolResults));
}

function parseAiJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    const error = new Error("模型返回空内容");
    error.rawContent = "";
    throw error;
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(jsonText);
  }
  catch (error) {
    const wrapped = new Error(`模型返回的 JSON 无法解析：${error.message}`);
    wrapped.rawContent = jsonText;
    throw wrapped;
  }
}

function normalizeExternalAiResponse(json) {
  const message = json?.choices?.[0]?.message;
  const content = message?.content;
  if (content != null && String(content).trim()) return parseAiJsonText(content);
  if (message?.reasoning_content) {
    const error = new Error("模型只返回了 reasoning_content，未返回最终 JSON");
    error.rawContent = message.reasoning_content;
    throw error;
  }
  if (content != null) return parseAiJsonText(content);
  return json;
}

function externalAiRepairPrompt(rawContent, toolResults = []) {
  return JSON.stringify({
    task: "Repair the invalid model output into one valid JSON object only.",
    invalid_output: String(rawContent || "").slice(0, 1600),
    allowed_shapes: [
      { type: "tool_call", tool: "inspect_unit", arguments: { unit: "unit-id" } },
      { type: "final_action", reason: "short reason", action: { type: "pass", reason: "short reason" } }
    ],
    constraints: [
      "Return JSON only.",
      "Prefer a final_action if a tool result already confirms a legal candidate.",
      "If uncertain, return a final_action pass.",
      "Do not include Markdown or commentary."
    ],
    context: compactExternalAiContext(toolResults)
  });
}

function externalAiRequestBody(toolResults = [], options = {}) {
  const api = aiApiDefaults();
  if (api.kind !== "chat_completions") return externalAiPayload(toolResults);
  const repairing = options.repairContent != null;
  return {
    model: el("aiModelInput")?.value || api.model || "",
    messages: [
      {
        role: "system",
        content: repairing
          ? "You repair invalid JSON for a wargame AI. Return exactly one valid compact JSON object."
          : externalAiSystemPrompt()
      },
      {
        role: "user",
        content: repairing ? externalAiRepairPrompt(options.repairContent, toolResults) : externalAiUserPrompt(toolResults)
      }
    ],
    temperature: repairing ? 0 : Number(api.temperature ?? 0.25),
    max_tokens: repairing ? Number(api.repairMaxTokens || 900) : Number(api.maxTokens || 2200),
    response_format: api.responseFormat || { type: "json_object" }
  };
}

async function fetchExternalAiJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`API ${response.status} ${response.statusText}`);
    return normalizeExternalAiResponse(await response.json());
  }
  finally {
    clearTimeout(timer);
  }
}

function externalAiErrorMessage(error) {
  if (error.name === "AbortError") return "API 请求超时";
  const message = error.message || String(error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "API 网络请求失败。若浏览器直连 DeepSeek 被 CORS 拦截，请改用本地/服务器代理转发 Chat Completions 请求。";
  }
  return message;
}

async function requestExternalAiAction() {
  syncExternalAiDefaults();
  const api = aiApiDefaults();
  const url = el("aiApiUrlInput")?.value.trim() || api.url || "";
  if (!url) return { type: "external", error: "请填写 API URL" };
  const maxRounds = Number(el("aiMaxToolRoundsInput")?.value || api.maxToolRounds || 4);
  const timeoutMs = Number(el("aiTimeoutInput")?.value || api.timeoutSeconds || 20) * 1000;
  const toolResults = [];
  const calls = [];
  const headers = { "Content-Type": "application/json" };
  const key = el("aiApiKeyInput")?.value || api.apiKey || "";
  if (key) headers.Authorization = `Bearer ${key}`;
  let finalReviewUsed = false;
  for (let round = 0; round <= maxRounds; round++) {
    let json;
    try {
      json = await fetchExternalAiJson(url, headers, externalAiRequestBody(toolResults), timeoutMs);
    }
    catch (error) {
      if (error.rawContent != null) {
        try {
          json = await fetchExternalAiJson(url, headers, externalAiRequestBody(toolResults, { repairContent: error.rawContent }), timeoutMs);
        }
        catch (repairError) {
          return { type: "external", error: externalAiErrorMessage(repairError), original_error: externalAiErrorMessage(error), raw_response: error.rawContent, tool_results: toolResults };
        }
      }
      else {
        return { type: "external", error: externalAiErrorMessage(error), tool_results: toolResults };
      }
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
    const assessment = evaluateActionForAi(finalAction);
    const review = finalActionReviewForAi(finalAction, assessment);
    if (!review.accept && !finalReviewUsed && round < maxRounds) {
      finalReviewUsed = true;
      const record = {
        tool: "final_action_review",
        arguments: { action: finalAction },
        result: review
      };
      toolResults.push(record);
      calls.push(record);
      continue;
    }
    return { type: "external", action: validation.action || finalAction, reason: json.reason || "", validation, assessment, final_review: review, review_used: finalReviewUsed, tool_results: toolResults, raw_response: json };
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
  syncExternalAiDefaults();
  config.classList.toggle("active", aiModeForSide(state.active_side) === "external" || el("aiModeSelect")?.value === "external");
  renderAiProfiles();
  syncAiAutoControls();
  renderActionControls();
}

async function playAiForCurrentSide() {
  const controller = playerController(state.active_side);
  if (controller === "human") {
    const result = { legal: false, reason: `${state.active_side} 当前由玩家控制` };
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
  focusOpeningView({ phaseTab: true });
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
    option.textContent = phaseDisplayName(phase);
    el("phaseSelect").append(option);
    const setupOption = option.cloneNode(true);
    el("setupPhaseSelect")?.append(setupOption);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      switchTab(tab.dataset.tab);
    });
  });
  el("phaseActionDock")?.addEventListener("click", handlePhaseActionDockClick);
  el("selectionSummaryPanel")?.addEventListener("click", handleSelectionSummaryClick);
  document.addEventListener("click", (event) => {
    if (event.target.closest?.(".phase-dock-more")) return;
    closeDockMenus();
    if (!event.target.closest?.(".map-toolbar")) closeMapToolMenus();
  });
  el("sideCommandBar")?.addEventListener("click", (event) => {
    const commandButton = event.target.closest?.("button[data-command]");
    if (commandButton) {
      handlePhaseActionDockClick(event);
      return;
    }
    handleGameLogClick(event);
  });
  document.querySelector(".side-panel")?.addEventListener("click", handleActionableUnitsClick);
  document.querySelector(".side-panel")?.addEventListener("click", (event) => {
    if (event.target.closest?.("#loadLatestSlotBtn")) loadLatestSlot();
  });
  el("combatTargetList")?.addEventListener("click", handleCombatTargetListClick);
  el("routeStepList")?.addEventListener("click", handleRouteStepListClick);
  el("tab-log")?.addEventListener("click", handleGameLogClick);
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (event.key === "Escape") {
      const hadOpenMenus = !!document.querySelector(".phase-dock-more[open], .map-view-menu[open], .map-layer-menu[open]");
      closeDockMenus();
      closeMapToolMenus();
      if (target?.matches?.("input, select, textarea, button")) {
        target.blur?.();
      }
      else if (!hadOpenMenus) {
        clearInteractionFocus();
        renderState();
      }
      event.preventDefault();
      return;
    }
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
    else if (key === "n") {
      cycleActionableUnit(1);
      event.preventDefault();
    }
  });

  el("turnInput").addEventListener("change", () => { state.turn = Number(el("turnInput").value); renderState(); });
  el("activeSideSelect").addEventListener("change", () => { state.active_side = el("activeSideSelect").value; renderState(); });
  el("phaseSelect").addEventListener("change", () => {
    state.phase = el("phaseSelect").value;
    syncActiveSideFromPhase();
    renderState();
    focusCurrentPhaseTab();
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
  document.querySelectorAll("[data-setup-scenario]").forEach((button) => {
    button.addEventListener("click", () => openSetupScenario(button.dataset.setupScenario));
  });
  window.addEventListener("pagehide", saveCurrentGameOnExit);
  window.addEventListener("beforeunload", saveCurrentGameOnExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveCurrentGameOnExit();
  });
  ["setupScenarioSelect", "setupTurnInput", "setupPhaseSelect", "setupAxisRoleSelect", "setupAlliesRoleSelect", "setupAiTargetInput"].forEach((id) => {
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
  el("sidePanelToggleBtn")?.addEventListener("click", toggleSidePanel);
  el("gameSettingsBtn")?.addEventListener("click", () => switchTab("settings", { expandPanel: true }));
  el("unitSearch").addEventListener("input", renderUnitList);
  el("ruleSearch")?.addEventListener("input", filterRulebook);
  el("expandRulesBtn")?.addEventListener("click", () => setRulebookOpen(true));
  el("collapseRulesBtn")?.addEventListener("click", () => setRulebookOpen(false));
  document.querySelectorAll("[data-map-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setMapViewMode(button.dataset.mapMode);
      closeMapToolMenus();
      renderOperationHint();
      renderMap();
    });
  });
  document.querySelectorAll(".map-view-menu, .map-layer-menu").forEach((details) => {
    details.addEventListener("toggle", () => {
      if (details.open) closeMapToolMenus(details);
    });
  });
  ["showUnitsToggle", "showMarkersToggle", "expandStacksToggle", "showMinesToggle", "showReachableToggle", "showZocToggle", "showTerrainToggle", "showHexToggle"].forEach((id) => {
    el(id).addEventListener("change", () => {
      syncMapModeButtons();
      renderOperationHint();
      renderMap();
    });
  });
  el("mapViewModeSelect").addEventListener("change", () => {
    syncMapModeButtons();
    closeMapToolMenus();
    renderOperationHint();
    renderMap();
  });
  el("moveUnitSelect").addEventListener("change", () => selectUnit(el("moveUnitSelect").value, { showStateTab: false }));
  el("moveModeSelect").addEventListener("change", () => { renderRouteStatus(); renderActionControls(); renderMap(); });
  el("combatResolveDieSelect").addEventListener("change", () => {
    renderAutoJudge();
    renderActionControls();
  });
  el("useSelectedCombatBtn").addEventListener("click", () => {
    if (selectedUnitId) el("combatAttackersInput").value = selectedUnitId;
    if (selectedCombatDefenderHex) el("combatDefendersInput").value = selectedCombatDefenderHex;
    setOutput("combatOutput", checkCombat(parseCombatAction()));
    renderActionControls();
  });
  el("previewCombatBtn").addEventListener("click", previewCombatFromInputs);
  el("randomCombatBtn")?.addEventListener("click", resolveCombatWithRandomDie);
  el("resolveCombatBtn").addEventListener("click", () => {
    setOutput("combatOutput", resolveCombat(parseCombatAction()));
    renderActionControls();
  });
  el("undoActionBtn").addEventListener("click", undoLastAction);
  el("clearMineBtn").addEventListener("click", () => {
    setOutput("combatOutput", clearMine(el("engineerSelect").value, el("mineHexInput").value));
    renderActionControls();
  });
  ["combatAttackersInput", "combatDefendersInput", "engineerSelect", "mineHexInput"].forEach((id) => {
    el(id)?.addEventListener("input", renderActionControls);
    el(id)?.addEventListener("change", renderActionControls);
  });
  ["combatAttackersInput", "combatDefendersInput"].forEach((id) => {
    el(id)?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      previewCombatFromInputs();
    });
  });
  el("calibrationStatusFilter").addEventListener("change", renderCalibration);
  el("calibrationSearch").addEventListener("input", renderCalibration);
  el("moveTargetInput")?.addEventListener("input", renderActionControls);
  el("moveTargetInput")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runAutoRouteFromTarget();
  });
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
  el("autoRouteBtn").addEventListener("click", runAutoRouteFromTarget);
  el("enterRoadModeBtn").addEventListener("click", () => {
    el("moveModeSelect").value = "road";
    renderRouteStatus();
    renderActionControls();
    renderMap();
  });
  el("leaveRoadModeBtn").addEventListener("click", () => {
    const unitId = el("moveUnitSelect").value;
    if (!unitId || !state.units[unitId]) return;
    const verdict = RulesEngine.checkLeaveRoadMode(rulesContext(), unitId);
    if (!verdict.legal) {
      setOutput("moveOutput", verdict);
      renderActionControls();
      return;
    }
    pushHistory("leave_road_mode");
    const result = RulesEngine.leaveRoadMode(rulesContext(), unitId);
    el("moveModeSelect").value = "normal";
    logEvent("leave_road_mode", `${unitId} 退出道路模式`, result.details);
    renderState();
    setOutput("moveOutput", result);
  });
  el("exitWestBtn").addEventListener("click", () => {
    const unitId = el("moveUnitSelect").value;
    const result = exitWestUnit(unitId, "manual");
    setOutput("moveOutput", result);
    renderState();
  });

  el("loadScenarioBtn").addEventListener("click", () => loadScenario(el("scenarioSelect").value));
  el("scenarioSelect").addEventListener("change", () => {
    setOutput("saveOutput", { selected_scenario: el("scenarioSelect").value, note: "点击“加载场景”后才会覆盖当前局面" });
  });
  el("loadExampleBtn").addEventListener("click", async () => {
    applyStateDefaults(await loadJson("./example_state.json", FALLBACK_STATE));
    logEvent("load_example", "加载示例局面", {});
    renderState();
    renderDataOutput();
    focusOpeningView({ phaseTab: true });
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
    focusOpeningView({ phaseTab: true });
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
      state.units[unitId].temporary_overstack = false;
      if (verdict.details?.repaired_temporary_overstack) {
        for (const hex of [fromHex, state.units[unitId].hex]) {
          const stackOk = RulesEngine.checkStacking(rulesContext(), state, { hexes: [hex] });
          if (!stackOk.legal) continue;
          for (const candidate of Object.values(state.units || {})) {
            if (candidate.hex && normalizeHex(candidate.hex) === hex) candidate.temporary_overstack = false;
          }
        }
      }
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
    setOutput("moveOutput", verdict);
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
  syncExternalAiDefaults({ force: true });
  renderAiConfig();
  syncSetupControls();
  syncMapModeButtons();
  setSidePanelCollapsed(localStorage.getItem(SIDE_PANEL_COLLAPSED_KEY) === "1", { persist: false });
}

async function main() {
  syncVersionLabels();
  await initData();
  initControls();
}

globalThis.AlameinStudioDebug = {
  getState: () => structuredClone(state),
  aiStateSummary: () => aiStateSummary(),
  externalAiPayload: (toolResults = []) => externalAiPayload(toolResults),
  checkVictory: () => checkVictory(),
  suggestRulesAction: () => suggestRulesAction(),
  enumerateLegalAiActions: (limit = 50) => enumerateLegalAiActions(limit).map(compactAction),
  autoPlayAi: (maxSteps = 80) => autoPlayAi(maxSteps)
};

main();
