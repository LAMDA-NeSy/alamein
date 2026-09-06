"use strict";

const path = require("node:path");
const { readConfigFile } = require("./config_file.js");
const { resolveToolProfile } = require("./agent_tools.js");
const { resolveModel } = require("./model_runtime.js");
const { CONFIG_DIR } = require("./project_paths.js");

const CONFIG_FILE = path.join(CONFIG_DIR, "agent_methods.yaml");
const METHOD_CATEGORIES = new Set(["decision_policy", "harness"]);

function loadAgentMethodConfig(file = CONFIG_FILE) {
  const parsed = readConfigFile(file);
  if (Number(parsed.version || 0) !== 1) throw new Error("agent method config version must be 1");
  if (!parsed.defaults || typeof parsed.defaults !== "object") throw new Error("agent method config requires defaults");
  if (!parsed.methods || typeof parsed.methods !== "object" || Array.isArray(parsed.methods)) {
    throw new Error("agent method config requires methods");
  }
  return parsed;
}

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function normalizeAgentMethod(methodId, raw, options = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`agent method ${methodId} must be an object`);
  if (!METHOD_CATEGORIES.has(raw.category)) throw new Error(`agent method ${methodId} has invalid category ${raw.category || "<missing>"}`);
  const toolProfile = resolveToolProfile(raw.tool_profile, options.toolProfileOptions);
  if (!sameList(raw.tools, toolProfile.tools)) {
    throw new Error(`agent method ${methodId} tools do not match tool profile ${toolProfile.id}`);
  }
  if (Number(raw.max_calls_per_step) !== toolProfile.max_calls_per_step) {
    throw new Error(`agent method ${methodId} max_calls_per_step does not match tool profile ${toolProfile.id}`);
  }
  const model = resolveModel(raw.model_profile, options.modelOptions);
  const timeoutMs = Number(raw.step_timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error(`agent method ${methodId} step_timeout_ms must be at least 1000`);
  const rollingUnitSettings = ["unit_plan_hybrid", "hierarchical_sae"].includes(methodId)
    ? Object.freeze({
      protocol: String(raw.rolling_unit_protocol || "v1"),
      phase_status_first: raw.phase_status_first !== false,
      execution_order: String(raw.execution_order || "model_tool_call_order"),
      accepted_actions_per_replay_step: Number(raw.accepted_actions_per_replay_step || 1)
    })
    : null;
  const taskManagement = raw.task_management === "multi_task"
    ? Object.freeze({
      mode: "multi_task",
      protocol: String(raw.task_protocol || "side-aware-task-v2"),
      max_child_tasks: Math.max(3, Math.min(6, Number(raw.max_child_tasks || 6))),
      max_active_child_tasks: Math.max(1, Math.min(3, Number(raw.max_active_child_tasks || 3))),
      checker_enabled: raw.task_checker_enabled !== false,
      checker_model_profile: String(raw.task_checker_model_profile || "mock_secondary"),
      checker_timeout_ms: Math.max(1000, Number(raw.task_checker_timeout_ms || 60000)),
      checker_max_calls_per_turn: Math.max(1, Number(raw.task_checker_max_calls_per_turn || 4)),
      task_generation: String(raw.task_generation || "fixed_skeleton"),
      dependency_policy: String(raw.task_dependency_policy || "hard_soft_conditional_v1"),
      task_switching: String(raw.task_switching || "existing_tasks_only"),
      goal_management: String(raw.goal_management || "disabled"),
      goal_protocol: String(raw.goal_protocol || ""),
      no_progress_replan_threshold: Math.max(2, Number(raw.no_progress_replan_threshold || 3)),
      blocked_replan_threshold: Math.max(2, Number(raw.blocked_replan_threshold || 2)),
      supply_worsened_replan_threshold: Math.max(2, Number(raw.supply_worsened_replan_threshold || 2)),
      low_odds_replan_threshold: Math.max(2, Number(raw.low_odds_replan_threshold || 2)),
      passive_hold_replan_threshold: Math.max(2, Number(raw.passive_hold_replan_threshold || 3)),
      replan_cooldown_actions: Math.max(0, Number(raw.replan_cooldown_actions || 3))
    })
    : null;
  if (taskManagement && !["hierarchical-task-v1", "side-aware-task-v2"].includes(taskManagement.protocol)) {
    throw new Error(`agent method ${methodId} task_protocol must be hierarchical-task-v1 or side-aware-task-v2`);
  }
  if (taskManagement && !["fixed_skeleton", "model_defined"].includes(taskManagement.task_generation)) {
    throw new Error(`agent method ${methodId} task_generation must be fixed_skeleton or model_defined`);
  }
  if (taskManagement && taskManagement.dependency_policy !== "hard_soft_conditional_v1") {
    throw new Error(`agent method ${methodId} task_dependency_policy must be hard_soft_conditional_v1`);
  }
  if (taskManagement && taskManagement.task_switching !== "existing_tasks_only") {
    throw new Error(`agent method ${methodId} task_switching must be existing_tasks_only`);
  }
  if (rollingUnitSettings && rollingUnitSettings.protocol !== "v1") {
    throw new Error(`agent method ${methodId} rolling_unit_protocol must be v1`);
  }
  if (rollingUnitSettings && rollingUnitSettings.execution_order !== "model_tool_call_order") {
    throw new Error(`agent method ${methodId} execution_order must be model_tool_call_order`);
  }
  if (rollingUnitSettings && rollingUnitSettings.accepted_actions_per_replay_step !== 1) {
    throw new Error(`agent method ${methodId} accepted_actions_per_replay_step must be 1`);
  }
  return Object.freeze({
    id: methodId,
    category: raw.category,
    decision_policy: String(raw.decision_policy || "direct"),
    harness: String(raw.harness || "manual_single_action"),
    tool_profile: toolProfile.id,
    tools: Object.freeze([...toolProfile.tools]),
    max_calls_per_step: toolProfile.max_calls_per_step,
    model_profile: model.profile_id,
    step_timeout_ms: timeoutMs,
    rolling_unit: rollingUnitSettings,
    task_management: taskManagement
  });
}

function resolveAgentMethod(methodId, options = {}) {
  const config = options.config || loadAgentMethodConfig(options.file);
  const resolvedId = methodId || config.defaults.decision_policy || "direct";
  if (!Object.hasOwn(config.methods, resolvedId)) throw new Error(`unknown agent method ${resolvedId}`);
  return normalizeAgentMethod(resolvedId, config.methods[resolvedId], options);
}

function agentMethodDefaults(options = {}) {
  const config = options.config || loadAgentMethodConfig(options.file);
  const profile = resolveToolProfile(config.defaults.tool_profile, options.toolProfileOptions);
  const model = resolveModel(config.defaults.model_profile, options.modelOptions);
  if (Number(config.defaults.max_calls_per_step) !== profile.max_calls_per_step) {
    throw new Error("agent method defaults max_calls_per_step does not match its tool profile");
  }
  return Object.freeze({
    decision_policy: String(config.defaults.decision_policy || "direct"),
    harness: String(config.defaults.harness || "opencode_harness"),
    tool_profile: profile.id,
    model_profile: model.profile_id,
    max_calls_per_step: profile.max_calls_per_step,
    step_timeout_ms: Number(config.defaults.step_timeout_ms || 180000)
  });
}

module.exports = {
  CONFIG_FILE,
  agentMethodDefaults,
  loadAgentMethodConfig,
  normalizeAgentMethod,
  resolveAgentMethod
};
