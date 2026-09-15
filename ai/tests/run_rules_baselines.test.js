"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { markStaleManifest: markBaselineStaleManifest, processAlive } = require("../experiments/run_rules_baselines.js");
const { markStaleManifest: markAcceptanceStaleManifest } = require("../experiments/run_sae_acceptance.js");

test("baseline runner marks a dead running manifest as interrupted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-baseline-stale-"));
  const manifestPath = path.join(directory, "baseline_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    protocol: "rules-baseline-batch-v1",
    pid: 99999999,
    status: "running",
    cases: [{ scenario: "july", status: "completed" }, { scenario: "october", status: "running" }]
  }));
  const repaired = markBaselineStaleManifest(directory);
  assert.equal(repaired.status, "interrupted");
  assert.equal(repaired.cases[0].status, "completed");
  assert.equal(repaired.cases[1].status, "interrupted");
  assert.match(repaired.interruption_reason, /no longer alive/);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).status, "interrupted");
});

test("SAE acceptance runner marks a dead running manifest and child as interrupted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-acceptance-stale-"));
  const manifestPath = path.join(directory, "batch_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    protocol: "sae-six-case-acceptance-v1",
    pid: 99999999,
    status: "running",
    cases: [
      { scenario: "july", status: "completed" },
      { scenario: "july", side: "allies", pid: process.pid, status: "running" }
    ]
  }));
  const repaired = markAcceptanceStaleManifest(directory);
  assert.equal(repaired.status, "interrupted");
  assert.equal(repaired.cases[0].status, "completed");
  assert.equal(repaired.cases[1].status, "interrupted");
  assert.match(repaired.interruption_reason, /no longer alive/);
  assert.equal(repaired.cases[1].orphaned_pid, process.pid);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).status, "interrupted");
});

test("baseline runner recognizes its own live process", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(0), false);
});
