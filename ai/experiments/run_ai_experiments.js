#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { agentMethodDefaults } = require("../core/agent_method_config.js");
const { LOG_DIR } = require("../core/experiment_log.js");
const { PROJECT_ROOT } = require("../core/project_paths.js");

const ROOT = PROJECT_ROOT;
const HARNESS_DIR = path.join(PROJECT_ROOT, "ai", "harnesses");
const EXPERIMENT_DIR = __dirname;

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function listArg(name, fallback) {
  return argValue(name, fallback).split(",").map((value) => value.trim()).filter(Boolean);
}

function safeId(values) {
  return values.map((value) => String(value).replace(/[^a-zA-Z0-9_-]+/g, "_")).join("__");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
  });
}

async function main() {
  const defaults = agentMethodDefaults();
  const scenario = argValue("--scenario", "july");
  const legacySide = argValue("--external-side", "");
  const axisControllerArg = argValue("--axis-controller", "");
  const alliesControllerArg = argValue("--allies-controller", "");
  const hasControllerFlags = !!axisControllerArg || !!alliesControllerArg;
  const axisController = axisControllerArg || (legacySide === "axis" ? "external_ai" : "rules_ai");
  const alliesController = alliesControllerArg || (legacySide === "allies" ? "external_ai" : "rules_ai");
  const profiles = listArg("--model-profiles", argValue("--model-profile", defaults.model_profile));
  const seeds = listArg("--seeds", argValue("--seed", "1942")).map(Number);
  const harnesses = listArg("--harnesses", defaults.harness);
  const decisionPolicies = listArg("--decision-policies", argValue("--decision-policy", argValue("--decision-mode", defaults.decision_policy)));
  const toolProfiles = listArg("--tool-profiles", argValue("--tool-profile", defaults.tool_profile));
  const replicates = Math.max(1, Number(argValue("--replicates", "1")));
  const maxSteps = Number(argValue("--max-steps", 1000));
  const stepTimeoutMs = Number(argValue("--step-timeout-ms", defaults.step_timeout_ms));
  const pydanticPython = argValue("--pydanticai-python", "");
  const outDir = path.resolve(argValue("--out-dir", LOG_DIR));
  fs.mkdirSync(outDir, { recursive: true });
  const outputs = [];
  const scripts = {
    opencode_harness: path.join(HARNESS_DIR, "opencode_harness.mjs"),
    langgraph_harness: path.join(HARNESS_DIR, "langgraph_harness.mjs"),
    pydanticai_harness: path.join(HARNESS_DIR, "pydanticai_harness.mjs"),
    manual_single_action: path.join(EXPERIMENT_DIR, "external_ai_full_game_transcript.js")
  };
  for (const profile of profiles) {
    for (const seed of seeds) {
      for (let replicate = 1; replicate <= replicates; replicate += 1) {
        for (const harness of harnesses) {
          const script = scripts[harness] || path.join(EXPERIMENT_DIR, "external_ai_full_game_transcript.js");
          for (const decisionPolicy of decisionPolicies) {
            for (const toolProfile of toolProfiles) {
              const id = safeId([scenario, `axis-${axisController}`, `allies-${alliesController}`, seed, replicate, harness, decisionPolicy, toolProfile, profile]);
              const output = path.join(outDir, `${id}.json`);
              const args = [script,
                "--scenario", scenario,
                "--decision-policy", decisionPolicy,
                "--tool-profile", toolProfile,
                "--model-profile", profile,
                "--seed", String(seed),
                "--replicate", String(replicate),
                "--max-steps", String(maxSteps),
                "--step-timeout-ms", String(stepTimeoutMs),
                "--out", output
              ];
              if (hasControllerFlags || !legacySide) {
                args.push("--axis-controller", axisController, "--allies-controller", alliesController);
              }
              if (legacySide) {
                args.push("--external-side", legacySide);
              }
              if (harness === "pydanticai_harness" && pydanticPython) args.push("--pydanticai-python", pydanticPython);
              await run(process.execPath, args);
              outputs.push(output);
            }
          }
        }
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ scenario, legacySide: legacySide || null, axisController, alliesController, profiles, seeds, replicates, harnesses, decisionPolicies, toolProfiles, outputs }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exitCode = 1;
});
