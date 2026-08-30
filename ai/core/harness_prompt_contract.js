"use strict";

const crypto = require("node:crypto");
const { renderSidePrompt, sidePromptRegistryMetadata, toolInstruction } = require("./prompt_registry.js");
const { toolPromptReference } = require("./agent_tools.js");

const HARNESS_PROMPT_CONTRACT_VERSION = "harness-prompt-v2-side-aware";

function normalizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) throw new Error("harness prompt contract requires at least one tool");
  return tools.map(String);
}

function createHarnessPromptContract(tools, side) {
  const allowedTools = normalizeTools(tools);
  const promptProfile = sidePromptRegistryMetadata(side);
  const instruction = toolInstruction("harness", allowedTools);
  const templates = {
    system: renderSidePrompt(side, "harness.system", {
      tool_names: allowedTools.join(", "),
      tool_instruction: instruction,
      tool_reference: toolPromptReference({
        id: "inline_harness",
        version: 1,
        tools: allowedTools,
        max_calls_per_step: 32,
        parallel_tool_calls: false,
        stop_on_accepted: true
      })
    }),
    step: renderSidePrompt(side, "harness.step", {
      step: "__HARNESS_STEP__",
      turn: "__HARNESS_TURN__",
      phase: "__HARNESS_PHASE__",
      side: "__HARNESS_SIDE__",
      payload: "__HARNESS_PAYLOAD__",
      tool_instruction: instruction
    })
      .replaceAll("__HARNESS_STEP__", "{{step}}")
      .replaceAll("__HARNESS_TURN__", "{{turn}}")
      .replaceAll("__HARNESS_PHASE__", "{{phase}}")
      .replaceAll("__HARNESS_SIDE__", "{{side}}")
      .replaceAll("__HARNESS_PAYLOAD__", "{{payload}}")
  };
  const canonical = JSON.stringify({
    version: HARNESS_PROMPT_CONTRACT_VERSION,
    side: promptProfile.side,
    prompt_profile_hash: promptProfile.hash,
    tools: allowedTools,
    templates
  });
  return {
    version: HARNESS_PROMPT_CONTRACT_VERSION,
    side: promptProfile.side,
    prompt_profile: promptProfile.profile,
    tools: allowedTools,
    templates,
    hash: crypto.createHash("sha256").update(canonical).digest("hex"),
    registry: promptProfile
  };
}

function renderHarnessStep(contract, payload, input) {
  if (!contract?.templates?.step) throw new Error("invalid harness prompt contract");
  return contract.templates.step.replace(/\{\{(step|turn|phase|side|payload)\}\}/g, (_match, key) => {
    if (key === "payload") return JSON.stringify(payload);
    if (!Object.hasOwn(input, key)) throw new Error(`missing harness step field ${key}`);
    return String(input[key]);
  });
}

module.exports = {
  HARNESS_PROMPT_CONTRACT_VERSION,
  createHarnessPromptContract,
  renderHarnessStep
};
