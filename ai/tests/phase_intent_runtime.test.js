"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { readConfig } = require("../experiments/external_ai_transcript.js");
const { createPhaseIntentPlanner } = require("../core/phase_intent_runtime.js");

const ROOT = path.resolve(__dirname, "../..");

function runtime() {
  return {
    profile: {
      defaults: { temperature: 0.25 },
      limits: { output: 6000 },
      capabilities: { structured_output: "json_object" }
    }
  };
}

test("Hybrid phase intent is candidate-free, cached by phase, and normalized", async () => {
  const config = readConfig();
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));
  let calls = 0;
  const client = {
    async complete(request) {
      calls += 1;
      assert.doesNotMatch(request.messages[1].content, /candidate_actions/);
      return {
        ok: true,
        status: 200,
        elapsed_ms: 4,
        response_json: { choices: [{ message: { content: JSON.stringify({ type: "phase_intent", intent: { type: "advance", sector: "north", priority_units: ["missing"] } }) } }] }
      };
    }
  };
  const planner = createPhaseIntentPlanner({ config, runtime: runtime(), client, decisionPolicy: "hybrid" });
  const input = { state, step: 1, turn: state.turn, phase: state.phase, side: state.active_side };
  const first = await planner.plan(input);
  const second = await planner.plan({ ...input, step: 2 });
  assert.equal(calls, 1);
  assert.equal(first.phaseIntent.type, "advance");
  assert.deepEqual(first.phaseIntent.priority_units, []);
  assert.equal(first.record.reused, false);
  assert.equal(second.record.reused, true);
  assert.deepEqual(second.phaseIntent, first.phaseIntent);
});

test("Hybrid falls back locally for malformed phase intent and skips an empty phase", async () => {
  const config = readConfig();
  let calls = 0;
  const planner = createPhaseIntentPlanner({
    config,
    runtime: runtime(),
    decisionPolicy: "hybrid",
    client: {
      async complete() {
        calls += 1;
        return { ok: true, status: 200, elapsed_ms: 1, response_json: { choices: [{ message: { content: "not-json" } }] } };
      }
    }
  });
  const empty = {
    scenario: "july",
    turn: 1,
    phase: "axis_combat",
    active_side: "axis",
    units: {}
  };
  const fast = await planner.plan({ state: empty, step: 1, turn: 1, phase: empty.phase, side: "axis" });
  assert.equal(fast.localFastPass, true);
  assert.equal(fast.record.source, "local_fast_pass");
  assert.equal(calls, 0);

  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));
  const fallback = await planner.plan({ state, step: 1, turn: state.turn, phase: state.phase, side: state.active_side });
  assert.equal(fallback.phaseIntent.source, "local_default");
  assert.match(fallback.record.fallback_reason, /invalid|JSON/);
  assert.equal(calls, 1);
});

test("strategy_execute caches strategy but submits model pass through act", async () => {
  const config = readConfig();
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));
  let calls = 0;
  const planner = createPhaseIntentPlanner({
    config,
    runtime: runtime(),
    decisionPolicy: "strategy_execute",
    client: {
      async complete(request) {
        calls += 1;
        assert.doesNotMatch(request.messages[1].content, /candidate_actions/);
        return {
          ok: true,
          status: 200,
          elapsed_ms: 1,
          response_json: { choices: [{ message: { content: JSON.stringify({ type: "phase_intent", intent: { type: "advance", sector: "central" } }) } }] }
        };
      }
    }
  });
  const input = { state, step: 1, turn: state.turn, phase: state.phase, side: state.active_side };
  const first = await planner.plan(input);
  const second = await planner.plan({ ...input, step: 2 });
  assert.equal(calls, 1);
  assert.equal(first.phaseIntent.type, "advance");
  assert.equal(first.localFastPass, false);
  assert.equal(second.record.reused, true);
});

test("unit-plan movement does not let the intent candidate pool bypass phase_status", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai/experiments/external_ai_full_game_transcript.js"), "utf8");
  assert.match(source, /intentFastPassAllowed = phasePlan\.localFastPass && !\(stepRecord\.rolling_movement && rollingStatus\)/);
});

test("execution requests require a tool call while phase planning remains separate", () => {
  const source = fs.readFileSync(path.join(ROOT, "ai/experiments/external_ai_full_game_transcript.js"), "utf8");
  assert.match(source, /tools: modelTools,\s*toolChoice: EXECUTION_TOOL_CHOICE/);
  assert.match(source, /const EXECUTION_TOOL_CHOICE = "auto"/);
  assert.match(source, /calls\.length !== 1 \|\| !toolProfile\.tools\.includes\(name\)/);
  assert.doesNotMatch(source, /requestOptions\.toolChoice = \{ type: "function"/);
  assert.doesNotMatch(source, /thinking: options\.toolChoice === EXECUTION_TOOL_CHOICE/);
});
