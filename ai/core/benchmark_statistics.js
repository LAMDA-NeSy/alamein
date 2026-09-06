"use strict";

const { jStat } = require("jstat");

function summaryStats(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  const count = finite.length;
  if (!count) return { count: 0, mean: null, median: null, stddev: null, ci95_half_width: null, ci_method: "student_t" };
  const mean = finite.reduce((sum, value) => sum + value, 0) / count;
  const stddev = count > 1 ? Math.sqrt(finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1)) : null;
  const middle = Math.floor(count / 2);
  return {
    count,
    mean,
    median: count % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2,
    stddev,
    ci95_half_width: count > 1 ? jStat.studentt.inv(0.975, count - 1) * stddev / Math.sqrt(count) : null,
    ci_method: "student_t"
  };
}

function pairedStatistics(pairs) {
  const byVariant = new Map();
  for (const pair of pairs) {
    for (const item of pair.comparisons) {
      if (!byVariant.has(item.compared_variant)) byVariant.set(item.compared_variant, []);
      if (item.ranking_eligible && Number.isFinite(item.vp_difference)) byVariant.get(item.compared_variant).push(item);
    }
  }
  return [...byVariant].map(([variant, rows]) => {
    const bySeed = new Map();
    for (const row of rows) {
      if (!bySeed.has(row.seed)) bySeed.set(row.seed, []);
      bySeed.get(row.seed).push(row.vp_difference);
    }
    const seedMeans = [...bySeed.values()].map((values) => summaryStats(values).mean);
    return {
      compared_variant: variant,
      paired_replicates: rows.length,
      seed_count: bySeed.size,
      vp_difference: summaryStats(rows.map((row) => row.vp_difference)),
      // Replicates share a game seed; across-seed inference uses seed means.
      across_seed_vp_difference: summaryStats(seedMeans),
      inference_scope: bySeed.size > 1 ? "paired_seed_means" : "within_seed_model_replicates_only"
    };
  });
}

module.exports = { pairedStatistics, summaryStats };
