"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  aggregateRuns,
  buildBaselineComparison,
  attachJudgeResults,
  buildActionWindows,
  buildResearchReport,
  deterministicRunMetrics,
  oddsBelowTwoToOne,
  validateJudgeResult
} = require("../experiments/research_metrics.js");
const { judgeWindow, parseArgs, parseJudgeContent } = require("../experiments/evaluate_research_metrics.js");
const { createArtifactManifest } = require("../core/benchmark_artifacts.js");
const {
  COMPARISON_CONTRACT_VERSION,
  comparisonContractHash
} = require("../core/comparison_contract.js");

const TEST_MANIFEST = createArtifactManifest("july", { includeGitMetadata: false });

function completeTranscript(id, vp = 30) {
  const comparisonContract = {
    version: COMPARISON_CONTRACT_VERSION,
    benchmark_version: TEST_MANIFEST.benchmark_version,
    scenario: "july",
    external_side: "axis",
    controllers: { axis: "external_ai", allies: "rules_ai" },
    artifact_manifest: TEST_MANIFEST,
    artifact_manifest_hash: TEST_MANIFEST.artifact_manifest_hash,
    model_configuration: { identity: { profile_id: "mock_primary" }, defaults: { thinking: "disabled" } },
    max_steps: 1000,
    max_calls_per_step: 6,
    step_timeout_ms: 180000,
    model_profile: "mock_primary",
    tool_profile: "map_and_action",
    tool_config_hash: "tools-v1",
    context_profile: "compact_current_state_v1",
    prompt_profile_hash: "prompt-v1",
    harness_prompt_hash: "prompt-v1"
  };
  return {
    experiment_id: id,
    scenario: "july",
    external_side: "axis",
    seed: 1942,
    replicate: 1,
    status: "final_victory",
    harness: "manual_single_action",
    decision_mode: "unit_plan_hybrid",
    model_profile: "mock_primary",
    comparison_contract_hash: comparisonContractHash(comparisonContract),
    benchmark_version: TEST_MANIFEST.benchmark_version,
    artifact_manifest_hash: TEST_MANIFEST.artifact_manifest_hash,
    artifact_manifest: TEST_MANIFEST,
    controllers: { axis: "external_ai", allies: "rules_ai" },
    tool_profile: "map_and_action",
    tool_config_hash: "tools-v1",
    context_profile: "compact_current_state_v1",
    prompt_profile_hash: "prompt-v1",
    harness_prompt_hash: "prompt-v1",
    comparison_contract: comparisonContract,
    summary: { victory: { final: true, victory_points: vp } },
    counts: { act_calls: 6, invalid_action_attempts: 2 },
    model_steps: [
      {
        step: 1,
        turn: 1,
        side: "axis",
        phase: "axis_combat",
        action_attempts: [
          { accepted: false, action: { type: "combat" }, reason: "not adjacent" },
          { accepted: true, action: { type: "combat", attackers: ["a", "b"], defender_hexes: ["2512"] }, assessment: { evaluation: { odds_column: "1-1" } } }
        ]
      },
      {
        step: 2,
        turn: 1,
        side: "axis",
        phase: "axis_combat",
        action_attempts: [
          { accepted: true, action: { type: "combat", attackers: ["c"], defender_hexes: ["2612"] }, assessment: { evaluation: { odds_column: "2:1" } } }
        ]
      },
      {
        step: 3,
        turn: 2,
        side: "axis",
        phase: "axis_combat",
        fallback_used: true,
        action_attempts: [
          { accepted: true, action: { type: "combat" }, assessment: { evaluation: { odds_column: "1-2" } } }
        ]
      }
    ],
    game_log: [
      { step: 1, turn: 1, result: { legal: true } },
      { step: 2, turn: 1, result: { legal: true } },
      { step: 3, turn: 2, result: { legal: true } }
    ]
  };
}

test("deterministic research metrics follow the requested formulas", () => {
  const run = deterministicRunMetrics(completeTranscript("run-a"), {
    complete_game: { statuses: ["final_victory"], require_final_victory_flag: true }
  });
  assert.equal(run.complete_game, true);
  assert.equal(run.final_vp, 30);
  assert.equal(run.vp_baseline, 25);
  assert.equal(run.vp_delta, 5);
  assert.equal(run.side_adjusted_vp_gain, 5);
  assert.equal(run.submitted_actions, 6);
  assert.equal(run.rejected_actions, 2);
  assert.equal(run.action_rejection_rate, 2 / 6);
  assert.equal(run.autonomous_attacks, 2);
  assert.equal(run.low_odds_attacks, 1);
  assert.equal(run.low_odds_attack_rate, 0.5);
});

test("ranking report explains why a complete game was excluded", () => {
  const transcript = completeTranscript("dirty-worktree");
  transcript.artifact_manifest = {
    ...transcript.artifact_manifest,
    source_control: { working_tree_dirty: true }
  };
  const run = deterministicRunMetrics(transcript);
  assert.equal(run.complete_game, true);
  assert.equal(run.ranking_eligible, false);
  assert.ok(run.ranking_eligibility_reasons.includes("working_tree_dirty"));
  const report = buildResearchReport([run]);
  assert.equal(report.ranking_eligibility.exclusion_reasons.working_tree_dirty, 1);
  assert.equal(report.result_metrics.end_to_end.final_vp.mean, 30);
});

test("transcript-level manifest hashes validate serialized manifests and missing latency is not zero", () => {
  const transcript = completeTranscript("serialized-manifest");
  transcript.artifact_manifest = { ...transcript.artifact_manifest };
  delete transcript.artifact_manifest.artifact_manifest_hash;
  transcript.model_steps = [{ provider_result: { elapsed_ms: null } }, { provider_result: { elapsed_ms: 40 } }];
  const run = deterministicRunMetrics(transcript);
  assert.ok(run.artifact_group_hashes?.rules);
  assert.equal(run.reproducibility.integrity_valid, true);
  assert.equal(run.p50_latency_ms, 40);
  assert.equal(run.p95_latency_ms, 40);
});

test("September success rate stays unknown when clearance success evidence is missing", () => {
  const transcript = completeTranscript("missing-mine-evidence");
  transcript.scenario = "september";
  transcript.model_steps = [{
    step: 1, turn: 1, side: "axis", phase: "axis_combat",
    action_attempts: [{ accepted: true, action: { type: "clear_mine", unit: "a" } }]
  }];
  const run = deterministicRunMetrics(transcript);
  assert.equal(run.scenario_metrics.mine_clear_attempts, 1);
  assert.equal(run.scenario_metrics.mine_clear_successes, null);
  assert.equal(run.scenario_metrics.mine_clear_success_rate, null);
});

test("clearance rates use observed outcomes for the acting side, not global Axis score", () => {
  for (const side of ["axis", "allies"]) {
    const transcript = completeTranscript(`clearance-${side}`);
    transcript.scenario = "september";
    transcript.external_side = side;
    transcript.summary.victory.breakdown = [{ id: "september_axis_cleared_mines", points: 9, mines: ["m1", "m2", "m3"] }];
    transcript.model_steps = [false, true].map((cleared) => ({ side, final_action: { type: "clear_mine", unit: "engineer" },
      action_applied: { applied: true, result: { legal: true, details: { cleared } } } }));
    const metrics = deterministicRunMetrics(transcript).scenario_metrics;
    assert.equal(metrics.mine_clear_attempts, 2);
    assert.equal(metrics.mine_clear_successes, 1);
    assert.equal(metrics.mine_clear_success_rate, 0.5);
    assert.equal(metrics.mine_clear_evidence_coverage, 1);
    delete transcript.model_steps[1].action_applied.result.details;
    const partial = deterministicRunMetrics(transcript).scenario_metrics;
    assert.equal(partial.mine_clear_successes, null);
    assert.equal(partial.mine_clear_evidence_coverage, 0.5);
  }
});

test("October line rejection survives a later accepted action in the same step", () => {
  const transcript = completeTranscript("line-retry");
  transcript.scenario = "october";
  transcript.model_steps = [{ turn: 3, side: "axis", action_attempts: [
    { accepted: false, rejection_type: "rules", action: { type: "move" }, reason: "October retreat line restriction" },
    { accepted: false, model_submitted: false, action: { type: "move" }, reason: "October retreat line restriction" },
    { accepted: false, action: { type: "move" }, reason: "insufficient movement points" },
    { accepted: true, action: { type: "pass" } }
  ] }];
  assert.equal(deterministicRunMetrics(transcript).scenario_metrics.withdrawal_line_illegal_movement_count, 1);
});

test("execution-ledger rejection rate uses model attempts, not act bridge calls", () => {
  const transcript = completeTranscript("ledger-denominator");
  transcript.counts.act_calls = 20;
  transcript.execution_ledger_summary = { model_submitted_actions: 3 };
  transcript.model_steps = [{ action_attempts: [
    { accepted: false, model_submitted: true, rejection_type: "rules", action: { type: "move" } },
    { accepted: true, model_submitted: true, action: { type: "move" } },
    { accepted: false, model_submitted: true, rejection_type: "rules", action: { type: "move" } },
    { accepted: true, model_submitted: false, action: { type: "pass" } }
  ] }];
  assert.equal(deterministicRunMetrics(transcript).submitted_actions, 3);
  assert.equal(deterministicRunMetrics(transcript).rejected_actions, 2);
  assert.equal(deterministicRunMetrics(transcript).action_rejection_rate, 2 / 3);
});

test("whole-game action rates include combat tool submissions outside the movement ledger", () => {
  const transcript = completeTranscript("mixed-phase-submissions");
  const movement = { event_id: "move1", accepted: true, model_submitted: true, action: { type: "move" } };
  transcript.execution_ledger_summary = { model_submitted_actions: 1, model_rule_rejections: 0 };
  transcript.model_steps = [
    { phase: "axis_initial_movement", execution_ledger: {}, action_attempts: [movement] },
    { phase: "axis_initial_movement", execution_ledger: {}, action_attempts: [movement] },
    { phase: "axis_combat", action_attempts: [
      { event_id: "combat1", accepted: false, model_submitted: true, rejection_type: "rules", action: { type: "combat" } },
      { event_id: "combat2", accepted: true, model_submitted: true, action: { type: "combat" } },
      { event_id: "local", accepted: true, model_submitted: false, action: { type: "pass" } }
    ] }
  ];
  const run = deterministicRunMetrics(transcript);
  assert.equal(run.submitted_actions, 3);
  assert.equal(run.rejected_actions, 1);
  assert.equal(run.action_rejection_rate, 1 / 3);
  assert.equal(run.action_attempt_evidence_source, "deduplicated_model_submission_events_all_phases");
});

test("tasks without machine-readable evidence remain unavailable", () => {
  const transcript = completeTranscript("task-evidence");
  transcript.model_steps = [{
    task_observation: {
      plan: { children: [{ id: "free-form", status: "active", completion_condition: "do something" }] },
      progress: { task_id: "free-form", changed: false }
    }
  }];
  const metrics = deterministicRunMetrics(transcript).scenario_metrics;
  assert.equal(metrics.task_evidence_available, false);
  assert.equal(metrics.task_progress_rate, null);
  assert.equal(metrics.task_completion_rate, null);
  assert.equal(metrics.task_blocking_rate, null);
});

test("task completion counts one stable task across replanned criteria", () => {
  const transcript = completeTranscript("stable-task-id");
  transcript.final_task_settlement = {
    child_statuses: { hold_line: "completed" },
    children: [{ id: "hold_line", status: "completed", completion_criteria: { metric: "position" } }]
  };
  transcript.model_steps = [
    { task_observation: { plan: { children: [{ id: "hold_line", status: "active", completion_criteria: { metric: "position", target: "3511" } }] } } },
    { task_observation: { plan: { children: [{ id: "hold_line", status: "active", completion_criteria: { metric: "position", target: "3611" } }] } } }
  ];
  const metrics = deterministicRunMetrics(transcript).scenario_metrics;
  assert.equal(metrics.task_count, 1);
  assert.equal(metrics.measurable_task_count, 1);
  assert.equal(metrics.task_completion_rate, 1);
});

test("request totals include the independently configured checker without double counting", () => {
  const transcript = completeTranscript("requests");
  transcript.model_transport = [{}, {}];
  transcript.task_checker_transport = [{}];
  transcript.model_transport_by_component = { "axis.agent": [{}, {}], "axis.task_checker": [{}] };
  assert.equal(deterministicRunMetrics(transcript).requests, 3);
});

test("October withdrawal eligibility uses unit IDs rather than numeric phase counts", () => {
  const transcript = completeTranscript("exit-coverage");
  transcript.scenario = "october";
  transcript.model_steps = [38, 25, 4].map((count) => ({ side: "axis", turn: 11, movement_phase: { eligible_units_at_phase_start: count } }));
  let metrics = deterministicRunMetrics(transcript).scenario_metrics;
  assert.equal(metrics.eligible_withdrawal_unit_count, null);
  transcript.model_steps[0].movement_phase.withdrawal_eligible_units = ["a", "b"];
  metrics = deterministicRunMetrics(transcript).scenario_metrics;
  assert.equal(metrics.eligible_withdrawal_unit_count, 2);
});

test("average VP includes complete method-fallback games but excludes incomplete games", () => {
  const first = deterministicRunMetrics(completeTranscript("run-a", 30));
  const secondTranscript = completeTranscript("run-b", 40);
  secondTranscript.counts.transport_failures = 2;
  const second = deterministicRunMetrics(secondTranscript);
  const partialTranscript = completeTranscript("partial", 100);
  partialTranscript.status = "step_limit";
  partialTranscript.summary.victory.final = false;
  const partial = deterministicRunMetrics(partialTranscript);
  const [group] = aggregateRuns([first, second, partial], "decision_policy");
  assert.equal(group.complete_games, 2);
  assert.equal(group.ranking_eligible_games, 2);
  assert.equal(group.raw_final_vp_sum, 70);
  assert.equal(group.ranking_final_vp_sum, 70);
  assert.equal(group.final_vp_sum, 70);
  assert.equal(group.average_vp, 35);
  assert.equal(group.raw_average_vp, 35);
  assert.equal(group.average_vp_delta, 10);
  assert.equal(group.raw_vp_delta_sum, 20);
  assert.equal(group.ranking_vp_delta_sum, 20);
  assert.equal(group.vp_delta_sum, 20);
  assert.equal(group.average_side_adjusted_vp_gain, 10);
});

test("side-adjusted VP gain makes lower VP positive for an Allied agent", () => {
  const transcript = completeTranscript("allied-run", 20);
  transcript.external_side = "allies";
  const run = deterministicRunMetrics(transcript);
  assert.equal(run.vp_baseline, 25);
  assert.equal(run.vp_delta, -5);
  assert.equal(run.side_adjusted_vp_gain, 5);
});

test("action windows are fixed by external side and game turn", () => {
  const windows = buildActionWindows(completeTranscript("run-a"));
  assert.equal(windows.length, 2);
  assert.equal(windows[0].turn, 1);
  assert.deepEqual(windows[0].actions.map((item) => item.step), [1, 2]);
  assert.equal(windows[1].turn, 2);
});

test("Judge validation enforces score ranges, opportunity types, and window membership", () => {
  const [window] = buildActionWindows(completeTranscript("run-a"));
  const valid = validateJudgeResult({
    type: "research_metric_judgment",
    opportunity_decisions: [{
      decision_id: "op-1",
      step: 1,
      opportunity_type: "joint_attack",
      severity: 2,
      evidence_refs: [{ step: 1, unit_ids: ["a", "b"], target_hexes: ["2512"] }],
      opportunity_evidence: "two adjacent attackers",
      chosen_action_evidence: "single attack",
      rationale: "coordination was available"
    }],
    plan_coherence: { score: 4, evidence: "movement supported combat", rationale: "clear coordination" }
  }, window);
  assert.equal(valid.opportunity_decisions[0].severity, 2);
  assert.equal(valid.plan_coherence.score, 4);
  assert.throws(() => validateJudgeResult({ opportunity_decisions: [], plan_coherence: { score: 6 } }, window), /1 to 5/);
  assert.throws(() => validateJudgeResult({
    opportunity_decisions: [{ step: 99, opportunity_type: "joint_attack", severity: 1 }],
    plan_coherence: { score: 3 }
  }, window), /outside the action window/);
});

test("Judge metrics use pooled opportunity points and fixed action windows", () => {
  const transcript = completeTranscript("run-a");
  const run = deterministicRunMetrics(transcript);
  const windows = buildActionWindows(transcript);
  const judgments = windows.map((window, index) => ({
    window_id: window.window_id,
    judgment: validateJudgeResult({
      opportunity_decisions: index === 0
        ? [
          { decision_id: "op-1", step: 1, opportunity_type: "joint_attack", severity: 0,
            evidence_refs: [{ step: 1, unit_ids: ["a", "b"], target_hexes: ["2512"] }] },
          { decision_id: "op-2", step: 2, opportunity_type: "capture_objective", severity: 2,
            evidence_refs: [{ step: 2, target_hexes: ["2612"] }] }
        ]
        : [{ decision_id: "op-3", step: 3, opportunity_type: "restore_supply", severity: 3,
          evidence_refs: [{ step: 3, unit_ids: ["c"] }] }],
      plan_coherence: { score: index === 0 ? 4 : 2, evidence: "steps in the window support the assessment" }
    }, window)
  }));
  attachJudgeResults(run, windows, judgments);
  const report = buildResearchReport([run]);
  const [group] = report.by_decision_policy;
  assert.equal(group.opportunity_decision_points, 3);
  assert.equal(group.missed_opportunity_severity, 5 / 3);
  assert.equal(group.multi_step_plan_coherence, 3);
  assert.equal(group.judge_coverage, 1);
});

test("Judge metrics separate converted opportunities, missed severity, and abstentions", () => {
  const transcript = completeTranscript("run-separation");
  const run = deterministicRunMetrics(transcript);
  const [window] = buildActionWindows(transcript);
  const result = validateJudgeResult({
    opportunity_decisions: [
      {
        decision_id: "converted",
        step: 1,
        opportunity_type: "joint_attack",
        opportunity_status: "converted",
        severity: 0,
        confidence: 0.9,
        evidence_refs: [{ step: 1, unit_ids: ["a", "b"], target_hexes: ["2512"] }]
      },
      {
        decision_id: "missed",
        step: 2,
        opportunity_type: "restore_supply",
        opportunity_status: "missed",
        severity: 2,
        confidence: 0.8,
        evidence_refs: [{ step: 2, unit_ids: ["c"], target_hexes: ["2612"] }]
      },
      {
        decision_id: "uncertain",
        step: 2,
        opportunity_type: "capture_objective",
        opportunity_status: "uncertain",
        abstain: true,
        severity: null,
        confidence: 0.2
      }
    ],
    plan_coherence: { score: 4, confidence: 0.75, evidence: "steps 1 and 2 coordinate", rationale: "clear sequence" }
  }, window);
  attachJudgeResults(run, [window], [{ window_id: window.window_id, judgment: result }]);
  assert.equal(run.judge.opportunity_decision_points, 2);
  assert.equal(run.judge.converted_opportunity_count, 1);
  assert.equal(run.judge.missed_opportunity_count, 1);
  assert.equal(run.judge.opportunity_conversion_rate, 0.5);
  assert.equal(run.judge.conditional_missed_opportunity_severity, 2);
  assert.equal(run.judge.opportunity_abstentions, 1);
  assert.ok(Math.abs(run.judge.opportunity_confidence - 0.85) < 1e-9);
  assert.equal(run.judge.plan_coherence_confidence, 0.75);
});

test("Judge evidence references must stay inside the action window", () => {
  const transcript = completeTranscript("run-evidence");
  const [window] = buildActionWindows(transcript);
  assert.throws(() => validateJudgeResult({
    opportunity_decisions: [{
      decision_id: "bad-evidence",
      step: 1,
      opportunity_type: "joint_attack",
      severity: 1,
      evidence_refs: [{ step: 99, unit_ids: ["a"], target_hexes: ["2512"] }]
    }],
    plan_coherence: { score: 3 }
  }, window), /outside the action window/);
});

test("Judge requires evidence for confirmed opportunities and rejects duplicates", () => {
  const transcript = completeTranscript("run-evidence-contract");
  const [window] = buildActionWindows(transcript);
  assert.throws(() => validateJudgeResult({
    opportunity_decisions: [{ step: 1, opportunity_type: "joint_attack", severity: 1 }],
    plan_coherence: { score: 3 }
  }, window), /requires evidence_refs/);
  assert.throws(() => validateJudgeResult({
    opportunity_decisions: [
      { decision_id: "first", step: 1, opportunity_type: "joint_attack", severity: 1,
        evidence_refs: [{ step: 1, unit_ids: ["a", "b"], target_hexes: ["2512"] }] },
      { decision_id: "second", step: 2, opportunity_type: "joint_attack", severity: 2,
        evidence_refs: [{ step: 1, unit_ids: ["b", "a"], target_hexes: ["2512"] }] }
    ],
    plan_coherence: { score: 3 }
  }, window), /duplicate opportunity evidence/);
});

test("Judge requires evidence for non-abstained plan coherence", () => {
  const transcript = completeTranscript("run-coherence-evidence");
  const [window] = buildActionWindows(transcript);
  assert.throws(() => validateJudgeResult({
    opportunity_decisions: [],
    plan_coherence: { score: 3 }
  }, window), /plan coherence requires evidence/);
  const result = validateJudgeResult({
    opportunity_decisions: [],
    plan_coherence: { abstain: true, confidence: 0.2 }
  }, window);
  assert.equal(result.plan_coherence.abstain, true);
});

test("odds parser supports dash and colon notation", () => {
  assert.equal(oddsBelowTwoToOne("1-1"), true);
  assert.equal(oddsBelowTwoToOne("3:2"), true);
  assert.equal(oddsBelowTwoToOne("2:1"), false);
  assert.equal(oddsBelowTwoToOne("bad"), false);
});

test("metrics CLI accepts the pnpm argument separator", () => {
  const options = parseArgs(["--", "log/a.json", "--out", "log/report.json"]);
  assert.deepEqual(options.files, ["log/a.json"]);
  assert.equal(options.out, "log/report.json");
});

test("Judge retries empty successful responses before accepting a valid judgment", async () => {
  const [window] = buildActionWindows(completeTranscript("run-a"));
  let calls = 0;
  const client = {
    async complete() {
      calls += 1;
      return {
        ok: true,
        status: 200,
        elapsed_ms: 5,
        error_class: "none",
        response_json: calls === 1
          ? { id: "empty", choices: [{ message: { content: "" } }] }
          : {
              id: "valid",
              choices: [{ message: { content: JSON.stringify({
                type: "research_metric_judgment",
                opportunity_decisions: [],
                plan_coherence: { score: 3, evidence: "basic plan", rationale: "coherent enough" }
              }) } }]
            }
      };
    }
  };
  const result = await judgeWindow(client, {
    profile: { capabilities: { structured_output: "json_object" } }
  }, {
    judge: {
      protocol_retries: 2,
      protocol_retry_delay_ms: 0,
      opportunity_types: [],
      missed_opportunity_scale: {},
      plan_coherence_scale: {}
    }
  }, "judge system", window);
  assert.equal(calls, 2);
  assert.equal(result.judgment.plan_coherence.score, 3);
  assert.deepEqual(result.api.attempts.map((item) => item.outcome), ["rejected", "accepted"]);
});

test("Judge accepts complete JSON in reasoning content but rejects truncated reasoning", () => {
  assert.deepEqual(parseJudgeContent({
    response_json: {
      choices: [{
        finish_reason: "stop",
        message: { content: "", reasoning_content: '{"type":"research_metric_judgment"}' }
      }]
    }
  }), { type: "research_metric_judgment" });
  assert.throws(() => parseJudgeContent({
    response_json: {
      choices: [{
        finish_reason: "length",
        message: { content: "", reasoning_content: '{"type":"research_metric' }
      }]
    }
  }), /output limit/);
});

test("unified report separates July, September, and October metrics", () => {
  const july = completeTranscript("july-run", 33);
  july.summary.victory.breakdown = [
    { id: "scenario_start", points: 25 },
    { id: "july_east_of_3400", points: 6, farthest_column: 36 }
  ];
  const september = completeTranscript("september-run", 38);
  september.scenario = "september";
  september.external_side = "axis";
  september.summary.victory.breakdown = [
    { id: "scenario_start", points: 35 },
    { id: "september_axis_cleared_mines", points: 3, cleared_mines: 1 }
  ];
  september.model_steps[0].action_attempts[1].accepted = true;
  september.model_steps[0].action_attempts[1].action = { type: "clear_mine", unit: "engineer" };
  const october = completeTranscript("october-run", 5);
  october.scenario = "october";
  october.external_side = "axis";
  october.summary.victory.breakdown = [
    { id: "scenario_start", points: -20 },
    { id: "october_combat_exited_west", points: 20, units: ["tank"] }
  ];
  october.model_steps[0].action_attempts[0].accepted = true;
  october.model_steps[0].action_attempts[0].action = { type: "exit_west", unit: "tank" };
  october.model_steps[0].turn = 11;
  const report = buildResearchReport([july && deterministicRunMetrics(july), deterministicRunMetrics(september), deterministicRunMetrics(october)]);
  assert.deepEqual(Object.keys(report.scenario_metrics), ["july", "september", "october"]);
  assert.equal(report.scenario_metrics.july.metrics.effective_scoring_column.mean, 36);
  assert.equal(report.scenario_metrics.september.metrics.mine_clear_attempts.mean, 1);
  assert.equal(report.scenario_metrics.october.metrics.withdrawal_vp.mean, 20);
  assert.equal(report.scenario_metrics.october.metrics.effective_scoring_column, undefined);
});

test("baseline comparison only matches the same scenario, side, seed, and replicate", () => {
  const agent = completeTranscript("agent", 30);
  const baseline = completeTranscript("baseline", 25);
  baseline.controllers = { axis: "rules_ai", allies: "rules_ai" };
  const otherScenario = completeTranscript("other", 99);
  otherScenario.scenario = "september";
  otherScenario.controllers = { axis: "rules_ai", allies: "rules_ai" };
  const report = buildResearchReport([deterministicRunMetrics(agent)], {
    baseline_runs: [baseline, otherScenario]
  });
  assert.equal(report.baseline_comparison.matched_pairs, 1);
  assert.equal(report.baseline_comparison.pairs[0].agent_minus_rules_ai_vp, 5);
});

test("Rules-vs-Rules baseline serves both sides but duplicate and different-rule references do not match", () => {
  const baseline = completeTranscript("baseline", 25);
  baseline.controllers = { axis: "rules_ai", allies: "rules_ai" };
  baseline.external_side = "";
  const allied = completeTranscript("allied", 20);
  allied.external_side = "allies";
  const row = deterministicRunMetrics(allied);
  const matched = buildBaselineComparison([row], [baseline]);
  assert.equal(matched.matched_pairs, 1);
  assert.equal(matched.pairs[0].side_adjusted_baseline_gain, 5);
  assert.equal(buildBaselineComparison([row], [baseline, baseline]).matched_pairs, 0);
  assert.equal(buildBaselineComparison([{ ...row, artifact_group_hashes: { ...row.artifact_group_hashes, rules: "other" } }], [baseline]).matched_pairs, 0);
});

test("report counts one stable task across replanned criteria", () => {
  const transcript = completeTranscript("tasks");
  const task = { id: "t", type: "model_task", completion_criteria: { all: [{ metric: "axis_vp", target: 40 }] }, status: "failed" };
  transcript.model_steps = [{ task_observation: { plan: { children: [task] } } },
    { task_observation: { plan: { children: [{ ...task, status: "completed", completion_criteria: { all: [{ metric: "axis_vp", target: 30 }] } }] } } }];
  const metrics = deterministicRunMetrics(transcript).scenario_metrics;
  assert.equal(metrics.task_completion_rate, 1);
});
