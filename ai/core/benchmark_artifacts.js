"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PROJECT_ROOT } = require("./project_paths.js");

const BENCHMARK_VERSION = "alamein-benchmark-v3-verified-counter-stats";
const RULE_KEYS = ["rule_engine", "rule_configuration", "terrain", "scenario", "counter_stats"];
const OPPONENT_KEYS = ["rules_ai", "controllers", "replay"];
const LEGACY_SCHEMA_3_FILES = {
  counter_stats: "counter_stats.json",
  counter_stats_validator: "ai/core/counter_stats.js",
  model_json: "ai/core/model_json.js",
  execution_ledger: "ai/core/phase_execution_ledger.js",
  opportunity_ledger: "ai/core/opportunity_ledger.js",
  goal_revision_ledger: "ai/core/goal_revision_ledger.js",
  research_metrics: "ai/experiments/research_metrics.js",
  metrics_runner: "ai/experiments/evaluate_research_metrics.js",
  artifact_validator: "ai/core/benchmark_artifacts.js"
};
const LEGACY_SCHEMA_4_FILES = { ...LEGACY_SCHEMA_3_FILES, task_review: "ai/core/task_review.js" };
const CURRENT_FILES = { ...LEGACY_SCHEMA_4_FILES, task_predicates: "ai/core/task_predicate_schema.js" };

// Schema 2 was emitted before counter_stats was promoted to a benchmark
// artifact. Historical manifests must be validated against the file set they
// recorded, not against today's workspace file set.
const LEGACY_SCHEMA_2_FILES = {
  model_json: "ai/core/model_json.js",
  execution_ledger: "ai/core/phase_execution_ledger.js",
  opportunity_ledger: "ai/core/opportunity_ledger.js",
  goal_revision_ledger: "ai/core/goal_revision_ledger.js",
  research_metrics: "ai/experiments/research_metrics.js",
  metrics_runner: "ai/experiments/evaluate_research_metrics.js",
  artifact_validator: "ai/core/benchmark_artifacts.js"
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function artifactFiles(scenario) {
  const normalizedScenario = String(scenario || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(normalizedScenario)) throw new Error(`invalid scenario for artifact manifest: ${scenario}`);
  return {
    rule_engine: "rule_engine.js",
    rule_configuration: "rules_el_alamein.json",
    terrain: "terrain.json",
    scenario: `scenarios/${normalizedScenario}.json`,
    rules_ai: "ai/core/rules_ai_controller.js",
    replay: "ai/experiments/ai_replay.js",
    transcript: "ai/experiments/external_ai_transcript.js",
    full_game_runner: "ai/experiments/external_ai_full_game_transcript.js",
    controllers: "ai/core/controller_config.js",
    sae_runtime: "ai/core/sae_runtime.js",
    phase_intent_runtime: "ai/core/phase_intent_runtime.js",
    unit_plan_runtime: "ai/core/unit_plan_runtime.js",
    task_manager: "ai/core/task_manager.js",
    task_checker: "ai/core/task_checker_runtime.js",
    scenario_policy: "ai/core/scenario_policy.js",
    goal_manager: "ai/core/goal_manager.js",
    context_store: "ai/core/context_store.js",
    agent_context: "ai/core/agent_context.js",
    reasoning_memory: "ai/core/reasoning_memory.js",
    rule_bridge: "ai/core/action_rule_bridge.js",
    harness_rule_bridge: "ai/core/opencode_rule_bridge.js",
    harness_prompt_contract: "ai/core/harness_prompt_contract.js",
    opencode_tool_args: "ai/core/opencode_tool_args.js",
    opencode_harness: "ai/harnesses/opencode_harness.mjs",
    opencode_plugin: "ai/harnesses/opencode_wargame_plugin.mjs",
    langgraph_harness: "ai/harnesses/langgraph_harness.mjs",
    pydanticai_harness: "ai/harnesses/pydanticai_harness.mjs",
    pydanticai_runner: "ai/harnesses/pydanticai_runner.py",
    agent_tools: "ai/core/agent_tools.js",
    prompt_registry: "ai/core/prompt_registry.js",
    model_runtime: "ai/core/model_runtime.js",
    agent_method_config: "ai/core/agent_method_config.js",
    config_loader: "ai/core/config_file.js",
    experiment_accounting: "ai/core/experiment_accounting.js",
    transport_attribution: "ai/core/transport_attribution.js",
    experiment_selection: "ai/core/experiment_selection.js",
    experiment_log: "ai/core/experiment_log.js",
    method_configuration: "ai/config/agent_methods.yaml",
    model_configuration: "ai/config/ai_models.yaml",
    tool_configuration: "ai/config/agent_tools.yaml",
    context_configuration: "ai/config/ai_config.yaml",
    metrics_configuration: "ai/config/research_metrics.yaml",
    shared_prompts: "ai/prompt/prompts.yaml",
    axis_prompts: "ai/prompt/axis_prompts.yaml",
    allies_prompts: "ai/prompt/allies_prompts.yaml",
    comparison: "ai/core/comparison_contract.js",
    comparison_validator: "ai/core/benchmark_comparison.js",
    comparison_statistics: "ai/core/benchmark_statistics.js",
    package_manifest: "package.json",
    package_lock: "pnpm-lock.yaml",
    python_lock: "uv.lock"
  };
}

function gitMetadata() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: PROJECT_ROOT, encoding: "utf8" });
  return {
    commit: commit.status === 0 ? String(commit.stdout || "").trim() : null,
    working_tree_dirty: dirty.status === 0 && Boolean(String(dirty.stdout || "").trim())
  };
}

function createArtifactManifest(scenario, options = {}) {
  const files = { ...artifactFiles(scenario), ...CURRENT_FILES };
  const entries = {};
  const missing = [];
  for (const [name, relativePath] of Object.entries(files)) {
    const absolutePath = path.join(PROJECT_ROOT, relativePath);
    try {
      entries[name] = { path: relativePath, sha256: sha256(fs.readFileSync(absolutePath)) };
    }
    catch {
      missing.push(relativePath);
    }
  }
  if (missing.length) throw new Error(`benchmark artifact files are missing: ${missing.join(", ")}`);
  const manifest = {
    manifest_schema: 5,
    benchmark_version: String(options.benchmarkVersion || BENCHMARK_VERSION),
    scenario: String(scenario),
    files: entries
  };
  const source = options.includeGitMetadata === false ? {} : gitMetadata();
  return {
    ...manifest,
    artifact_manifest_hash: sha256(JSON.stringify(manifest)),
    source_control: source
  };
}

function validateArtifactManifest(manifest, expectedHash) {
  if (!manifest || !expectedHash) return false;
  const { benchmark_version, scenario, files } = manifest;
  if (!benchmark_version || !scenario || !files) return false;
  let expectedFiles;
  const schema = manifest.manifest_schema == null ? 1 : Number(manifest.manifest_schema);
  try {
    expectedFiles = {
      ...artifactFiles(scenario),
      ...(schema === 1 ? {} : schema === 2 ? LEGACY_SCHEMA_2_FILES : schema === 3 ? LEGACY_SCHEMA_3_FILES : schema === 4 ? LEGACY_SCHEMA_4_FILES : schema === 5 ? CURRENT_FILES : null)
    };
  }
  catch { return false; }
  if (![1, 2, 3, 4, 5].includes(schema)) return false;
  if (Object.entries(expectedFiles).some(([key, file]) => {
    if (files[key]?.path !== file || !/^[a-f0-9]{64}$/.test(files[key]?.sha256 || "")) return true;
    return false;
  })) return false;
  if (Object.keys(files).some((key) => !expectedFiles[key])) return false;
  return sha256(JSON.stringify({ ...(manifest.manifest_schema ? { manifest_schema: manifest.manifest_schema } : {}),
    benchmark_version, scenario, files })) === expectedHash;
}

function artifactReproducibility(manifest, options = {}) {
  const valid = validateArtifactManifest(manifest, manifest?.artifact_manifest_hash);
  if (!valid) return { integrity_valid: false, matches_workspace: null, drift: [] };
  const drift = [];
  for (const [key, item] of Object.entries(manifest.files)) {
    let current = null;
    try { current = sha256(fs.readFileSync(path.join(options.root || PROJECT_ROOT, item.path))); } catch {}
    if (current !== item.sha256) drift.push({ artifact: key, path: item.path, recorded_hash: item.sha256, current_hash: current });
  }
  return { integrity_valid: true, matches_workspace: !drift.length, drift };
}

function artifactGroupHashes(manifest) {
  if (!validateArtifactManifest(manifest, manifest?.artifact_manifest_hash)) return null;
  const hashKeys = (keys) => sha256(JSON.stringify(keys.slice().sort().map((key) => [key, manifest.files[key]])));
  return { rules: hashKeys(RULE_KEYS), opponent: hashKeys(OPPONENT_KEYS),
    implementation: hashKeys(Object.keys(manifest.files).filter((key) => !RULE_KEYS.includes(key) && !OPPONENT_KEYS.includes(key))) };
}

function artifactContractFields(manifest) {
  return {
    benchmark_version: manifest.benchmark_version,
    artifact_manifest_hash: manifest.artifact_manifest_hash,
    artifact_group_hashes: artifactGroupHashes(manifest),
    artifact_hashes: Object.fromEntries(Object.entries(manifest.files).map(([name, item]) => [name, item.sha256]))
  };
}

function compareArtifactManifests(manifests) {
  const list = (manifests || []).filter(Boolean);
  if (!list.length) return { comparable: false, reasons: ["artifact manifest is missing"] };
  const hashes = [...new Set(list.map((manifest) => manifest.artifact_manifest_hash || ""))];
  const versions = [...new Set(list.map((manifest) => manifest.benchmark_version || ""))];
  const reasons = [];
  if (list.some((manifest) => !validateArtifactManifest(manifest, manifest.artifact_manifest_hash))) reasons.push("artifact manifest is incomplete or its contents do not match its hash");
  if (hashes.length !== 1 || !hashes[0]) reasons.push("artifact manifest hashes differ or are missing");
  if (versions.length !== 1 || !versions[0]) reasons.push("benchmark versions differ or are missing");
  return { comparable: reasons.length === 0, reasons, benchmark_version: versions[0] || null, artifact_manifest_hash: hashes[0] || null };
}

module.exports = {
  BENCHMARK_VERSION,
  artifactContractFields,
  artifactGroupHashes,
  artifactReproducibility,
  artifactFiles,
  compareArtifactManifests,
  createArtifactManifest,
  validateArtifactManifest,
  sha256
};
