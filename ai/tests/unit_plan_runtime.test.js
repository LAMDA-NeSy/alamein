"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { makeReplay } = require("../experiments/ai_replay.js");
const {
  buildPlanningSnapshot,
  createUnitPlanRuntime,
  historyAdjustment,
  normalizeUnitPlan,
  parseModelJson
} = require("../core/unit_plan_runtime.js");
const { readConfig } = require("../experiments/external_ai_transcript.js");
const { createActionRuleBridge } = require("../core/action_rule_bridge.js");
const Rules = require("../../rule_engine.js");

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
  assert.ok(snapshot.units.every((item) => item.recommendation_target === "3711"));
  assert.ok(snapshot.units.every((item) => item.recommendation_source === "phase_intent"));
});

test("planning snapshot ignores malformed cached task and intent coordinates", () => {
  const state = { scenario: "october", active_side: "axis", turn: 11, phase: "axis_initial_movement", units: {
    a: { side: "axis", kind: "ground", hex: "0101", attack: 2, defense: 2, movement: 4, state: "fresh" }
  } };
  const snapshot = buildPlanningSnapshot(readConfig(), {
    state, side: "axis", turn: 11, phase: state.phase,
    operationState: { task_plan: { children: [{ id: "screen", status: "active", assigned_units: ["a"], target_hex: "28xx" }] } }
  }, { type: "withdraw", target_hex: "9999" }, new Map(), { max_recommendation_expansions: 1, max_options_per_unit: 1 });
  assert.ok(Rules.onMap(snapshot.units[0].recommendation_target));
  assert.equal(snapshot.units[0].recommendation_source, "local_candidate_search");
  assert.deepEqual(snapshot.units[0].target_corrections.map((item) => item.requested), ["28xx", "9999"]);
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

test("unit plan parser accepts a structured plan in reasoning_content", () => {
  const parsed = parseModelJson({
    response_json: {
      choices: [{ message: {
        content: "",
        reasoning_content: 'I inspected the phase. {"type":"phase_unit_plan","unit_orders":[{"unit":"a","disposition":"hold","target_hex":"","role":"reserve","priority":1,"reason":"preserve the reserve"}]}'
      } }]
    }
  });
  assert.equal(parsed.response_source, "reasoning_content");
  assert.equal(parsed.unit_orders[0].unit, "a");
});

test("normalization reports raw model coverage separately from local holds", () => {
  const normalized = normalizeUnitPlan({
    type: "phase_unit_plan",
    unit_orders: [{ unit: "a", disposition: "hold", target_hex: "", role: "reserve", priority: 1 }]
  }, { units: [unit("a"), unit("b")] });
  assert.equal(normalized.coverage, 1);
  assert.equal(normalized.model_covered_units, 1);
  assert.equal(normalized.model_unit_plan_coverage, 0.5);
  assert.deepEqual(normalized.omitted_units, ["b"]);
});

test("unit planner rejects root arrays and unrelated JSON instead of making a model hold plan", () => {
  for (const value of [[{ type: "phase_unit_plan", unit_orders: [] }], {}, { type: "final_action" }, { type: "phase_unit_plan", unit_orders: {} }]) {
    const parsed = parseModelJson({ response_json: { choices: [{ message: { content: JSON.stringify(value) } }] } });
    assert.ok(parsed.error, JSON.stringify(value));
  }
});

function tinyOctober() {
  return { scenario: "october", active_side: "axis", turn: 11, phase: "axis_initial_movement", units: {
    a: { side: "axis", kind: "ground", hex: "0101", attack: 2, defense: 2, movement: 4, state: "fresh" }
  } };
}

test("unit planner includes real task goals, feedback and a legal west exit, then executes it once", async () => {
  const state = tinyOctober();
  const config = readConfig();
  const bridge = createActionRuleBridge(config, { toolProfile: "rolling_unit_rules_tactical" });
  const input = { state, side: "axis", turn: 11, phase: state.phase, step: 1, operationState: {
    task_plan: { children: [{ id: "extract", status: "active", model_task_type: "exit_west", title: "Extract the force", completion_condition: "legal west exit", assigned_units: ["a"] }] },
    tactical_summary: { last_action_effect: { actual_vp_delta: 0 } }
  }, reasoningMemory: { recent: "previous preparation" } };
  const intent = { type: "withdraw" };
  const prepared = bridge.prepareStep({ ...input, session_id: "test", decisionMode: "unit_plan_hybrid", privateCandidates: false });
  let calls = 0;
  const runtime = createUnitPlanRuntime({ config, bridge, sessionId: "test", settings: { max_recommendation_expansions: 1 },
    runtime: { profile: { defaults: { temperature: 0 }, limits: { output: 1000 }, capabilities: {} } },
    client: { complete: async (request) => {
      calls++;
      const payload = JSON.parse(request.messages[1].content);
      assert.equal(payload.scenario, "october");
      assert.equal(payload.tasks[0].title, "Extract the force");
      assert.equal(payload.tasks[0].completion_condition, "legal west exit");
      assert.equal(payload.actionable_units[0].legal_exit_west, true);
      assert.equal(payload.actionable_units[0].recommended_actions, undefined);
      assert.ok(payload.scoring.current_scoring.october_withdrawal);
      assert.ok(payload.last_action_effect);
      assert.ok(payload.reasoning_memory);
      return { ok: true, response_json: { choices: [{ message: { content: JSON.stringify({ type: "phase_unit_plan", unit_orders: [
        { unit: "a", task_id: "extract", disposition: "exit_west", target_hex: "", role: "support", priority: 1 }
      ] }) } }] } };
    } }
  });
  const next = await runtime.next({ ...input, builtContext: bridge.current().built, preparedStep: prepared, phaseStatus: bridge.phaseStatus() }, intent);
  assert.equal(calls, 1);
  assert.equal(next.action.type, "exit_west");
  assert.equal(next.tool_result.accepted, true);
  assert.equal(next.prepared, prepared);
  assert.equal(next.execution.execution_source, "phase_plan");
  assert.equal(Rules.checkExitWest(bridge.current().built.ctx, next.action).legal, true);
  assert.equal(state.units.a.hex, "0101", "only replay may mutate the state");
  const nextState = structuredClone(state);
  Rules.applyExitWest(Rules.createContext({ state: nextState, rules: bridge.current().built.ctx.rules, terrain: bridge.current().built.ctx.terrain }), "a");
  const nextInput = { ...input, state: nextState, step: 2 };
  const nextPrepared = bridge.prepareStep({ ...nextInput, session_id: "test", decisionMode: "unit_plan_hybrid", privateCandidates: false });
  const done = await runtime.next({ ...nextInput, builtContext: bridge.current().built, preparedStep: nextPrepared }, intent);
  assert.equal(calls, 1, "cached orders do not require another planning request");
  assert.equal(done.action.type, "pass");
});

test("expired unit planning deadline does not issue a 1ms API request", async () => {
  const state = tinyOctober();
  const config = readConfig();
  const bridge = createActionRuleBridge(config, { toolProfile: "rolling_unit_rules_tactical" });
  const input = { state, side: "axis", turn: 11, phase: state.phase, step: 1 };
  const prepared = bridge.prepareStep({ ...input, privateCandidates: false, decisionMode: "unit_plan_hybrid", session_id: "test" });
  let calls = 0;
  const planner = createUnitPlanRuntime({ config, bridge, sessionId: "test", settings: { max_recommendation_expansions: 1 },
    runtime: { profile: { defaults: {}, limits: {}, capabilities: {} } },
    client: { complete: async () => { calls++; throw new Error("must not call"); } }
  });
  const next = await planner.next({ ...input, preparedStep: prepared, builtContext: bridge.current().built }, { type: "withdraw" }, Date.now() - 100);
  assert.equal(calls, 0);
  assert.equal(next.plan.source, "local_fallback");
  assert.match(next.plan.api.error, /deadline exhausted/);
  assert.equal(next.action.type, "exit_west");
});

test("focused repair suggestions enumerate only the affected unit", () => {
  const state = tinyOctober();
  state.units.b = { ...state.units.a, hex: "0103" };
  const snapshot = buildPlanningSnapshot(readConfig(), { state, side: "axis", turn: 11, phase: state.phase },
    { type: "withdraw" }, new Map(), { focus_unit: "a", max_recommendation_expansions: 1 });
  assert.deepEqual(snapshot.units.map((unit) => unit.unit), ["a"]);
});
