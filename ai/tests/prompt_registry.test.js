"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  loadPromptRegistry,
  promptRegistryMetadata,
  promptValue,
  renderPrompt,
  renderTemplate,
  strategyConfig,
  sidePromptRegistryMetadata,
  sideStrategyConfig,
  resolveSidePrompt,
  toolInstruction
} = require("../core/prompt_registry.js");
const { toolPromptReference } = require("../core/agent_tools.js");

test("shared prompt registry contains only side-neutral protocol text", () => {
  const registry = loadPromptRegistry();
  assert.equal(registry.version, 1);
  assert.match(strategyConfig().doctrine, /side profile/);
  for (const id of [
    "harness.agent_description",
    "harness.tool_with_map",
    "harness.tool_act",
    "evaluation.research_metrics_judge_system",
    "context.rules_role",
    "context.tool_policy_rolling"
  ]) assert.ok(promptValue(id).length > 20, id);
  assert.throws(() => promptValue("external.system"), /unknown or empty prompt/);
  assert.match(promptRegistryMetadata().hash, /^[a-f0-9]{64}$/);
  assert.match(resolveSidePrompt("axis", "external.system"), /command Axis/);
  assert.match(resolveSidePrompt("allies", "external.system"), /command Allies/);
  assert.match(resolveSidePrompt("axis", "harness.compaction"), /Axis scoring objective/);
  assert.match(resolveSidePrompt("allies", "harness.compaction"), /defended Axis frontier/);
  assert.notEqual(sidePromptRegistryMetadata("axis").hash, sidePromptRegistryMetadata("allies").hash);
  assert.match(sideStrategyConfig("allies").doctrine, /minimizing final Axis VP/);
});

test("prompt rendering requires every declared variable", () => {
  assert.equal(renderTemplate("A {{value}}", { value: "B" }), "A B");
  assert.throws(() => renderTemplate("A {{missing}}"), /missing prompt variable/);
  const rendered = renderPrompt("harness.tool_with_map");
  assert.match(rendered, /view_map/);
  assert.match(rendered, /accepted=true/);
  assert.match(toolInstruction("harness", ["view_map", "act"]), /rules reason/);
  assert.ok(toolPromptReference({
    id: "inline_harness",
    version: 1,
    tools: ["view_map", "act"],
    max_calls_per_step: 32,
    parallel_tool_calls: false,
    stop_on_accepted: true
  }).includes("Purpose:"));
});
