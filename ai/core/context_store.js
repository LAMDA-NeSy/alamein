"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const input = typeof value === "string" ? value : stableJson(value);
  return crypto.createHash("sha256").update(input).digest("hex");
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function readJsonl(file, label, validate = null) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${file}`);
  const records = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let value;
    try { value = JSON.parse(line); }
    catch (error) { throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`); }
    if (validate) validate(value, index + 1);
    records.push(value);
  }
  return records;
}

function safeFilePart(value) {
  return String(value || "run").replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function storeFiles(directory) {
  return {
    manifest: path.join(directory, "manifest.json"),
    mapReference: path.join(directory, "map_reference.json"),
    stateSnapshots: path.join(directory, "state_snapshots.jsonl"),
    durableMemory: path.join(directory, "durable_memory.json"),
    modelSteps: path.join(directory, "model_steps.jsonl")
  };
}

function validateSnapshot(record, line) {
  if (!record || typeof record !== "object" || !record.state || !record.state_hash) {
    throw new Error(`state_snapshots line ${line} has no state or state_hash`);
  }
  const actual = sha256(record.state);
  if (actual !== record.state_hash) {
    throw new Error(`state_snapshots line ${line} has state hash ${record.state_hash}, calculated ${actual}`);
  }
}

function loadContextStore(directory, options = {}) {
  const resolvedDirectory = path.resolve(directory);
  const files = storeFiles(resolvedDirectory);
  const manifest = readJson(files.manifest, "context manifest");
  if (manifest.context_store_version !== 1) {
    throw new Error(`unsupported context store version ${manifest.context_store_version}`);
  }
  const mapReference = readJson(files.mapReference, "map reference");
  const hashes = manifest.hashes || {};
  const mapHash = sha256(mapReference);
  if (hashes.map_reference_hash && hashes.map_reference_hash !== mapHash) {
    throw new Error(`map reference hash mismatch: manifest=${hashes.map_reference_hash}, calculated=${mapHash}`);
  }
  for (const [name, expected] of Object.entries(options.expectedHashes || {})) {
    if (expected == null || expected === "") continue;
    if (hashes[name] !== expected) {
      throw new Error(`context hash mismatch for ${name}: manifest=${hashes[name] || "<missing>"}, expected=${expected}`);
    }
  }
  const snapshots = readJsonl(files.stateSnapshots, "state snapshots", validateSnapshot);
  const modelSteps = readJsonl(files.modelSteps, "model steps");
  const durableMemory = readJson(files.durableMemory, "durable memory");
  return {
    directory: resolvedDirectory,
    files,
    manifest,
    mapReference,
    snapshots,
    modelSteps,
    durableMemory,
    latestSnapshot() { return snapshots.at(-1) || null; },
    latestState() { return snapshots.at(-1)?.state ? clone(snapshots.at(-1).state) : null; },
    memory() { return clone(durableMemory); },
    verify() {
      return {
        ok: true,
        snapshot_count: snapshots.length,
        model_step_count: modelSteps.length,
        map_reference_hash: mapHash,
        latest_snapshot_hash: snapshots.at(-1)?.state_hash || null
      };
    }
  };
}

function createContextStore(options = {}) {
  if (!options.runId) throw new Error("context store requires runId");
  const outFile = options.outFile ? path.resolve(options.outFile) : "";
  const directory = path.resolve(options.directory || path.join(path.dirname(outFile || process.cwd()), safeFilePart(options.runId)));
  fs.mkdirSync(directory, { recursive: true });
  const files = storeFiles(directory);
  const memory = {
    version: 1,
    updated_at: null,
    player_goal_summary: "",
    strategic_intent: null,
    goal_plan: null,
    force_allocation: null,
    operation_state: null,
    task_plan: null,
    reasoning_memory: null,
    supply_risks: [],
    recent_strategic_events: []
  };

  function writeMemory() {
    memory.updated_at = new Date().toISOString();
    fs.writeFileSync(files.durableMemory, JSON.stringify(memory, null, 2), "utf8");
  }

  function updateMemory(update = {}) {
    for (const key of ["player_goal_summary", "strategic_intent", "goal_plan", "force_allocation", "operation_state", "task_plan", "reasoning_memory"]) {
      if (update[key] !== undefined) memory[key] = clone(update[key]);
    }
    if (Array.isArray(update.supply_risks)) memory.supply_risks = clone(update.supply_risks).slice(-12);
    if (Array.isArray(update.recent_strategic_events)) memory.recent_strategic_events = clone(update.recent_strategic_events).slice(-24);
    writeMemory();
    return clone(memory);
  }

  function recordModelStep(stepRecord, state, metadata = {}) {
    const step = clone(stepRecord);
    const taskPlan = step.task_observation?.plan
      || step.sae_plan?.task_plan
      || undefined;
    const taskParentState = taskPlan?.parent?.state || "";
    const taskIsTerminal = ["completed", "failed", "cancelled", "superseded"].includes(taskParentState);
    const durableOperationState = taskIsTerminal
      ? null
      : (step.operation_state || undefined);
    const event = {
      step: step.step,
      turn: step.turn,
      phase: step.phase,
      side: step.side,
      context_bytes: step.context_bytes || 0,
      raw_context_bytes: step.raw_context_bytes || 0,
      static_context_bytes: step.static_context_bytes || 0,
      effective_context_bytes: step.effective_context_bytes || step.context_bytes || 0,
      context_profile: step.context_profile || null,
      tool_feedback_profile: step.tool_feedback_profile || null,
      final_action: step.final_action || null,
      fallback_used: !!step.fallback_used,
      local_fast_pass: !!step.local_fast_pass,
      phase_intent: step.phase_intent?.value || step.phase_intent || null,
      strategic_intent: step.strategic_intent || null,
      goal_plan: step.goal_plan || null,
      force_allocation: step.force_allocation || null,
      operation_state: step.operation_state || null,
      task_plan: taskPlan || null,
      task_observation: step.task_observation || null,
      reasoning_memory_entry: step.reasoning_memory_entry || null,
      reasoning_memory_stats: step.reasoning_memory_stats || null,
      context_policy: metadata.context_policy || "current_state_plus_durable_memory",
      map_reference_hash: metadata.map_reference_hash || null,
      tool_calls: (step.rounds || []).filter((round) => round.tool_result).map((round) => round.tool_result),
      state_hash_before: metadata.stateHashBefore || (state ? sha256(state) : null),
      state_hash_after: metadata.stateAfter ? sha256(metadata.stateAfter) : (step.state_hash_after || null),
      action_applied: step.action_applied || null
    };
    appendJsonl(files.modelSteps, event);
    updateMemory({
      strategic_intent: taskIsTerminal ? null : step.strategic_intent,
      goal_plan: taskIsTerminal ? null : step.goal_plan,
      force_allocation: taskIsTerminal ? null : step.force_allocation,
      operation_state: durableOperationState,
      task_plan: taskPlan === undefined ? undefined : (taskIsTerminal ? null : taskPlan),
      reasoning_memory: step.reasoning_memory_state || undefined,
      recent_strategic_events: [{ step: step.step, turn: step.turn, phase: step.phase, action: step.final_action || null }]
    });
  }

  function snapshot(input = {}) {
    if (!input.state) throw new Error("context snapshot requires state");
    const state = clone(input.state);
    const record = {
      snapshot_id: `${input.step ?? "x"}:${input.stage || "state"}:${Date.now()}`,
      saved_at: new Date().toISOString(),
      stage: input.stage || "state",
      step: input.step ?? null,
      turn: input.turn ?? state.turn ?? null,
      phase: input.phase || state.phase || null,
      side: input.side || state.active_side || null,
      state_hash: sha256(state),
      state
    };
    appendJsonl(files.stateSnapshots, record);
    return record;
  }

  function initialize(manifest = {}, mapReference = null) {
    const normalizedManifest = {
      context_store_version: 1,
      run_id: options.runId,
      created_at: new Date().toISOString(),
      ...clone(manifest),
      hashes: {
        ...(manifest.hashes || {}),
        map_reference_hash: mapReference ? sha256(mapReference) : null
      },
      files: files
    };
    fs.writeFileSync(files.manifest, JSON.stringify(normalizedManifest, null, 2), "utf8");
    if (mapReference) fs.writeFileSync(files.mapReference, JSON.stringify(mapReference, null, 2), "utf8");
    // initialize starts a new experiment; never append records from a prior
    // run that happened to reuse the same output path.
    fs.writeFileSync(files.stateSnapshots, "", "utf8");
    fs.writeFileSync(files.modelSteps, "", "utf8");
    writeMemory();
    return normalizedManifest;
  }

  return {
    directory,
    files,
    initialize,
    snapshot,
    recordModelStep,
    updateMemory,
    memory: () => clone(memory),
    hash: sha256
  };
}

module.exports = { createContextStore, loadContextStore, sha256, stableJson };
