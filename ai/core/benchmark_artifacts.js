"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PROJECT_ROOT } = require("./project_paths.js");

const BENCHMARK_VERSION = "alamein-benchmark-v1";

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
    controllers: "ai/core/controller_config.js"
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
  const files = artifactFiles(scenario);
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
  try { expectedFiles = artifactFiles(scenario); }
  catch { return false; }
  if (Object.entries(expectedFiles).some(([key, file]) => {
    if (files[key]?.path !== file || !/^[a-f0-9]{64}$/.test(files[key]?.sha256 || "")) return true;
    try { return sha256(fs.readFileSync(path.join(PROJECT_ROOT, file))) !== files[key].sha256; }
    catch { return true; }
  })) return false;
  return sha256(JSON.stringify({ benchmark_version, scenario, files })) === expectedHash;
}

function artifactContractFields(manifest) {
  return {
    benchmark_version: manifest.benchmark_version,
    artifact_manifest_hash: manifest.artifact_manifest_hash,
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
  artifactFiles,
  compareArtifactManifests,
  createArtifactManifest,
  validateArtifactManifest,
  sha256
};
