"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { attachRuntimeAccounting, transportCounts } = require("../core/experiment_accounting.js");

test("request accounting deduplicates failures and separates protocol from transport", () => {
  const failure = { request_id: "one", error_class: "connection_error", attempts: 1 };
  const counts = transportCounts([failure, failure, { request_id: "two", error_class: "none", protocol_failure: { error: "bad JSON" } }]);
  assert.equal(counts.requests, 2);
  assert.equal(counts.transport_failures, 1);
  assert.equal(counts.protocol_failures, 1);
});

test("stage usage preserves missing and redacted evidence rather than claiming zero", () => {
  const transcript = { model_steps: [{ step: 1, protocol_failures: [{ request_id: "two" }] }] };
  attachRuntimeAccounting(transcript, { main: { usage: {}, transport: [
    { request_id: "one", stage: "unit_plan", response: { usage: { prompt_tokens: "[REDACTED]", completion_tokens: null } } },
    { request_id: "two", stage: "unit_plan", protocol_failure: { error: "bad JSON" }, response: { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } } },
    { request_id: "three", stage: "checker", response: null }
  ] } });
  assert.equal(transcript.model_requests_by_stage.unit_plan.input_tokens, 100);
  assert.equal(transcript.model_requests_by_stage.unit_plan.usage_coverage.input_tokens, 0.5);
  assert.equal(transcript.model_requests_by_stage.unit_plan.cache_tokens, 0);
  assert.equal(transcript.model_requests_by_stage.checker.input_tokens, null);
  assert.equal(transcript.counts.protocol_failures, 1);
});
