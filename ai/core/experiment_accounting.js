"use strict";

const bindings = new WeakMap();
const TOKEN_FIELDS = ["input_tokens", "uncached_input_tokens", "output_tokens", "cache_tokens"];

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
  return {
    requests: records.length,
    transport_failures: records.filter((item) => item.error_class && item.error_class !== "none").length,
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
  transcript.accounting_version = "all-runtime-requests-v1";
  transcript.model_usage_by_component = Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, { ...runtime.usage }]));
  transcript.model_transport_by_component = Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, runtime.transport]));
  transcript.model_usage = sumUsage(transcript.model_usage_by_component);
  transcript.transport_counts_by_component = Object.fromEntries(Object.entries(runtimes).map(([name, runtime]) => [name, transportCounts(runtime.transport)]));
  const records = Object.values(runtimes).flatMap((runtime) => runtime.transport);
  transcript.counts = {
    ...transcript.counts,
    ...transportCounts(records),
    circuit_open_events: Object.values(runtimes).reduce((sum, runtime) => sum + Number(runtime.transport_health?.circuit_open_events || 0), 0)
  };
}

function recordedTransportCounts(transcript) {
  const components = transcript.model_transport_by_component;
  const records = components ? Object.values(components).flat() : transcript.model_transport;
  return Array.isArray(records) ? transportCounts(records) : null;
}

module.exports = { attachRuntimeAccounting, recordedTransportCounts, refreshRuntimeAccounting, sumUsage, transportCounts };
