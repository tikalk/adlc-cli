// Error events must carry a readable message.
//
// opencode v2 nests the message under error.message; v1 used a flat message.
// The normalizer once read only the flat form, so every opencode v2 failure
// rendered as "[object Object]" — the real cause (auth, quota, provider) was
// discarded before it reached the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLine } from "../src/run-events.mjs";

const norm = (raw, format = "json") => normalizeLine(JSON.stringify(raw), format)[0];

test("opencode v2 error event yields the nested message", () => {
  const out = norm({
    type: "error",
    timestamp: 1,
    sessionID: "s1",
    error: { type: "provider.auth", message: "Authentication Error, No api key passed in.", status: 401 },
  });
  assert.equal(out.type, "error");
  assert.match(out.message, /Authentication Error/);
  assert.doesNotMatch(out.message, /\[object Object\]/);
});

test("opencode v2 error event keeps the type and status for triage", () => {
  const out = norm({
    type: "error",
    error: { type: "provider.rate_limit", message: "rate limited", status: 429 },
  });
  assert.match(out.message, /provider\.rate_limit/);
  assert.match(out.message, /rate limited/);
  assert.match(out.message, /429/);
});

test("opencode v1 flat error message still works", () => {
  const out = norm({ type: "error", timestamp: 1, sessionID: "s1", message: "flat message" });
  assert.equal(out.message, "flat message");
});

test("string error payload is used verbatim", () => {
  const out = norm({ type: "error", error: "something broke" });
  assert.equal(out.message, "something broke");
});

test("stream-json error path extracts the same message", () => {
  const out = norm(
    { type: "error", error: { type: "provider", message: "stream failure" } },
    "stream-json",
  );
  assert.match(out.message, /stream failure/);
});

test("an error event with no message still yields something printable", () => {
  const out = norm({ type: "error", foo: "bar" });
  assert.equal(out.type, "error");
  assert.ok(out.message.length > 0);
});
