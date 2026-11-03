---
type: Eval
title: opencode-session-end Evaluation Goldset
description: Published evaluation criterion for the OpenCode session_end → session.deleted fallback (ADR-479). Code-based grader on generator output.
resource: ./evals/opencode-session-end/goldset.md
tags: [eval, goldset, opencode, session_end]
timestamp: 2026-10-31T00:00:00Z
id: opencode-session-end-goldset
created: 2026-10-31
modified: 2026-10-31
verified: 2026-10-31
age_days: 0
---

# Goldset: opencode-session-end Plugin Wiring

This goldset contains the evaluation criterion for the OpenCode `session_end` fallback (ADR-479).
Grader type: code-based (`tests/events.test.mjs` session_end block). No LLM judge.

---

## Criterion EVAL-001: opencode-session-end-plugin-wiring

**Status**: accepted
**Description**: Verifies that a generated OpenCode hybrid plugin carries canonical `session_end` through to the native `session.deleted` lifecycle event on both V1 and V2 entrypoints, with `file.edited` stream separation preserved.

Related ADR: ADR-479 (accepted) — OpenCode `session_end` falls back to `session.deleted` event subscription.

### Pass Condition

A `session_end`-only manifest resolves for OpenCode and the generated plugin contains a V1 `session.deleted` guard dispatching canonical `session_end` for `team-levelup` AND a V2 `session.deleted` subscription; a combined `session_end` + `file_edited` manifest keeps both type guards in separate event entries.

### Fail Condition

`resolveEvents` drops `session_end` for OpenCode, the generated plugin lacks either the V1 or V2 `session.deleted` path, or the `file.edited` and `session.deleted` guards merge into one unguarded handler.

### Failure Type

specification_failure → fix_directive (confirmed, high confidence).

### Error Analysis Provenance

- **Traces analyzed**: 2 (RED resolution drop + RED generation ENOENT, 2026-10-31 session)
- **Saturation**: NOT claimed (single session)
- **Central phenomenon**: null-mapping event drops are silent — a falsy `canonical_to_native` entry skips resolution with no diagnostic, so generation emits nothing and the skill never fires.
- **Causal conditions**: `resolveEvents()` treats falsy nativeEvent as "unsupported agent" and filters it out; no warn/error path exists for declared-but-unmapped events.
- **Detection rule**: assert both the resolved mapping AND the generated artifact.

### Pass Example 1

- **Scenario**: session_end-only manifest resolves with native fallback
- **Input Context**: manifest `{ events: { session_end: [{ skill: "team-levelup", timeout: 120 }] } }`, agent `opencode`
- **Expected Output**: `resolved.session_end == [{ skill: "team-levelup", timeout: 120, nativeEvent: "session.deleted" }]`

### Pass Example 2

- **Scenario**: generated plugin carries both V1 and V2 session.deleted paths
- **Input Context**: same manifest through `installEvents("opencode", projectRoot, resolved, ".agents/skills")`
- **Expected Output**: generated `.opencode/plugins/adlc-skills-events.ts` contains `event.type === "session.deleted"` + `"session_end"` + `"team-levelup"` (V1) and `"session.deleted"` + `"ctx.event.subscribe"` (V2)

### Fail Example 1

- **Scenario**: declared event vanishes with no error (the shipped bug)
- **Input Context**: manifest from Pass Example 1 through `resolveEvents` with `session_end: null` mapping (pre-fix registry)
- **Actual Output**: `resolved == {}` (`session_end` dropped)

### Fail Example 2

- **Scenario**: teardown and file-edit streams cross-fire, or duplicate handler keys drop a stream
- **Input Context**: manifest `{ events: { session_end: [...], file_edited: [...] } }`, agent `opencode`
- **Actual Output**: a single `"event"` entry with no type guard, or one branch covering both streams, OR two `"event"` object keys (duplicate-key semantics silently drop one handler at runtime)

### Adversarial Examples

- **Adversarial 1 — mapping regression**: future edit reverts `session_end` to `null`. Detected by Pass Example 1 assertion.
- **Adversarial 2 — guard collapse**: V2 `setup()` or V1 `server()` merges the two subscriptions into one unguarded branch, or emits two `"event"` keys (duplicate-key drop). Detected by single-entry + both-branch assertions.
- **Adversarial 3 (synthetic) — V1-only regression**: V2 `setup()` loses the `session.deleted` loop while V1 keeps working. Detected by Pass Example 2 V2 assertions (a V1-only check would miss it).
- **Adversarial 4 — HOLDOUT — timeout loss**: `session.deleted` runner hardcodes a timeout instead of propagating the manifest value (120). Reserved for unbiased validation.
- **Adversarial 5 — HOLDOUT — wrong native signal**: `session_end` mapped to `session.idle` (fires repeatedly per session, not once per teardown). Reserved for unbiased validation.

### Implementation Details

- **Evaluator type**: code-based, Tier 1
- **Grader**: `tests/events.test.mjs` session_end block (node:test, deterministic string assertions)
- **SLA**: runs inside existing `node --test` suite (<2s for file)
- **Fail-safe**: test fails closed (missing artifact = fail)

### Quality Assurance

- **Pass examples**: 100% (2/2, verified in 2026-10-31 GREEN run: 74/74 events, 329/329 full suite)
- **Fail examples**: 100% (2/2, verified in 2026-10-31 RED run)
- **Adversarial robustness**: 3/5 exercised in-suite (1, 2 implicit in guard tests); 2/5 (4, 5) reserved as holdout

### EDD Compliance

- **I — Spec-Driven**: validates ADR-479 contract ✅
- **II — Binary Pass/Fail**: deterministic 1.0/0.0, no scores ✅
- **III — Error Analysis**: open coding → axial coding; saturation NOT claimed ✅ (explicit)
- **VIII — Production Loop**: specification_failure → fix_directive ✅
- **IX — Test Data as Code**: version-controlled, adversarial included, holdout segregated ✅

---

*Source draft: `adlc-cli/.adlc/drafts/evals/EVAL-001.md` (status: accepted). Holdout cases 4–5 isolated in `adlc-cli/.adlc/memory/evals/holdout.json` — never used in implementation or training.*
