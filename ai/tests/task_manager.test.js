"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const RulesEngine = require("../../rule_engine.js");

const state = JSON.parse(fs.readFileSync(path.join(__dirname, "../../scenarios/july.json"), "utf8"));
const {
  buildTaskSkeleton,
  createTaskManager,
  normalizeTaskPlan,
  phaseDispatchTasks,
  frontierBreakthroughPlan,
  alliedDefensePosture,
  taskEvents
} = require("../core/task_manager.js");
const { checkerPayload, createTaskCheckerRuntime, normalizeCheck } = require("../core/task_checker_runtime.js");

const unit = Object.keys(state.units).find((id) => state.units[id].side === state.active_side && state.units[id].hex);

test("Axis breakthrough skeleton contains ordered supplied column tasks and support tracks", () => {
  const skeleton = buildTaskSkeleton({
    intent: { intent: { type: "pressure" }, success_condition: "reach the frontier" },
    operation: "eastward_breakthrough",
    state,
    side: state.active_side
  });
  assert.equal(skeleton.children.length, 6);
  assert.equal(skeleton.parent.title, "完成突破");
  assert.deepEqual(
    skeleton.children.filter((task) => task.type === "breakthrough_step").map((task) => task.id),
    ["breakthrough_to_35", "breakthrough_to_36", "breakthrough_to_37"]
  );
  assert.deepEqual(skeleton.children.find((task) => task.id === "breakthrough_to_35").depends_on, []);
  assert.deepEqual(skeleton.children.find((task) => task.id === "breakthrough_to_36").depends_on, ["breakthrough_to_35"]);
  assert.deepEqual(skeleton.children.find((task) => task.id === "breakthrough_to_37").depends_on, ["breakthrough_to_36"]);
  assert.ok(skeleton.children.some((task) => task.type === "support"));
  assert.ok(skeleton.children.some((task) => task.type === "protect_flank"));
  assert.ok(skeleton.children.some((task) => task.type === "reserve"));
});

test("open goal target column is decomposed into ordered breakthrough steps", () => {
  const skeleton = buildTaskSkeleton({
    intent: {
      intent: { type: "advance" },
      target_column: 37,
      goal_plan: {
        protocol: "open-grounded-goal-v1",
        primary_goal: {
          title: "Secure the next scoring frontier",
          goal_type: "secure_scoring_frontier",
          target_column: 37,
          observable_conditions: [{ description: "a supplied unit reaches column 37" }]
        }
      }
    },
    operation: "open_advance",
    state,
    side: state.active_side
  });
  assert.equal(skeleton.parent.target_column, 37);
  assert.deepEqual(
    skeleton.children.filter((task) => task.type === "breakthrough_step").map((task) => task.target_column),
    [35, 36, 37]
  );
  assert.equal(skeleton.protocol, "side-aware-task-v2");
});

test("Axis breakthrough steps activate sequentially and cannot be skipped", () => {
  const manager = createTaskManager({ maxActiveChildTasks: 3, replanCooldownActions: 0 });
  const initialized = manager.initialize({
    intent: {
      side: "axis",
      target_column: 37,
      goal_plan: {
        protocol: "side-aware-goal-v2",
        side: "axis",
        primary_goal: { title: "Complete the breakthrough", target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "at_least", evaluation_scope: "turn_end" }
      }
    },
    operation: "breakthrough_to_37",
    input: { state, side: "axis", turn: 1 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  });
  assert.equal(initialized.children.find((task) => task.id === "breakthrough_to_35").status, "active");
  assert.equal(initialized.children.find((task) => task.id === "breakthrough_to_36").status, "pending");
  assert.equal(initialized.children.find((task) => task.id === "breakthrough_to_37").status, "pending");

  const column35 = structuredClone(state);
  column35.units[unit].hex = "3510";
  column35.units[unit].supply_state = "supplied";
  const after35 = manager.refresh({ state: column35, side: "axis", turn: 1 });
  assert.equal(after35.children.find((task) => task.id === "breakthrough_to_35").status, "completed");
  assert.equal(after35.children.find((task) => task.id === "breakthrough_to_36").status, "active");
  assert.equal(after35.children.find((task) => task.id === "breakthrough_to_37").status, "pending");

  const column37 = structuredClone(column35);
  column37.units[unit].hex = "3710";
  const afterJump = manager.refresh({ state: column37, side: "axis", turn: 1 });
  assert.equal(afterJump.children.find((task) => task.id === "breakthrough_to_36").status, "completed");
  assert.equal(afterJump.children.find((task) => task.id === "breakthrough_to_37").status, "active");
  assert.notEqual(afterJump.parent.state, "completed");
  const after37 = manager.refresh({ state: column37, side: "axis", turn: 1 });
  assert.equal(after37.children.find((task) => task.id === "breakthrough_to_37").status, "completed");
  assert.equal(after37.parent.state, "completed");
});

test("an isolated spearhead does not complete a breakthrough step", () => {
  const isolated = structuredClone(state);
  isolated.units[unit].hex = "3510";
  isolated.units[unit].supply_state = "isolated";
  const manager = createTaskManager({ replanCooldownActions: 0 });
  manager.initialize({
    intent: { side: "axis", target_column: 37 },
    operation: "supplied_breakthrough",
    input: { state, side: "axis", turn: 1 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  });
  const result = manager.refresh({ state: isolated, side: "axis", turn: 1 });
  assert.notEqual(result.children.find((task) => task.id === "breakthrough_to_35").status, "completed");
});

test("task checker cannot complete a locally grounded breakthrough step", () => {
  const manager = createTaskManager({ replanCooldownActions: 0 });
  const plan = manager.initialize({
    intent: { side: "axis", target_column: 37 },
    operation: "checked_breakthrough",
    input: { state, side: "axis", turn: 1 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  });
  const checked = manager.applyCheck({
    task_id: "breakthrough_to_35",
    task_status: "completed",
    task_progress: 1,
    confidence: 1,
    abstain: false,
    reason: "model believes the spearhead is ready"
  });
  assert.notEqual(checked.children.find((task) => task.id === "breakthrough_to_35").status, "completed");
  assert.notEqual(checked.parent.state, "completed");
  assert.ok(plan.children.some((task) => task.id === "breakthrough_to_35"));
});

test("breakthrough replanning preserves completed column steps by task id", () => {
  const manager = createTaskManager({ replanCooldownActions: 0 });
  const args = {
    intent: { side: "axis", target_column: 37 },
    operation: "persistent_breakthrough",
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  };
  manager.initialize({ ...args, input: { state, side: "axis", turn: 1 } });
  const column35 = structuredClone(state);
  column35.units[unit].hex = "3510";
  column35.units[unit].supply_state = "supplied";
  manager.refresh({ state: column35, side: "axis", turn: 1 });
  const replanned = manager.initialize({
    ...args,
    input: { state: column35, side: "axis", turn: 2 },
    preserveParent: true
  });
  assert.equal(replanned.children.find((task) => task.id === "breakthrough_to_35").status, "completed");
  assert.equal(replanned.children.find((task) => task.id === "breakthrough_to_36").status, "active");
});

test("Allied denial task does not complete from Allied eastward position", () => {
  const allied = Object.keys(state.units).find((id) => state.units[id].side === "allies" && state.units[id].hex);
  const next = structuredClone(state);
  next.units[allied].hex = "4901";
  const plan = buildTaskSkeleton({
    intent: {
      side: "allies",
      goal_plan: { primary_goal: { title: "Deny Axis column 37", target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", evaluation_scope: "game_end" } }
    }, operation: "deny", state: next, side: "allies"
  });
  const denial = plan.children.find((task) => task.type === "deny_scoring_frontier");
  assert.ok(denial);
  assert.equal(denial.target_column, 37);
  assert.equal(denial.relation, "keep_below");
});

test("Allied denial observes the Axis frontier and only completes at game end", () => {
  const alliedState = structuredClone(state);
  alliedState.active_side = "allies";
  alliedState.phase = "allies_initial_movement";
  const alliedUnit = Object.keys(alliedState.units).find((id) => alliedState.units[id].side === "allies" && alliedState.units[id].hex);
  alliedState.units[alliedUnit].hex = "4901";
  const manager = createTaskManager({ replanCooldownActions: 0 });
  manager.initialize({
    intent: {
      side: "allies",
      target_column: 37,
      goal_plan: {
        protocol: "side-aware-goal-v2",
        side: "allies",
        primary_goal: { title: "Deny Axis column 37", goal_type: "deny_scoring_frontier", target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", evaluation_scope: "game_end" }
      }
    },
    operation: "deny_axis_37",
    input: { state: alliedState, side: "allies", turn: 1 },
    allocation: { spearhead: [{ unit: alliedUnit }], support: [], supply: [], reserve: [] }
  });
  const inProgress = manager.refresh({ state: alliedState, side: "allies", turn: 1 });
  assert.notEqual(inProgress.parent.state, "completed");
  assert.equal(manager.needsReplan(), false);
});

test("Allied defensive task normalization gives disruption and counterattack their own units", () => {
  const alliedState = structuredClone(state);
  alliedState.active_side = "allies";
  alliedState.phase = "allies_initial_movement";
  const eligible = Object.entries(alliedState.units)
    .filter(([, item]) => item.side === "allies" && item.hex && RulesEngine.isMapCounter(item))
    .map(([id]) => id);
  const plan = buildTaskSkeleton({
    intent: { side: "allies", goal_plan: { primary_goal: { target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", evaluation_scope: "game_end" } } },
    operation: "allied_defense",
    state: alliedState,
    side: "allies"
  });
  const normalized = normalizeTaskPlan(plan, plan, {
    state: alliedState,
    side: "allies",
    allocation: {
      spearhead: eligible.slice(0, 5).map((unit) => ({ unit })),
      support: eligible.slice(5, 10).map((unit) => ({ unit })),
      supply: eligible.filter((id) => RulesEngine.isSupplyUnit({ id, ...alliedState.units[id] })).slice(0, 2).map((unit) => ({ unit })),
      reserve: eligible.slice(10, 15)
    }
  });
  const disruption = normalized.children.find((task) => task.type === "disrupt_axis_supply");
  const counterattack = normalized.children.find((task) => task.type === "counterattack");
  assert.ok(disruption.assigned_units.length > 0);
  assert.ok(counterattack.assigned_units.length > 0);
  assert.equal(new Set([...disruption.assigned_units, ...counterattack.assigned_units]).size,
    disruption.assigned_units.length + counterattack.assigned_units.length);
  assert.ok([...disruption.assigned_units, ...counterattack.assigned_units]
    .every((id) => RulesEngine.isCombatUnit({ id, ...alliedState.units[id] })));
});

test("Allied tactical tasks stay pending without an opportunity and activate only for a verified threat", () => {
  const alliedState = structuredClone(state);
  alliedState.active_side = "allies";
  alliedState.phase = "allies_combat";
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "../../rules_el_alamein.json"), "utf8"));
  const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, "../../terrain.json"), "utf8"));
  const ctx = RulesEngine.createContext({ state: alliedState, rules, terrain });
  const eligible = Object.entries(alliedState.units)
    .filter(([, item]) => item.side === "allies" && item.hex && RulesEngine.isCombatUnit(item))
    .map(([id]) => id);
  const manager = createTaskManager({ maxActiveChildTasks: 3, replanCooldownActions: 0 });
  const plan = manager.initialize({
    intent: { side: "allies", target_column: 37, goal_plan: { primary_goal: { target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", evaluation_scope: "game_end" } } },
    operation: "allied_dynamic_tasks",
    input: { state: alliedState, side: "allies", turn: 1, phase: alliedState.phase, ctx },
    allocation: { spearhead: eligible.slice(0, 3).map((unit) => ({ unit })), support: eligible.slice(3, 7).map((unit) => ({ unit })), supply: [], reserve: eligible.slice(7, 10) }
  });
  const counterattack = plan.children.find((task) => task.type === "counterattack");
  const disruption = plan.children.find((task) => task.type === "disrupt_axis_supply");
  assert.ok(counterattack);
  assert.ok(disruption);
  assert.equal(counterattack.tactical_opportunities.length, 0);
  assert.equal(disruption.tactical_opportunities.length, 0);
  assert.equal(counterattack.status, "pending");
  assert.equal(disruption.status, "pending");
});

test("Allied denial is completed locally only at game end when Axis stays below the target", () => {
  const finalState = structuredClone(state);
  finalState.active_side = "allies";
  finalState.turn = RulesEngine.scenarioFinalTurn(finalState.scenario);
  finalState.phase = "end_game_turn";
  const alliedUnit = Object.keys(finalState.units).find((id) => finalState.units[id].side === "allies" && finalState.units[id].hex);
  finalState.units[alliedUnit].hex = "4901";
  const manager = createTaskManager({ replanCooldownActions: 0 });
  manager.initialize({
    intent: {
      side: "allies",
      target_column: 37,
      goal_plan: {
        protocol: "side-aware-goal-v2",
        side: "allies",
        primary_goal: { title: "Deny Axis column 37", goal_type: "deny_scoring_frontier", target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", evaluation_scope: "game_end" }
      }
    },
    operation: "deny_axis_37",
    input: { state: finalState, side: "allies", turn: finalState.turn },
    allocation: { spearhead: [{ unit: alliedUnit }], support: [], supply: [], reserve: [] }
  });
  const result = manager.refresh({ state: finalState, side: "allies", turn: finalState.turn });
  assert.equal(result.parent.state, "completed");
  assert.equal(result.children.find((task) => task.type === "deny_scoring_frontier").status, "completed");
});

test("Allied parent does not complete when frontier denial succeeds but campaign VP target fails", () => {
  const finalState = structuredClone(state);
  finalState.active_side = "allies";
  finalState.turn = RulesEngine.scenarioFinalTurn(finalState.scenario);
  finalState.phase = "end_game_turn";
  const alliedUnit = Object.keys(finalState.units).find((id) => finalState.units[id].side === "allies" && finalState.units[id].hex);
  const manager = createTaskManager({ replanCooldownActions: 0 });
  manager.initialize({
    intent: {
      side: "allies",
      target_column: 37,
      goal_plan: {
        protocol: "side-aware-goal-v2",
        side: "allies",
        campaign_goal: { id: "campaign", metric: "axis_vp", relation: "at_most", target_vp: -1, evaluation_scope: "game_end" },
        primary_goal: { id: "deny", goal_type: "deny_scoring_frontier", target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", evaluation_scope: "game_end" }
      }
    },
    operation: "deny_axis_and_reduce_vp",
    input: { state: finalState, side: "allies", turn: finalState.turn },
    allocation: { spearhead: [{ unit: alliedUnit }], support: [], supply: [], reserve: [] }
  });
  const result = manager.refresh({ state: finalState, side: "allies", turn: finalState.turn });
  assert.equal(result.parent.state, "failed");
  assert.equal(result.parent.goal_failure_evidence.some((item) => item.goal_id === "campaign" && item.met === false), true);
});

test("Allied defense posture separates the next scoring column, campaign breach, and hard stop", () => {
  const defensiveState = structuredClone(state);
  defensiveState.victory_points = 25;
  const plan = {
    side: "allies",
    parent: { target_column: 37 },
    goal_plan: {
      campaign_goal: { metric: "axis_vp", relation: "at_most", target_vp: 29 },
      primary_goal: { metric: "scoring_frontier", relation: "keep_below", target_column: 37 }
    }
  };
  const posture = alliedDefensePosture(plan, { state: defensiveState, side: "allies" });
  assert.equal(posture.axis_scoring_frontier, 34);
  assert.equal(posture.next_threatened_column, 35);
  assert.equal(posture.campaign_breach_column, 36);
  assert.equal(posture.hard_stop_column, 37);
  assert.deepEqual(posture.defense_layers, [35, 36, 37]);
});

test("three Allied holds in one step trigger defensive replanning", () => {
  const defensiveState = structuredClone(state);
  defensiveState.active_side = "allies";
  defensiveState.phase = "allies_initial_movement";
  const alliedUnits = Object.keys(defensiveState.units)
    .filter((id) => defensiveState.units[id].side === "allies" && defensiveState.units[id].hex)
    .slice(0, 4);
  const manager = createTaskManager({ replanCooldownActions: 0, passiveHoldThreshold: 3 });
  manager.initialize({
    intent: {
      side: "allies",
      goal_plan: {
        campaign_goal: { metric: "axis_vp", relation: "at_most", target_vp: 29, evaluation_scope: "game_end" },
        primary_goal: { metric: "scoring_frontier", relation: "keep_below", target_column: 37, evaluation_scope: "game_end" }
      }
    },
    operation: "layered_defense",
    input: { state: defensiveState, side: "allies", turn: 1, phase: defensiveState.phase },
    allocation: { spearhead: [{ unit: alliedUnits[0] }], support: [{ unit: alliedUnits[1] }], supply: [], reserve: alliedUnits.slice(2) }
  });
  const observation = manager.observe(
    { state: defensiveState, side: "allies", turn: 1, step: 1, phase: defensiveState.phase },
    {
      final_action: { type: "move", unit: alliedUnits[0], destination: defensiveState.units[alliedUnits[0]].hex },
      action_attempts: [{ accepted: true, assessment: { evaluation: { victory_impact: {} } } }],
      rolling_unit_action: { held_this_step: alliedUnits.slice(1, 4).map((unit) => ({ unit, reason: "defensive role" })) }
    }
  );
  assert.ok(observation.events.includes("excessive_passive_holds"));
  assert.equal(manager.consumeReplanReason(), "task_excessive_passive_holds");
});

test("Allied checker payload separates local denial evidence from campaign VP outcome", () => {
  const payload = checkerPayload({
    input: { side: "allies", turn: 7, step: 20, phase: "end_game_turn", state },
    taskPlan: {
      side: "allies",
      parent: { id: "defense", state: "active", objective: "deny", completion_condition: "deny 37", goal_progress_evidence: [{ kind: "victory_points", actual: 31, target: 29, met: false }] },
      goal_plan: {
        campaign_goal: { metric: "axis_vp", relation: "at_most", target_vp: 29 },
        primary_goal: { metric: "scoring_frontier", relation: "keep_below", target_column: 37 }
      },
      defensive_posture: { next_threatened_column: 37, campaign_status: "campaign_target_already_exceeded" },
      children: [{ id: "deny", type: "deny_scoring_frontier", status: "active", assigned_units: [] }]
    },
    stepRecord: { final_action: { type: "pass" }, action_attempts: [] },
    events: ["phase_end"]
  });
  assert.equal(payload.parent.campaign_goal.target_vp, 29);
  assert.equal(payload.parent.defensive_posture.campaign_status, "campaign_target_already_exceeded");
  assert.match(payload.parent.authority, /Local rules alone/);
});

test("Allied denial fails locally at game end when the supplied Axis frontier reaches the target", () => {
  const finalState = structuredClone(state);
  finalState.active_side = "allies";
  finalState.turn = RulesEngine.scenarioFinalTurn(finalState.scenario);
  finalState.phase = "end_game_turn";
  const alliedUnit = Object.keys(finalState.units).find((id) => finalState.units[id].side === "allies" && finalState.units[id].hex);
  const axisUnit = Object.keys(finalState.units).find((id) => finalState.units[id].side === "axis"
    && finalState.units[id].hex && (finalState.units[id].kind || "ground") === "ground");
  finalState.units[axisUnit].hex = "3711";
  finalState.units[axisUnit].supply_state = "supplied";
  const manager = createTaskManager({ replanCooldownActions: 0 });
  manager.initialize({
    intent: {
      side: "allies",
      target_column: 37,
      goal_plan: {
        protocol: "side-aware-goal-v2",
        side: "allies",
        primary_goal: { title: "Deny Axis column 37", goal_type: "deny_scoring_frontier", target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", evaluation_scope: "game_end" }
      }
    },
    operation: "deny_axis_37",
    input: { state: finalState, side: "allies", turn: finalState.turn },
    allocation: { spearhead: [{ unit: alliedUnit }], support: [], supply: [], reserve: [] }
  });
  const result = manager.refresh({ state: finalState, side: "allies", turn: finalState.turn });
  assert.equal(result.parent.state, "failed");
  assert.equal(result.children.find((task) => task.type === "deny_scoring_frontier").status, "failed");
});

test("an unmet Axis frontier goal fails locally at game end", () => {
  const finalState = structuredClone(state);
  finalState.active_side = "axis";
  finalState.turn = RulesEngine.scenarioFinalTurn(finalState.scenario);
  finalState.phase = "end_game_turn";
  const manager = createTaskManager({ replanCooldownActions: 0 });
  manager.initialize({
    intent: {
      side: "axis",
      target_column: 37,
      goal_plan: {
        protocol: "side-aware-goal-v2",
        side: "axis",
        primary_goal: { title: "Reach Axis column 37", goal_type: "advance", target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "at_least", evaluation_scope: "turn_end" }
      }
    },
    operation: "reach_axis_37",
    input: { state: finalState, side: "axis", turn: finalState.turn },
    allocation: { spearhead: [], support: [], supply: [], reserve: [] }
  });
  const result = manager.refresh({ state: finalState, side: "axis", turn: finalState.turn });
  assert.equal(result.parent.state, "failed");
  assert.ok(result.parent.goal_failure_evidence.some((item) => item.kind === "scoring_frontier" && item.met === false));
});

test("task checker cannot complete an Allied denial before local end-game adjudication", () => {
  const alliedState = structuredClone(state);
  alliedState.active_side = "allies";
  alliedState.phase = "allies_initial_movement";
  const alliedUnit = Object.keys(alliedState.units).find((id) => alliedState.units[id].side === "allies" && alliedState.units[id].hex);
  const manager = createTaskManager({ replanCooldownActions: 0 });
  const plan = manager.initialize({
    intent: {
      side: "allies",
      target_column: 37,
      goal_plan: {
        protocol: "side-aware-goal-v2",
        side: "allies",
        primary_goal: { title: "Deny Axis column 37", goal_type: "deny_scoring_frontier", target_column: 37, subject_side: "axis", metric: "scoring_frontier", relation: "keep_below", evaluation_scope: "game_end" }
      }
    },
    operation: "deny_axis_37",
    input: { state: alliedState, side: "allies", turn: 1 },
    allocation: { spearhead: [{ unit: alliedUnit }], support: [], supply: [], reserve: [] }
  });
  const denial = plan.children.find((task) => task.type === "deny_scoring_frontier");
  const checked = manager.applyCheck({
    task_id: denial.id,
    task_status: "completed",
    task_progress: 1,
    confidence: 1,
    abstain: false,
    reason: "model believes the line is secure"
  });
  assert.notEqual(checked.children.find((task) => task.id === denial.id).status, "completed");
  assert.notEqual(checked.parent.state, "completed");
});

test("frontier breakthrough plan exposes dynamic entry and approach routes", () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "../../rules_el_alamein.json"), "utf8"));
  const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, "../../terrain.json"), "utf8"));
  const ctx = RulesEngine.createContext({ state: structuredClone(state), rules, terrain });
  const plan = buildTaskSkeleton({
    intent: { intent: { type: "advance" }, target_column: 35 },
    operation: "dynamic_frontier",
    state,
    side: "axis"
  });
  const result = frontierBreakthroughPlan({ parent: { target_column: 35 } }, {
    state: ctx.state,
    side: "axis",
    phase: "axis_initial_movement",
    ctx
  });
  assert.equal(result.protocol, "dynamic-frontier-breakthrough-v1");
  assert.equal(result.current_column, 34);
  assert.equal(result.target_column, 35);
  assert.ok(result.direct_entry_routes.length > 0);
  assert.ok(result.direct_entry_routes.every((route) => route.target_column >= 35));
  assert.ok(result.direct_entry_routes.every((route) => Array.isArray(route.path) && route.path.length > 1));
  assert.match(result.model_freedom, /not mandatory/);
  const dispatch = phaseDispatchTasks({ ...plan, parent: { target_column: 35 }, children: [] }, {
    state: ctx.state,
    side: "axis",
    phase: "axis_initial_movement",
    ctx
  });
  assert.equal(dispatch.frontier_breakthrough.target_column, 35);
});

test("a grounded primary frontier goal triggers rolling replanning when achieved", () => {
  const manager = createTaskManager({ replanCooldownActions: 0 });
  const nextState = structuredClone(state);
  nextState.units[unit].hex = "3510";
  nextState.units[unit].supply_state = "supplied";
  manager.initialize({
    intent: {
      intent: { type: "advance" },
      target_column: 35,
      goal_plan: {
        protocol: "open-grounded-goal-v1",
        primary_goal: { title: "Secure column 35", goal_type: "secure_scoring_frontier", target_column: 35 }
      }
    },
    operation: "rolling_frontier",
    input: { state, side: state.active_side, turn: 1 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  });
  const refreshed = manager.refresh({ state: nextState, side: state.active_side, turn: 1, step: 2 });
  assert.equal(refreshed.parent.state, "completed");
  assert.equal(manager.needsReplan(), true);
  assert.equal(manager.consumeReplanReason(), "task_goal_completed");
});

test("task normalization preserves ordered breakthrough reuse and rejects parallel duplicate units", () => {
  const skeleton = buildTaskSkeleton({ intent: {}, operation: "operation", state, side: state.active_side });
  const plan = normalizeTaskPlan({
    children: skeleton.children.map((task, index) => ({
      ...task,
      id: `model-${index}`,
      assigned_units: index < 2 ? [unit] : [],
      depends_on: index < 2 ? [`model-${index === 0 ? 1 : 0}`] : []
    }))
  }, skeleton, {
    state,
    side: state.active_side,
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  });
  const breakthrough = plan.children.filter((task) => task.type === "breakthrough_step");
  assert.equal(breakthrough.length, 3);
  assert.ok(breakthrough.every((task) => task.assigned_units.includes(unit)));
  const parallel = plan.children.filter((task) => task.type !== "breakthrough_step");
  assert.equal(parallel.flatMap((task) => task.assigned_units).includes(unit), false);
  assert.equal(plan.children.some((task) => task.depends_on.includes(task.id)), false);
  assert.equal(plan.children.length, 6);
  const assignedSet = new Set(plan.children.flatMap((task) => task.assigned_units));
  const eligibleCount = Object.values(state.units).filter((item) => item.side === state.active_side && item.hex && !item.eliminated).length;
  assert.equal(assignedSet.size, eligibleCount);
  assert.deepEqual(breakthrough[1].depends_on, [breakthrough[0].id]);
  assert.deepEqual(breakthrough[2].depends_on, [breakthrough[1].id]);
});

test("task normalization assigns the spearhead to every sequential breakthrough step", () => {
  const spearhead = Object.keys(state.units).find((id) => state.units[id].side === state.active_side
    && state.units[id].kind === "ground" && state.units[id].hex);
  const support = Object.keys(state.units).find((id) => id !== spearhead && state.units[id].side === state.active_side
    && state.units[id].kind === "ground" && state.units[id].hex);
  const skeleton = buildTaskSkeleton({ intent: {}, operation: "grounded_tasks", state, side: state.active_side });
  const plan = normalizeTaskPlan({}, skeleton, {
    state,
    side: state.active_side,
    allocation: {
      spearhead: [{ unit: spearhead }],
      support: [{ unit: support }],
      supply: [],
      reserve: []
    }
  });
  const breakthrough = plan.children.filter((task) => task.type === "breakthrough_step");
  assert.equal(breakthrough.length, 3);
  assert.ok(breakthrough.every((task) => task.assigned_units.includes(spearhead)));
  assert.equal(plan.children.filter((task) => task.type !== "breakthrough_step")
    .flatMap((task) => task.assigned_units).includes(spearhead), false);
  assert.ok(plan.children.find((task) => task.type === "support").assigned_units.includes(support));
});

test("task manager persists the parent plan and requires three no-progress observations", () => {
  const manager = createTaskManager({ maxActiveChildTasks: 3 });
  manager.initialize({
    intent: { intent: { type: "advance" }, success_condition: "reach the frontier" },
    operation: "eastward_breakthrough",
    input: { state, side: state.active_side, turn: 1 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  });
  const input = { state, side: state.active_side, turn: 1, step: 1, phase: "axis_combat" };
  const first = manager.observe(input, { final_action: { type: "pass" }, action_attempts: [] });
  assert.equal(first.events.includes("no_task_progress"), true);
  assert.equal(first.checker_events.includes("repeated_no_task_progress"), false);
  assert.equal(manager.needsReplan(), false);
  const second = manager.observe({ ...input, step: 2 }, { final_action: { type: "pass" }, action_attempts: [] });
  assert.equal(second.events.includes("no_task_progress"), true);
  assert.equal(manager.needsReplan(), false);
  const third = manager.observe({ ...input, step: 3 }, { final_action: { type: "pass" }, action_attempts: [] });
  assert.equal(third.events.includes("no_task_progress"), true);
  assert.equal(third.checker_events.includes("repeated_no_task_progress"), true);
  assert.equal(manager.needsReplan(), true);
  assert.equal(manager.consumeReplanReason(), "task_no_progress");
});

test("actions assigned only to an inactive task do not create artificial progress", () => {
  const supportUnit = Object.keys(state.units).find((id) => id !== unit
    && state.units[id].side === state.active_side
    && state.units[id].kind === "ground"
    && state.units[id].hex);
  const manager = createTaskManager({ maxActiveChildTasks: 1 });
  manager.initialize({
    intent: { intent: { type: "advance" }, success_condition: "reach the frontier" },
    operation: "eastward_breakthrough",
    input: { state, side: state.active_side, turn: 1 },
    allocation: { spearhead: [{ unit }], support: [{ unit: supportUnit }], supply: [], reserve: [] }
  });
  const result = manager.observe({
    state,
    side: state.active_side,
    turn: 1,
    step: 1,
    phase: "axis_initial_movement"
  }, {
    final_action: { type: "move", unit: supportUnit, destination: state.units[supportUnit].hex },
    action_attempts: [{ accepted: true }]
  });
  assert.equal(result.progress.changed, false);
  assert.equal(result.progress.action_matched_inactive_task, true);
  assert.equal(result.progress.reason, "action_unit_assigned_to_inactive_task");
});

test("phase dispatch filters task units by the current phase", () => {
  const manager = createTaskManager({ maxActiveChildTasks: 3 });
  const plan = manager.initialize({
    intent: { intent: { type: "advance" }, success_condition: "reach the frontier" },
    operation: "phase_dispatch",
    input: { state, side: state.active_side, turn: 1 },
    allocation: {
      spearhead: [{ unit }],
      support: [],
      supply: [{ unit: "july-Axis-Supply-2-01" }],
      reserve: []
    }
  });
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "../../rules_el_alamein.json"), "utf8"));
  const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, "../../terrain.json"), "utf8"));
  const ctx = RulesEngine.createContext({ state, rules, terrain });
  const dispatch = phaseDispatchTasks(plan, {
    state,
    side: state.active_side,
    phase: "axis_initial_movement",
    ctx
  });
  assert.equal(dispatch.tasks.some((task) => task.type === "preserve_supply"), false);
  assert.equal(dispatch.tasks.some((task) => task.type === "breakthrough_step"), true);
  assert.equal(dispatch.tasks.some((task) => task.type === "joint_attack"), false);
  assert.equal(dispatch.allowed_unit_ids.includes("july-Axis-Supply-2-01"), false);
});

test("combat events distinguish joint attacks and low odds from single-unit attacks", () => {
  const single = taskEvents({}, {
    phase: "axis_combat",
    final_action: { type: "combat", attackers: ["a"] },
    action_attempts: [{ accepted: true, assessment: { evaluation: { odds_column: "1-1" } } }]
  }, { changed: false });
  assert.equal(single.includes("joint_attack"), false);
  assert.equal(single.includes("low_odds_attack"), true);
  assert.equal(single.includes("phase_end"), false);
  const joint = taskEvents({}, {
    phase: "axis_combat",
    final_action: { type: "combat", attackers: ["a", "b"] },
    action_attempts: [{ accepted: true, assessment: { evaluation: { odds_column: "2-1" } } }]
  }, { changed: true });
  assert.equal(joint.includes("joint_attack"), true);
  assert.equal(joint.includes("low_odds_attack"), false);
});

test("combat pass is both a phase-end event and local no-progress evidence", () => {
  const events = taskEvents({}, {
    phase: "allies_combat",
    final_action: { type: "pass", reason: "no favorable attack" },
    action_attempts: [{ accepted: true }]
  }, { changed: false, reason: "no_accepted_non_pass_action" });
  assert.equal(events.includes("phase_end"), true);
  assert.equal(events.includes("no_task_progress"), true);
});

test("combat task events use the applied CRT result rather than expected odds", () => {
  const base = {
    phase: "allies_combat",
    final_action: { type: "combat", attackers: ["allied-a"], defender_hexes: ["3511"] },
    action_attempts: [{
      accepted: true,
      assessment: {
        action: { verdict: { details: { defenders: ["axis-d"] } } },
        evaluation: { odds_column: "3-1", targets: [{ defenders: [{ id: "axis-d", supply: "supplied" }] }] }
      }
    }]
  };
  const adverse = taskEvents({ side: "allies" }, {
    ...base,
    action_applied: { result: { details: { outcome: "A1", defenders: ["axis-d"], effects: { eliminated: [], retreated: { retreated: ["allied-a"] } } } } }
  }, { changed: false });
  assert.equal(adverse.includes("combat_target_threat_reduced"), false);
  assert.equal(adverse.includes("own_force_harmed"), true);

  const effective = taskEvents({ side: "allies" }, {
    ...base,
    action_applied: { result: { details: { outcome: "D1", defenders: ["axis-d"], effects: { eliminated: [], retreated: { retreated: ["axis-d"] } } } } }
  }, { changed: true });
  assert.equal(effective.includes("combat_target_threat_reduced"), true);
  assert.equal(effective.includes("own_force_harmed"), false);
});

test("two consecutive low-odds attacks trigger goal replanning", () => {
  const manager = createTaskManager({ maxActiveChildTasks: 3, lowOddsThreshold: 2, replanCooldownActions: 0 });
  manager.initialize({
    intent: { intent: { type: "attack_pressure" }, success_condition: "create a favorable attack" },
    operation: "attack_operation",
    input: { state, side: state.active_side, turn: 1 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  });
  const record = {
    final_action: { type: "combat", attackers: [unit], defender_hexes: ["3612"] },
    action_attempts: [{ accepted: true, assessment: { evaluation: { odds_column: "1-1" } } }]
  };
  manager.observe({ state, side: state.active_side, turn: 1, step: 1, phase: "axis_combat" }, record);
  assert.equal(manager.needsReplan(), false);
  manager.observe({ state, side: state.active_side, turn: 1, step: 2, phase: "axis_combat" }, record);
  assert.equal(manager.needsReplan(), true);
  assert.equal(manager.consumeReplanReason(), "task_repeated_low_odds_attack");
});

test("task replanning preserves the active parent identity", () => {
  const manager = createTaskManager({ maxActiveChildTasks: 3 });
  const first = manager.initialize({
    intent: { intent: { type: "advance" }, success_condition: "reach the frontier" },
    operation: "eastward_breakthrough",
    input: { state, side: state.active_side, turn: 1 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] }
  });
  const second = manager.initialize({
    intent: { intent: { type: "consolidate" }, success_condition: "preserve the corridor" },
    operation: "supply_recovery",
    input: { state, side: state.active_side, turn: 2 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] },
    preserveParent: true
  });
  assert.equal(second.parent.id, first.parent.id);
  assert.equal(second.parent.started_turn, first.parent.started_turn);
  assert.equal(second.parent.objective, first.parent.objective);
  assert.equal(second.parent.previous_replan_count, 1);
});

test("task checker normalization only accepts existing task ids and status values", () => {
  const result = normalizeCheck({
    task_id: "missing",
    task_status: "completed",
    action_assessment: "good",
    task_progress: 2,
    next_task: "missing"
  }, { children: [{ id: "advance_frontier", status: "active" }] });
  assert.equal(result.task_id, "advance_frontier");
  assert.equal(result.task_status, "completed");
  assert.equal(result.task_progress, 1);
  assert.equal(result.next_task, "");
  assert.equal(result.abstain, true);
});

test("task checker rejects unsupported judgments without state-change evidence", async () => {
  const checker = createTaskCheckerRuntime({
    client: {
      async complete() {
        return {
          ok: true,
          status: 200,
          response_json: { choices: [{ message: { content: JSON.stringify({
            type: "task_check",
            task_id: "advance_frontier",
            task_status: "completed",
            confidence: 0.9,
            abstain: false
          }) } }] }
        };
      }
    },
    runtime: { profile: { provider: "mock", defaults: { temperature: 0 }, limits: { output: 2048 }, capabilities: { structured_output: true } } }
  });
  const result = await checker.check({
    input: { turn: 1, state },
    taskPlan: { children: [{ id: "advance_frontier", status: "active" }] },
    stepRecord: { final_action: { type: "move", unit } },
    events: ["task_completed"]
  });
  assert.equal(result.fallback, true);
  assert.match(result.reason, /state-change evidence/);
});
