// Node-version gate for the npx-dependent shell E2E (tests/e2e-workspace.sh).
// The chained `skills add` step shells out to `npx skills`, whose bundled
// @clack/prompts chunk imports `styleText` from "node:util" — unavailable on
// Node 18 (added in Node 20). Unit tests run everywhere; the shell E2E skips
// below Node 20 with a clear message (exit 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipE2E } from "./e2e-node-gate.mjs";

test("gate skips Node 18 (npx skills needs util.styleText, Node 20+)", () => {
  assert.equal(shouldSkipE2E("v18.20.8"), true);
  assert.equal(shouldSkipE2E("18.0.0"), true);
});

test("gate runs Node 20/22", () => {
  assert.equal(shouldSkipE2E("v20.11.0"), false);
  assert.equal(shouldSkipE2E("v22.23.3"), false);
});
