"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { makeReplay } = require("../experiments/ai_replay.js");

test("replay reports a provider action only after the phase state is applied", async () => {
  const replay = makeReplay("july", { seed: 1942 });
  const applied = [];
  const provider = async ({ state, side, phase, turn, step }) => ({
    action: { type: "pass", reason: "test phase advance" },
    model: { provider: "mock", state_before_phase: state.phase }
  });
  provider.onActionApplied = async (event) => {
    applied.push(event);
  };

  const result = await replay.playWithProvider({
    maxSteps: 1,
    externalSide: "axis",
    externalAction: provider
  });

  assert.equal(result.steps, 1);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].applied, true);
  assert.equal(applied[0].from_phase, "axis_initial_movement");
  assert.notEqual(applied[0].to_phase, applied[0].from_phase);
  assert.equal(applied[0].state.phase, applied[0].to_phase);
  assert.equal(applied[0].action.type, "pass");
});

test("replay can run a local heuristic controller against the rules controller", async () => {
  const replay = makeReplay("july", { seed: 1942 });
  const result = await replay.playWithProvider({
    maxSteps: 2,
    controllers: { axis: "heuristic_ai", allies: "rules_ai" }
  });
  assert.notEqual(result.status, "provider_error");
  assert.ok(result.log.length > 0);
  assert.ok(result.log.every((item) => item.controller === "heuristic_ai" || item.controller === "rules_ai" || !item.side));
});

test("human controller stops an automated replay explicitly", async () => {
  const replay = makeReplay("july", { seed: 1942 });
  const result = await replay.playWithProvider({
    maxSteps: 2,
    controllers: { axis: "human", allies: "rules_ai" }
  });
  assert.equal(result.status, "waiting_for_human");
  assert.equal(result.waiting_for_human, "axis");
});

test("replay completes an exchange outcome after a valid model combat action", async () => {
  const replay = makeReplay("july", { seed: 1942 });
  replay.state.phase = "axis_combat";
  replay.state.active_side = "axis";
  replay.state.road_supply_markers = { axis: "2424" };
  replay.state.scenario_meta = { road_path: ["0101", "2424"] };
  replay.state.units = {
    attacker_a: { side: "axis", hex: "2424", state: "fresh", attack: 4, defense: 2, movement: 4, kind: "ground" },
    attacker_b: { side: "axis", hex: "2424", state: "fresh", attack: 4, defense: 2, movement: 4, kind: "ground" },
    defender: { side: "allies", hex: "2525", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
  };
  const provider = async () => ({
    action: { type: "combat", attackers: ["attacker_a", "attacker_b"], defender_hexes: ["2525"] }
  });

  const result = await replay.playWithProvider({
    maxSteps: 1,
    externalSide: "axis",
    externalAction: provider
  });

  assert.notEqual(result.status, "illegal_action");
  assert.equal(result.log[0].result.legal, true);
  assert.equal(result.log[0].result.die, 4);
  assert.deepEqual(result.log[0].result.resolution.automatic_exchange_loss_ids, ["attacker_a"]);
});
