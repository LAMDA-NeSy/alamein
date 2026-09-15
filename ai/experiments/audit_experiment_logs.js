#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { readJsonFile, writeJsonAtomic } = require("../core/json_file.js");
const { comparisonContractHash } = require("../core/comparison_contract.js");
const { validateArtifactManifest } = require("../core/benchmark_artifacts.js");
const { summarizeExecutionLedger } = require("../core/phase_execution_ledger.js");
const { deterministicRunMetrics, actionAttempts } = require("./research_metrics.js");

function issue(code, detail = null) {
  return detail ? { code, detail } : { code };
}

function sameNumber(left, right) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Number(left) === Number(right);
}

function auditTranscript(transcript) {
  const issues = [];
  const warnings = [];
  if (!transcript || typeof transcript !== "object" || Array.isArray(transcript)) {
    return { usable_for_scoring: false, issues: [issue("invalid_json_root")], warnings: [] };
  }

  const log = Array.isArray(transcript.game_log) ? transcript.game_log : [];
  const steps = Array.isArray(transcript.model_steps) ? transcript.model_steps : [];
  const attempts = actionAttempts(transcript);
  const externalLog = log.filter((entry) => entry.source === "external_model" && typeof entry.action === "object");
  const rulesLog = log.filter((entry) => entry.controller === "rules_ai" && typeof entry.action === "object");
  const illegal = log.filter((entry) => entry.result && entry.result.legal === false).length;
  const modelRejected = attempts.filter(({ attempt }) => attempt.accepted === false).length;
  const modelAccepted = attempts.filter(({ attempt }) => attempt.accepted === true).length;
  const actCalls = steps.reduce((sum, step) => sum + (step.rounds || [])
    .filter((round) => round.tool_result?.tool === "act").length, 0);
  const fallbackSteps = steps.filter((step) => step.fallback_used).length;
  const counts = transcript.counts || {};

  if (!Array.isArray(transcript.game_log)) issues.push(issue("game_log_missing"));
  if (!Array.isArray(transcript.model_steps)) warnings.push(issue("model_steps_missing"));
  if (transcript.status !== "final_victory" || transcript.summary?.victory?.final !== true) {
    issues.push(issue("game_not_complete"));
  }
  if (!validateArtifactManifest(transcript.artifact_manifest, transcript.artifact_manifest_hash)) {
    issues.push(issue("artifact_manifest_invalid"));
  }
  if (transcript.comparison_contract && transcript.comparison_contract_hash
    && comparisonContractHash(transcript.comparison_contract) !== transcript.comparison_contract_hash) {
    issues.push(issue("comparison_contract_hash_mismatch"));
  }

  const countChecks = [
    ["external_actions", externalLog.length],
    ["rules_actions", rulesLog.length],
    ["illegal_actions", illegal],
    ["fallback_actions", fallbackSteps],
    ["model_submitted_actions", attempts.length],
    ["model_accepted_actions", modelAccepted],
    ["model_rejected_actions", modelRejected],
    ["act_calls", actCalls]
  ];
  const legacyCountMismatches = [];
  for (const [name, actual] of countChecks) {
    if (counts[name] != null && !sameNumber(counts[name], actual)) {
      const mismatch = issue("count_mismatch", { field: name, recorded: counts[name], derived: actual });
      // v18 transcripts were emitted before action-ledger-v2 separated phase
      // transition records from actual actions. Preserve those logs as
      // scoreable evidence, while explicitly flagging their stale redundant
      // summary fields.
      if (counts.accounting_protocol !== "action-ledger-v2") legacyCountMismatches.push(mismatch);
      else issues.push(mismatch);
    }
  }
  const acceptedExternal = externalLog.filter((entry) => entry.result?.legal === true).length;
  if (counts.accepted_actions != null && !sameNumber(counts.accepted_actions, acceptedExternal)) {
    const mismatch = issue("count_mismatch", { field: "accepted_actions", recorded: counts.accepted_actions, derived: acceptedExternal });
    if (counts.accounting_protocol !== "action-ledger-v2") legacyCountMismatches.push(mismatch);
    else issues.push(mismatch);
  }
  if (legacyCountMismatches.length) warnings.push(issue("legacy_count_summary_mismatch", legacyCountMismatches));

  if (transcript.execution_ledger_summary) {
    const derived = summarizeExecutionLedger(steps);
    for (const field of ["phases", "closed_phases", "plan_versions", "requests", "model_submitted_actions",
      "model_rule_rejections", "executed", "application_failures", "held", "failed", "replaced",
      "batch_repair_requests"]) {
      if (transcript.execution_ledger_summary[field] != null && derived[field] !== transcript.execution_ledger_summary[field]) {
        issues.push(issue("execution_ledger_mismatch", {
          field, recorded: transcript.execution_ledger_summary[field], derived: derived[field]
        }));
      }
    }
  }

  const settlement = transcript.final_task_settlement?.child_statuses
    ? transcript.final_task_settlement
    : Object.values(transcript.final_task_settlement || {}).find((item) => item?.child_statuses);
  if (settlement?.child_statuses && Array.isArray(settlement.children)) {
    const childIds = new Set(settlement.children.map((task) => task.id).filter(Boolean));
    const statusIds = new Set(Object.keys(settlement.child_statuses));
    if (childIds.size !== statusIds.size || [...childIds].some((id) => !statusIds.has(id))) {
      issues.push(issue("task_settlement_id_mismatch"));
    }
  }

  const score = deterministicRunMetrics(transcript);
  if (score.final_vp == null) issues.push(issue("final_vp_missing"));
  if (score.sample_status === "infrastructure_affected") warnings.push(issue("infrastructure_affected"));
  if (score.ranking_eligibility_reasons?.length) {
    warnings.push(issue("not_strict_ranking_eligible", score.ranking_eligibility_reasons));
  }
  return {
    experiment_id: transcript.experiment_id || null,
    scenario: transcript.scenario || null,
    external_side: transcript.external_side || null,
    status: transcript.status || null,
    final_vp: score.final_vp,
    sample_status: score.sample_status,
    usable_for_scoring: issues.length === 0 && score.final_vp != null,
    ranking_eligible: score.ranking_eligible,
    ranking_eligibility_reasons: score.ranking_eligibility_reasons || [],
    issues,
    warnings,
    derived: {
      external_actions: externalLog.length,
      rules_actions: rulesLog.length,
      illegal_actions: illegal,
      accepted_external_actions: acceptedExternal,
      model_submitted_actions: attempts.length,
      model_accepted_actions: modelAccepted,
      model_rejected_actions: modelRejected,
      act_calls: actCalls,
      fallback_steps: fallbackSteps
    },
    score
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const files = [];
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    if (argv[index] === "--out") out = argv[++index];
    else if (argv[index].startsWith("--")) throw new Error(`unknown option ${argv[index]}`);
    else files.push(argv[index]);
  }
  if (!files.length) throw new Error("provide one or more transcript JSON files");
  return { files, out };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const audits = [];
  for (const file of options.files) {
    try {
      audits.push({ file: path.resolve(file), ...(auditTranscript(await readJsonFile(path.resolve(file)))) });
    }
    catch (error) {
      audits.push({ file: path.resolve(file), usable_for_scoring: false,
        issues: [issue("read_or_parse_failure", error.message)], warnings: [] });
    }
  }
  const report = {
    generated_at: new Date().toISOString(),
    protocol: "experiment-log-audit-v1",
    scoring_rule: "usable_for_scoring requires a complete transcript, valid artifact manifest, valid contract hash when present, and consistent counts/ledger",
    strict_ranking_is_separate: true,
    total_files: audits.length,
    usable_for_scoring: audits.filter((audit) => audit.usable_for_scoring).length,
    invalid_files: audits.filter((audit) => !audit.usable_for_scoring).length,
    audits
  };
  if (options.out) writeJsonAtomic(path.resolve(options.out), report);
  process.stdout.write(`${JSON.stringify(options.out ? { output: path.resolve(options.out), ...report } : report, null, 2)}\n`);
  if (audits.some((audit) => !audit.usable_for_scoring)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { auditTranscript, parseArgs };
