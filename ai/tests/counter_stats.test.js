"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Rules = require("../../rule_engine.js");

const ROOT = path.join(__dirname, "../..");
const counterStats = JSON.parse(fs.readFileSync(path.join(ROOT, "counter_stats.json"), "utf8")).stats;

function scenarioState(scenario) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios", `${scenario}.json`), "utf8"));
}

test("counter stats cover every combat counter in every benchmark scenario", () => {
  for (const scenario of ["july", "september", "october"]) {
    const state = scenarioState(scenario);
    for (const [id, unit] of Object.entries(state.units)) {
      const image = String(unit.image || "").split("/").pop();
      const isTurnMarker = /game-turn|turn marker|turn-record/i.test(`${id} ${unit.name || ""} ${image}`);
      if (isTurnMarker) {
        assert.equal(unit.kind, "marker", `${scenario}/${id} must be a marker`);
        continue;
      }
      if (!Rules.isCombatUnit({ ...unit, id })) continue;
      assert.ok(counterStats[image], `${scenario}/${id} has no counter stats for ${image}`);
      assert.equal(unit.stats_status, "verified", `${scenario}/${id} is not verified`);
      assert.equal(unit.attack, counterStats[image].attack, `${scenario}/${id} attack`);
      assert.equal(unit.defense, counterStats[image].defense, `${scenario}/${id} defense`);
      assert.equal(unit.movement, counterStats[image].movement, `${scenario}/${id} movement`);
      assert.equal(!!unit.parenthesized_attack, !!counterStats[image].parenthesizedAttack, `${scenario}/${id} attack mode`);
    }
  }
});

test("parenthesized engineer and anti-air counters remain defensive-only", () => {
  const context = Rules.createContext({
    state: { scenario: "october", active_side: "allies", phase: "allies_combat", turn: 1, units: {} },
    terrain: { hexes: {}, edges: {} }
  });
  for (const [id, image, side] of [
    ["engineer", "allied-engineers.png", "allies"],
    ["aa", "102-aa.png", "axis"]
  ]) {
    const printed = counterStats[image];
    const unit = { id, side, kind: id === "engineer" ? "engineer" : "ground", image: `mod_images/${image}`,
      hex: "2424", state: "fresh", attack: printed.attack, defense: printed.defense,
      movement: printed.movement, parenthesized_attack: true, supply_state: "supplied" };
    context.state.units[id] = unit;
    assert.equal(Rules.canAttackUnit(unit), false, `${image} must not attack`);
    assert.equal(Rules.effectiveAttack(context, unit), 0, `${image} must have no effective attack`);
    assert.equal(Rules.effectiveDefense(context, unit), printed.defense, `${image} must defend`);
  }
});
