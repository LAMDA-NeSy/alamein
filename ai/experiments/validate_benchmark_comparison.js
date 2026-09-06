#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { metrics } = require("./summarize_ai_experiments.js");
const {
  COMPARISON_DIMENSIONS,
  buildPairedResults,
  validateComparisonRows
} = require("../core/benchmark_comparison.js");

function parseArgs(argv = process.argv.slice(2)) {
  const options = { dimension: "method", files: [], out: null, baseline: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dimension") options.dimension = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--baseline") options.baseline = argv[++index];
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (!COMPARISON_DIMENSIONS.has(options.dimension)) throw new Error("--dimension must be method, harness, model, or system");
  if (!options.files.length) throw new Error("provide experiment transcript JSON files");
  return options;
}

function validateFiles(files, dimension, baseline = null) {
  const transcripts = files.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8")));
  const rows = transcripts.map(metrics);
  return {
    dimension,
    validation: validateComparisonRows(rows, dimension),
    baseline_variant: baseline || null,
    paired_results: buildPairedResults(rows, dimension, baseline),
    rows
  };
}

function main() {
  const options = parseArgs();
  const report = {
    generated_at: new Date().toISOString(),
    ranking_policy: "complete-game-method-fallback-paired-v2",
    ...validateFiles(options.files, options.dimension, options.baseline)
  };
  if (options.out) {
    const output = path.resolve(options.out);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    report.output = output;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.validation.valid) process.exitCode = 2;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, validateFiles };
