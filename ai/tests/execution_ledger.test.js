"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPhaseExecutionLedger, summarizeExecutionLedger } = require("../core/phase_execution_ledger.js");
const { createGoalRevisionLedger } = require("../core/goal_revision_ledger.js");
const { updateTaskExecutionHistory, taskPlanSnapshot } = require("../core/task_manager.js");
const { createActionRuleBridge, reviewStrategicMovement } = require("../core/action_rule_bridge.js");
const { readConfig } = require("../experiments/external_ai_transcript.js");
const { createOpportunityLedger } = require("../core/opportunity_ledger.js");
const { reconstructLegacyPlans } = require("../core/phase_execution_ledger.js");
const { buildAcceptanceJobs, resolveConcurrency } = require("../experiments/run_sae_acceptance.js");

test("long task histories have bounded snapshots without losing or mutating audit events", () => {
  const plan = { children: [{ id: "long_task", assigned_units: ["u0"], status: "active" }] };
  const step = { execution_ledger: { events: Array.from({ length: 2000 }, (_, i) => ({
    event_id: `event-${i}`, task_id: "long_task", status: "held", reason: "preserve force"
  })) }, phase_unit_plan: { unit_orders: [] } };
  updateTaskExecutionHistory(plan, step, { step: 1 });
  const snapshot = taskPlanSnapshot(plan);
  assert.equal(plan.children[0].execution_history.length, 2000);
  assert.equal(snapshot.children[0].execution_history.length, 8);
  assert.equal(snapshot.children[0].execution_history_summary.total_events, 2000);
  assert.equal(snapshot.children[0].execution_history_summary.last_event_id, "event-1999");
  assert.ok(JSON.stringify(snapshot).length < 2500);
  snapshot.children[0].execution_history[0].reason = "changed";
  assert.equal(plan.children[0].execution_history[1992].reason, "preserve force");
  updateTaskExecutionHistory(plan, step, { step: 2 });
  assert.equal(plan.children[0].execution_history.length, 2000);
});

function fixture({ size = 48, disposition = "hold", badUnits = [], repaired = false, mandatory = false } = {}) {
  const ids = Array.from({ length: size }, (_, i) => `u${i}`);
  const units = Object.fromEntries(ids.map((id) => [id, { hex: "3511", side: "axis", state: "fresh" }]));
  const held = new Set();
  const acted = new Set();
  const calls = [];
  let step = 0;
  let current;
  let creations = 0;
  let repairs = 0;
  const phaseStatus = () => ({ eligible_units: ids, remaining_units: ids.filter((id) => !held.has(id) && !acted.has(id)),
    held_units: [...held], acted_units: [...acted], can_pass: held.size + acted.size === ids.length,
    mandatory_actions: mandatory && !acted.has("u0") ? [{ type: "stack_repair", units: ["u0"] }] : [] });
  const bridge = {
    profile: { max_calls_per_step: 20 }, current: () => current, phaseStatus,
    executeLocalTool(tool, args) {
      calls.push({ tool, args });
      if (tool.startsWith("hold")) {
        const orders = tool === "hold_units" ? args.orders : [args];
        if (mandatory && orders.some((order) => order.unit === "u0") && !acted.has("u0")) return { accepted: false, reason: "mandatory stack" };
        orders.forEach((order) => held.add(order.unit));
        return { accepted: true, newly_held: orders.map((order) => order.unit) };
      }
      const action = args.action;
      assert.equal(current.submitted, null, "at most one accepted action per step");
      if (action.type === "pass") assert.equal(phaseStatus().can_pass, true);
      if (action.destination === "bad") return { accepted: false, rejection_type: "rules", reason: "no legal path found" };
      if (action.unit) assert.equal(acted.has(action.unit), false, "unit must not act twice");
      const accepted = { ...action, type: action.type === "move_intent" ? "move" : action.type };
      current.submitted = accepted;
      return { accepted: true, action: accepted };
    },
    fallbackAction() { return { type: "move", unit: "u0", destination: "3512", path: ["3511", "3512"] }; }
  };
  const ledger = createPhaseExecutionLedger({ bridge, sessionId: "test", history: new Map(),
    settings: { phase_repair_timeout_ms: 30000, reversal_history_size: 4 }, rules: { checkMove: () => ({ legal: true }) },
    prepare: () => ({}), buildSnapshot: () => ({}),
    createPlan: async (input, intent) => {
      creations += 1;
      return { source: "model", phase_intent: intent, api: { error_class: "none" }, request_count: 1, repair_request_count: 0, executions: [],
        actionable_units: input.phaseStatus.remaining_units.map((unit) => ({ unit })),
        unit_orders: input.phaseStatus.remaining_units.map((unit, i) => ({ unit, task_id: `task${i % 2}`, source: "model", priority: i + 1,
          disposition, target_hex: badUnits.includes(unit) ? "bad" : "3512", status: disposition === "hold" ? "held" : "pending",
          repair_attempts: 0, reason: "stay" })) };
    },
    requestRepair: async (_input, _plan, orders, _snapshot, timeoutMs) => {
      repairs += 1;
      assert.ok(timeoutMs <= 30000);
      return { orders: orders.map((order) => ({ unit: order.unit, disposition: repaired ? "move" : "hold",
        target_hex: "3512", status: repaired ? "pending" : "held", reason: "repair" })) };
    }
  });
  return { ledger, calls, acted, held, units, get creations() { return creations; }, get repairs() { return repairs; },
    async next({ goal = 37, budget = 0, expired = false } = {}) {
      current = { submitted: null, tool_calls: budget, built: { ctx: {} } };
      step += 1;
      const result = await ledger.next({ step, state: { units }, turn: 1, phase: "axis_initial_movement", side: "axis",
        strategicIntent: { goal_plan: { primary_goal: { target_column: goal } } } }, { type: "advance" }, expired ? Date.now() - 1 : Date.now() + 180000);
      if (result.action.unit) acted.add(result.action.unit);
      return result;
    }
  };
}

test("48 unit holds use one local batch, no model tools, one validated phase end", async () => {
  const f = fixture();
  const result = await f.next({ budget: 20 });
  assert.equal(result.action.type, "pass");
  assert.equal(f.calls.filter((call) => call.tool === "hold_units").length, 1);
  assert.equal(result.ledger.events.filter((event) => event.held).length, 48);
  assert.equal(Object.keys(result.ledger.terminal_units).length, 48);
  assert.equal(f.repairs, 0);
});

test("48 unit partial failure executes viable orders before one concentrated repair", async () => {
  const f = fixture({ disposition: "move", badUnits: ["u0", "u2"], repaired: true });
  const steps = [];
  for (let i = 0; i < 49; i += 1) {
    const result = await f.next();
    steps.push({ execution_ledger: result.ledger, phase_unit_plan: result.plan });
    if (i === 0) { assert.equal(result.action.unit, "u1"); assert.equal(f.repairs, 0); }
    if (result.action.type === "pass") break;
  }
  assert.equal(f.acted.size, 48);
  assert.equal(f.repairs, 1);
  assert.equal(f.creations, 1);
  const summary = summarizeExecutionLedger([...steps, ...steps]);
  assert.equal(summary.executed, 48);
  assert.equal(summary.batch_repair_requests, 1);
  assert.equal(summary.model_submitted_actions, 50);
  assert.equal(summary.model_rule_rejections, 2);
  assert.equal(summary.closed_phases, 1);
});

test("repair failure holds only failed orders and closes the phase", async () => {
  const f = fixture({ disposition: "move", badUnits: ["u0", "u1"] });
  let last;
  for (let i = 0; i < 49; i += 1) { last = await f.next(); if (last.action.type === "pass") break; }
  assert.equal(f.repairs, 1);
  assert.equal(f.acted.size, 46);
  assert.equal(f.held.size, 2);
  assert.equal(last.ledger.repaired_units.length, 2);
});

test("goal replacement never requeues an executed unit and retains all versions", async () => {
  const f = fixture({ size: 3, disposition: "move" });
  const first = await f.next();
  const second = await f.next({ goal: 38 });
  assert.equal(first.action.unit, "u0");
  assert.equal(second.action.unit, "u1");
  assert.equal(f.creations, 2);
  assert.equal(second.plan.replaces_plan_id, first.plan.plan_id);
  assert.equal(second.ledger.plan_versions[0].unit_orders.filter((order) => order.status === "replaced").length, 2);
  assert.ok(!second.plan.unit_orders.some((order) => order.unit === "u0"));
});

test("repair allowance survives plan replacement and cannot be reset by a new goal", async () => {
  const f = fixture({ size: 3, disposition: "move", badUnits: ["u0", "u1", "u2"], repaired: true });
  const first = await f.next();
  assert.equal(first.action.unit, "u0");
  assert.equal(f.repairs, 1);
  const second = await f.next({ goal: 38 });
  assert.equal(second.action.type, "pass");
  assert.equal(f.repairs, 1);
  assert.equal(second.ledger.repaired_units.length, 3);
  assert.equal(f.acted.size, 1);
  assert.equal(f.held.size, 2);
});

for (const condition of [{ budget: 20 }, { expired: true }]) {
  test(`nonretryable budget/deadline does not call batch repair ${JSON.stringify(condition)}`, async () => {
    const f = fixture({ disposition: "move", badUnits: Array.from({ length: 48 }, (_, i) => `u${i}`) });
    const result = await f.next(condition);
    assert.equal(result.action.type, "pass");
    assert.equal(f.repairs, 0);
    assert.equal(f.held.size, 48);
  });
}

test("mandatory stack repair cannot be bypassed by an all-hold plan", async () => {
  const f = fixture({ mandatory: true });
  const result = await f.next();
  assert.equal(result.action.unit, "u0");
  assert.equal(result.action.type, "move");
  assert.equal(f.held.has("u0"), false);
});

test("goal revisions retain original target, prior failure and fixed evaluation", () => {
  const history = createGoalRevisionLedger((_plan, _input, goal) => ({ completed: goal.target <= 4, evidence: [{ actual: 4, target: goal.target }] }));
  const input = { step: 1, turn: 1, side: "axis" };
  history.revise({ target: 10, reason: "opening" }, { input, rulesEvaluation: { initial_vp: -20 } });
  history.revise({ target: 4, reason: "force loss" }, { input: { ...input, step: 9 }, rulesEvaluation: { initial_vp: 99 } });
  const report = history.report(input);
  assert.equal(report.opening_goal.target, 10);
  assert.equal(report.revisions[1].previous_completion.completed, false);
  assert.equal(report.evaluations[1].completed, true);
  assert.equal(report.fixed_game_evaluation.initial_vp, -20);
});

test("task failures are scoped, infrastructure and legal holds are not tactical blockers", () => {
  const plan = { children: ["a", "b"].map((id) => ({ id, assigned_units: [id], status: "active" })) };
  const events = [
    { event_id: "1", task_id: "a", status: "attempt", accepted: false, failure_class: "step_timeout" },
    { event_id: "2", task_id: "a", status: "held" },
    { event_id: "3", task_id: "b", status: "attempt", accepted: false, failure_class: "path_unavailable" },
    { event_id: "4", task_id: "b", status: "attempt", accepted: false, failure_class: "policy_rejection" }
  ];
  const step = { execution_ledger: { events, batch_repair_attempted: true }, phase_unit_plan: { unit_orders: [] } };
  updateTaskExecutionHistory(plan, step, { step: 1 });
  updateTaskExecutionHistory(plan, step, { step: 1 });
  assert.equal(plan.children[0].status, "active");
  assert.equal(plan.children[1].status, "blocked");
  assert.equal(plan.children[1].consecutive_execution_failures, 2);
  assert.equal(plan.children[1].execution_history.length, 2);
});

test("ledger legal Allied hold is not rejected by rationale keywords or tool quota", () => {
  const bridge = createActionRuleBridge(readConfig(), { toolProfile: "rolling_unit_tactical", executionLedger: true });
  const state = { scenario: "july", turn: 1, phase: "allies_initial_movement", active_side: "allies",
    units: { defender: { side: "allies", hex: "3714", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" } } };
  bridge.prepareStep({ state, step: 1, turn: 1, phase: state.phase, side: "allies", decisionMode: "hierarchical_sae",
    operationState: { task_plan: { side: "allies", children: [{ id: "line", type: "hold_blocking_line", assigned_units: ["defender"] }] } } });
  bridge.current().tool_calls = 20;
  assert.equal(bridge.executeLocalTool("hold_unit", { unit: "defender", reason: "stay here" }).accepted, true);
  assert.equal(bridge.current().tool_calls, 20);
  assert.equal(bridge.current().local_execution_calls, 1);
  assert.equal(bridge.executeTool("phase_status").error_class, "tool_budget_exhausted");
});

test("October supply coverage decline is a warning, not a universal strategy rejection", () => {
  const result = reviewStrategicMovement({ decisionMode: "hierarchical_sae", executionLedger: true,
    action: { type: "move", unit: "s", destination: "2911" },
    state: { scenario: "october", units: { s: { side: "axis", kind: "supply", hex: "3011", movement: 4 } } },
    assessment: { evaluation: { victory_impact: { supply_coverage: { delta: -2 } } } } });
  assert.equal(result.accept, true);
  assert.match(result.warnings.join(" "), /october/);
});

test("scenario opportunity ledger deduplicates discovery and leaves preparation effect unknown", () => {
  const ledger = createOpportunityLedger();
  const input = { side: "axis", phase: "axis_initial_movement", step: 1, state: { scenario: "october", units: { a: { hex: "3511" } } } };
  const plan = { actionable_units: [{ unit: "a", hex: "3511", supply: "supplied", recommended_options: [{ destination: "3411" }] }] };
  ledger.observePlan(input, plan, false);
  ledger.observePlan(input, plan, true);
  ledger.apply(input, { step: 1, phase: input.phase, final_action_source: "phase_plan",
    final_action: { type: "move", unit: "a", destination: "3411" }, action_applied: { applied: true, result: { legal: true } } });
  const result = ledger.report();
  assert.equal(result.discovery, 1);
  assert.equal(result.model_seen, 1);
  assert.equal(result.model_selected, 1);
  assert.equal(result.verified_effects, 0);
  assert.equal(result.unknown_effects, 1);
});

test("offline legacy reconstruction retains every plan version and labels missing provenance", () => {
  const steps = [true, false, true, false].map((plan_created, i) => ({ step: i + 1, turn: 1, phase: "axis_initial_movement", side: "axis",
    phase_unit_plan: { plan_created, request_count: 1, repair_request_count: i, unit_orders: [] } }));
  const result = reconstructLegacyPlans(steps);
  assert.equal(result.plan_versions, 2);
  assert.equal(result.reconstructed_plans[0].repair_request_count, 1);
  assert.equal(result.reconstructed_plans[1].repair_request_count, 3);
  assert.equal(result.comparable_to_v16, false);
  assert.equal(result.unique_model_submissions, null);
});

test("acceptance jobs are exactly six selections with unchanged scenario budgets", () => {
  const jobs = buildAcceptanceJobs({ outputDir: "/tmp/sae-ledger-test" });
  assert.deepEqual(jobs.map((job) => [job.scenario, job.side]), [
    ["july", "axis"], ["july", "allies"], ["september", "axis"], ["september", "allies"], ["october", "axis"], ["october", "allies"]
  ]);
  assert.deepEqual(jobs.map((job) => job.args[job.args.indexOf("--max-steps") + 1]), ["1000", "1000", "1500", "1500", "3000", "3000"]);
  for (const job of jobs) {
    assert.ok(job.args.includes("rules_ai"));
    assert.ok(job.args.includes("180000"));
    assert.ok(job.args.includes("mock_secondary"));
  }
  assert.equal(resolveConcurrency({ model: "mock_primary", jobCount: jobs.length }), 6);
  assert.equal(resolveConcurrency({ model: "glm_53_flash_coding_plan", jobCount: jobs.length }), 1);
  assert.equal(resolveConcurrency({ model: "glm_53_flash_coding_plan", requested: "2", jobCount: jobs.length }), 2);
});
