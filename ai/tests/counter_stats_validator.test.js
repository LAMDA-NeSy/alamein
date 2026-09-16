"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateScenarioCounterStats } = require("../core/counter_stats.js");

const ROOT = path.join(__dirname, "../..");
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, "counter_stats.json"), "utf8")).stats;

test("scenario counter validation rejects a placeholder or mismatched counter", () => {
  const state = { units: {
    good: { kind: "ground", side: "axis", image: "mod_images/200-pzg.png", attack: 2, defense: 2, movement: 10, stats_status: "verified" },
    bad: { kind: "ground", side: "axis", image: "mod_images/200-pzg.png", attack: 1, defense: 1, movement: 10, stats_status: "needs_manual_review" }
  } };
  const result = validateScenarioCounterStats(state, { stats, throwOnError: false });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.throws(() => validateScenarioCounterStats(state, { stats }), /counter stats validation failed/);
});
