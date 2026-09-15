"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadSuite, parseArgs } = require("../experiments/run_model_suite.js");

test("model suite loads unique model/checker pairs and supports selection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-model-suite-"));
  const file = path.join(directory, "suite.yaml");
  fs.writeFileSync(file, [
    "version: 1",
    "models:",
    "  - id: mock",
    "    model_profile: mock_primary",
    "    checker_model_profile: mock_secondary",
    "  - id: second",
    "    model_profile: mock_primary",
    "    checker_model_profile: mock_secondary",
    ""
  ].join("\n"));
  assert.deepEqual(loadSuite(file, ["second"]), [{
    id: "second", model_profile: "mock_primary", checker_model_profile: "mock_secondary"
  }]);
});

test("model suite rejects duplicate ids and malformed selection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-model-suite-"));
  const file = path.join(directory, "suite.yaml");
  fs.writeFileSync(file, "version: 1\nmodels:\n  - id: same\n    model_profile: mock_primary\n    checker_model_profile: mock_secondary\n  - id: same\n    model_profile: mock_primary\n    checker_model_profile: mock_secondary\n");
  assert.throws(() => loadSuite(file), /duplicate suite model id/);
  assert.throws(() => parseArgs(["--out-dir", "log/x", "--concurrency", "0"]), /--concurrency/);
});
