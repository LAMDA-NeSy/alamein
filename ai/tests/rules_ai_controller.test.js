"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Rules = require("../../rule_engine.js");
const { createRulesAiController } = require("../core/rules_ai_controller.js");

const root = path.join(__dirname, "../..");
const terrain = JSON.parse(fs.readFileSync(path.join(root, "terrain.json"), "utf8"));
const rules = JSON.parse(fs.readFileSync(path.join(root, "rules_el_alamein.json"), "utf8"));

function scenarioState(name) {
  const state = JSON.parse(fs.readFileSync(path.join(root, "scenarios", `${name}.json`), "utf8"));
  Rules.applyStateDefaults(state);
  return state;
}

test("shared rules AI uses scenario-aware targets instead of a universal 3711 target", () => {
  for (const scenario of ["july", "september", "october"]) {
    const state = scenarioState(scenario);
    const controller = createRulesAiController({ state, rules, terrain, engine: Rules, maxActions: 5 });
    const suggestion = controller.suggestAction();
    assert.notEqual(suggestion.target, "3711", scenario);
    assert.match(suggestion.policy, /共享前端复杂规则 AI/);
  }
});

test("shared rules AI only returns rule-legal actions", () => {
  const state = scenarioState("july");
  const controller = createRulesAiController({ state, rules, terrain, engine: Rules, maxActions: 8 });
  for (const action of controller.enumerateLegalActions(8)) {
    if (action.type === "pass" || action.type === "exit_west") continue;
    const verdict = action.type === "move"
      ? Rules.checkMove(Rules.createContext({ state, rules, terrain }), action.unit, action.path, { mode: action.mode || "normal" })
      : Rules.checkCombat(Rules.createContext({ state, rules, terrain }), action);
    assert.equal(verdict.legal, true, `${action.type} should be legal`);
  }
});
