const test = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("./rule_engine.js");

function ctx(state, terrain = { hexes: {}, edges: {} }) {
  Rules.applyStateDefaults(state);
  return Rules.createContext({ state, rules: Rules.DEFAULT_RULES, terrain });
}

function baseState(overrides = {}) {
  return {
    scenario: "july",
    turn: 1,
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {},
    ...overrides
  };
}

test("September turn 1 skips Allies initial movement", () => {
  const state = baseState({ scenario: "september", turn: 1, phase: "axis_supply_movement" });
  const next = Rules.nextPhase(ctx(state));
  assert.equal(next.phase, "allies_combat");
  assert.equal(next.turn_increment, 0);
});

test("October standard scenario defaults to Allies first player", () => {
  const state = baseState({ scenario: "october", turn: 1, phase: "axis_initial_movement", active_side: "axis" });
  Rules.applyStateDefaults(state);
  assert.equal(state.phase, "allies_initial_movement");
  assert.equal(state.active_side, "allies");
});

test("single unit cannot voluntarily leave enemy ZOC without friendly stay-behind", () => {
  const state = baseState({
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      e: { side: "allies", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const verdict = Rules.checkMove(ctx(state), "a", ["0202", "0201"]);
  assert.equal(verdict.legal, false);
  assert.match(verdict.reason, /ZOC/);
});

test("unit may leave enemy ZOC when a friendly unit remains in the origin hex", () => {
  const state = baseState({
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      stay: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      e: { side: "allies", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const verdict = Rules.checkMove(ctx(state), "a", ["0202", "0201"]);
  assert.equal(verdict.legal, true, verdict.reason);
});

test("entering a friendly stack adds mechanized stack cost", () => {
  const state = baseState({
    units: {
      tank: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 6, kind: "ground", piece_type: "Mech" },
      friend: { side: "axis", hex: "0201", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const verdict = Rules.checkMove(ctx(state), "tank", ["0202", "0201"]);
  assert.equal(verdict.legal, true, verdict.reason);
  assert.equal(verdict.details.spent, 4);
});

test("odds below 1:4 are resolved on the 1:4 column", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" }
    }
  });
  const verdict = Rules.checkCombat(ctx(state), { attackers: ["a"], defender_hexes: ["0302"], die: 1 });
  assert.equal(verdict.legal, true, verdict.reason);
  assert.equal(verdict.details.odds_column, "1-4");
  assert.equal(verdict.details.outcome, "A3");
});

test("attackers must be adjacent to a selected defender hex", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      far: { side: "axis", hex: "0101", state: "fresh", attack: 10, defense: 1, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const verdict = Rules.checkCombat(ctx(state), { attackers: ["a", "far"], defender_hexes: ["0302"], die: 1 });
  assert.equal(verdict.legal, false);
  assert.match(verdict.reason, /邻接/);
});

test("hill/ridge defense cancels D retreat combat results", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const terrain = { hexes: { "0302": ["hill_or_ridge"] }, edges: {} };
  const verdict = Rules.checkCombat(ctx(state, terrain), { attackers: ["a"], defender_hexes: ["0302"], die: 1 });
  assert.equal(verdict.legal, true, verdict.reason);
  assert.equal(verdict.details.raw_outcome, "D1");
  assert.equal(verdict.details.outcome, "No Effect");
});

test("map-edge supply source only grants automatic supply within 4 hexes", () => {
  const state = baseState({
    units: {
      near: { side: "axis", hex: "0501", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      far: { side: "axis", hex: "0701", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const supply = Rules.checkSupply(ctx(state), "axis");
  assert.equal(supply.near, "supplied");
  assert.equal(supply.far, "partially_supplied");
});

test("terrain coastal road path supplies Axis units near the road vanguard", () => {
  const state = baseState({
    road_supply_markers: { axis: "3208" },
    units: {
      front: { side: "axis", hex: "3510", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const terrain = { hexes: {}, edges: {}, notes: { coastal_road: ["0101", "0201", "0302", "3108", "3208", "3309", "3409", "3510", "3610", "3711"] } };
  const supply = Rules.checkSupply(ctx(state, terrain), "axis");
  assert.equal(supply.front, "supplied");
});

test("July east VP uses current supply tracing over stale unit supply state", () => {
  const state = baseState({
    scenario: "july",
    road_supply_markers: { axis: "3208" },
    units: {
      front: { side: "axis", hex: "3510", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", supply_state: "isolated" }
    }
  });
  const terrain = { hexes: {}, edges: {}, notes: { coastal_road: ["0101", "0201", "0302", "3108", "3208", "3309", "3409", "3510"] } };
  const result = Rules.calculateVictoryPoints(ctx(state, terrain));
  assert.equal(result.victory_points, 28);
  assert.equal(result.breakdown.some((item) => item.id === "july_east_of_3400"), true);
});

test("combat mine-clear failure consumes the unit attempt for the turn", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      mine: { side: "allies", hex: "0302", kind: "mine" }
    }
  });
  const result = Rules.clearMine(ctx(state), "a", "0302", 2);
  assert.equal(result.legal, true);
  assert.equal(result.details.cleared, false);
  assert.equal(state.units.a.mine_cleared_this_turn, true);
  assert.equal(state.units.a.cleared_mine_this_turn, true);
});

test("friendly minefield doubles defender strength", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      mine: { side: "allies", hex: "0302", kind: "mine" }
    }
  });
  const verdict = Rules.checkCombat(ctx(state), { attackers: ["a"], defender_hexes: ["0302"], die: 1 });
  assert.equal(verdict.legal, true, verdict.reason);
  assert.equal(verdict.details.defense, 2);
  assert.equal(verdict.details.odds_column, "1-1");
});

test("September VP counts Axis-cleared Allied minefields", () => {
  const state = baseState({
    scenario: "september",
    units: {
      mine: { side: "allies", hex: "0302", kind: "mine", eliminated: true, eliminated_reason: "mine_cleared", cleared_by_side: "axis" }
    }
  });
  const result = Rules.calculateVictoryPoints(ctx(state));
  assert.equal(result.victory_points, 38);
});

test("Exchange losses do not award Allied eliminated combat VP", () => {
  const state = baseState({
    units: {
      d: { side: "allies", hex: "0302", kind: "ground", eliminated: true, eliminated_reason: "exchange", attack: 1, defense: 1, movement: 4 }
    }
  });
  const result = Rules.calculateVictoryPoints(ctx(state));
  assert.equal(result.victory_points, 25);
});
