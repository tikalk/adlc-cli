<!-- factory-review:step=review run=pr39-b0d330c iter=0 status=completed findings=3 important=2 nits=1 head=b0d330cf3b8ea8c75de297de9ab12db6911c1534 -->

## factory-review — compliance review

**Reviewed revision:** `b0d330cf3b8ea8c75de297de9ab12db6911c1534` · base `8a6316ac26b3856bf158aff15750d4562a2f8150` · merge-base `8a6316ac` (linear)
**Policy:** REVIEW.md — passes: bugs · security · spec-compliance · quality
**Verdict:** 🔴 2 Important · 💬 1 Nit — **not merge-ready** until the Important findings are resolved or explicitly waived. This review is strictly non-approving; a human code-owner approval remains required.

---

### 🔴 Important — security: control characters in record file names reach the approver message unsanitised

**Scenario (reproduced):** a record matching `context.records` whose **file name** carries ESC/control bytes — e.g. `.adlc/drafts/pdr/PDR-901-\x1b[31mRED\x1b[0m.md` — committed on the gated branch, in a checkout with no resolvable web remote (detached HEAD / no upstream — the documented “repo-relative path when nothing was pushed” state).

**Actual:** `renderGateMessage` emits the raw path as the record link:
`Status: draft · .adlc/drafts/pdr/PDR-901-\x1b[31mRED\x1b[0m.md`
Record *fields* (id/title/decision/status) are cleaned; the *path* is not. Reproduced directly against `buildGateManifest`/`renderGateMessage` at this head (record listed as new, ESC byte present in the rendered message JSON).

**Impact:** raw ANSI/control bytes reach (a) `payload.message` on `gate_paused`/`permission_request` → the Slack HITL message, (b) the interactive TTY gate prompt, (c) persisted `state.json` step results and `log.jsonl`. This is the injection class the module documents as sanitised (“…cannot inject ANSI/terminal escapes into the TTY chooser or the HITL message”) and the suite asserts (“raw ESC must not reach the message”) — the invariant holds for fields but not for names.

**Required correction:** sanitise the path in the repo-relative fallback — e.g. `.replace(CONTROL_CHARS, "")` (or `clean(path)`) at `src/workflow/gate-context.mjs:260` (`if (!web) return path;`), and/or defensively at render time (`:175`). The web-URL branch is already safe (`encodeURIComponent`). Add a regression test with a control-character file name.

### 🔴 Important — spec-compliance: `gate-completion` does not render the required “(+ MR link)”

**Violated criterion:** the spec states `gate-completion → .adlc/drafts/chdr/*.md (+ MR link)` in all three artifacts: the accepted ADR-391-amendment-gate-decision-context, the AD v13.7.0 delta, and the execution-harness functional view (§ “Gate Decision Context”); issue #22 repeats it under **Constraints**. The bundled gate renders the ChDR manifest only; the static message text mentions the merge request but links nothing.

**Evidence:** no merge-request/pull-request URL source exists anywhere in `src/`; the author disclosed this as N4.

**Impact:** the completion approver cannot reach the MR from the approval message.
**Resolution options:** (a) provide a link source and render it, or (b) explicitly narrow the spec (ADR/issue note) — the amendment’s “engine builds from git only, no forge integration” constraint and “(+ MR link)” are in tension, so (b) may be the honest fix. Per REVIEW.md a spec deviation blocks until resolved or waived; this needs an explicit owner decision.

### 💬 Nit — decision-line extraction splits on abbreviations

`firstSentence` (`src/workflow/gate-context.mjs:367`) ends at the first `[.!?]` followed by whitespace, so a decision line like `Use K8s e.g. GKE per region. More.` renders as `Use K8s e.g.` — cosmetic; the ADR only requires tolerant first-sentence extraction.

---

### Verified — no finding

- **Integrity fixes hold.** Independent read at this exact head plus the reproduced tests: (I1) an approval binds the shown manifest — HEAD-move re-pauses with a fresh list and the consumed verdict is cleared; (I2) stale local `main` no longer pulls merged drafts back (`merge-base --independent` selection); (I3) runs on the target branch fall back to the run-start HEAD. `approved_sha` chaining and the `gate_approved` audit copy verified in `engine.mjs`.
- **No-context parity.** Gates without `context` keep identical message, event shape, `step_results`, state and log output (code path + parity test).
- **Security posture (pass).** All git via `spawnSync` argument arrays; rendering bounded to `context.records` paths and whitelisted fields (≤10 items, 300-char field cap); remote-URL userinfo/token stripping; glob confinement via `:(glob)` pathspecs — no path escape found.
- **Tests reproduced.** `node --test`: **425/425 pass, 0 fail** · `npm test` (incl. e2e) PASS on Node v22.23.3 · new gate-context suites 41/41.
- **Issue #22 criteria.** #1–#7 covered by the reproduced suites · #8 verified here: agentic-container hitl-bridge + workflow adapter suites pass unchanged (6/6, 11/11 @ `951b857`) and the relay contract review shows the manifest is additive · #9 (live Slack drill) still pending — disclosed, blocked by O1.

### Notes

- Disclosed pre-existing issue O1 (shared `verdict_input` auto-approving later factory gates): **Outside ticket scope — human opt-in required**; tracked separately, consistent with the PR description.
- Author-disclosed nits concurred: “Decision list unavailable” when no target branch exists; `run_start_sha` edge for context added mid-run; a no-record HEAD move re-pausing (intended per the ADR’s approval-binding rule).
- This verdict certifies exactly `b0d330cf`; any fix push invalidates it and requires a full re-review. Reviewed from a detached checkout of the head SHA (ADR-335); no source edits.

**Run:** pr39-b0d330c · **Target:** tikalk/adlc-cli#39
