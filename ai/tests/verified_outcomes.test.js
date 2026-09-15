"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseModelObject } = require("../core/model_json.js");
const { parseModelJson } = require("../core/unit_plan_runtime.js");
const { createArtifactManifest, validateArtifactManifest, artifactReproducibility, artifactGroupHashes, sha256 } = require("../core/benchmark_artifacts.js");
const { allocationCorrectionMetrics } = require("../core/experiment_accounting.js");
const { evaluateObservableCriteria, localTaskProgress } = require("../core/task_manager.js");
const { createOpportunityLedger, summarizeOpportunityEvidence } = require("../core/opportunity_ledger.js");
const { createModelRuntime, createChatCompletionsClient, closeModelRuntime } = require("../core/model_runtime.js");
const { validateAcceptanceResult } = require("../experiments/run_sae_acceptance.js");

const response = (content, reasoning_content = "") => ({ response_json: { choices: [{ message: { content, reasoning_content } }] } });
const plan = { type: "phase_unit_plan", unit_orders: [] };

test("JSON envelopes normalize without discarding source or changing the protocol", () => {
  for (const field of ["answer", "final_answer"]) {
    const parsed = parseModelJson(response(JSON.stringify({ [field]: plan })));
    assert.equal(parsed.type, "phase_unit_plan");
    assert.equal(parsed.parse_status, "normalized_envelope");
    assert.deepEqual(parsed.response_wrappers, [field]);
  }
  assert.ok(parseModelJson(response('{"answer":{"unit_orders":[]}}')).error);
});

test("final content takes priority and conflicting reasoning objects are rejected", () => {
  const first = { type: "x", target: 1 }, second = { type: "x", target: 2 };
  assert.equal(parseModelObject(response(JSON.stringify(first), JSON.stringify(second))).target, 1);
  assert.equal(parseModelObject(response("", `${JSON.stringify(first)}\n${JSON.stringify(second)}`)).parse_status, "ambiguous");
  assert.equal(parseModelObject(response("", `Final:\n\`\`\`json\n${JSON.stringify(first)}\n\`\`\``)).response_source, "reasoning_content");
});

function rehash(manifest) {
  manifest.artifact_manifest_hash = sha256(JSON.stringify({ manifest_schema: manifest.manifest_schema,
    benchmark_version: manifest.benchmark_version, scenario: manifest.scenario, files: manifest.files }));
}

test("historical manifest integrity is independent of workspace drift", () => {
  const manifest = createArtifactManifest("july", { includeGitMetadata: false });
  const initial = artifactGroupHashes(manifest);
  manifest.files.sae_runtime.sha256 = "a".repeat(64);
  assert.equal(validateArtifactManifest(manifest, manifest.artifact_manifest_hash), false);
  rehash(manifest);
  assert.equal(validateArtifactManifest(manifest, manifest.artifact_manifest_hash), true);
  const drift = artifactReproducibility(manifest);
  assert.equal(drift.integrity_valid, true);
  assert.equal(drift.matches_workspace, false);
  assert.deepEqual(drift.drift.map((item) => item.artifact), ["sae_runtime"]);
  assert.equal(artifactGroupHashes(manifest).rules, initial.rules);
  assert.equal(artifactGroupHashes(manifest).opponent, initial.opponent);
  assert.notEqual(artifactGroupHashes(manifest).implementation, initial.implementation);
});

test("allocation snapshots count once per version and exclude correction arrays from unit coverage", () => {
  const allocation = { spearhead: [{ unit: "a" }], reserve: ["b"], supply_executable_units: ["s"],
    allocation_corrections: [{ unit: "a", reason: "duplicate" }] };
  const steps = Array.from({ length: 40 }, (_, i) => ({ side: "axis", step: i + 1,
    force_allocation: allocation, sae_plan: { reused: i > 0 } }));
  const metrics = allocationCorrectionMetrics(steps);
  assert.equal(metrics.corrections, 1);
  assert.equal(metrics.assigned_unit_versions, 2);
  assert.equal(metrics.correction_rate, 0.5);
});

const condition = (metric, target = 1, extra = {}) => ({ metric, relation: "at_least", target, ...extra });
test("all criteria use the weakest progress; any criteria use satisfied alternatives", () => {
  const task = { id: "t" }, input = { side: "axis", state: {} };
  const all = evaluateObservableCriteria({ all: [condition("supply_coverage"), condition("assigned_units_alive", 4)] }, task,
    { supplied_ratio: 1, assigned: 1 }, input);
  assert.equal(all.progress, 0.25);
  assert.equal(all.status, "not_met");
  const any = evaluateObservableCriteria({ any: [condition("supply_coverage"), condition("unknown")] }, task, { supplied_ratio: 1 }, input);
  assert.equal(any.progress, 1);
  assert.equal(any.status, "met");
});

test("current satisfaction does not prematurely settle game-end maintenance", () => {
  const result = evaluateObservableCriteria({ all: [condition("supply_coverage", 1, { evaluation_scope: "game_end" })] },
    { id: "s" }, { supplied_ratio: 1 }, { side: "axis", state: { turn: 1, phase: "axis_initial_movement" } });
  assert.equal(result.status, "met");
  assert.equal(result.scope_ready, false);
});

test("missing evidence is unknown and strict greater-than is not greater-or-equal", () => {
  const unknown = evaluateObservableCriteria({ all: [condition("unknown", 0)] }, { id: "t" }, {}, { state: {} });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.progress_known, false);
  assert.equal(evaluateObservableCriteria({ all: [condition("assigned_units_alive", 2, { relation: "gt" })] },
    { id: "t" }, { assigned: 2 }, { state: {} }).status, "not_met");
});

test("arrival alone does not complete supply task for beneficiary units", () => {
  const input = { side: "axis", state: { units: { s: { hex: "3511", side: "axis", supply: "supplied" },
    a: { hex: "3512", side: "axis", supply: "isolated" } } } };
  const result = evaluateObservableCriteria({ all: [condition("position", 1, { unit_ids: ["s"], target_hex: "3511" }),
    condition("supply_coverage", 1, { beneficiary_unit_ids: ["a"] })] }, { id: "s" }, {}, input);
  assert.equal(result.status, "not_met");
  assert.equal(result.progress, 0);
});

test("one action can satisfy independent tasks without changing executor assignments", () => {
  const input = { side: "axis", state: { scenario: "july", phase: "axis_initial_movement", turn: 1,
    units: { a: { kind: "ground", side: "axis", hex: "3511", supply: "supplied", movement: 4 } } } };
  const plan = { side: "axis", parent: { state: "active" }, children: ["arrival", "supplied"].map((id) => ({
    id, type: "model_task", status: "active", progress: 0, priority: 1, assigned_units: id === "arrival" ? ["a"] : [],
    completion_criteria: { all: [id === "arrival" ? condition("position", 1, { unit_ids: ["a"], target_hex: "3511" })
      : condition("unit_supply", 1, { beneficiary_unit_ids: ["a"] })] }
  })) };
  const result = localTaskProgress(plan, input, { final_action: { type: "move", unit: "a" },
    action_attempts: [{ accepted: true }] });
  assert.equal(result.changes.length, 2);
  assert.equal(plan.children.every((task) => task.status === "completed"), true);
  assert.deepEqual(plan.children[1].assigned_units, []);
});

test("unknown opportunity outcomes do not become a zero conversion rate", () => {
  const summary = summarizeOpportunityEvidence({ executed: 165, unknown_effects: 165, verified_effects: 0 });
  assert.equal(summary.conversion_rate, null);
  assert.equal(summary.known_outcome_conversion_rate, null);
  assert.equal(summary.effect_evidence_coverage, 0);
});

test("opportunities from previous turns cannot receive credit for current actions", () => {
  const ledger = createOpportunityLedger();
  const input = { side: "axis", turn: 1, step: 1, phase: "axis_initial_movement", state: { scenario: "july", units: { a: { hex: "3411" } } } };
  ledger.observePlan(input, { actionable_units: [{ unit: "a", hex: "3411", recommended_options: [{ destination: "3511" }] }] }, true);
  const action = { phase: input.phase, final_action_source: "phase_plan", final_action: { type: "move", unit: "a", destination: "3511" }, action_applied: { applied: true, result: { legal: true } } };
  assert.equal(ledger.apply({ ...input, turn: 2 }, action), null);
  ledger.apply(input, { ...action, action_effect: { actual_vp_delta: undefined } });
  assert.equal(ledger.report().unknown_effects, 1);
});

test("a response observed after the deadline is never accepted even before timers fire", async (t) => {
  const runtime = createModelRuntime("mock_primary", { mockResponder() {
    // Advance wall time without running timeout callbacks, as during a local pause.
    const afterPause = Date.now() + 10000;
    t.mock.method(Date, "now", () => afterPause);
    return { choices: [{ message: { content: "{}" } }] };
  } });
  runtime.profile.defaults.retries = 0;
  try {
    const result = await createChatCompletionsClient(runtime).complete({ timeout_ms: 5000, messages: [] });
    assert.equal(result.ok, false);
    assert.equal(result.error_class, "network_timeout");
    assert.equal(runtime.transport[0].deadline_exceeded, true);
    assert.equal(runtime.transport[0].response.choices[0].message.content, "{}");
  } finally { await closeModelRuntime(runtime); }
});

test("Rules-vs-Rules runner starts without an external-agent context or unit plan", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-baseline-"));
  const output = path.join(directory, "game.json");
  try {
    const child = spawnSync(process.execPath, ["ai/experiments/external_ai_full_game_transcript.js", "--scenario", "july",
      "--axis-controller", "rules_ai", "--allies-controller", "rules_ai", "--decision-policy", "direct",
      "--task-management", "disabled", "--model-profile", "mock_primary", "--max-steps", "1", "--out", output],
    { cwd: path.resolve(__dirname, "../.."), encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const run = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(run.controllers, { axis: "rules_ai", allies: "rules_ai" });
    assert.equal(run.counts.illegal_actions, 0);
    assert.equal(run.model_steps.length, 0);
    assert.equal(validateArtifactManifest(run.artifact_manifest, run.artifact_manifest_hash), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("acceptance rejects missing artifact metadata and repeated per-unit repairs across versions", () => {
  const artifact = createArtifactManifest("july", { includeGitMetadata: false });
  const step = { execution_ledger: { phase_id: "phase", requests: [{ request_id: "r1", stage: "concentrated_repair" }],
    events: [{ event_id: "e1", phase_id: "phase", status: "repair_result", unit: "a" }] } };
  const run = { status: "final_victory", summary: { victory: { final: true } }, counts: { illegal_actions: 0 },
    artifact_manifest: artifact, artifact_manifest_hash: artifact.artifact_manifest_hash,
    execution_ledger_summary: { phases: 1, closed_phases: 1 }, model_steps: [step, step] };
  assert.equal(validateAcceptanceResult(run).passed, true);
  run.model_steps.push({ execution_ledger: { phase_id: "phase", requests: [{ request_id: "r2", stage: "concentrated_repair" }],
    events: [{ event_id: "e2", phase_id: "phase", status: "repair_result", unit: "a" }] } });
  const repeated = validateAcceptanceResult(run);
  assert.ok(repeated.reasons.includes("unit_repair_limit_exceeded"));
  assert.ok(repeated.reasons.includes("phase_repair_limit_exceeded"));
  delete run.artifact_manifest;
  assert.ok(validateAcceptanceResult(run).reasons.includes("artifact_manifest_invalid"));
});
