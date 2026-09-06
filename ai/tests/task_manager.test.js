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
  axisTacticalOpportunities,
  axisCombatPreparation,
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

test("September and October local task fallbacks do not import July breakthrough checkpoints", () => {
  for (const scenario of ["september", "october"]) {
    const scenarioState = JSON.parse(fs.readFileSync(path.join(__dirname, `../../scenarios/${scenario}.json`), "utf8"));
    const skeleton = buildTaskSkeleton({
      intent: { side: "axis" },
      operation: `${scenario}_fallback`,
      state: scenarioState,
      side: "axis"
    });
    assert.equal(skeleton.children.some((task) => task.type === "breakthrough_step"), false, scenario);
    assert.ok(skeleton.children.some((task) => task.type === "preserve_supply"), scenario);
    assert.ok(skeleton.children.some((task) => task.type === "preserve_force"), scenario);
    if (scenario === "september") assert.equal(skeleton.children.find((task) => task.type === "clear_blocker").title, "清除 Allied 雷区和突破阻挡");
    if (scenario === "october") assert.match(skeleton.children.find((task) => task.type === "preserve_force").title, /Axis/);
  }
});

test("model-defined task mode preserves a flexible model task tree", () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "../../rules_el_alamein.json"), "utf8"));
  const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, "../../terrain.json"), "utf8"));
  const ctx = RulesEngine.createContext({ state: structuredClone(state), rules, terrain });
  const units = Object.keys(state.units).filter((id) => state.units[id].side === "axis" && state.units[id].hex).slice(0, 2);
  const skeleton = buildTaskSkeleton({
    intent: { side: "axis", target_column: 37 },
    operation: "southern_envelopment",
    state: ctx.state,
    side: "axis",
    taskGeneration: "model_defined"
  });
  const plan = normalizeTaskPlan({
    task_plan: {
      parent: { title: "绕过中央防线", completion_condition: "主力从南侧形成突破", failure_condition: "南侧路线被完全封锁" },
      children: [
        { id: "screen_south", type: "screen", title: "牵制南侧防线", priority: 2, assigned_unit_ids: [units[0]], dependencies: [], observable_completion_condition: "南侧敌军无法支援中央", observable_failure_condition: "牵制失败", phases: ["initial_movement"] },
        { id: "bypass", task_type: "maneuver", title: "从南侧绕行", priority: 1, assigned_unit_ids: [units[1]], dependencies: ["screen_south"], observable_completion_condition: "装甲单位进入南侧突破区域", observable_failure_condition: "路线不可行", phases: ["mechanized_movement"] }
      ]
    }
  }, skeleton, {
    state: ctx.state,
    side: "axis",
    allocation: { spearhead: [{ unit: units[1] }], support: [{ unit: units[0] }], supply: [], reserve: [] }
  });
  assert.equal(plan.protocol, "model-defined-task-v1");
  assert.equal(plan.task_generation, "model_defined");
  assert.deepEqual(plan.children.map((task) => task.id), ["screen_south", "bypass"]);
  assert.equal(plan.children[0].model_task_type, "screen");
  assert.deepEqual(plan.children[1].depends_on, ["screen_south"]);
  assert.deepEqual(plan.children[0].assigned_units, [units[0]]);
  assert.deepEqual(plan.children[1].assigned_units, [units[1]]);
  assert.deepEqual(plan.children[0].phase_scope, ["initial_movement"]);
  assert.equal(plan.children.some((task) => task.type === "breakthrough_step"), false);
  assert.equal(plan.children.some((task) => task.type === "clear_blocker"), false);
});

test("model-defined tasks distinguish hard, soft, and conditional dependencies", () => {
  const skeleton = buildTaskSkeleton({
    intent: { side: "axis" },
    operation: "dependency_semantics",
    state,
    side: "axis",
    taskGeneration: "model_defined"
  });
  const plan = normalizeTaskPlan({
    children: [
      { id: "prepare", task_type: "consolidate", assigned_unit_ids: [unit] },
      { id: "hard_follow", task_type: "advance", assigned_unit_ids: [], depends_on: ["prepare"] },
      { id: "soft_follow", task_type: "screen", assigned_unit_ids: [], soft_dependencies: ["prepare"] },
      { id: "conditional_follow", task_type: "attack", assigned_unit_ids: [], conditional_dependencies: [{ id: "prepare", when: "only if contact exists" }] }
    ]
  }, skeleton, { state, side: "axis", allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] } });
  const hard = plan.children.find((task) => task.id === "hard_follow");
  const soft = plan.children.find((task) => task.id === "soft_follow");
  const conditional = plan.children.find((task) => task.id === "conditional_follow");
  assert.equal(hard.dependency_status.hard_ready, false);
  assert.equal(soft.dependency_status.hard_ready, true);
  assert.equal(conditional.dependency_status.conditional_ready, true);
  assert.deepEqual(soft.soft_depends_on, ["prepare"]);
  assert.equal(conditional.conditional_dependencies[0].active, false);
});

test("model-defined advance progress is grounded in the observed scoring frontier", () => {
  const before = structuredClone(state);
  const advanceUnit = Object.keys(before.units).find((id) => before.units[id].side === "axis" && before.units[id].hex);
  before.units[advanceUnit].hex = "3410";
  before.units[advanceUnit].supply_state = "supplied";
  const skeleton = buildTaskSkeleton({ intent: { side: "axis" }, operation: "evidence_progress", state: before, side: "axis", taskGeneration: "model_defined" });
  const manager = createTaskManager({ taskGeneration: "model_defined", replanCooldownActions: 0 });
  manager.initialize({
    intent: { side: "axis" },
    operation: "evidence_progress",
    input: { state: before, side: "axis", turn: 1 },
    rawPlan: { children: [{ id: "advance_east", task_type: "advance", target_column: 35, assigned_unit_ids: [advanceUnit] }] },
    allocation: { spearhead: [{ unit: advanceUnit }], support: [], supply: [], reserve: [] },
    taskGeneration: "model_defined"
  });
  const after = structuredClone(before);
  after.units[advanceUnit].hex = "3510";
  const observation = manager.observe(
    { state: after, side: "axis", turn: 1, step: 1 },
    {
      final_action: { type: "move", unit: advanceUnit, destination: "3510" },
      action_attempts: [{ accepted: true, assessment: { evaluation: { progress: 1, victory_impact: { projected_supply_after_move: "supplied", estimated_vp_delta: 3 } } } }]
    }
  );
  assert.equal(observation.progress.changed, true);
  assert.equal(observation.progress.progress, 1);
  assert.match(observation.progress.evidence, /frontier delta|target distance/);
  assert.doesNotMatch(observation.progress.evidence, /received an accepted/);
});

test("task checker can switch execution to an existing task", () => {
  const manager = createTaskManager({ replanCooldownActions: 0 });
  manager.initialize({
    intent: { side: "axis" },
    operation: "switch_existing",
    input: { state, side: "axis", turn: 1 },
    rawPlan: { children: [
      { id: "blocked_route", task_type: "advance", assigned_unit_ids: [unit] },
      { id: "alternate_route", task_type: "maneuver", assigned_unit_ids: [] }
    ] },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [] },
    taskGeneration: "model_defined"
  });
  const switched = manager.applyCheck({
    task_id: "blocked_route",
    task_status: "blocked",
    task_control: "switch",
    switch_to: "alternate_route",
    confidence: 1,
    reason: "route is blocked; use the existing alternate route"
  });
  assert.equal(switched.children.find((task) => task.id === "blocked_route").status, "blocked");
  assert.equal(switched.children.find((task) => task.id === "alternate_route").status, "active");
  assert.equal(switched.task_switches.at(-1).to, "alternate_route");
});

test("model-defined tasks are dispatched by phase and remain subject to normal action progress", () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "../../rules_el_alamein.json"), "utf8"));
  const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, "../../terrain.json"), "utf8"));
  const ctx = RulesEngine.createContext({ state: structuredClone(state), rules, terrain });
  const unitIds = Object.keys(state.units).filter((id) => state.units[id].side === "axis" && state.units[id].hex).slice(0, 2);
  const skeleton = buildTaskSkeleton({ intent: { side: "axis" }, operation: "flexible", state, side: "axis", taskGeneration: "model_defined" });
  const plan = normalizeTaskPlan({ children: [{ id: "recon_route", type: "recon", assigned_unit_ids: [unitIds[0]], phases: ["initial_movement"], observable_completion_condition: "侦察路线", observable_failure_condition: "路线不可用" }] }, skeleton, {
    state, side: "axis", allocation: { spearhead: [{ unit: unitIds[0] }], support: [], supply: [], reserve: [] }
  });
  plan.children[0].status = "active";
  const dispatch = phaseDispatchTasks(plan, { state: ctx.state, side: "axis", phase: "axis_initial_movement", ctx });
  assert.deepEqual(dispatch.tasks[0].id, "recon_route");
  assert.deepEqual(dispatch.allowed_unit_ids, [unitIds[0]]);
  const otherPhase = phaseDispatchTasks(plan, { state: ctx.state, side: "axis", phase: "axis_combat", ctx });
  assert.equal(otherPhase.tasks.length, 0);
});

test("Axis combat opportunities are rule-verified and dispatched before ordinary breakthrough support", () => {
  const combatState = {
    scenario: "july",
    turn: 1,
    phase: "axis_combat",
    active_side: "axis",
    units: {
      "axis-a": { side: "axis", hex: "2424", state: "fresh", attack: 8, defense: 2, movement: 4, kind: "ground" },
      "axis-b": { side: "axis", hex: "2423", state: "fresh", attack: 8, defense: 2, movement: 4, kind: "ground" },
      "allied-blocker": { side: "allies", hex: "2524", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
    }
  };
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "../../rules_el_alamein.json"), "utf8"));
  const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, "../../terrain.json"), "utf8"));
  const ctx = RulesEngine.createContext({ state: combatState, rules, terrain });
  const manager = createTaskManager({ maxActiveChildTasks: 3, replanCooldownActions: 0 });
  const plan = manager.initialize({
    intent: { side: "axis", target_column: 37 },
    operation: "clear_verified_blocker",
    input: { state: combatState, side: "axis", phase: combatState.phase, ctx },
    allocation: { spearhead: [{ unit: "axis-a" }], support: [{ unit: "axis-b" }], supply: [], reserve: [] }
  });
  const opportunities = axisTacticalOpportunities(plan, { state: combatState, side: "axis", phase: combatState.phase, ctx });
  assert.equal(opportunities.clear_blocker.length, 1);
  assert.deepEqual(opportunities.clear_blocker[0].defender_hexes, ["2524"]);
  assert.equal(opportunities.clear_blocker[0].odds_column, "4-1");
  const dispatch = phaseDispatchTasks(plan, { state: combatState, side: "axis", phase: combatState.phase, ctx });
  assert.equal(dispatch.primary_task_id, "clear_blocker");
  assert.deepEqual(dispatch.tasks.find((task) => task.type === "clear_blocker").eligible_units, ["axis-a", "axis-b"]);
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

test("Axis breakthrough checkpoints activate sequentially but one supplied move can complete every crossed column", () => {
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
  assert.equal(afterJump.children.find((task) => task.id === "breakthrough_to_37").status, "completed");
  assert.equal(afterJump.parent.state, "completed");
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
  const result = frontierBreakthroughPlan({ ...plan, parent: { ...plan.parent, target_column: 35 } }, {
    state: ctx.state,
    side: "axis",
    phase: "axis_initial_movement",
    ctx
  });
  assert.equal(result.protocol, "dynamic-frontier-breakthrough-v2-max-reach");
  assert.equal(result.current_column, 34);
  assert.equal(result.target_column, 35);
  assert.equal(result.minimum_checkpoint_column, 35);
  assert.equal(result.campaign_target_column, 35);
  assert.ok(result.best_scoring_routes.length > 0);
  assert.ok(result.best_scoring_routes.length <= 3);
  assert.ok(result.best_scoring_routes.every((route) => route.scoring_eligible));
  assert.ok(result.best_scoring_routes.every((route) => route.target_column > 35));
  assert.ok(result.best_scoring_routes.every((route) => route.crossed_checkpoints.includes(35)));
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
  assert.ok(dispatch.dynamic_spearhead_unit_ids.length > 0);
  assert.ok(dispatch.dynamic_spearhead_unit_ids.every((id) => dispatch.allowed_unit_ids.includes(id)));
  assert.equal(dispatch.dynamic_spearhead_reassignment, true);
  assert.equal(dispatch.execution_source, "dynamic_spearhead_reassignment");
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

test("legal west extraction completes a model-defined withdrawal task", () => {
  const october = JSON.parse(fs.readFileSync(path.join(__dirname, "../../scenarios/october.json"), "utf8"));
  october.active_side = "axis";
  october.phase = "axis_initial_movement";
  october.turn = 11;
  const withdrawer = Object.keys(october.units).find((id) => october.units[id].side === "axis"
    && october.units[id].kind === "ground" && october.units[id].hex);

  const manager = createTaskManager({ replanCooldownActions: 0 });
  manager.initialize({
    intent: { side: "axis" },
    operation: "west_withdrawal",
    input: { state: october, side: "axis", turn: 11 },
    rawPlan: {
      task_plan: {
        parent: { title: "完成撤退", completion_condition: "指定单位撤出西边", failure_condition: "无法撤出" },
        children: [{
          id: "exit_test_unit",
          type: "exit_west",
          title: "撤出测试单位",
          assigned_unit_ids: [withdrawer],
          completion_condition: "单位合法撤出西边",
          failure_condition: "没有合法西撤路径"
        }]
      }
    },
    taskGeneration: "model_defined"
  });

  const withdrawn = structuredClone(october);
  withdrawn.units[withdrawer].hex = null;
  withdrawn.units[withdrawer].off_map = true;
  withdrawn.units[withdrawer].exited_edge = "west";
  withdrawn.units[withdrawer].exit_edge = "west";
  withdrawn.units[withdrawer].exited = "west";
  withdrawn.units[withdrawer].exited_turn = 11;

  const observed = manager.observe({ state: withdrawn, side: "axis", turn: 11, step: 1 }, {
    final_action: { type: "exit_west", unit: withdrawer },
    action_attempts: [{
      accepted: true,
      assessment: { evaluation: { victory_impact: {} } }
    }]
  });
  assert.equal(observed.progress.changed, true);
  assert.equal(observed.progress.task_id, "exit_test_unit");
  assert.equal(observed.progress.progress, 1);
  assert.equal(observed.plan.children[0].status, "completed");
});

test("a dynamically reassigned Axis unit advances the active breakthrough task", () => {
  const dynamicUnit = Object.keys(state.units).find((id) => id !== unit
    && state.units[id].side === "axis"
    && state.units[id].hex
    && RulesEngine.isCombatUnit({ id, ...state.units[id] }));
  const manager = createTaskManager({ maxActiveChildTasks: 3, replanCooldownActions: 0 });
  manager.initialize({
    intent: { side: "axis", target_column: 37 },
    operation: "dynamic_spearhead",
    input: { state, side: "axis", turn: 1 },
    allocation: { spearhead: [{ unit }], support: [], supply: [], reserve: [dynamicUnit] }
  });
  const advanced = structuredClone(state);
  advanced.units[dynamicUnit].hex = "3710";
  advanced.units[dynamicUnit].supply_state = "supplied";
  const observed = manager.observe({ state: advanced, side: "axis", turn: 1, step: 1 }, {
    final_action: { type: "move", unit: dynamicUnit, destination: "3710" },
    action_attempts: [{
      accepted: true,
      assessment: {
        evaluation: {
          progress: 3,
          victory_impact: {
            estimated_vp_delta: 9,
            projected_supply_after_move: "supplied",
            maintains_july_scoring_supply: true
          }
        }
      }
    }]
  });
  assert.equal(observed.progress.task_id, "breakthrough_to_35");
  assert.equal(observed.progress.changed, true);
  assert.equal(observed.progress.execution_source, "dynamic_spearhead_reassignment");
  assert.equal(observed.events.includes("no_task_progress"), false);
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

test("Axis movement dispatch exposes combat preparation without fixing an attack", () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, "../../rules_el_alamein.json"), "utf8"));
  const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, "../../terrain.json"), "utf8"));
  const ctx = RulesEngine.createContext({ state: structuredClone(state), rules, terrain });
  const plan = buildTaskSkeleton({
    intent: { side: "axis", target_column: 37 },
    operation: "combat_preparation",
    state: ctx.state,
    side: "axis"
  });
  const preparation = axisCombatPreparation(plan, {
    state: ctx.state,
    side: "axis",
    phase: "axis_initial_movement",
    ctx
  });
  assert.ok(preparation.targets.length > 0);
  assert.ok(preparation.recommended_unit_ids.length > 0);
  assert.ok(preparation.targets.some((target) => target.joint_attack_potential));
  assert.ok(preparation.targets.every((target) => target.verified_combat === false));
  assert.ok(preparation.targets.every((target) => Array.isArray(target.approaches)));

  const dispatch = phaseDispatchTasks(plan, {
    state: ctx.state,
    side: "axis",
    phase: "axis_initial_movement",
    ctx
  });
  assert.deepEqual(dispatch.upcoming_combat_opportunities, preparation.targets);
  assert.deepEqual(dispatch.recommended_preparation_unit_ids, preparation.recommended_unit_ids);
  assert.ok(dispatch.preparation_actions.length > 0);

  const alliesDispatch = phaseDispatchTasks({ ...plan, side: "allies" }, {
    state: ctx.state,
    side: "allies",
    phase: "allies_initial_movement",
    ctx
  });
  assert.deepEqual(alliesDispatch.upcoming_combat_opportunities, []);
  assert.deepEqual(alliesDispatch.recommended_preparation_unit_ids, []);
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
