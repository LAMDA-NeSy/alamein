"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveControllers } = require("../core/controller_config.js");

test("controller config defaults both sides to the frontend rules AI", () => {
  assert.deepEqual(resolveControllers({}), {
    axis: "rules_ai",
    allies: "rules_ai",
    external_side: null,
    explicit: false,
    legacy_external_side: null
  });
});

test("legacy external side maps only the selected side to external_ai", () => {
  const axis = resolveControllers({ externalSide: "axis" });
  assert.equal(axis.axis, "external_ai");
  assert.equal(axis.allies, "rules_ai");
  assert.equal(axis.external_side, "axis");
  const allies = resolveControllers({ externalSide: "allies" });
  assert.equal(allies.axis, "rules_ai");
  assert.equal(allies.allies, "external_ai");
  assert.equal(allies.external_side, "allies");
});

test("explicit side controllers support mixed and mirrored matchups", () => {
  const mixed = resolveControllers({ axisController: "heuristic_ai", alliesController: "external_ai" });
  assert.equal(mixed.axis, "heuristic_ai");
  assert.equal(mixed.allies, "external_ai");
  assert.equal(mixed.external_side, "allies");
  const bothExternal = resolveControllers({ controllers: { axis: "external_ai", allies: "external_ai" } });
  assert.equal(bothExternal.external_side, null);
});

test("invalid controller values fail before a replay starts", () => {
  assert.throws(() => resolveControllers({ axisController: "random_ai" }), /invalid controller/);
});
