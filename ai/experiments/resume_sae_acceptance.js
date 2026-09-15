#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");

function argValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function saveJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function runChild(args, outputFile) {
  return new Promise((resolve) => {
    const fd = fs.openSync(outputFile, "a");
    const command = process.platform === "darwin" ? "caffeinate" : process.execPath;
    const commandArgs = process.platform === "darwin" ? ["-i", process.execPath, ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", fd, fd]
    });
    child.once("error", (error) => {
      fs.closeSync(fd);
      resolve({ code: 1, error: error.message });
    });
    child.once("exit", (code, signal) => {
      fs.closeSync(fd);
      resolve({ code: code ?? 1, signal });
    });
  });
}

async function waitForBatch(manifestPath) {
  while (true) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.status !== "running") return manifest;
    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
}

async function main(argv = process.argv.slice(2)) {
  const sourceDir = path.resolve(argValue(argv, "--source-dir", "log/sae_v17_advisory_acceptance_glm53_2026-09-14"));
  const outputDir = path.resolve(argValue(argv, "--out-dir", `${sourceDir}-recovered`));
  const sourceManifestPath = path.join(sourceDir, "batch_manifest.json");
  const recoveryManifestPath = path.join(outputDir, "recovery_manifest.json");
  if (!fs.existsSync(sourceManifestPath)) throw new Error(`source batch manifest not found: ${sourceManifestPath}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
  const failed = sourceManifest.cases.find((entry) => entry.scenario === "july" && entry.side === "axis");
  if (!failed) throw new Error("failed July Axis case is not present in source batch");
  const outputFile = path.join(outputDir, path.basename(failed.output));
  const args = failed.args.map((value, index) => failed.args[index - 1] === "--out" ? outputFile : value);
  const state = {
    status: "waiting_for_original_batch",
    started_at: new Date().toISOString(),
    source_dir: sourceDir,
    output_dir: outputDir,
    rerun_output: outputFile,
    reason: "retry failed July Axis with repaired execution bridge",
    original_status: failed.game_status || null
  };
  saveJson(recoveryManifestPath, state);

  await waitForBatch(sourceManifestPath);
  state.status = "running";
  state.original_batch_finished_at = new Date().toISOString();
  saveJson(recoveryManifestPath, state);
  const gameResult = await runChild(args, path.join(outputDir, "july_axis.console.log"));
  state.game_exit_code = gameResult.code;
  state.game_error = gameResult.error || null;
  state.game_status = fs.existsSync(outputFile) ? JSON.parse(fs.readFileSync(outputFile, "utf8")).status : null;
  saveJson(recoveryManifestPath, state);

  if (state.game_status === "final_victory") {
    const files = sourceManifest.cases
      .filter((entry) => !(entry.scenario === "july" && entry.side === "axis") && fs.existsSync(entry.output))
      .map((entry) => entry.output);
    files.push(outputFile);
    state.report = path.join(outputDir, "all_scenarios_metrics.json");
    const reportResult = await runChild([
      "ai/experiments/evaluate_research_metrics.js",
      ...files,
      "--out",
      state.report
    ], path.join(outputDir, "metrics.console.log"));
    state.report_exit_code = reportResult.code;
  }
  state.status = state.game_status === "final_victory" && state.report_exit_code === 0
    ? "completed" : "completed_with_errors";
  state.finished_at = new Date().toISOString();
  saveJson(recoveryManifestPath, state);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, waitForBatch };
