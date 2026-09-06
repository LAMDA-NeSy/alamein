"use strict";

const { resolveAgentMethod } = require("./agent_method_config.js");

const BASELINE_HARNESSES = new Set(["opencode_harness", "langgraph_harness", "pydanticai_harness"]);

function validateExperimentSelection(harness, decisionPolicy) {
  const method = resolveAgentMethod(decisionPolicy);
  if (method.category !== "decision_policy") throw new Error(`${decisionPolicy} is not a decision policy`);
  if (harness !== "manual_single_action" && !BASELINE_HARNESSES.has(harness)) throw new Error(`unknown harness ${harness}`);
  if (BASELINE_HARNESSES.has(harness) && decisionPolicy !== "direct") {
    throw new Error(`${harness} is an independent direct baseline; ${decisionPolicy} must use manual_single_action`);
  }
  return method;
}

module.exports = { BASELINE_HARNESSES, validateExperimentSelection };
