"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { fallbackReasonClass, isNonRetryableRequestStatus, stepBudget } = require("../core/transport_attribution.js");

test("zero fallback reserve gives the model the complete step budget", () => {
  const started = Date.now();
  const budget = stepBudget({ transport: { stepFallbackReserveMs: 0 } }, started, 180000);

  assert.equal(budget.fallbackReserveMs, 0);
  assert.ok(budget.remainingStepMs <= 180000 && budget.remainingStepMs > 179000);
  assert.equal(budget.modelBudgetMs, budget.remainingStepMs);
});

test("non-retryable 4xx request errors are separated from network failures", () => {
  assert.equal(isNonRetryableRequestStatus(402), true);
  assert.equal(isNonRetryableRequestStatus(429), false);
  assert.equal(isNonRetryableRequestStatus(503), false);
  assert.equal(fallbackReasonClass({
    fallbackUsed: true,
    transportFailures: [{ status: 402, error_class: "request_error" }]
  }), "request_error");
});
