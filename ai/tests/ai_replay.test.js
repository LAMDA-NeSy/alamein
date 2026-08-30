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
