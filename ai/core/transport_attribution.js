"use strict";

const NETWORK_ERROR_CLASSES = new Set([
  "network_timeout",
  "dns_error",
  "connection_error",
  "rate_limit",
  "upstream_unavailable",
  "upstream_5xx",
  "network_error",
  "circuit_open"
]);

function failedTransportRecords(runtime, startIndex = 0) {
  const records = (runtime?.transport || []).slice(startIndex);
  return records.filter((record) => (
    record.error_class
    && record.error_class !== "none"
  ));
}

function transportFailureDetails(runtime, startIndex = 0) {
  return failedTransportRecords(runtime, startIndex).map((record) => ({
    status: Number(record.status || 0),
    error_class: record.error_class,
    attempts: Number(record.attempts || 0),
    elapsed_ms: Number(record.elapsed_ms || 0)
  }));
}

function recoveredTransportDetails(runtime, startIndex = 0) {
  const records = (runtime?.transport || []).slice(startIndex);
  return records
    .filter((record) => record.recovered_after_retry)
    .map((record) => ({
      status: Number(record.status || 0),
      attempts: Number(record.attempts || 0),
      elapsed_ms: Number(record.elapsed_ms || 0),
      retryable_failures: record.retryable_failures || [],
      recovery: "gateway_retry"
    }));
}

function hasNetworkFailure(records = []) {
  return records.some((record) => NETWORK_ERROR_CLASSES.has(record.error_class));
}

function isNonRetryableRequestStatus(status) {
  const code = Number(status || 0);
  return code >= 400 && code < 500 && ![408, 409, 429].includes(code);
}

function fallbackReasonClass({ fallbackUsed, timedOut = false, transportFailures = [], protocolFailures = [], error = "" }) {
  if (!fallbackUsed) return "";
  if (hasNetworkFailure(transportFailures)) return "transport_failure";
  if (transportFailures.some((record) => isNonRetryableRequestStatus(record.status))) return "request_error";
  if (timedOut || /\b(exceeded|timed? out|timeout)\b/i.test(String(error))) return "step_timeout";
  if (protocolFailures.length || /no tool call|did not produce an accepted action|invalid model output/i.test(String(error))) {
    return "model_protocol_failure";
  }
  if (/sidecar|broken pipe|exited|closed/i.test(String(error))) return "harness_failure";
  return "tool_call_limit";
}

function stepBudget(config, stepStarted, stepTimeoutMs) {
  const fallbackReserveMs = Math.max(0, Number(config?.transport?.stepFallbackReserveMs ?? 0));
  const remainingStepMs = Math.max(0, Number(stepTimeoutMs) - (Date.now() - Number(stepStarted)));
  return {
    fallbackReserveMs,
    remainingStepMs,
    modelBudgetMs: Math.max(0, remainingStepMs - fallbackReserveMs)
  };
}

module.exports = {
  NETWORK_ERROR_CLASSES,
  failedTransportRecords,
  fallbackReasonClass,
  hasNetworkFailure,
  isNonRetryableRequestStatus,
  recoveredTransportDetails,
  stepBudget,
  transportFailureDetails
};
