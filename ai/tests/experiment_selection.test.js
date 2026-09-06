"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateExperimentSelection } = require("../core/experiment_selection.js");
const { buildExperimentJobs } = require("../experiments/run_ai_experiments.js");

test("baseline harnesses are direct-only and self-owned methods use the manual runner", () => {
  assert.equal(validateExperimentSelection("opencode_harness", "direct").id, "direct");
  assert.throws(() => validateExperimentSelection("opencode_harness", "hierarchical_sae"), /independent direct baseline/);
  const [job] = buildExperimentJobs({ systems: "hierarchical_sae", "model-profile": "mock_primary", seed: "1942", "out-dir": "log/test-selection" });
  assert.match(job.args[0], /external_ai_full_game_transcript\.js$/);
  assert.ok(job.args.includes("--task-management"));
});

test("a batch rejects unsupported harness and policy combinations before spawning", () => {
  assert.throws(() => buildExperimentJobs({ harnesses: "langgraph_harness", "decision-policies": "hybrid", "model-profile": "mock_primary" }), /independent direct baseline/);
});
