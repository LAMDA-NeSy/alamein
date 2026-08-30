"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { makeReplay } = require("../experiments/ai_replay.js");
const {
  buildPlanningSnapshot,
  historyAdjustment,
  normalizeUnitPlan,
  parseModelJson
} = require("../core/unit_plan_runtime.js");
const { readConfig } = require("../experiments/external_ai_transcript.js");

function unit(id, options = []) {
  return {
    unit: id,
    hex: "2412",
    forced_stack_repair: false,
    forced_stack_repair_hex: "",
    recommended_options: options
  };
}

test("unit plan normalization covers every eligible unit once and drops invalid orders", () => {
  const snapshot = {
    units: [unit("a", [{ destination: "2512" }]), unit("b")]
  };
  const normalized = normalizeUnitPlan({
    type: "phase_unit_plan",
    unit_orders: [
      { unit: "a", disposition: "move", target_hex: "2512", role: "flank", priority: 3 },
      { unit: "a", disposition: "hold", target_hex: "", role: "reserve", priority: 7 },
      { unit: "enemy", disposition: "move", target_hex: "2513", role: "support", priority: 1 }
    ]
  }, snapshot);

  assert.equal(normalized.coverage, 1);
  assert.deepEqual(normalized.orders.map((order) => order.unit).sort(), ["a", "b"]);
  assert.equal(normalized.orders.find((order) => order.unit === "a").disposition, "move");
  assert.equal(normalized.orders.find((order) => order.unit === "b").reason, "omitted_by_model");
  assert.deepEqual(normalized.omitted_units, ["b"]);
  assert.equal(normalized.invalid_orders.length, 1);
});

test("mandatory overstack repair is promoted ahead of ordinary planned movement", () => {
  const repair = {
    ...unit("repair", [{ destination: "2512" }]),
    forced_stack_repair: true,
    forced_stack_repair_hex: "2412",
    forced_stack_repair_excess: 1
  };
  const snapshot = { units: [repair, unit("ordinary", [{ destination: "2612" }])] };
  const normalized = normalizeUnitPlan({
    unit_orders: [
      { unit: "ordinary", disposition: "move", target_hex: "2612", role: "support", priority: 1 },
      { unit: "repair", disposition: "hold", target_hex: "", role: "reserve", priority: 2 }
    ]
  }, snapshot);

  assert.equal(normalized.orders[0].unit, "repair");
  assert.equal(normalized.orders[0].disposition, "move");
  assert.equal(normalized.orders[0].source, "forced_stack_repair");
});

test("movement history penalizes an immediate reversal and repeated destination", () => {
  const ctx = {
    state: { units: { mover: { side: "axis", hex: "2512", kind: "ground" } } },
    rules: {},
    terrain: { hexes: {}, edges: {} }
  };
  const result = historyAdjustment(ctx, {
    action: { unit: "mover", destination: "2412" },
    evaluation: { progress: -1, risks: [], victory_impact: {} }
  }, ["2412", "2512"], {
    reversal_penalty: 80,
    repeated_destination_penalty: 35
  });

  assert.equal(result.immediate_reversal, true);
  assert.equal(result.repeat_count, 1);
  assert.equal(result.adjustment, -115);
});

test("replay movement phases have no artificial action budget", () => {
  const replay = makeReplay("july", { seed: 1942 });
  replay.state.phase = "axis_initial_movement";
  replay.state.active_side = "axis";
  assert.equal(replay.debugPhaseActionLimit("axis"), 0);
  replay.state.phase = "axis_mechanized_movement";
  assert.equal(replay.debugPhaseActionLimit("axis"), 0);
  replay.state.phase = "axis_supply_movement";
  assert.equal(replay.debugPhaseActionLimit("axis"), 0);
  replay.state.phase = "axis_combat";
  assert.equal(replay.debugPhaseActionLimit("axis"), 3);
});

test("planning snapshot exposes computed supply for every eligible unit", () => {
  const replay = makeReplay("july", { seed: 1942 });
  const snapshot = buildPlanningSnapshot(readConfig(), {
    state: replay.state,
    side: "axis",
    phase: replay.state.phase,
    turn: replay.state.turn
  }, { type: "advance", sector: "central", target_hex: "3711", priority_units: [] }, new Map(), {
    max_options_per_unit: 1,
    max_reachable_hexes: 8,
    reversal_penalty: 80,
    repeated_destination_penalty: 35
  });

  assert.ok(snapshot.units.length > 10);
  assert.ok(snapshot.units.every((item) => ["supplied", "partially_supplied", "unsupplied", "isolated"].includes(item.supply)));
  assert.ok(snapshot.units.every((item) => item.recommended_options.length <= 1));
});

test("truncated model output recovers only complete unit orders", () => {
  const parsed = parseModelJson({
    response_json: {
      choices: [{ message: { content: '{"type":"phase_unit_plan","unit_orders":[{"unit":"a","disposition":"move","target_hex":"2512","role":"support","priority":1,"reason":"ok"},{"unit":"b","disposition":"move"' } }]
    }
  });

  assert.equal(parsed.partial_model_plan, true);
  assert.equal(parsed.unit_orders.length, 1);
  assert.equal(parsed.unit_orders[0].unit, "a");
  assert.match(parsed.parse_warning, /recovered 1 complete orders/);
});
