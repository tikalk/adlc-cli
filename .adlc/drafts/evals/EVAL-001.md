---
id: EVAL-001
status: accepted
name: opencode-session-end-plugin-wiring
description: Generated OpenCode hybrid plugin must carry canonical session_end through to the native session.deleted lifecycle event on both V1 and V2 entrypoints, with file.edited stream separation preserved.

# Binary pass/fail only (EDD Principle II)
pass_condition: A session_end-only manifest resolves for OpenCode and the generated plugin contains a V1 session.deleted guard dispatching canonical session_end for team-levelup AND a V2 session.deleted subscription; a combined session_end + file_edited manifest keeps both type guards in separate event entries.
fail_condition: resolveEvents drops session_end for OpenCode, the generated plugin lacks either the V1 or V2 session.deleted path, or the file.edited and session.deleted guards merge into one unguarded handler.

# Failure type gate (EDD Principle VIII)
failure_type:
  specification_failure:
    action: fix_directive

# Error analysis provenance (EDD Principle III)
error_analysis:
  traces_analyzed: 2
  theoretical_saturation: false
  open_coding_notes: |
    Observed failure (2026-10-31 session): canonical session_end mapped to null
    for OpenCode in registry.mjs, so resolveEvents() silently dropped it and
    installEvents() generated a plugin with zero session_end references — the
    team-levelup hook never fired. RED run confirmed: resolved.session_end was
    undefined and the plugin file was never written. Post-fix GREEN run: 74/74
    events tests, 329/329 full suite.

# Test data hygiene (EDD Principle IX)
test_data:
  adversarial_included: true
  # Pass/fail examples balanced 50/50 for goldset (2 pass + 2 fail observed; 3 synthetic adversarial held out below).
holdout_ratio: 0.2

# Implementation details
implementation:
  evaluator_type: code-based
  tier: 1
  complexity: low
  automation_feasible: true
  synthesis_inputs:
    - pass_condition
    - fail_condition
    - examples.pass
    - examples.fail
  synthesis_tuning:
    max_iterations: 3
    holdout_locked: true
---

# opencode-session-end-plugin-wiring

## Error Analysis Notes

### Pattern Discovery

Silent event-drop: a canonical-to-native mapping of `null` causes `resolveEvents()` to skip the event entirely, so downstream generators emit no hook and no error. The failure is invisible unless a test asserts the resolved mapping AND the generated artifact.

**Discovery Method**: Bottom-up trace analysis (failing-first TDD run)
**Frequency**: 1 of 1 analyzed manifests with session_end for OpenCode (100% of analyzed traces)
**Severity**: High
**Detectability**: Low (no error, no warning — the hook simply never fires)

### Open Coding Observations

**Trace 1 - RED run, resolution**:
- Input: manifest `{ events: { session_end: [{ skill: "team-levelup", timeout: 120 }] } }`, agent `opencode`
- Output: `resolved.session_end === undefined`
- Failure: canonical event silently dropped by null mapping
- Notes: assertion `resolved.session_end is not dropped for OpenCode` failed with `ERR_ASSERTION`

**Trace 2 - RED run, generation**:
- Input: same manifest through `installEvents("opencode", ...)`
- Output: `ENOENT: no such file or directory ... adlc-skills-events.ts` (no resolved events → strip path, no plugin written)
- Failure: no plugin artifact emitted for a declared event
- Notes: proves resolution-drop propagates to missing generation, not a partial hook

### Pattern Clustering (Axial Coding)

**Central Phenomenon**: null-mapping event drops are silent — a falsy `canonical_to_native` entry skips resolution with no diagnostic, so generation emits nothing and the skill never fires.

**Causal Conditions**: `resolveEvents()` treats falsy nativeEvent as "unsupported agent" and filters it out; no warn/error path exists for declared-but-unmapped events. The `null` mapping was documented as "(no equivalent; skip)" — a correct-looking comment that hid the missing OpenCode-native alternative.

**Contextual Factors**: OpenCode's plugin surface differs per event (named hooks vs generic `event` subscription vs `ctx.event.subscribe()` stream), so "no hook key" does not imply "no native signal" — unlike agents with a flat hook table.

**Intervening Conditions**: none — the drop happens in resolution, before generation, so no downstream guard can catch it.

**Consequences**: skill never fires on one agent; session-end lifecycle silently unimplemented. Detection requires asserting both the resolved mapping AND the generated artifact.

**Saturation note**: 2 traces, single session — saturation NOT claimed. The two adversarial additions below are synthetic guard-regressions, marked as such.

**Acceptance review (2026-10-31, `/evals-clarify`)**:
- [x] Pattern clarity: clear and distinct (silent null-mapping drop, resolution-phase, no diagnostic)
- [x] Implementation feasibility: confirmed (code-based grader = existing `tests/events.test.mjs` session_end block)
- [x] Binary evaluability: pass/fail determinable (deterministic string assertions, no LLM judge)
- [x] No criterion overlap: validated (no existing opencode-session-end criterion in team-skills goldset)
- [x] Evidence sufficiency: met for publication with caveat (RED+GREEN runs verified; saturation explicitly not claimed; 2 of 5 adversarial synthetic)

## Examples

### Pass Examples

#### Pass Example 1
```
Input: manifest { events: { session_end: [{ skill: "team-levelup", timeout: 120 }] } }, agent "opencode"
Context: resolveEvents(manifest, getEventAgentConfig("opencode"))
Expected Output: resolved.session_end == [{ skill: "team-levelup", timeout: 120, nativeEvent: "session.deleted" }]
```
**Why it passes**: canonical event survives resolution with the native fallback attached
**Key compliance factors**: skill name, timeout, and nativeEvent all preserved

#### Pass Example 2
```
Input: same manifest through installEvents("opencode", projectRoot, resolved, ".agents/skills")
Context: generated .opencode/plugins/adlc-skills-events.ts
Expected Output: file contains 'event.type === "session.deleted"' + '"session_end"' + '"team-levelup"' (V1) and "session.deleted" + "ctx.event.subscribe" (V2)
```
**Why it passes**: both plugin generations route teardown through the native lifecycle event
**Key compliance factors**: V1 guard, canonical dispatch, skill routing, V2 subscription all present

### Fail Examples

#### Fail Example 1
```
Input: manifest { events: { session_end: [{ skill: "team-levelup", timeout: 120 }] } }, agent "opencode"
Context: resolveEvents with session_end: null mapping (pre-fix registry)
Actual Output: resolved == {} (session_end dropped)
```
**Why it fails**: declared event vanishes with no error — the exact shipped bug
**Violation specifics**: `resolved.session_end` undefined despite manifest declaration

#### Fail Example 2
```
Input: manifest { events: { session_end: [...], file_edited: [...] } }, agent "opencode"
Context: generated plugin V1 "event" handler section
Actual Output: a single "event" entry with no type guard, or one guard covering both streams
```
**Why it fails**: teardown and file-edit streams would cross-fire (session_end runs on every file edit or vice versa), or duplicate `"event"` object keys would silently drop one handler at runtime
**Violation specifics**: missing either the `session.deleted` / `file.edited` `===` branch, or two `"event": async ({ event }) => {` entries (duplicate keys — second overwrites first)

### Adversarial Examples

#### Adversarial Example 1
**Attack Vector**: mapping regression — future edit reverts session_end to null
```
Input: session_end-only manifest, agent "opencode"
Context: resolveEvents after a registry refactor
Expected: FAIL
```
**Attack Method**: reintroduce the null mapping (e.g. "cleanup" of unmapped events)
**Detection Strategy**: Pass Example 1 assertion fails immediately

#### Adversarial Example 2
**Attack Vector**: guard collapse — future edit merges the two event subscriptions into one loop without type guards
```
Input: session_end + file_edited manifest, agent "opencode"
Context: generated V2 setup body
Expected: FAIL
```
**Attack Method**: single `ctx.event.subscribe()` loop with no `continue` guards, or two `"event"` object keys in V1 `server()` (second overwrites first)
**Detection Strategy**: single-entry assertion (`guards.length === 1`) plus both `===` branches present — zero, two, or unguarded all fail

#### Adversarial Example 3 (synthetic)
**Attack Vector**: V1-only regression — V2 `setup()` loses the session.deleted loop while V1 keeps working
```
Input: session_end-only manifest, agent "opencode"
Context: generated plugin V2 setup body
Expected: FAIL
```
**Attack Method**: delete the `sessionDeletedRuns` emission block from `buildOpenCodeV2Setup`
**Detection Strategy**: Pass Example 2's V2 assertions (`ctx.event.subscribe` + `session.deleted` in setup) fail; V1 assertions still pass, so a V1-only check would miss it

#### Adversarial Example 4 (synthetic)
**Attack Vector**: timeout loss — session.deleted runner hardcodes a timeout instead of propagating the manifest value
```
Input: manifest { events: { session_end: [{ skill: "team-levelup", timeout: 120 }] } }, agent "opencode"
Context: generated runEvent call for canonical session_end
Expected: FAIL
```
**Attack Method**: emit `runEvent("team-levelup", "session_end", 60, ...)` instead of the manifest's 120
**Detection Strategy**: timeout-preservation assertion (Pass Example extension) fails

#### Adversarial Example 5 (synthetic)
**Attack Vector**: wrong native signal — session_end mapped to `session.idle`
```
Input: session_end-only manifest, agent "opencode"
Context: generated plugin
Expected: FAIL
```
**Attack Method**: map `session_end: "session.idle"` (fires repeatedly per session, not once per teardown)
**Detection Strategy**: exact-match assertion on `"session.deleted"` fails; firing-frequency rationale documented in ADR-479

## Implementation Notes

### Evaluation Method
- **Primary Type**: code-based (node:test assertions on resolver output + generated plugin text)
- **Fallback Method**: none
- **Hybrid Approach**: N/A — deterministic string assertions, no LLM judge needed

### Technical Implementation

#### Code-Based Patterns
**Failure Patterns**:
```regex
resolved\.session_end\s*===\s*undefined
event\.type !== "session\.deleted"  # absent
event\.type !== "file\.edited"  # absent
```

**Success Indicators**:
```regex
nativeEvent:\s*"session\.deleted"
event\.type !== "session\.deleted"
ctx\.event\.subscribe
```

**Implementation Complexity**: low
**Expected Accuracy**: 100%
**Performance**: milliseconds (in-memory generation + string match)

### Error Handling
**API Failures**: N/A (no external API)
**Timeout Strategy**: N/A
**Fallback Behavior**: N/A
**Fail-Safe Mode**: test fails closed (missing artifact = fail)

### Performance Requirements
- **Tier Assignment**: 1
- **SLA Requirement**: runs inside existing `node --test` suite (<2s for file)
- **Parallel Execution**: yes (node:test default)
- **Resource Requirements**: temp dir per case, removed in finally

## Quality Assurance

### Validation Results
**Goldset Accuracy**: TBD% (0/0)
**Pass Example Success**: 100% (2/2 — verified in 2026-10-31 GREEN run)
**Fail Example Success**: 100% (2/2 — verified in 2026-10-31 RED run)
**Adversarial Robustness**: 0% (0/0 — not yet exercised)

### Edge Case Analysis
TBD — session_end combined with session_start (no standalone drainer interaction: session.deleted path emits no drainer, verified by existing standalone-drainer tests covering file_edited only).

### False Positive/Negative Analysis
**False Positives**: 0 cases
**False Negatives**: 0 cases
**Mitigation Strategies**: assertions pin exact guard strings; any generator rewording forces deliberate test update, not silent drift.

## EDD Principle Compliance

### Principle I: Spec-Driven Contracts ✅
- [x] Criterion validates specific specification compliance
- [x] Clear traceability from spec to evaluation logic
- [x] Pass/fail conditions align with requirements

### Principle II: Binary Pass/Fail ✅
- [x] No Likert scales or numerical scoring
- [x] All examples demonstrate clear binary outcomes
- [x] Grader outputs only 1.0 (pass) or 0.0 (fail)

### Principle III: Error Analysis & Pattern Discovery ✅
- [x] Bottom-up discovery from actual failure traces
- [x] Open coding → axial coding methodology applied
- [ ] Theoretical saturation achieved (2 traces — saturation NOT claimed)

### Principle VIII: Close Production Loop ✅
- [x] Failure type correctly classified (specification_failure)
- [x] Appropriate action routing configured
- [x] Clear path from evaluation to resolution

### Principle IX: Test Data as Code ✅
- [x] Examples version-controlled and traceable
- [x] Adversarial scenarios included
- [x] Holdout data properly segregated

## Integration Status

### Goldset Integration
- [x] Criterion accepted into published goldset
- [x] Examples validated and balanced
- [x] Metadata complete and consistent

### Evaluator Implementation
- [x] Grader script generated and tested (tests/events.test.mjs session_end block)
- [x] PromptFoo configuration updated
- [x] Failure routing configured

### CI/CD Integration
- [x] Tier assignment appropriate for SLA
- [x] Pipeline integration tested
- [x] Error handling verified

### Monitoring Setup
- [ ] Metrics collection configured
- [ ] Alerting thresholds set
- [ ] Dashboard integration complete

## Maintenance

### Review Schedule
- **Next Review**: 2026-11-30
- **Review Frequency**: monthly until goldset acceptance
- **Maintenance Owner**: Lior Kanfi

### Update Triggers
- [ ] New failure patterns observed
- [ ] Accuracy degradation detected
- [ ] False positive/negative rate increase
- [ ] Performance regression

### Deprecation Criteria
- [ ] Underlying system behavior changed
- [ ] No failures observed for 6 months
- [ ] Superseded by more comprehensive criterion
- [ ] Cost/benefit analysis suggests removal

---

*This criterion follows EDD principles for systematic evaluation development. All patterns discovered through bottom-up error analysis, not theoretical speculation.*
