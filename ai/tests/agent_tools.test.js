"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getOpenAiToolDefinitions,
  loadToolCatalog,
  resolveToolProfile,
  toolPromptReference,
  toolProfileHash,
  validateToolProfile
} = require("../core/agent_tools.js");

test("tool descriptions and schemas load from the YAML catalog", () => {
  const catalog = loadToolCatalog();
  assert.equal(catalog.catalog_version, "v7");
  assert.deepEqual(Object.keys(catalog.tools), ["inspect_rules", "view_map", "plan_route", "evaluate_maneuver", "check_combat", "inspect_supply", "phase_status", "hold_unit", "hold_units", "act", "inspect", "evaluate_action", "submit_action"]);
  assert.match(catalog.tools.act.description, /authoritative rules engine/);
  assert.match(catalog.tool_docs.act.purpose, /Submit exactly one/);
  assert.match(catalog.tool_docs.view_map.output_guide, /neighbor/);
  assert.deepEqual(catalog.tools.view_map.parameters.properties.focus.enum, ["overview", "frontline", "region", "unit", "hex"]);
  assert.deepEqual(catalog.tools.act.parameters.properties.action, catalog.action_schema);
  assert.deepEqual(catalog.tools.check_combat.parameters.required, ["attackers", "defender_hexes"]);
  assert.deepEqual(catalog.tools.inspect_supply.parameters.required, ["unit"]);
  assert.deepEqual(catalog.tools.phase_status.parameters, { type: "object", additionalProperties: false });
  assert.match(catalog.tools.phase_status.description, /group.*enemy targets/i);
  assert.deepEqual(catalog.tools.inspect_rules.parameters.properties.topic.enum, ["overview", "scoring", "movement", "combat", "supply", "phase", "stacking"]);
  assert.deepEqual(catalog.tools.hold_unit.parameters.required, ["unit", "reason"]);
  assert.deepEqual(catalog.tools.hold_units.parameters.required, ["orders"]);
  assert.deepEqual(catalog.tools.plan_route.parameters.required, ["unit", "target"]);
  assert.deepEqual(catalog.tools.evaluate_maneuver.parameters.required, ["maneuver"]);
});

test("single_action profile exposes only act with a stable schema hash", () => {
  const profile = resolveToolProfile("single_action");
  assert.deepEqual(profile.tools, ["act"]);
  const definitions = getOpenAiToolDefinitions(profile);
  assert.deepEqual(definitions.map((item) => item.function.name), ["act"]);
  const action = definitions[0].function.parameters.properties.action;
  assert.equal(action.additionalProperties, false);
  assert.deepEqual(action.properties.attackers.items, { type: "string" });
  assert.deepEqual(action.properties.defender_hexes.items, { type: "string" });
  assert.match(toolProfileHash(profile), /^[a-f0-9]{64}$/);
});

test("map_and_action exposes exactly the read-only map and atomic action tools", () => {
  const profile = resolveToolProfile("map_and_action");
  assert.deepEqual(profile.tools, ["view_map", "act"]);
  const definitions = getOpenAiToolDefinitions(profile);
  assert.deepEqual(definitions.map((item) => item.function.name), ["view_map", "act"]);
  assert.equal(Object.hasOwn(definitions[0].function, "returns"), false);
  assert.deepEqual(definitions[0].function.parameters.properties.focus.enum, ["overview", "frontline", "region", "unit", "hex"]);
  assert.equal(definitions[0].function.parameters.additionalProperties, false);
});

test("map_tactical_action exposes map, combat, supply, and atomic action tools", () => {
  const profile = resolveToolProfile("map_tactical_action");
  assert.deepEqual(profile.tools, ["view_map", "check_combat", "inspect_supply", "phase_status", "act"]);
  assert.equal(profile.max_calls_per_step, 10);
  const definitions = getOpenAiToolDefinitions(profile);
  assert.deepEqual(definitions.map((item) => item.function.name), profile.tools);
  assert.equal(definitions[1].function.parameters.additionalProperties, false);
  assert.equal(definitions[2].function.parameters.properties.unit.minLength, 1);
});

test("map_route_tactical exposes topology, route, maneuver, and action tools", () => {
  const profile = resolveToolProfile("map_route_tactical");
  assert.deepEqual(profile.tools, ["view_map", "plan_route", "evaluate_maneuver", "inspect_supply", "check_combat", "act"]);
  assert.equal(profile.max_calls_per_step, 12);
  assert.deepEqual(getOpenAiToolDefinitions(profile).map((item) => item.function.name), profile.tools);
  const reference = toolPromptReference(profile);
  assert.match(reference, /Tool: view_map/);
  assert.match(reference, /Decision rule:/);
  assert.match(reference, /plan_route/);
});

test("rolling_unit_tactical exposes explicit phase progress, hold, and action tools", () => {
  const profile = resolveToolProfile("rolling_unit_tactical");
  assert.deepEqual(profile.tools, ["phase_status", "view_map", "inspect_supply", "check_combat", "hold_units", "hold_unit", "act"]);
  assert.equal(profile.max_calls_per_step, 20);
  assert.deepEqual(getOpenAiToolDefinitions(profile).map((item) => item.function.name), profile.tools);
});

test("rolling_unit_rules_tactical exposes on-demand rule lookup", () => {
  const profile = resolveToolProfile("rolling_unit_rules_tactical");
  assert.deepEqual(profile.tools, ["phase_status", "inspect_rules", "view_map", "inspect_supply", "check_combat", "hold_units", "hold_unit", "act"]);
  const rules = getOpenAiToolDefinitions(profile).find((item) => item.function.name === "inspect_rules");
  assert.equal(rules.function.parameters.additionalProperties, false);
});

test("tool profile validation rejects dangerous or incoherent configuration", () => {
  assert.throws(() => validateToolProfile({
    id: "bad", version: 1, tools: ["act", "act"], max_calls_per_step: 6, parallel_tool_calls: false, stop_on_accepted: true
  }, "bad"), /duplicate/);
  assert.throws(() => validateToolProfile({
    id: "bad", version: 1, tools: ["inspect"], max_calls_per_step: 6, parallel_tool_calls: false, stop_on_accepted: true
  }, "bad"), /include act/);
  assert.throws(() => validateToolProfile({
    id: "bad", version: 1, tools: ["act"], max_calls_per_step: 6, parallel_tool_calls: true, stop_on_accepted: true
  }, "bad"), /parallel_tool_calls/);
  assert.throws(() => validateToolProfile({
    id: "bad", version: 1, tools: ["act"], max_calls_per_step: 6, parallel_tool_calls: false, stop_on_accepted: true, url: "https://example.test"
  }, "bad"), /unsupported field/);
});

test("legacy profile is explicit rather than an accidental no-act profile", () => {
  assert.deepEqual(resolveToolProfile("legacy_three_tool").tools, ["inspect", "evaluate_action", "submit_action"]);
});
