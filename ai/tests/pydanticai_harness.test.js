"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const HARNESS_DIR = path.join(ROOT, "ai", "harnesses");

test("PydanticAI runner validates the map and action protocol when Python 3.11 is configured", (t) => {
  const python = process.env.PYDANTICAI_PYTHON || path.join(ROOT, ".venv", "bin", "python");
  if (!fs.existsSync(python)) return t.skip("run uv sync --group dev first");
  const result = spawnSync(python, [path.join(HARNESS_DIR, "pydanticai_runner.py"),
    "--model", "mock-wargame-primary",
    "--gateway-url", "http://127.0.0.1:1/v1",
    "--gateway-token", "test",
    "--bridge-url", "http://127.0.0.1:1",
    "--bridge-token", "test",
    "--protocol-check"
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.allowed_tools, ["view_map", "act"]);
  assert.doesNotMatch(fs.readFileSync(path.join(HARNESS_DIR, "pydanticai_harness.mjs"), "utf8"), /DEEPSEEK_API_KEY/);
});
