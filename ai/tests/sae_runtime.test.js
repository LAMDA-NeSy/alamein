"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { readConfig } = require("../experiments/external_ai_transcript.js");
const {
  createSaeRuntime,
  battlefieldFingerprint,
  localAllocation,
  normalizeAllocation,
  normalizeIntent,
  parsePlanningResponse,
  phaseKey
} = require("../core/sae_runtime.js");

const ROOT = path.resolve(__dirname, "../..");
const state = JSON.parse(fs.readFileSync(path.join(ROOT, "scenarios/july.json"), "utf8"));

function runtime() {
  return {
    profile: {
      profile_id: "mock_primary",
      provider: "deepseek",
      defaults: { temperature: 0.25, thinking: "disabled" },
      limits: { output: 6000 },
      capabilities: { structured_output: "json_object" }
    }
  };
}

function response(value) {
  return { ok: true, status: 200, elapsed_ms: 1, response_json: { choices: [{ message: { content: JSON.stringify(value) } }] } };
}

function reasoningResponse(value) {
  return {
    ok: true,
    status: 200,
    elapsed_ms: 1,
    response_json: {
      choices: [{ message: { content: "", reasoning_content: `I considered the current position.\\n${JSON.stringify(value)}\\n` } }]
    }
  };
}

test("SAE waits across phases, reviews due waits once, and honors checker continue without replanning", async () => {
  const current = structuredClone(state);
  const ids = Object.keys(current.units).filter((id) => current.units[id].side === "axis" && current.units[id].hex);
  const input = { state: current, turn: 1, side: "axis", phase: current.phase, step: 1 };
  let plans = 0;
  let checks = 0;
  const sae = createSaeRuntime({
    config: { ...readConfig(), task_management: "multi_task", task_management_options: {
      execution_ledger: true, review_policy: "model_review_wait_v1", task_generation: "model_defined",
      route_feasibility_budget_ms: 10
    } }, runtime: runtime(),
    client: { async complete(request) {
      plans += 1;
      return request.audit_stage === "allocation" ? response({ type: "force_allocation", spearhead: [{ unit: ids[0] }], support: [], supply: [], reserve: [] })
        : response({ type: "strategic_intent", operation: "prepare", intent: { type: "consolidate", sector: "central" },
          children: [{ id: "prepare_main", task_type: "maneuver", assigned_unit_ids: [ids[0]],
            completion_criteria: { all: [{ metric: "position", relation: "at_least", target: 1, unit_ids: [ids[0]], target_hex: "4910", evaluation_scope: "immediate" }] } }] });
    } },
    taskChecker: { timeoutMs: 1000, async check({ reviewRequests, input: checkInput }) {
      checks += 1;
      const request = reviewRequests[0];
      assert.ok(request);
      return { ok: true, result: { task_id: request.task_id, review_id: request.id,
        review_decision: checks === 1 ? "wait" : "continue", confidence: 0.9, abstain: checks === 3, reason: "Retain preparation.",
        next_action_at: { turn: checkInput.state.turn, phase: checkInput.state.phase, boundary: "start" },
        evidence: { step: checkInput.step, state_change: "The phase schedule explains the pause." },
        wait: checks === 1 ? { reason: "Wait for the supply phase.", expected_change: "The truck can restore supply.",
          condition: { kind: "phase_reached", turn: 1, phase: "axis_supply_movement", boundary: "end" },
          review_at: { turn: 1, phase: "axis_supply_movement", boundary: "end" } } : null } };
    } }
  });
  await sae.plan(input);
  assert.equal(plans, 2);
  current.phase = "axis_combat";
  await sae.observe(input, { step: 1, turn: 1, phase: input.phase, final_action: { type: "pass" } });
  input.phase = current.phase; input.step = 2;
  const waiting = await sae.plan(input);
  assert.equal(checks, 1);
  assert.equal(waiting.record.task_reviews[0].review_application.accepted, true);
  assert.equal(waiting.operation_state.task_plan.children[0].wait_state.status, "waiting");
  assert.equal(waiting.record.task_plan.children[0].wait_state.status, "waiting");
  assert.equal(plans, 2);
  current.phase = "axis_supply_movement"; input.phase = current.phase; input.step = 3;
  await sae.plan(input);
  assert.equal(checks, 1);
  current.turn = 2; input.turn = 2; current.phase = "axis_initial_movement"; input.phase = current.phase; input.step = 4;
  const resumed = await sae.plan(input);
  assert.equal(checks, 2);
  assert.equal(plans, 2);
  assert.equal(resumed.record.replanned, false);
  assert.equal(resumed.operation_state.task_plan.children[0].wait_state.status, "reviewed");
  await sae.plan({ ...input, step: 5 });
  assert.equal(checks, 2);
  await sae.observe(input, { step: 5, turn: 2, phase: input.phase, final_action: { type: "pass" } });
  current.phase = "axis_combat"; input.phase = current.phase; input.step = 6;
  const abstained = await sae.plan(input);
  assert.equal(checks, 3);
  assert.equal(abstained.record.task_reviews[0].review_application, null);
  assert.equal(plans, 2);
});

test("SAE normalizes intent and filters allocation to active-side units", () => {
  const config = readConfig();
  const firstUnit = Object.keys(state.units).find((id) => state.units[id].side === state.active_side);
  const intent = normalizeIntent({ type: "strategic_intent", operation: "breakthrough", intent: { type: "pressure", sector: "central" }, target_column: 37 }, state);
  assert.equal(intent.intent.type, "pressure");
  assert.equal(intent.target_column, 37);
  const allocation = normalizeAllocation({
    force_allocation: {
      spearhead: [{ unit: firstUnit, task: "advance" }, { unit: "enemy-unit", task: "bad" }],
      support: [{ unit: firstUnit, task: "duplicate" }],
      reserve: ["enemy-unit"]
    }
  }, state, state.active_side, intent);
  assert.deepEqual(allocation.spearhead.map((item) => item.unit), [firstUnit]);
  assert.equal(allocation.support.length, 0);
  assert.equal(allocation.reserve.includes("enemy-unit"), false);
  assert.equal(allocation.reserve.includes(firstUnit), false);
  assert.equal(localAllocation(state, state.active_side, intent).source, "local_fallback");
  assert.equal(phaseKey({ turn: 2, side: "axis" }), "2:axis");
});

test("multi-task battlefield fingerprint ignores friendly control changes", () => {
  const baseline = structuredClone(state);
  const friendly = Object.entries(baseline.units).find(([, unit]) => unit.side === baseline.active_side && unit.hex);
  assert.ok(friendly);
  const options = { includeEnemyPositions: false, includeControl: false, includeVp: false };
  const before = battlefieldFingerprint({ state: baseline, side: baseline.active_side }, null, options);
  const changed = structuredClone(baseline);
  changed.units[friendly[0]].hex = "3510";
  changed.control = { ...(changed.control || {}), "3510": baseline.active_side };
  changed.victory_points = Number(changed.victory_points || 0) + 3;
  const after = battlefieldFingerprint({ state: changed, side: changed.active_side }, null, options);
  assert.equal(after, before);

  const enemy = Object.entries(changed.units).find(([, unit]) => unit.side !== changed.active_side && unit.hex);
  assert.ok(enemy);
  changed.units[enemy[0]].eliminated = true;
  const enemyChanged = battlefieldFingerprint({ state: changed, side: changed.active_side }, null, options);
  assert.notEqual(enemyChanged, before);
});

test("SAE replaces a supply vanguard assignment with an executable supply unit", () => {
  const intent = normalizeIntent({ type: "strategic_intent", operation: "supply_grounding" }, state);
  const allocation = normalizeAllocation({
    force_allocation: {
      spearhead: [],
      support: [],
      supply: [{ unit: "july-Axis-Supply-Vanguard-01", task: "maintain supply" }],
      reserve: ["july-Axis-Supply-2-01"]
    }
  }, state, "axis", intent);
  assert.equal(allocation.supply.some((item) => item.unit === "july-Axis-Supply-Vanguard-01"), false);
  assert.equal(allocation.supply.some((item) => item.unit === "july-Axis-Supply-2-01"), true);
  assert.equal(allocation.reserve.includes("july-Axis-Supply-2-01"), false);
  assert.ok(allocation.supply_corrections.some((item) => item.unit === "july-Axis-Supply-Vanguard-01"));
  assert.equal(localAllocation(state, "axis", intent).supply.some((item) => item.unit.includes("Vanguard")), false);
});

test("SAE rejects an execution response in a planning request", () => {
  const result = parsePlanningResponse(response({ type: "final_action", action: { type: "pass" } }), "strategic_intent", "strategic planner");
  assert.match(result.error, /expected strategic_intent/);
  const allocation = parsePlanningResponse(response({ type: "final_action", action: { type: "pass" } }), "force_allocation", "force allocator");
  assert.match(allocation.error, /expected force_allocation/);
});

test("SAE parses structured planning JSON from reasoning_content", () => {
  const strategic = parsePlanningResponse(
    reasoningResponse({ type: "strategic_intent", operation: "eastward_breakthrough", intent_type: "advance" }),
    "strategic_intent",
    "strategic planner"
  );
  assert.equal(strategic.type, "strategic_intent");
  assert.equal(strategic.response_source, "reasoning_content");

  const allocation = parsePlanningResponse(
    reasoningResponse({
      type: "force_allocation",
      spearhead: [{ unit: "july-5-panzer-b-01", task: "breakthrough" }],
      support: [],
      supply: [],
      reserve: []
    }),
    "force_allocation",
    "force allocator"
  );
  assert.equal(allocation.type, "force_allocation");
  assert.equal(allocation.response_source, "reasoning_content");
});

test("SAE prefers content when both response fields are present", () => {
  const result = parsePlanningResponse({
    ok: true,
    status: 200,
    response_json: {
      choices: [{ message: {
        content: JSON.stringify({ type: "strategic_intent", operation: "content_answer" }),
        reasoning_content: JSON.stringify({ type: "strategic_intent", operation: "reasoning_answer" })
      } }]
    }
  }, "strategic_intent", "strategic planner");
  assert.equal(result.operation, "content_answer");
  assert.equal(result.response_source, "content");
});

test("SAE caches a turn-side plan and records separate planner fallbacks", async () => {
  const config = readConfig();
  let calls = 0;
  const requests = [];
  const client = {
    async complete(request) {
      requests.push(request);
      calls += 1;
      if (calls === 1) return response({ type: "strategic_intent", operation: "eastward_breakthrough", intent_type: "pressure", target_column: 37 });
      return response({ type: "force_allocation", spearhead: [], support: [], supply: [], reserve: [] });
    }
  };
  const sae = createSaeRuntime({ config, runtime: runtime(), client });
  const input = { state, turn: 1, side: state.active_side, phase: state.phase, step: 1 };
  const first = await sae.plan(input);
  const second = await sae.plan({ ...input, step: 2 });
  assert.equal(calls, 2);
  assert.equal(first.reused, undefined);
  assert.equal(second.reused, true);
  assert.equal(second.record.replanned, false);
  assert.equal(second.record.replan_reason, "");
  assert.equal(first.record.strategic_fallback, false);
  assert.equal(first.record.allocation_fallback, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.thinking), [{ type: "disabled" }, { type: "disabled" }]);
  assert.equal(first.operation_state.version, "sae-operation-v1");
  assert.match(first.operation_state.next_required_task, /choose a legal action|advance/);
  const strategicPayload = JSON.parse(requests[0].messages.at(-1).content).context;
  assert.ok(Array.isArray(strategicPayload.objective_resolution.candidates));
  assert.ok(Object.hasOwn(strategicPayload, "objective_resolution"));
  assert.equal(Object.hasOwn(strategicPayload, "candidate_actions"), false);
  assert.equal(Object.hasOwn(strategicPayload, "forces"), false);
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).forces, undefined);
  assert.ok(Array.isArray(JSON.parse(requests[1].messages.at(-1).content).units.active));
  assert.equal(first.record.context_profile, "compact_current_state_v4_reasoning_memory");
  assert.ok(first.record.strategic_context_bytes < first.record.strategic_raw_context_bytes);
  const nextPhase = await sae.plan({ ...input, phase: "axis_combat", step: 3 });
  assert.equal(calls, 2);
  assert.equal(nextPhase.reused, true);
  assert.equal(nextPhase.operation_state.phase, "axis_combat");
});

test("SAE replans when the enemy battlefield fingerprint changes", async () => {
  const config = readConfig();
  let calls = 0;
  const requests = [];
  const client = {
    async complete(request) {
      requests.push(request);
      calls += 1;
      return calls % 2
        ? response({ type: "strategic_intent", operation: "hold_the_front", intent_type: "pressure" })
        : response({ type: "force_allocation", spearhead: [], support: [], supply: [], reserve: [] });
    }
  };
  const sae = createSaeRuntime({ config, runtime: runtime(), client });
  const first = structuredClone(state);
  const enemy = Object.entries(first.units).find(([, unit]) => unit.side !== first.active_side && unit.hex);
  assert.ok(enemy, "fixture must contain an enemy unit");
  const input = { state: first, turn: 1, side: first.active_side, phase: first.phase, step: 1 };
  await sae.plan(input);
  const own = Object.entries(first.units).find(([, unit]) => unit.side === first.active_side && unit.kind === "ground" && unit.hex);
  assert.ok(own);
  const feedback = { action_attempts: [{ accepted: false,
    action: { type: "move_intent", unit: own[0], destination: "3710" }, reason: "route rejected" }] };
  await sae.observe(input, feedback);
  assert.ok(feedback.verified_route_obstacles.some((item) => item.from === "3610" && item.to === "3710"));
  const changed = structuredClone(first);
  changed.units[enemy[0]].hex = changed.units[enemy[0]].hex === "2524" ? "2624" : "2524";
  const replanned = await sae.plan({ ...input, state: changed, step: 2 });
  assert.equal(calls, 4);
  assert.equal(replanned.record.replanned, true);
  assert.equal(replanned.record.replan_reason, "enemy_state_changed");
  const payload = JSON.parse(requests[2].messages.at(-1).content);
  assert.deepEqual(payload.verified_route_obstacles, feedback.verified_route_obstacles);
});

test("SAE uses local defaults when both planning responses fail", async () => {
  const config = readConfig();
  const sae = createSaeRuntime({
    config,
    runtime: runtime(),
    client: { async complete() { throw new Error("offline"); } }
  });
  const result = await sae.plan({ state, turn: 1, side: state.active_side, phase: state.phase, step: 1 });
  assert.equal(result.strategic_intent.source, "local_default");
  assert.equal(result.force_allocation.source, "local_fallback");
  assert.equal(result.record.strategic_fallback, true);
  assert.equal(result.record.allocation_fallback, true);
});

test("failed replanning retains the old operation and retries only at the next phase", async () => {
  const config = { ...readConfig(), task_management: "multi_task",
    task_management_options: { execution_ledger: true, task_generation: "model_defined" } };
  let calls = 0;
  const sae = createSaeRuntime({ config, runtime: runtime(), client: { async complete() {
    calls += 1;
    if (calls === 1) return response({ type: "strategic_intent", operation: "preserve_model_goal", target_column: 37 });
    if (calls === 2) return response({ type: "force_allocation", spearhead: [], support: [], supply: [], reserve: [] });
    return { ok: false, status: 503, error_class: "provider_error" };
  } } });
  const input = { state, turn: 1, side: state.active_side, phase: state.phase, step: 1 };
  const first = await sae.plan(input);
  sae.replanReasons.set(phaseKey(input), "operational_goal_completed");
  const failed = await sae.plan({ ...input, step: 2 });
  assert.equal(calls, 3);
  assert.equal(failed.record.retained_previous_plan, true);
  assert.equal(failed.record.planning_attempted, true);
  assert.deepEqual(failed.strategic_intent, first.strategic_intent);
  assert.deepEqual(failed.force_allocation, first.force_allocation);
  assert.deepEqual(failed.operation_state.task_plan.children.map((task) => task.id), first.operation_state.task_plan.children.map((task) => task.id));
  const cached = await sae.plan({ ...input, step: 3 });
  assert.equal(calls, 3);
  assert.equal(cached.record.planning_attempted, false);
  assert.equal(cached.operation_state.waiting_for_new_goal, true);
  const next = await sae.plan({ ...input, phase: "axis_combat", state: { ...state, phase: "axis_combat" }, step: 4 });
  assert.equal(calls, 4);
  assert.equal(next.record.retained_previous_plan, true);
  assert.equal(next.record.replan_reason, "operational_goal_completed");
});

test("multi-task SAE uses an open model goal and grounds its hard facts", async () => {
  const config = {
    ...readConfig(),
    task_management: "multi_task",
    task_management_options: {
      goal_management: "open_grounded",
      max_active_child_tasks: 3,
      no_progress_replan_threshold: 3,
      blocked_replan_threshold: 2,
      supply_worsened_replan_threshold: 2,
      low_odds_replan_threshold: 2,
      replan_cooldown_actions: 0
    }
  };
  let calls = 0;
  const sae = createSaeRuntime({
    config,
    runtime: runtime(),
    client: {
      async complete() {
        calls += 1;
        return calls === 1
          ? response({
            type: "open_goal_plan",
            operation: "open_southern_bypass",
            campaign_goal: { title: "Reach Axis Marginal", target_vp: 40 },
            primary_goal: {
              id: "bypass",
              title: "Bypass the northern defense through the south",
              goal_type: "southern_bypass",
              target_column: 35,
              expected_vp_delta: 9,
              observable_conditions: ["a scoring-eligible unit reaches column 35"]
            },
            operation_policy: { main_axis: "south", minimum_attack_odds: "2-1" }
          })
          : response({ type: "force_allocation", spearhead: [], support: [], supply: [], reserve: [] });
      }
    }
  });
  const result = await sae.plan({ state, turn: 1, side: state.active_side, phase: state.phase, step: 1 });
  assert.equal(result.goal_plan.protocol, "side-aware-goal-v2");
  assert.equal(result.goal_plan.primary_goal.goal_type, "southern_bypass");
  assert.equal(result.goal_plan.primary_goal.expected_vp_delta, 3);
  assert.equal(result.strategic_intent.intent.sector, "south");
  assert.equal(result.operation_state.version, "sae-operation-v2+side-aware-goal-v2");
  assert.equal(result.record.goal_grounding.correction_count, 1);
  assert.equal(result.operation_state.persistent_operation.id, result.goal_plan.persistent_operation.id);
  assert.equal(result.operation_state.current_subgoal.id, result.goal_plan.current_subgoal.id);
  assert.equal(result.operation_state.operation_revision, result.goal_plan.persistent_operation.revision);
});

test("multi-task SAE finalizes a defensive game-end goal from the terminal state", async () => {
  const config = {
    ...readConfig(),
    task_management: "multi_task",
    task_management_options: {
      goal_management: "open_grounded",
      max_active_child_tasks: 3,
      replan_cooldown_actions: 0
    }
  };
  const alliedState = structuredClone(state);
  alliedState.active_side = "allies";
  alliedState.phase = "allies_initial_movement";
  let calls = 0;
  const sae = createSaeRuntime({
    config,
    runtime: runtime(),
    client: {
      async complete() {
        calls += 1;
        return calls === 1
          ? response({
            type: "open_goal_plan",
            operation: "deny_axis_frontier",
            campaign_goal: { title: "Limit Axis VP", subject_side: "axis", metric: "axis_vp", relation: "at_most", target: 29, evaluation_scope: "game_end" },
            primary_goal: { title: "Deny Axis column 37", goal_type: "deny_scoring_frontier", subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", target: 37, target_column: 37, evaluation_scope: "game_end" }
          })
          : response({ type: "force_allocation", spearhead: [], support: [], supply: [], reserve: [] });
      }
    }
  });
  await sae.plan({ state: alliedState, turn: 1, side: "allies", phase: alliedState.phase, step: 1 });
  const finalState = structuredClone(alliedState);
  finalState.turn = 7;
  finalState.phase = "end_game_turn";
  const finalPlan = await sae.finalize({ state: finalState, turn: 7, side: "allies", phase: finalState.phase, step: 1 });
  assert.equal(finalPlan.parent.state, "completed");
  assert.equal(finalPlan.children.find((task) => task.type === "deny_scoring_frontier").status, "completed");
});

test("SAE replans after repeated infeasible routes and records the reason", async () => {
  const config = readConfig();
  let calls = 0;
  const client = {
    async complete(request) {
      calls += 1;
      return calls % 2
        ? response({ type: "strategic_intent", operation: "advance", intent_type: "advance", target_column: 37 })
        : response({ type: "force_allocation", spearhead: [], support: [], supply: [], reserve: [] });
    }
  };
  const sae = createSaeRuntime({ config, runtime: runtime(), client });
  const input = { state, turn: 1, side: state.active_side, phase: state.phase, step: 1 };
  await sae.plan(input);
  sae.observe(input, {
    action_attempts: [
      { action: { type: "move_intent", unit: "unit-a", destination: "0101" }, accepted: false, reason: "no legal path found" },
      { action: { type: "move_intent", unit: "unit-a", destination: "0101" }, accepted: false, reason: "no legal path found" }
    ],
    fallback_used: false
  });
  const replanned = await sae.plan({ ...input, step: 2 });
  assert.equal(calls, 4);
  assert.equal(replanned.record.replanned, true);
  assert.equal(replanned.record.replan_reason, "repeated_infeasible_route");
});
