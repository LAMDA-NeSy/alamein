"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createHarnessPromptContract,
  renderHarnessStep
} = require("../core/harness_prompt_contract.js");

test("shared harness prompt contract is deterministic and tool-sensitive", () => {
  const first = createHarnessPromptContract(["view_map", "act"], "axis");
  const second = createHarnessPromptContract(["view_map", "act"], "axis");
  const actOnly = createHarnessPromptContract(["act"], "axis");
  assert.deepEqual(first, second);
  assert.notEqual(first.hash, actOnly.hash);
  assert.match(first.templates.system, /view_map, act/);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
});

test("shared step renderer resolves the application prompt", () => {
  const contract = createHarnessPromptContract(["view_map", "act"], "axis");
  const prompt = renderHarnessStep(contract, { game: { turn: 2 } }, {
    step: 7,
    turn: 2,
    phase: "axis_combat",
    side: "axis"
  });
  assert.match(prompt, /CURRENT_STATE step=7 turn=2 phase=axis_combat side=axis/);
  assert.match(prompt, /"turn":2/);
  assert.doesNotMatch(prompt, /\{\{/);
});
