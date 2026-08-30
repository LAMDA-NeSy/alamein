"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildContext,
  evaluateManeuverTool,
  mapHexState,
  mapRegionHexes,
  mapTopologySummary,
  planRouteTool
} = require("../experiments/external_ai_transcript.js");
const julyScenario = require("../../scenarios/july.json");

function config() {
  return {
    provider: "mock",
    api: { model: "mock" },
    context: { maxUnitsPerSide: 40, maxUnitIndexPerSide: 160 },
    strategy: { doctrine: "test", priorities: [], actionContract: "test", phaseObjectives: {} }
  };
}

function buildJuly() {
  const state = JSON.parse(JSON.stringify(julyScenario));
  state.phase = "axis_initial_movement";
  state.active_side = "axis";
  return buildContext(config(), { state });
}

test("map topology exposes complete neighbors independently of status", () => {
  const built = buildJuly();
  const detail = mapHexState(built.ctx, "3511", "axis");
  assert.equal(detail.neighbors.length, 6);
  assert.ok(detail.neighbors.includes("3410"));
  assert.ok(detail.neighbors.includes("3512"));
  assert.ok(mapRegionHexes(built.ctx, "3511", 1).includes("3511"));
  assert.ok(mapTopologySummary(built.ctx).hex_count > 0);
});

test("route planning uses the authoritative movement/path checker", () => {
  const built = buildJuly();
  const unit = built.allUnits.find((item) => item.side === "axis" && item.hex && item.kind !== "mine");
  assert.ok(unit, "fixture should contain an Axis map unit");
  const target = unit.hex === "3511" ? "3611" : "3511";
  const result = planRouteTool(built.ctx, { unit: unit.id, target, max_routes: 3 });
  assert.equal(result.read_only, true);
  assert.ok(Array.isArray(result.routes));
  for (const route of result.routes) {
    assert.equal(route.path[0], unit.hex);
    assert.equal(route.path.at(-1), target);
  }
});

test("maneuver evaluation reports missing synchronization conditions", () => {
  const built = buildJuly();
  const units = built.allUnits.filter((item) => item.side === "axis" && item.hex && item.kind !== "mine").slice(0, 2);
  assert.equal(units.length, 2);
  const result = evaluateManeuverTool(built.ctx, {
    maneuver: {
      north: { units: [units[0].id], target_hex: units[0].hex },
      south: { units: [units[1].id], target_hex: units[1].hex }
    },
    attack_target: "3716"
  });
  assert.equal(result.read_only, true);
  assert.ok(["complete", "partial", "not_ready"].includes(result.maneuver_status));
  assert.ok(Array.isArray(result.missing_conditions));
});
