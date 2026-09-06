"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");

const { createContextStore, loadContextStore, sha256 } = require("../core/context_store.js");

test("context store persists manifest, map, state snapshots, memory, and model steps", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-context-"));
  const store = createContextStore({ runId: "run-test", directory });
  const map = { format: "staggered_hex_coordinate_map", layout_rows: [{ row: 1, hexes: ["0101"] }] };
  const manifest = store.initialize({ scenario: "july", seed: 1942 }, map);
  assert.equal(manifest.hashes.map_reference_hash, sha256(map));
  store.snapshot({ stage: "before_decision", step: 1, state: { turn: 1, phase: "axis_initial_movement" } });
  store.updateMemory({ player_goal_summary: "你现在扮演 Axis。" });
  store.recordModelStep({ step: 1, turn: 1, phase: "axis_initial_movement", side: "axis", final_action: { type: "pass" }, rounds: [] }, { turn: 1 });
  for (const file of Object.values(store.files)) assert.equal(fs.existsSync(file), true, file);
  assert.match(fs.readFileSync(store.files.stateSnapshots, "utf8"), /before_decision/);
  assert.match(fs.readFileSync(store.files.modelSteps, "utf8"), /axis_initial_movement/);
  assert.match(fs.readFileSync(store.files.durableMemory, "utf8"), /你现在扮演 Axis/);

  const restored = loadContextStore(directory, {
    expectedHashes: { map_reference_hash: sha256(map) }
  });
  assert.equal(restored.verify().ok, true);
  assert.equal(restored.latestState().turn, 1);
  assert.equal(restored.memory().player_goal_summary, "你现在扮演 Axis。");
  assert.equal(restored.modelSteps.length, 1);
});

test("context store rejects a tampered state snapshot", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-context-tamper-"));
  const store = createContextStore({ runId: "run-tamper", directory });
  store.initialize({ scenario: "july" }, { layout: [] });
  store.snapshot({ stage: "before_decision", step: 1, state: { turn: 1, phase: "axis_initial_movement" } });
  const file = store.files.stateSnapshots;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.state.turn = 2;
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  assert.throws(() => loadContextStore(directory), /state hash/);
});

test("context store clears terminal SAE task memory instead of replaying it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-context-terminal-task-"));
  const store = createContextStore({ runId: "run-terminal-task", directory });
  store.initialize({ scenario: "july" }, { layout: [] });
  store.updateMemory({
    strategic_intent: { operation: "old_operation" },
    goal_plan: { primary_goal: { title: "old goal" } },
    force_allocation: { spearhead: ["unit-a"] },
    operation_state: { status: "in_progress" },
    task_plan: { parent: { state: "active" } }
  });
  store.recordModelStep({
    step: 2,
    turn: 1,
    phase: "axis_combat",
    side: "axis",
    final_action: { type: "combat" },
    rounds: [],
    task_observation: {
      plan: { parent: { state: "completed" }, children: [] }
    }
  }, { turn: 1, phase: "axis_combat" });
  const memory = store.memory();
  assert.equal(memory.strategic_intent, null);
  assert.equal(memory.goal_plan, null);
  assert.equal(memory.force_allocation, null);
  assert.equal(memory.operation_state, null);
  assert.equal(memory.task_plan, null);
});

test("context store initialization starts a fresh run when a directory is reused", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alamein-context-reuse-"));
  const store = createContextStore({ runId: "run-reuse", directory });
  store.initialize({ scenario: "july", seed: 1 }, { layout: [] });
  store.snapshot({ stage: "old", step: 1, state: { turn: 1 } });
  store.recordModelStep({ step: 1, turn: 1, side: "axis", final_action: { type: "pass" }, rounds: [] }, { turn: 1 });
  store.initialize({ scenario: "july", seed: 2 }, { layout: [] });
  assert.equal(fs.readFileSync(store.files.stateSnapshots, "utf8"), "");
  assert.equal(fs.readFileSync(store.files.modelSteps, "utf8"), "");
});
