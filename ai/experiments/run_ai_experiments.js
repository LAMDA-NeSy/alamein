#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { agentMethodDefaults, resolveAgentMethod } = require("../core/agent_method_config.js");
const { validateExperimentSelection } = require("../core/experiment_selection.js");
const { resolveControllers } = require("../core/controller_config.js");
const { resolveModel } = require("../core/model_runtime.js");
const { resolveToolProfile } = require("../core/agent_tools.js");
const { LOG_DIR } = require("../core/experiment_log.js");
const { PROJECT_ROOT } = require("../core/project_paths.js");

const SCRIPTS = {
  opencode_harness: "ai/harnesses/opencode_harness.mjs",
  langgraph_harness: "ai/harnesses/langgraph_harness.mjs",
  pydanticai_harness: "ai/harnesses/pydanticai_harness.mjs",
  manual_single_action: "ai/experiments/external_ai_full_game_transcript.js"
};
const FLAGS = new Set(["scenario", "external-side", "axis-controller", "allies-controller", "systems", "harnesses", "decision-policies", "decision-policy", "decision-mode", "model-profiles", "model-profile", "tool-profiles", "tool-profile", "seeds", "seed", "replicates", "max-steps", "step-timeout-ms", "pydanticai-python", "out-dir", "task-management", "task-checker-model-profile"]);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    const key = argv[index].replace(/^--/, "");
    if (!FLAGS.has(key)) throw new Error(`unknown option ${argv[index]}`);
    if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`missing value for --${key}`);
    result[key] = argv[++index];
  }
  return result;
}

function list(value) { return String(value).split(",").map((item) => item.trim()).filter(Boolean); }
function integer(value, label, minimum = 1) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return number;
}
function safeId(values) { return values.map((value) => String(value).replace(/[^a-zA-Z0-9_-]+/g, "_")).join("__"); }

function defaultMaxStepsForScenario(scenario) {
  return { july: 1000, september: 1500, october: 3000 }[scenario] || 1000;
}

function buildExperimentJobs(options = {}) {
  const defaults = agentMethodDefaults();
  const scenario = options.scenario || "july";
  if (!["july", "september", "october"].includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
  const hasControllers = options["axis-controller"] || options["allies-controller"];
  const controllers = resolveControllers({
    externalSide: options["external-side"] || (hasControllers ? undefined : "axis"),
    axisController: options["axis-controller"], alliesController: options["allies-controller"]
  });
  const profiles = list(options["model-profiles"] || options["model-profile"] || defaults.model_profile);
  const seeds = list(options.seeds || options.seed || "1942").map((seed) => integer(seed, "seed", 0));
  const replicates = integer(options.replicates || 1, "replicates");
  const maxSteps = integer(options["max-steps"] || defaultMaxStepsForScenario(scenario), "max-steps");
  const policies = list(options["decision-policies"] || options["decision-policy"] || options["decision-mode"] || defaults.decision_policy);
  if (options.systems && (options.harnesses || options["decision-policies"] || options["decision-policy"] || options["decision-mode"])) throw new Error("--systems cannot be combined with --harnesses or decision policy options");
  const selections = options.systems
    ? list(options.systems).map((id) => resolveAgentMethod(id))
    : policies.flatMap((policy) => {
      const method = resolveAgentMethod(policy);
      return (options.harnesses ? list(options.harnesses) : [method.harness]).map((harness) => ({ ...method, harness }));
    });
  const jobs = [];
  const ids = new Set();
  for (const selection of selections) {
    validateExperimentSelection(selection.harness, selection.decision_policy);
    const method = resolveAgentMethod(selection.decision_policy);
    const tools = list(options["tool-profiles"] || options["tool-profile"] || selection.tool_profile);
    const timeout = integer(options["step-timeout-ms"] || selection.step_timeout_ms, "step-timeout-ms", 1000);
    const taskMode = options["task-management"] || method.task_management?.mode || "disabled";
    if (!["disabled", "multi_task"].includes(taskMode)) throw new Error("task-management must be disabled or multi_task");
    if (taskMode !== "disabled" && selection.decision_policy !== "hierarchical_sae") throw new Error("multi_task requires hierarchical_sae");
    const checker = taskMode === "multi_task" ? options["task-checker-model-profile"] || method.task_management.checker_model_profile : null;
    if (checker) resolveModel(checker);
    for (const profileId of profiles) {
      const profile = resolveModel(profileId);
      if (checker && profile.adapter !== "mock" && !options["task-checker-model-profile"]) throw new Error("real multi-task experiments require --task-checker-model-profile");
      for (const seed of seeds) for (let replicate = 1; replicate <= replicates; replicate += 1) for (const tool of tools) {
        resolveToolProfile(tool);
        const id = safeId([scenario, `axis-${controllers.axis}`, `allies-${controllers.allies}`, seed, replicate, selection.harness, selection.decision_policy, tool, profileId, taskMode, checker || "no_checker"]);
        if (ids.has(id)) throw new Error(`duplicate experiment ${id}`);
        ids.add(id);
        const output = path.resolve(options["out-dir"] || LOG_DIR, `${id}.json`);
        const args = [path.join(PROJECT_ROOT, SCRIPTS[selection.harness]),
          "--scenario", scenario, "--axis-controller", controllers.axis, "--allies-controller", controllers.allies,
          "--decision-policy", selection.decision_policy, "--tool-profile", tool, "--model-profile", profileId,
          "--seed", String(seed), "--replicate", String(replicate), "--max-steps", String(maxSteps),
          "--step-timeout-ms", String(timeout), "--out", output];
        if (selection.harness === "manual_single_action") {
          args.push("--task-management", taskMode);
          if (checker) args.push("--task-checker-model-profile", checker);
        }
        if (selection.harness === "pydanticai_harness" && options["pydanticai-python"]) args.push("--pydanticai-python", options["pydanticai-python"]);
        jobs.push({ id, output, args });
      }
    }
  }
  if (!jobs.length) throw new Error("experiment selection is empty");
  return jobs;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`experiment exited with ${code}`)));
  });
}

async function main() {
  const jobs = buildExperimentJobs(parseArgs(process.argv.slice(2)));
  // Validate the whole batch before starting any paid requests or replacing logs.
  for (const job of jobs) if (fs.existsSync(job.output)) throw new Error(`output already exists: ${job.output}; use a new --out-dir`);
  for (const job of jobs) await run(job.args);
  process.stdout.write(`${JSON.stringify({ outputs: jobs.map((job) => job.output) }, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildExperimentJobs, parseArgs };
