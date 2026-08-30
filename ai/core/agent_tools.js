"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { readConfigFile } = require("./config_file.js");
const { CONFIG_DIR } = require("./project_paths.js");

const PROFILE_FILE = path.join(CONFIG_DIR, "agent_methods.yaml");
const CATALOG_FILE = path.join(CONFIG_DIR, "agent_tools.yaml");

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

function profileError(profileId, message) {
  return new Error(`tool profile ${profileId}: ${message}`);
}

function catalogError(message) {
  return new Error(`tool catalog: ${message}`);
}

function loadToolCatalog(file = CATALOG_FILE) {
  const document = readConfigFile(file);
  const allowedKeys = new Set(["version", "catalog_version", "action_schema", "tools", "tool_docs"]);
  for (const key of Object.keys(document)) {
    if (!allowedKeys.has(key)) throw catalogError(`contains unsupported field ${key}`);
  }
  if (!Number.isInteger(Number(document.version)) || Number(document.version) < 1) {
    throw catalogError("version must be a positive integer");
  }
  if (typeof document.catalog_version !== "string" || !document.catalog_version.trim()) {
    throw catalogError("catalog_version must be a non-empty string");
  }
  if (!document.action_schema || typeof document.action_schema !== "object" || Array.isArray(document.action_schema)) {
    throw catalogError("action_schema must be an object");
  }
  if (!document.tools || typeof document.tools !== "object" || Array.isArray(document.tools)) {
    throw catalogError("tools must be an object");
  }
  if (!document.tool_docs || typeof document.tool_docs !== "object" || Array.isArray(document.tool_docs)) {
    throw catalogError("tool_docs must be an object");
  }
  for (const name of Object.keys(document.tools)) {
    const docs = document.tool_docs[name];
    if (!docs || typeof docs !== "object" || Array.isArray(docs)) throw catalogError(`${name} requires tool_docs`);
    for (const field of ["purpose", "input_guide", "output_guide", "decision_effect"]) {
      if (typeof docs[field] !== "string" || !docs[field].trim()) throw catalogError(`${name}.tool_docs.${field} is required`);
    }
    if (docs.examples != null && (!Array.isArray(docs.examples) || docs.examples.some((item) => typeof item !== "string" || !item.trim()))) {
      throw catalogError(`${name}.tool_docs.examples must be an array of non-empty strings`);
    }
  }
  for (const [name, definition] of Object.entries(document.tools)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw catalogError(`${name} must be an object`);
    const definitionKeys = new Set(["name", "description", "parameters"]);
    for (const key of Object.keys(definition)) {
      if (!definitionKeys.has(key)) throw catalogError(`${name} contains unsupported field ${key}`);
    }
    if (definition.name !== name) throw catalogError(`${name}.name must match its registry key`);
    if (typeof definition.description !== "string" || !definition.description.trim()) throw catalogError(`${name}.description is required`);
    if (!definition.parameters || definition.parameters.type !== "object" || Array.isArray(definition.parameters)) {
      throw catalogError(`${name}.parameters must be an object schema`);
    }
  }
  return document;
}

const DEFAULT_TOOL_CATALOG = loadToolCatalog();
const TOOL_CATALOG_VERSION = DEFAULT_TOOL_CATALOG.catalog_version;

function configuredCatalog(options = {}) {
  if (options.catalog) return options.catalog;
  if (options.catalogFile) return loadToolCatalog(options.catalogFile);
  return DEFAULT_TOOL_CATALOG;
}

function loadToolProfiles(file = PROFILE_FILE) {
  const parsed = readConfigFile(file);
  const profiles = parsed.tool_profiles || parsed;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) throw new Error("tool profile registry must be an object");
  return profiles;
}

function validateToolProfile(profile, profileId = profile?.id || "inline", options = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw profileError(profileId, "must be an object");
  const allowedKeys = new Set(["id", "version", "tools", "max_calls_per_step", "parallel_tool_calls", "stop_on_accepted"]);
  for (const key of Object.keys(profile)) {
    if (!allowedKeys.has(key)) throw profileError(profileId, `contains unsupported field ${key}`);
  }
  if (String(profile.id || "") !== String(profileId)) throw profileError(profileId, "id must match registry key");
  if (!Number.isInteger(Number(profile.version)) || Number(profile.version) < 1) throw profileError(profileId, "version must be a positive integer");
  if (!Array.isArray(profile.tools) || !profile.tools.length) throw profileError(profileId, "requires at least one tool");
  const unique = new Set(profile.tools);
  if (unique.size !== profile.tools.length) throw profileError(profileId, "contains duplicate tools");
  const catalog = configuredCatalog(options);
  for (const name of profile.tools) {
    if (!Object.hasOwn(catalog.tools, name)) throw profileError(profileId, `uses unknown tool ${name}`);
  }
  const legacyThreeTool = profile.id === "legacy_three_tool" && profile.tools.join(",") === "inspect,evaluate_action,submit_action";
  if (!profile.tools.includes("act") && !legacyThreeTool) throw profileError(profileId, "action profiles must include act");
  if (profile.tools.includes("submit_action") && !profile.tools.includes("evaluate_action")) {
    throw profileError(profileId, "submit_action requires evaluate_action");
  }
  if (!Number.isInteger(Number(profile.max_calls_per_step)) || Number(profile.max_calls_per_step) < 1 || Number(profile.max_calls_per_step) > 32) {
    throw profileError(profileId, "max_calls_per_step must be an integer from 1 to 32");
  }
  if (profile.parallel_tool_calls !== false) throw profileError(profileId, "parallel_tool_calls must be false");
  if (typeof profile.stop_on_accepted !== "boolean") throw profileError(profileId, "stop_on_accepted must be boolean");
  return Object.freeze({
    id: String(profile.id),
    version: Number(profile.version),
    tools: Object.freeze([...profile.tools]),
    max_calls_per_step: Number(profile.max_calls_per_step),
    parallel_tool_calls: false,
    stop_on_accepted: profile.stop_on_accepted
  });
}

function resolveToolProfile(profileId = "map_and_action", options = {}) {
  const registry = options.registry || loadToolProfiles(options.file);
  if (!Object.hasOwn(registry, profileId)) throw new Error(`unknown tool profile ${profileId}`);
  return validateToolProfile(registry[profileId], profileId, options);
}

function getToolDefinitions(profileOrId = "map_and_action", options = {}) {
  const profile = typeof profileOrId === "string"
    ? resolveToolProfile(profileOrId, options)
    : validateToolProfile(profileOrId, profileOrId.id, options);
  const catalog = configuredCatalog(options);
  return profile.tools.map((name) => ({
    ...clone(catalog.tools[name]),
    ...clone(catalog.tool_docs?.[name] || {})
  }));
}

function getOpenAiToolDefinitions(profileOrId = "map_and_action", options = {}) {
  return getToolDefinitions(profileOrId, options).map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters
    }
  }));
}

function toolPromptReference(profileOrId = "map_and_action", options = {}) {
  return getToolDefinitions(profileOrId, options).map((tool) => {
    const examples = Array.isArray(tool.examples) && tool.examples.length
      ? `\n  Examples: ${tool.examples.join("; ")}`
      : "";
    return [
      `Tool: ${tool.name}`,
      `  Purpose: ${tool.purpose}`,
      `  Parameters: ${tool.input_guide}`,
      `  Returns: ${tool.output_guide}`,
      `  Decision rule: ${tool.decision_effect}${examples}`
    ].join("\n");
  }).join("\n\n");
}

function toolProfileHash(profileOrId = "map_and_action", options = {}) {
  const profile = typeof profileOrId === "string"
    ? resolveToolProfile(profileOrId, options)
    : validateToolProfile(profileOrId, profileOrId.id, options);
  const catalog = configuredCatalog(options);
  const payload = { tool_catalog_version: catalog.catalog_version, profile, tools: getToolDefinitions(profile, options) };
  return crypto.createHash("sha256").update(stableJson(payload)).digest("hex");
}

function createToolHandlers(profileOrId, execute) {
  if (typeof execute !== "function") throw new Error("createToolHandlers requires an executor");
  const profile = typeof profileOrId === "string" ? resolveToolProfile(profileOrId) : validateToolProfile(profileOrId, profileOrId.id);
  return Object.fromEntries(profile.tools.map((name) => [name, (argumentsValue = {}, sessionContext = {}) => executeToolCall(profile, name, argumentsValue, sessionContext, execute)]));
}

function executeToolCall(profileOrId, toolName, argumentsValue = {}, sessionContext = {}, execute) {
  const profile = typeof profileOrId === "string" ? resolveToolProfile(profileOrId) : validateToolProfile(profileOrId, profileOrId.id);
  if (!profile.tools.includes(toolName)) throw new Error(`tool ${toolName} is not enabled by profile ${profile.id}`);
  if (typeof execute !== "function") throw new Error("executeToolCall requires an executor");
  return execute(toolName, argumentsValue, sessionContext);
}

module.exports = {
  TOOL_CATALOG_VERSION,
  createToolHandlers,
  executeToolCall,
  getOpenAiToolDefinitions,
  getToolDefinitions,
  loadToolCatalog,
  loadToolProfiles,
  resolveToolProfile,
  toolProfileHash,
  toolPromptReference,
  validateToolProfile
};
