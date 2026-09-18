"use strict";

const bindings = new WeakMap();
const TOKEN_FIELDS = ["input_tokens", "uncached_input_tokens", "output_tokens", "cache_tokens"];

function allocationCorrectionMetrics(steps = []) {
  const events = new Map();
  let versions = 0, assigned = 0;
  for (const step of steps) {
    if (!step.force_allocation || !step.sae_plan || step.sae_plan.reused) continue;
    versions += 1;
    const allocation = step.force_allocation;
    const version = allocation.allocation_id || `${step.side}:${step.step}:allocation`;
    const ids = new Set(["spearhead", "support", "supply", "reserve"].flatMap((key) => allocation[key] || [])
      .map((item) => typeof item === "string" ? item : item?.unit).filter(Boolean));
    assigned += ids.size;
    for (const [index, correction] of (allocation.allocation_corrections || []).entries()) {
      const id = correction.event_id || `${version}:correction:${index}`;
      events.set(id, { ...correction, event_id: id, allocation_id: version });
    }
  }
  const corrected = new Set([...events.values()].filter((item) => item.unit)
    .map((item) => `${item.allocation_id}:${item.unit}`)).size;
  return { corrections: events.size, allocation_versions: versions, assigned_unit_versions: assigned,
    corrected_unit_versions: corrected, correction_rate: assigned ? corrected / assigned : null,
    source: "non_reused_allocation_versions", events: [...events.values()] };
}

function sumUsage(usages) {
  const values = Object.values(usages);
  return {
    ...Object.fromEntries(TOKEN_FIELDS.map((key) => [key, values.reduce((sum, usage) => sum + Number(usage[key] || 0), 0)])),
    estimated_cost: values.length && values.every((usage) => Number.isFinite(usage.estimated_cost))
      ? values.reduce((sum, usage) => sum + usage.estimated_cost, 0) : null,
    cost_coverage: values.length ? values.filter((usage) => Number.isFinite(usage.estimated_cost)).length / values.length : 0
  };
}

function transportCounts(records) {
  records = [...new Map(records.map((item, index) => [item.request_id || `missing:${index}`, item])).values()];
  return {
    requests: records.length,
    transport_failures: records.filter((item) => item.error_class && !["none", "protocol_failure", "model_protocol_failure"].includes(item.error_class)).length,
    protocol_failures: records.filter((item) => item.protocol_failure || ["protocol_failure", "model_protocol_failure"].includes(item.error_class)).length,
    recovered_transport_failures: records.filter((item) => item.error_class === "none" && item.recovered_after_retry).length,
    retry_attempts: records.reduce((sum, item) => sum + Math.max(0, Number(item.attempts || 1) - 1), 0)
  };
}

function attachRuntimeAccounting(transcript, runtimes) {
  bindings.set(transcript, runtimes);
  refreshRuntimeAccounting(transcript);
}

function refreshRuntimeAccounting(transcript) {
  const runtimes = bindings.get(transcript);
  if (!runtimes) return;
  transcript.accounting_version = "all-runtime-requests-v3-actual-planner-calls";
  transcript.model_usage_by_component = Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, { ...runtime.usage }]));
  transcript.model_transport_by_component = Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, runtime.transport]));
  transcript.model_usage = sumUsage(transcript.model_usage_by_component);
  transcript.transport_counts_by_component = Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, transportCounts(runtime.transport)]));
  const records = [...new Map(Object.values(runtimes).flatMap((runtime) => runtime.transport)
    .map((record, index) => [record.request_id || `missing:${index}`, record])).values()];
  transcript.model_requests_by_stage = {};
  for (const record of records) {
    const stage = record.stage || "unattributed";
    const summary = transcript.model_requests_by_stage[stage] ||= { requests: 0, request_ids: [], input_tokens: null,
      output_tokens: null, cache_tokens: null, usage_known_requests: { input_tokens: 0, output_tokens: 0, cache_tokens: 0 },
      api_ms: 0, retry_wait_ms: 0, elapsed_ms: 0 };
    const usage = record.response?.usage || {};
    summary.requests += 1;
    summary.request_ids.push(record.request_id);
    const tokens = { input_tokens: usage.prompt_tokens ?? usage.input_tokens,
      output_tokens: usage.completion_tokens ?? usage.output_tokens,
      cache_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens
        ?? usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens };
    for (const [key, value] of Object.entries(tokens)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      summary[key] = (summary[key] ?? 0) + value;
      summary.usage_known_requests[key] += 1;
    }
    summary.usage_coverage = Object.fromEntries(Object.entries(summary.usage_known_requests)
      .map(([key, count]) => [key, count / summary.requests]));
    summary.api_ms += Number(record.api_ms ?? record.elapsed_ms ?? 0);
    summary.retry_wait_ms += Number(record.retry_wait_ms || 0);
    summary.elapsed_ms += Number(record.elapsed_ms || 0);
  }
  transcript.counts = {
    ...transcript.counts,
    sae_plan_calls: records.filter((record) => ["strategic", "allocation"].includes(record.stage)).length,
    ...transportCounts(records),
    protocol_failures: new Set([
      ...records.filter((record) => record.protocol_failure).map((record) => record.request_id),
      ...(transcript.model_steps || []).flatMap((step) => (step.protocol_failures || []).map((event, index) => event.request_id || `${step.step}:protocol:${index}`))
    ]).size,
    circuit_open_events: Object.values(runtimes).reduce((sum, runtime) => sum + Number(runtime.transport_health?.circuit_open_events || 0), 0)
  };
  transcript.sae_plan_calls = transcript.counts.sae_plan_calls;
}

function recordedTransportCounts(transcript) {
  const components = transcript.model_transport_by_component;
  const records = components ? Object.values(components).flat() : transcript.model_transport;
  return Array.isArray(records) ? transportCounts(records) : null;
}

module.exports = { allocationCorrectionMetrics, attachRuntimeAccounting, recordedTransportCounts, refreshRuntimeAccounting, sumUsage, transportCounts };
