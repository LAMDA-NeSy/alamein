"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readConfigFile } = require("../core/config_file.js");
const { loadToolCatalog, loadToolProfiles } = require("../core/agent_tools.js");
const { loadRegistryDocument, resolveModel } = require("../core/model_runtime.js");
const {
  agentMethodDefaults,
  loadAgentMethodConfig,
  resolveAgentMethod
} = require("../core/agent_method_config.js");

const CONFIG_DIR = path.resolve(__dirname, "../config");

test("YAML config resolves every decision method and harness", () => {
  const config = loadAgentMethodConfig();
  assert.deepEqual(agentMethodDefaults(), {
    decision_policy: "direct",
    harness: "opencode_harness",
    tool_profile: "map_and_action",
    model_profile: "mock_primary",
    max_calls_per_step: 6,
    step_timeout_ms: 180000
  });
  for (const id of ["candidates", "intent", "hybrid", "opportunity_aware_hybrid", "unit_plan_hybrid", "hierarchical_sae", "direct", "strategy_execute", "opencode_harness", "langgraph_harness", "pydanticai_harness"]) {
    const method = resolveAgentMethod(id, { config });
    const expectedTools = id === "unit_plan_hybrid"
      ? ["phase_status", "view_map", "inspect_supply", "check_combat", "hold_units", "hold_unit", "act"]
      : id === "hierarchical_sae"
        ? ["phase_status", "inspect_rules", "view_map", "inspect_supply", "check_combat", "hold_units", "hold_unit", "act"]
      : ["view_map", "act"];
    assert.deepEqual(method.tools, expectedTools);
    assert.equal(method.max_calls_per_step, ["unit_plan_hybrid", "hierarchical_sae"].includes(id) ? 20 : 6);
    assert.equal(method.model_profile, "mock_primary");
    assert.equal(method.step_timeout_ms, 180000);
  }
  assert.deepEqual(resolveAgentMethod("unit_plan_hybrid", { config }).rolling_unit, {
    execution_ledger: false,
    repair_policy: "per_order",
    phase_repair_timeout_ms: 30000,
    protocol: "v2",
    phase_status_first: true,
    planning_mode: "phase_batch",
    execution_order: "phase_plan_priority",
    revalidate_each_action: true,
    accepted_actions_per_replay_step: 1,
    max_recommendation_expansions: 32,
    max_evaluated_options_per_unit: 12,
    max_stagnant_actions: 25
  });
  assert.deepEqual(resolveAgentMethod("hierarchical_sae", { config }).rolling_unit, {
    execution_ledger: true,
    repair_policy: "phase_batch_once",
    phase_repair_timeout_ms: 30000,
    protocol: "v2",
    phase_status_first: true,
    planning_mode: "phase_batch",
    execution_order: "phase_plan_priority",
    revalidate_each_action: true,
    accepted_actions_per_replay_step: 1,
    max_recommendation_expansions: 32,
    max_evaluated_options_per_unit: 12,
    max_stagnant_actions: 25
  });
  assert.deepEqual(resolveAgentMethod("hierarchical_sae", { config }).task_management, {
    execution_ledger: true,
    mode: "multi_task",
    protocol: "side-aware-task-v4",
    max_child_tasks: 6,
    max_active_child_tasks: 3,
      checker_enabled: true,
    checker_model_profile: "mock_secondary",
    checker_cooldown_actions: 3,
    route_feasibility_budget_ms: 2000,
    route_feasibility_scope: "task_units_only",
      task_generation: "model_defined",
      dependency_policy: "hard_soft_conditional_v1",
      task_switching: "existing_tasks_only",
      checker_timeout_ms: 60000,
      checker_max_calls_per_turn: 4,
      goal_management: "open_grounded",
      goal_protocol: "side-aware-goal-v2",
      no_progress_replan_threshold: 3,
      blocked_replan_threshold: 2,
      supply_worsened_replan_threshold: 2,
      low_odds_replan_threshold: 2,
      passive_hold_replan_threshold: 3,
      replan_cooldown_actions: 3
  });
  assert.deepEqual(resolveAgentMethod("hierarchical_sae", { config }).reasoning_memory, {
    enabled: true,
    within_step: "full",
    cross_step: "summary_plus_excerpt",
    max_recent_entries: 4,
    max_excerpt_tokens: 800,
    max_summary_tokens: 1200,
    retain_rejected_options: true,
    reset_on_phase_change: true,
    reset_on_replanning: true
  });
});

test("configuration directory contains YAML documents only", () => {
  const configFiles = fs.readdirSync(CONFIG_DIR).sort();
  assert.ok(configFiles.length >= 5);
  assert.deepEqual(configFiles.filter((file) => !/\.ya?ml$/i.test(file)), []);
  assert.equal(loadRegistryDocument().models.deepseek_flash.model, "deepseek-v4-flash");
  assert.deepEqual(loadToolProfiles().map_and_action.tools, ["view_map", "act"]);
  assert.match(loadToolCatalog().tools.view_map.description, /current board/);
  assert.equal(readConfigFile(path.join(CONFIG_DIR, "ai_config.yaml")).context.maxCandidateActions, 48);
  assert.equal(resolveModel().profile_id, "mock_primary");
});

test("method validation rejects tool, call-limit, and model drift", () => {
  const base = loadAgentMethodConfig();
  const withPatch = (patch) => ({
    ...base,
    methods: {
      ...base.methods,
      direct: { ...base.methods.direct, ...patch }
    }
  });
  assert.throws(() => resolveAgentMethod("direct", { config: withPatch({ tools: ["act"] }) }), /tools do not match/);
  assert.throws(() => resolveAgentMethod("direct", { config: withPatch({ max_calls_per_step: 7 }) }), /max_calls_per_step/);
  assert.throws(() => resolveAgentMethod("direct", { config: withPatch({ model_profile: "missing" }) }), /unknown model profile/);
});

test("YAML parser rejects duplicate keys", () => {
  const file = path.join(os.tmpdir(), `duplicate-agent-config-${process.pid}.yaml`);
  fs.writeFileSync(file, "version: 1\nversion: 2\n");
  try {
    assert.throws(() => readConfigFile(file), /Map keys must be unique/);
  }
  finally {
    fs.rmSync(file, { force: true });
  }
});
