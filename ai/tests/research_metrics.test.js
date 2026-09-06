"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  aggregateRuns,
  attachJudgeResults,
  buildActionWindows,
  buildResearchReport,
  deterministicRunMetrics,
  oddsBelowTwoToOne,
  validateJudgeResult
} = require("../experiments/research_metrics.js");
const { judgeWindow, parseArgs, parseJudgeContent } = require("../experiments/evaluate_research_metrics.js");

function completeTranscript(id, vp = 30) {
  return {
    experiment_id: id,
    scenario: "july",
    external_side: "axis",
    status: "final_victory",
    harness: "manual_single_action",
    decision_mode: "unit_plan_hybrid",
    model_profile: "mock_primary",
    comparison_contract_hash: "contract-v1",
    benchmark_version: "alamein-benchmark-v1",
    artifact_manifest_hash: "artifact-v1",
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
