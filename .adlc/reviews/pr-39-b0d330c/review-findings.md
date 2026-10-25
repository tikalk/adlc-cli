# factory-review scratchpad — PR tikalk/adlc-cli#39

Run: pr39-b0d330c · Date: 2026-10-18 · Mode: single review (no --self-heal)

## Reviewed revision
- head:  b0d330cf3b8ea8c75de297de9ab12db6911c1534 (factory/mission/adlc-workspace-22)
- base:  8a6316ac26b3856bf158aff15750d4562a2f8150 (main)
- merge-base: 8a6316ac (linear; base == merge-base)
- checkout: `.adlc/worktrees/factory-review-b0d330c` (detached, clean; fresh — prior run 1161498 worktree NOT reused)

## Environment / evidence
- node --test: 425/425 pass, 0 fail (Node v22.23.3); npm test e2e PASS; new gate-context suites 41/41
- agentic-container @ 951b857 (clean): hitl-bridge-sink 6/6, workflow adapter suites 11/11 → criterion 8 verified
- Governing specs: ADR-391-amendment-gate-decision-context (origin/main), AD.md v13.7.0 delta,
  execution-harness functional.md L198 + information.md §3.3.4, issue #22 (criteria + constraints)
- Mission bus: converge DONE at 4bf57f7 (superseded by b0d330c); O1 pre-existing, tracked separately

## Findings

### F1 — Important · security
Control chars in record FILE NAMES reach rendered message via repo-relative link fallback.
- Repro (executed): temp repo, branch feature, commit `.adlc/drafts/pdr/PDR-901-<ESC>[31mRED<ESC>[0m.md`;
  buildGateManifest + renderGateMessage at head → message JSON contains \u001b; decisions[].link raw.
- Fields (id/title/decision/status) are cleaned; the path is not. Web-URL branch is safe (encodeURIComponent).
- Sinks: payload.message (gate_paused/permission_request → Slack), TTY prompt, state.json step_results, log.jsonl.
- Violates module's own contract comment + test intent ("raw ESC must not reach the message").
- Fix: `clean(path)` or `.replace(CONTROL_CHARS,"")` in makeLinker fallback (gate-context.mjs:260); regression test.

### F2 — Important · spec-compliance
gate-completion misses "(+ MR link)" (ADR amendment table, AD v13.7.0, functional view L198, issue #22 Constraints).
- No forge/MR source exists in src/ (grep: no merge_request/pull_request/pr_url).
- Author-disclosed as N4. Resolution: implement source OR narrow spec explicitly (owner decision).

### N1 — Nit · quality
firstSentence (gate-context.mjs:367) truncates at abbreviations: "Use K8s e.g. GKE. More." → "Use K8s e.g.".

## Verified (no finding)
- I1/I2/I3 integrity fixes (code read + tests): shown-manifest binding, re-pause on HEAD move + verdict
  consumption, merge-base --independent (stale local main), run-start fallback on target branch
- approved_sha chain + gate_approved audit log (engine.mjs:912-927)
- No-context parity: event shape, state/log identical (engine.mjs:939-946 + parity test)
- Security posture: spawnSync arg arrays only; :(glob) pathspecs; URL userinfo strip; 300-char field cap;
  ≤10 parse cap; only whitelisted fields rendered
- Disclosed nits concurred (unavailable wording, run_start edge, no-record HEAD move = intended)
- O1: pre-existing, out of scope (label: Outside ticket scope — human opt-in required)

## Verdict
2 Important, 1 Nit → not merge-ready until resolved or explicitly waived. No approval, no merge.
Label: `validation` per skill §2.6 (flagging description caveat to user in preview).
