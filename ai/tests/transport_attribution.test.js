"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  failedTransportRecords,
  recoveredTransportDetails
} = require("../core/transport_attribution.js");

test("transport attribution does not treat an unrelated later request as recovery", () => {
  const runtime = {
    transport: [
      { status: 502, error_class: "upstream_unavailable", attempts: 3 },
      { status: 200, error_class: "none", attempts: 1 }
    ]
  };

  assert.equal(failedTransportRecords(runtime).length, 1);
  assert.deepEqual(recoveredTransportDetails(runtime), []);
});
test("transport attribution keeps a final failure unresolved", () => {
  const runtime = {
    transport: [
      { status: 502, error_class: "upstream_unavailable", attempts: 3 },
      { status: 200, error_class: "none", attempts: 1 },
      { status: 503, error_class: "upstream_unavailable", attempts: 3 }
    ]
  };

  assert.equal(failedTransportRecords(runtime).length, 2);
  assert.equal(failedTransportRecords(runtime).at(-1).status, 503);
  assert.equal(recoveredTransportDetails(runtime).length, 0);
});
