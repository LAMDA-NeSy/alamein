"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { readConfigFile } = require("./config_file.js");
const { PROMPT_DIR } = require("./project_paths.js");

const PROMPT_FILE = path.join(PROMPT_DIR, "prompts.yaml");
const SIDE_PROMPT_FILES = Object.freeze({
  axis: path.join(PROMPT_DIR, "axis_prompts.yaml"),
  allies: path.join(PROMPT_DIR, "allies_prompts.yaml")
});
const REQUIRED_SIDE_PROMPTS = Object.freeze([
  "harness.system", "harness.step", "harness.compaction",
  "manual.system", "manual.context_with_candidates", "manual.context_without_candidates",
  "manual.tool_with_map", "manual.tool_tactical", "manual.tool_route_tactical", "manual.tool_rolling", "manual.tool_act",
  "external.strategic_planner_system", "external.goal_manager_system", "external.force_allocator_system",
  "external.phase_intent_system", "external.phase_unit_plan_system", "external.unit_order_repair_system",
  "external.system", "external.task_checker_system", "external.context_intent", "external.context_candidates",
  "external.context_hierarchical", "external.decision_intent", "external.decision_candidates",
  "external.review_intent", "external.review_candidates", "external.review_hierarchical"
]);
const REQUIRED_PHASE_OBJECTIVES = Object.freeze([
  "initial_movement", "combat", "mechanized_movement", "supply_movement", "end_game_turn"
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function loadPromptRegistry(file = PROMPT_FILE) {
  const registry = readConfigFile(file);
  if (!Number.isInteger(Number(registry.version)) || Number(registry.version) < 1) {
    throw new Error("prompt registry version must be a positive integer");
  }
  if (!registry.strategy || typeof registry.strategy !== "object" || Array.isArray(registry.strategy)) {
    throw new Error("prompt registry strategy must be an object");
  }
  if (!registry.prompts || typeof registry.prompts !== "object" || Array.isArray(registry.prompts)) {
    throw new Error("prompt registry prompts must be an object");
  }
  return registry;
}

const DEFAULT_REGISTRY = loadPromptRegistry();

function normalizeSide(side) {
  const value = String(side || "").toLowerCase();
  if (!Object.hasOwn(SIDE_PROMPT_FILES, value)) throw new Error(`unknown prompt side ${side || "<empty>"}`);
  return value;
}

function loadSidePromptRegistry(side, file = null) {
  const normalized = normalizeSide(side);
  const registry = readConfigFile(file || SIDE_PROMPT_FILES[normalized]);
  if (Number(registry.version) < 1 || registry.side !== normalized || !registry.strategy || !registry.prompts) {
    throw new Error(`invalid ${normalized} prompt profile`);
  }
  if (!String(registry.strategy.doctrine || "").trim() || !String(registry.strategy.action_contract || "").trim()) {
    throw new Error(`${normalized} prompt profile requires doctrine and action_contract`);
  }
  if (!Array.isArray(registry.strategy.priorities) || !registry.strategy.priorities.length) {
    throw new Error(`${normalized} prompt profile requires priorities`);
  }
  for (const phase of REQUIRED_PHASE_OBJECTIVES) {
    if (!String(registry.strategy.phase_objectives?.[phase] || "").trim()) {
      throw new Error(`${normalized} prompt profile missing phase objective ${phase}`);
    }
  }
  for (const id of REQUIRED_SIDE_PROMPTS) promptValue(id, registry);
  return registry;
}

const SIDE_REGISTRIES = Object.freeze(Object.fromEntries(
  Object.keys(SIDE_PROMPT_FILES).map((side) => [side, loadSidePromptRegistry(side)])
));

function promptValue(id, registry = DEFAULT_REGISTRY) {
  const value = String(id).split(".").reduce((current, key) => current?.[key], registry.prompts);
  if (typeof value !== "string" || !value.trim()) throw new Error(`unknown or empty prompt ${id}`);
  return value;
}

function renderTemplate(template, variables = {}) {
  const rendered = String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    if (!Object.hasOwn(variables, key)) throw new Error(`missing prompt variable ${key}`);
    const value = variables[key];
    return value == null ? "" : String(value);
  });
  const unresolved = rendered.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/);
  if (unresolved) throw new Error(`unresolved prompt variable ${unresolved[0]}`);
  return rendered.split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function renderPrompt(id, variables = {}, registry = DEFAULT_REGISTRY) {
  return renderTemplate(promptValue(id, registry), variables);
}

function resolveSidePrompt(side, id, registry = null) {
  const normalized = normalizeSide(side);
  return promptValue(id, registry || SIDE_REGISTRIES[normalized]);
}

function renderSidePrompt(side, id, variables = {}, registry = null) {
  return renderTemplate(resolveSidePrompt(side, id, registry), variables);
}

function sideStrategyConfig(side, registry = null) {
  const normalized = normalizeSide(side);
  const strategy = clone((registry || SIDE_REGISTRIES[normalized]).strategy);
  return {
    doctrine: strategy.doctrine || "",
    actionContract: strategy.action_contract || "",
    phaseObjectives: strategy.phase_objectives || {},
    priorities: strategy.priorities || []
  };
}

function strategyConfig(registry = DEFAULT_REGISTRY) {
  const strategy = clone(registry.strategy);
  return {
    doctrine: strategy.doctrine || "",
    actionContract: strategy.action_contract || "",
    phaseObjectives: strategy.phase_objectives || {},
    priorities: strategy.priorities || []
  };
}

function toolInstruction(group, tools, registry = DEFAULT_REGISTRY) {
  const suffix = tools.includes("plan_route")
    ? "tool_route_tactical"
    : tools.includes("view_map")
      ? "tool_with_map"
      : tools.includes("act") ? "tool_act" : "tool_other";
  return renderPrompt(`${group}.${suffix}`, {}, registry);
}

function promptRegistryMetadata(registry = DEFAULT_REGISTRY) {
  return {
    version: Number(registry.version),
    hash: crypto.createHash("sha256").update(stableJson(registry)).digest("hex")
  };
}

function sidePromptRegistryMetadata(side) {
  const normalized = normalizeSide(side);
  const registry = SIDE_REGISTRIES[normalized];
  return {
    side: normalized,
    profile: `${normalized}_pe_v1`,
    version: Number(registry.version),
    hash: crypto.createHash("sha256").update(stableJson(registry)).digest("hex")
  };
}

module.exports = {
  PROMPT_FILE,
  REQUIRED_SIDE_PROMPTS,
  SIDE_PROMPT_FILES,
  loadPromptRegistry,
  loadSidePromptRegistry,
  promptValue,
  promptRegistryMetadata,
  renderSidePrompt,
  renderPrompt,
  renderTemplate,
  resolveSidePrompt,
  sidePromptRegistryMetadata,
  sideStrategyConfig,
  strategyConfig,
  toolInstruction
};
