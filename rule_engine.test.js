const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

test("July scenario runs from turn 1 through turn 7", () => {
  const scenario = JSON.parse(fs.readFileSync("./scenarios/july.json", "utf8"));
  assert.equal(scenario.turn, 1);
  assert.equal(Rules.SCENARIO_META.july.starting_turn, 1);
  assert.equal(Rules.SCENARIO_META.july.final_turn, 7);
});

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

test("scenario engineers use their printed (1)4 values", () => {
  const scenarios = ["september", "october"].map((name) => JSON.parse(fs.readFileSync(`./scenarios/${name}.json`, "utf8")));
  const engineers = scenarios.flatMap((scenario) => Object.values(scenario.units).filter((unit) => unit.kind === "engineer"));
  assert.equal(engineers.length, 8);
  for (const engineer of engineers) {
    assert.equal(engineer.attack, 1);
    assert.equal(engineer.defense, 1);
    assert.equal(engineer.movement, 4);
    assert.equal(engineer.parenthesized_attack, true);
  }
});

test("October Axis movement cannot cross west of the retreat line before turn 11", () => {
  const state = baseState({
    scenario: "october",
    turn: 10,
    phase: "axis_mechanized_movement",
    active_side: "axis",
    units: {
      tank: { side: "axis", hex: "1809", state: "fresh", attack: 2, defense: 2, movement: 10, kind: "ground", piece_type: "Mech" }
    }
  });
  const direct = Rules.checkMove(ctx(state), "tank", ["1809", "1709"]);
  const loop = Rules.checkMove(ctx(state), "tank", ["1809", "1709", "1809"]);
  assert.equal(direct.legal, false);
  assert.match(direct.reason, /撤退线/);
  assert.equal(loop.legal, false);
  assert.match(loop.reason, /撤退线/);
});

test("coastal all-sea hexes block movement and automatic pathfinding", () => {
  const terrain = JSON.parse(fs.readFileSync("./terrain.json", "utf8"));
  const state = baseState({
    units: {
      tank: { side: "axis", hex: "3209", state: "fresh", attack: 2, defense: 2, movement: 10, kind: "ground", piece_type: "Mech" }
    }
  });
  const context = ctx(state, terrain);
  assert.equal(Rules.hexTags(context, "3408").includes("all_sea"), true);
  const verdict = Rules.checkMove(context, "tank", ["3209", "3309", "3408"]);
  assert.equal(verdict.legal, false);
  assert.match(verdict.reason, /海边|海域|禁止进入/);
  assert.equal(Rules.findLegalPath(context, "tank", "4210"), null);
});

test("reviewed coastline hexes remain land-passable while their northern sea hexes stay blocked", () => {
  const terrain = JSON.parse(fs.readFileSync("./terrain.json", "utf8"));
  const state = baseState({
    units: {
      tank: { side: "axis", hex: "1303", state: "fresh", attack: 2, defense: 2, movement: 10, kind: "ground", piece_type: "Mech" }
    }
  });
  const context = ctx(state, terrain);
  for (const hex of terrain.notes.coastline) {
    const tags = Rules.hexTags(context, hex);
    assert.equal(tags.includes("coastline"), true, `${hex} should be identified as coastline`);
    assert.equal(tags.includes("all_sea"), false, `${hex} should retain a land portion`);
  }
  assert.equal(Rules.hexTags(context, "1301").includes("all_sea"), true);
  assert.equal(Rules.checkMove(context, "tank", ["1303", "1302"]).legal, true);
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

test("engineer explicitly counts as a friendly stay-behind unit in enemy ZOC", () => {
  const state = baseState({
    units: {
      mover: { side: "axis", hex: "2915", state: "fresh", attack: 2, defense: 2, movement: 6, kind: "ground" },
      engineer: { side: "axis", hex: "2915", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "engineer", parenthesized_attack: true },
      enemy: { side: "allies", hex: "2916", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const context = ctx(state);
  assert.deepEqual(Rules.zocHexes({ id: "engineer", ...state.units.engineer }), []);
  const verdict = Rules.checkMove(context, "mover", ["2915", "3014"]);
  assert.equal(verdict.legal, true, verdict.reason);
});

test("blocked supply sources do not seed supply unless a friendly unit cancels enemy ZOC", () => {
  const state = baseState({
    units: {
      enemy: { side: "allies", hex: "0201", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  let context = ctx(state);
  let network = Rules.buildSupplyNetwork(context, "axis");
  assert.equal(network.distances.has("0101"), false);
  assert.equal(network.distances.has("0102"), false);

  state.units.friendly = { side: "axis", hex: "0101", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" };
  context = ctx(state);
  network = Rules.buildSupplyNetwork(context, "axis");
  assert.equal(network.distances.get("0101"), 0);
});

test("legacy mine_cleared_entry cannot bypass an uncleared enemy minefield", () => {
  const state = baseState({
    units: {
      mover: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", mine_cleared_entry: true },
      mine: { side: "allies", hex: "0202", state: "fresh", attack: 0, defense: 0, movement: 0, kind: "mine" }
    }
  });
  const context = ctx(state);
  assert.equal("mine_cleared_entry" in state.units.mover, false);
  const verdict = Rules.checkMove(context, "mover", ["0202", "0203"]);
  assert.equal(verdict.legal, false);
  assert.match(verdict.reason, /雷区/);
});

test("live supply vanguard overrides and invalidates cached road marker coordinates", () => {
  const terrain = { hexes: {}, edges: {}, notes: { coastal_road: Rules.DEFAULT_ROAD_PATH } };
  const state = baseState({
    road_supply_markers: { axis: "0503" },
    units: {
      vanguard: { side: "axis", hex: "1005", state: "fresh", attack: 0, defense: 0, movement: 0, kind: "supply", name: "Supply Vanguard" }
    }
  });
  Rules.applyStateDefaults(state);
  assert.equal(state.road_supply_markers.axis, "1005");
  let context = Rules.createContext({ state, rules: Rules.DEFAULT_RULES, terrain });
  assert.equal(Rules.activeRoadSegment(context, "axis").has("1005"), true);

  state.units.vanguard.off_map = true;
  Rules.applyStateDefaults(state);
  assert.equal(state.road_supply_markers.axis, undefined);
  context = Rules.createContext({ state, rules: Rules.DEFAULT_RULES, terrain });
  assert.equal(Rules.activeRoadSegment(context, "axis").size, 0);
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

test("road mode multiplies only remaining movement after entry cost", () => {
  const state = baseState({
    units: {
      tank: { side: "axis", hex: "0101", state: "fresh", attack: 2, defense: 2, movement: 6, kind: "ground", piece_type: "Mech" }
    }
  });
  const terrain = { hexes: {}, edges: {}, notes: { coastal_road: Rules.DEFAULT_ROAD_PATH } };
  const legalPath = Rules.DEFAULT_ROAD_PATH.slice(0, 16);
  const tooFarPath = Rules.DEFAULT_ROAD_PATH.slice(0, 17);
  const legal = Rules.checkMove(ctx(state, terrain), "tank", legalPath, { mode: "road" });
  const tooFar = Rules.checkMove(ctx(state, terrain), "tank", tooFarPath, { mode: "road" });
  assert.equal(legal.legal, true, legal.reason);
  assert.equal(legal.details.allowance, 18);
  assert.equal(legal.details.spent, 18);
  assert.equal(tooFar.legal, false);
  assert.match(tooFar.reason, /移动力 18/);
});

test("supply vanguard marker does not block road mode entry", () => {
  const state = baseState({
    units: {
      tank: { side: "axis", hex: "0101", state: "fresh", attack: 2, defense: 2, movement: 6, kind: "ground", piece_type: "Mech" },
      vanguard: { side: "axis", hex: "0101", state: "fresh", attack: 0, defense: 0, movement: 0, kind: "supply", name: "Supply Vanguard" }
    }
  });
  const terrain = { hexes: {}, edges: {}, notes: { coastal_road: Rules.DEFAULT_ROAD_PATH } };
  const verdict = Rules.checkMove(ctx(state, terrain), "tank", Rules.DEFAULT_ROAD_PATH.slice(0, 2), { mode: "road" });
  assert.equal(verdict.legal, true, verdict.reason);
  assert.equal(verdict.details.steps.some((step) => step.terrain === "leave_stack"), false);
});

test("road mode movement space must remain empty while moving", () => {
  const state = baseState({
    units: {
      tank: { side: "axis", hex: "0101", state: "fresh", attack: 2, defense: 2, movement: 6, kind: "ground", piece_type: "Mech" },
      blocker: { side: "axis", hex: "0301", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const terrain = { hexes: {}, edges: {}, notes: { coastal_road: Rules.DEFAULT_ROAD_PATH } };
  const verdict = Rules.checkMove(ctx(state, terrain), "tank", ["0101", "0201"], { mode: "road" });
  assert.equal(verdict.legal, false);
  assert.match(verdict.reason, /前\/后方|道路移动空间/);
});

test("leaving road mode is a judged movement-cost action", () => {
  const state = baseState({
    units: {
      tank: { side: "axis", hex: "0201", state: "fresh", attack: 2, defense: 2, movement: 6, kind: "ground", piece_type: "Mech", road_mode: true, road_facing: 0, facing: 0 }
    }
  });
  const verdict = Rules.checkLeaveRoadMode(ctx(state), "tank");
  assert.equal(verdict.legal, true, verdict.reason);
  assert.equal(verdict.details.spent, 3);
  const result = Rules.leaveRoadMode(ctx(state), "tank");
  assert.equal(result.legal, true, result.reason);
  assert.equal(state.units.tank.road_mode, false);
  assert.equal(state.units.tank.state, "spent");
});

test("temporary overstack must be repaired before other movement", () => {
  const state = baseState({
    phase: "allies_initial_movement",
    active_side: "allies",
    units: {
      u1: { side: "allies", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      u2: { side: "allies", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      u3: { side: "allies", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      u4: { side: "allies", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", temporary_overstack: true },
      other: { side: "allies", hex: "0101", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const blocked = Rules.checkMove(ctx(state), "other", ["0101", "0201"]);
  assert.equal(blocked.legal, false);
  assert.match(blocked.reason, /临时超堆叠/);
  const repair = Rules.checkMove(ctx(state), "u4", ["0202", "0201"]);
  assert.equal(repair.legal, true, repair.reason);
  assert.equal(repair.details.repaired_temporary_overstack, true);
});

test("stacking uses only the Allied 3 and Axis 4 unit limits", () => {
  const state = baseState({
    units: {
      a1: { side: "allies", hex: "0202", kind: "ground", size: "division" },
      a2: { side: "allies", hex: "0202", kind: "ground", size: "division" },
      a3: { side: "allies", hex: "0202", kind: "ground", size: "division" },
      ae1: { side: "allies", hex: "0202", kind: "engineer" },
      ae2: { side: "allies", hex: "0202", kind: "engineer" },
      x1: { side: "axis", hex: "0303", kind: "ground", size: "division" },
      x2: { side: "axis", hex: "0303", kind: "ground", size: "division" },
      x3: { side: "axis", hex: "0303", kind: "ground", size: "division" },
      x4: { side: "axis", hex: "0303", kind: "ground", size: "division" }
    }
  });
  assert.equal(Rules.checkStacking(ctx(state)).legal, true);
  state.units.a4 = { side: "allies", hex: "0202", kind: "ground", size: "division" };
  const alliedOverstack = Rules.checkStacking(ctx(state));
  assert.equal(alliedOverstack.legal, false);
  assert.match(alliedOverstack.reason, /allies 4 个单位，超过 3/);
  assert.doesNotMatch(alliedOverstack.reason, /个师/);
});

test("retreat avoids an overstack when another equal-priority route exists", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 5, defense: 5, movement: 4, kind: "ground" },
      s1: { side: "axis", hex: "0102", kind: "ground" },
      s2: { side: "axis", hex: "0102", kind: "ground" },
      s3: { side: "axis", hex: "0102", kind: "ground" },
      s4: { side: "axis", hex: "0102", kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" }
    }
  });
  const plan = Rules.planRetreats(ctx(state), ["a"], 1, {});
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.pending.options.map((option) => option.hex), ["0103"]);
});

test("retreat may temporarily overstack only when the priority route is unique", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 5, defense: 5, movement: 4, kind: "ground" },
      s1: { side: "axis", hex: "0102", kind: "ground" },
      s2: { side: "axis", hex: "0102", kind: "ground" },
      s3: { side: "axis", hex: "0102", kind: "ground" },
      s4: { side: "axis", hex: "0102", kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" },
      mine: { side: "allies", hex: "0103", kind: "mine" }
    }
  });
  const context = ctx(state);
  const plan = Rules.planRetreats(context, ["a"], 1, {});
  assert.deepEqual(plan.pending.options.map((option) => option.hex), ["0102"]);
  assert.equal(plan.pending.options[0].temporary_overstack, true);
  const result = Rules.resolveCombat(context, {
    attackers: ["a"],
    defender_hexes: ["0302"],
    die: 1,
    retreat_paths: { a: ["0102"] }
  });
  assert.equal(result.legal, true, result.reason);
  assert.equal(Rules.temporaryOverstackGroups(context, "axis")[0].excess, 1);
  assert.equal(Object.values(state.units).filter((unit) => unit.temporary_overstack).length, 5);
});

test("a large temporary overstack can be repaired through consecutive moves", () => {
  const units = {};
  for (let index = 1; index <= 6; index += 1) {
    units[`u${index}`] = { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", temporary_overstack: true };
  }
  const state = baseState({ units });
  let context = ctx(state);
  const first = Rules.checkMove(context, "u6", ["0202", "0201"]);
  assert.equal(first.legal, true, first.reason);
  assert.equal(first.details.progressed_temporary_overstack, true);
  state.units.u6.hex = "0201";
  state.units.u6.temporary_overstack = false;
  context = ctx(state);
  const second = Rules.checkMove(context, "u5", ["0202", "0302"]);
  assert.equal(second.legal, true, second.reason);
  assert.equal(second.details.repaired_temporary_overstack, true);
});

test("owner may eliminate an excess unit only when movement cannot repair the stack", () => {
  const state = baseState({
    phase: "allies_initial_movement",
    active_side: "allies",
    units: {
      u1: { side: "allies", hex: "0202", state: "fresh", attack: 1, movement: 0, kind: "ground", temporary_overstack: true },
      u2: { side: "allies", hex: "0202", state: "fresh", attack: 1, movement: 0, kind: "ground", temporary_overstack: true },
      u3: { side: "allies", hex: "0202", state: "fresh", attack: 1, movement: 0, kind: "ground", temporary_overstack: true },
      u4: { side: "allies", hex: "0202", state: "fresh", attack: 1, movement: 0, kind: "ground", temporary_overstack: true }
    }
  });
  const context = ctx(state);
  assert.deepEqual(Rules.overstackRepairOptions(context, "0202"), []);
  const result = Rules.eliminateTemporaryOverstackUnit(context, "u4");
  assert.equal(result.legal, true, result.reason);
  assert.equal(state.units.u4.eliminated, true);
  assert.equal(Rules.temporaryOverstackGroups(context, "allies").length, 0);
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

test("multiple adjacent attackers combine strength against one defender hex", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      b: { side: "axis", hex: "0402", state: "fresh", attack: 3, defense: 3, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const verdict = Rules.checkCombat(ctx(state), { attackers: ["a", "b"], defender_hexes: ["0302"], die: 1 });
  assert.equal(verdict.legal, true, verdict.reason);
  assert.deepEqual(verdict.details.attackers, ["a", "b"]);
  assert.equal(verdict.details.attack, 5);
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

test("player may choose among equally ranked retreat hexes", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 5, defense: 5, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" }
    }
  });
  const context = ctx(state);
  const plan = Rules.planRetreats(context, ["a"], 1, {});
  assert.equal(plan.legal, true, plan.reason);
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.pending.options.map((option) => option.hex), ["0102", "0103"]);

  const result = Rules.resolveCombat(context, {
    attackers: ["a"],
    defender_hexes: ["0302"],
    die: 1,
    retreat_paths: { a: ["0103"] }
  });
  assert.equal(result.legal, true, result.reason);
  assert.equal(result.details.outcome, "A1");
  assert.equal(state.units.a.hex, "0103");
});

test("player-selected retreat order must be an exact unit permutation", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 3, defense: 3, movement: 4, kind: "ground" },
      b: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" }
    }
  });
  const result = Rules.resolveCombat(ctx(state), {
    attackers: ["a", "b"],
    defender_hexes: ["0302"],
    die: 1,
    retreat_order: ["b", "a"],
    retreat_paths: { b: ["0102"], a: ["0103"] }
  });
  assert.equal(result.legal, true, result.reason);
  assert.equal(state.units.b.hex, "0102");
  assert.equal(state.units.a.hex, "0103");

  const invalidState = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 3, defense: 3, movement: 4, kind: "ground" },
      b: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" }
    }
  });
  const invalid = Rules.resolveCombat(ctx(invalidState), {
    attackers: ["a", "b"],
    defender_hexes: ["0302"],
    die: 1,
    retreat_order: ["b", "b"],
    retreat_paths: { b: ["0102"], a: ["0103"] }
  });
  assert.equal(invalid.legal, false);
  assert.match(invalid.reason, /撤退处理顺序/);
});

test("AI retreat planner completes mandatory retreat without player input", () => {
  const state = baseState({
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 5, defense: 5, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" }
    }
  });
  const plan = Rules.autoPlanRetreats(ctx(state), ["a"], 1);
  assert.equal(plan.legal, true, plan.reason);
  assert.equal(plan.complete, true, plan.reason);
  assert.deepEqual(plan.paths.a, ["0102"]);
  assert.equal(plan.destinations.a, "0102");
});

test("unreachable movement diagnosis reports the exact stacking failure", () => {
  const state = baseState({
    phase: "axis_initial_movement",
    active_side: "axis",
    units: {
      mover: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 10, kind: "ground", piece_type: "Mech", size: "regiment" },
      stay: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", size: "regiment" },
      t1: { side: "axis", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", size: "regiment" },
      t2: { side: "axis", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", size: "regiment" },
      t3: { side: "axis", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", size: "regiment" },
      t4: { side: "axis", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", size: "regiment" }
    }
  });
  const verdict = Rules.diagnoseUnreachableMove(ctx(state), "mover", "0302", { mode: "normal" });
  assert.equal(verdict.legal, false);
  assert.match(verdict.reason, /0302/);
  assert.match(verdict.reason, /超过 4/);
});

test("over-budget movement diagnosis lists terrain and stacking costs", () => {
  const state = baseState({
    units: {
      mover: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 10, kind: "ground", piece_type: "Mech", size: "regiment" },
      stay: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", size: "regiment" },
      target: { side: "axis", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground", size: "regiment" }
    }
  });
  const terrain = { hexes: { "0302": ["hill_or_ridge"] }, edges: {} };
  const verdict = Rules.diagnoseUnreachableMove(ctx(state, terrain), "mover", "0302", { mode: "normal" });
  assert.equal(verdict.legal, false);
  assert.match(verdict.reason, /移动力 10 MP/);
  assert.match(verdict.reason, /需要 11 MP/);
  assert.match(verdict.reason, /离开 0202 堆叠 3 MP/);
  assert.match(verdict.reason, /进入 0302 堆叠 3 MP/);
  assert.match(verdict.reason, /0202 → 0302 山脊 5 MP/);
});

test("retreat choice must follow the highest-priority legal options", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 5, defense: 5, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" }
    }
  });
  const result = Rules.resolveCombat(ctx(state), {
    attackers: ["a"],
    defender_hexes: ["0302"],
    die: 1,
    retreat_paths: { a: ["0201"] }
  });
  assert.equal(result.legal, false);
  assert.match(result.reason, /撤退优先级/);
  assert.equal(state.units.a.hex, "0202");
  assert.equal(state.units.a.state, "fresh");
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
  assert.equal(result.details.die, 2);
  assert.equal(state.units.a.mine_cleared_this_turn, true);
  assert.equal(state.units.a.cleared_mine_this_turn, true);
});

test("combat mine-clear success reports the actual die and removes the minefield", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      mine: { side: "allies", hex: "0302", kind: "mine" }
    }
  });
  const result = Rules.clearMine(ctx(state), "a", "0302", 5);
  assert.equal(result.legal, true);
  assert.equal(result.details.cleared, true);
  assert.equal(result.details.die, 5);
  assert.equal(state.units.mine.eliminated, true);
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

test("engineer assist cancels enemy minefield defense doubling", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
      eng: { side: "axis", hex: "0201", state: "fresh", attack: 0, defense: 1, movement: 4, kind: "engineer" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      mine: { side: "allies", hex: "0302", kind: "mine" }
    }
  });
  const verdict = Rules.checkCombat(ctx(state), { attackers: ["a"], defender_hexes: ["0302"], engineer_assists: ["eng"], die: 1 });
  assert.equal(verdict.legal, true, verdict.reason);
  assert.equal(verdict.details.defense, 1);
  assert.deepEqual(verdict.details.mine_defense_canceled_hexes, ["0302"]);
  const result = Rules.resolveCombat(ctx(state), { attackers: ["a"], defender_hexes: ["0302"], engineer_assists: ["eng"], die: 1, advance_attacker: false });
  assert.equal(result.legal, true, result.reason);
  assert.equal(state.units.eng.engineer_assisted_this_turn, true);
});

test("engineer cannot clear mines after assisting an attack this turn", () => {
  const state = baseState({
    phase: "axis_initial_movement",
    units: {
      eng: { side: "axis", hex: "0201", state: "fresh", attack: 0, defense: 1, movement: 4, kind: "engineer", engineer_assisted_this_turn: true },
      mine: { side: "allies", hex: "0302", kind: "mine" }
    }
  });
  const result = Rules.clearMine(ctx(state), "eng", "0302");
  assert.equal(result.legal, false);
  assert.match(result.reason, /已协助攻击/);
});

test("engineer uses printed (1)4 values, defends, and cannot attack", () => {
  const state = baseState({
    phase: "allies_combat",
    active_side: "allies",
    units: {
      eng: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "engineer", parenthesized_attack: true },
      enemy: { side: "allies", hex: "0302", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" }
    }
  });
  const context = ctx(state);
  assert.equal(Rules.isCombatUnit({ id: "eng", ...state.units.eng }), true);
  assert.equal(Rules.canAttackUnit({ id: "eng", ...state.units.eng }), false);
  assert.equal(Rules.checkCombat(context, { attackers: ["eng"], defender_hexes: ["0302"] }).legal, false);
  const defense = Rules.checkCombat(context, { attackers: ["enemy"], defender_hexes: ["0202"] });
  assert.equal(defense.legal, true, defense.reason);
  assert.equal(defense.details.defense, 1);
});

test("defender advance after attacker retreat is optional and explicit", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 10, defense: 10, movement: 4, kind: "ground" }
    }
  });
  const result = Rules.resolveCombat(ctx(state), { attackers: ["a"], defender_hexes: ["0302"], die: 1, defender_advance: { unit: "d", target: "0202" } });
  assert.equal(result.legal, true, result.reason);
  assert.equal(result.details.outcome, "A3");
  assert.deepEqual(result.details.effects.defender_advanced, { unit: "d", to: "0202" });
  assert.equal(state.units.d.hex, "0202");
});

test("attacker advance is limited to a vacated defender hex", () => {
  const state = baseState({
    phase: "axis_combat",
    units: {
      a: { side: "axis", hex: "0202", state: "fresh", attack: 7, defense: 7, movement: 4, kind: "ground" },
      d: { side: "allies", hex: "0302", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  });
  const result = Rules.resolveCombat(ctx(state), {
    attackers: ["a"],
    defender_hexes: ["0302"],
    die: 1,
    advance_attacker: { unit: "a", target: "0201" }
  });
  assert.equal(result.legal, true, result.reason);
  assert.equal(result.details.outcome, "De");
  assert.equal(result.details.effects.advanced, null);
  assert.equal(state.units.a.hex, "0202");
  assert.equal(state.units.d.eliminated, true);
  assert.equal(Rules.checkStacking(ctx(state)).legal, true);
});

test("off-map and coordinate-less units do not crash supply checks", () => {
  const state = baseState({
    units: {
      active: { side: "axis", hex: "0101", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      exited: { side: "axis", hex: "0102", state: "spent", attack: 1, defense: 1, movement: 4, kind: "ground", off_map: true },
      missing: { side: "axis", hex: null, state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" },
      supply: { side: "axis", hex: null, state: "fresh", attack: 0, defense: 0, movement: 4, kind: "supply" }
    }
  });
  const context = ctx(state);
  assert.equal(Rules.supplyState(context, "exited"), "off_map");
  assert.equal(Rules.supplyState(context, "missing"), "off_map");
  assert.deepEqual(Object.keys(Rules.checkSupply(context, "axis")), ["active"]);
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

test("October west exits score as off-map withdrawals without elimination or a map hex", () => {
  const state = baseState({
    scenario: "october",
    turn: 11,
    phase: "end_game_turn",
    active_side: "axis",
    units: {
      exited: {
        side: "axis",
        hex: null,
        off_map: true,
        eliminated: false,
        exited: "west",
        exited_edge: "west",
        exited_turn: 11,
        exit_hex: "0101",
        attack: 4,
        defense: 4,
        movement: 10,
        kind: "ground"
      }
    }
  });
  const result = Rules.calculateVictoryPoints(ctx(state));
  assert.equal(result.victory_points, Rules.SCENARIO_META.october.starting_vp + 4);
  assert.equal(result.breakdown.some((item) => item.id === "october_combat_exited_west"), true);
});
