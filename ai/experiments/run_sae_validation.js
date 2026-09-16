#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PROJECT_ROOT } = require("../core/project_paths.js");
const { createModelRuntime, closeModelRuntime } = require("../core/model_runtime.js");

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--out-dir", "--real-model-profile", "--real-checker-profile"].includes(argv[i]) || !argv[i + 1]) throw new Error(`invalid option ${argv[i]}`);
    options[argv[i]] = argv[i + 1];
  }
  if (!options["--out-dir"]) throw new Error("--out-dir is required");
  if (!!options["--real-model-profile"] !== !!options["--real-checker-profile"]) throw new Error("real validation requires both explicit model and checker profiles");
  const outputDir = path.resolve(options["--out-dir"]);
  const manifestFile = path.join(outputDir, "validation_manifest.json");
  if (fs.existsSync(manifestFile)) throw new Error("validation directory already used; no automatic reruns");
  for (const profile of [options["--real-model-profile"], options["--real-checker-profile"]].filter(Boolean)) {
    await closeModelRuntime(createModelRuntime(profile));
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const acceptance = path.join(PROJECT_ROOT, "ai/experiments/run_sae_acceptance.js");
  const stages = [
    { id: "javascript", command: "pnpm", args: ["test"] },
    { id: "python", command: "uv", args: ["run", "--locked", "--group", "dev", "pytest", "ai/tests"] },
    { id: "mock_six_cases", command: process.execPath, args: [acceptance, "--out-dir", path.join(outputDir, "mock"),
      "--model-profile", "mock_primary", "--task-checker-model-profile", "mock_secondary"] }
  ];
  if (options["--real-model-profile"]) stages.push({ id: "real_six_cases", command: process.execPath,
    args: [acceptance, "--out-dir", path.join(outputDir, "real"), "--model-profile", options["--real-model-profile"],
      "--task-checker-model-profile", options["--real-checker-profile"]] });
  const manifest = { protocol: "sae-validation-gate-v1", pid: process.pid, status: "running", concurrency: 1,
    started_at: new Date().toISOString(), real_opt_in: !!options["--real-model-profile"],
    real_model_profile: options["--real-model-profile"] || null, real_checker_profile: options["--real-checker-profile"] || null,
    real_requests_require_all_tests_and_mock_games: true, paid_reruns: false, ordinary_api_failover: false,
    stages: stages.map((stage) => ({ ...stage, status: "pending" })) };
  const save = () => {
    fs.writeFileSync(`${manifestFile}.tmp`, JSON.stringify(manifest, null, 2));
    fs.renameSync(`${manifestFile}.tmp`, manifestFile);
  };
  save();
  for (const stage of manifest.stages) {
    stage.status = "running";
    stage.started_at = new Date().toISOString();
    stage.log = path.join(outputDir, `${stage.id}.log`);
    const fd = fs.openSync(stage.log, "a");
    const child = spawn(stage.command, stage.args, { cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", fd, fd] });
    stage.pid = child.pid;
    save();
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: 1, error: error.message }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    fs.closeSync(fd);
    stage.finished_at = new Date().toISOString();
    stage.exit_code = result.code;
    stage.error = result.error || null;
    stage.status = result.code === 0 ? "completed" : "failed";
    save();
    if (result.code !== 0) {
      manifest.status = "validation_failed";
      manifest.failed_stage = stage.id;
      manifest.finished_at = new Date().toISOString();
      save();
      process.exitCode = 1;
      return;
    }
  }
  manifest.status = "completed";
  manifest.finished_at = new Date().toISOString();
  save();
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
