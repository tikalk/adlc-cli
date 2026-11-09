# Changelog

## [2.12.1] - 2026-11-09

### Fixed

- **Truncated output before process exit** (#87) — `bin/adlc-cli.mjs` and `bin/adlc-skills-cli.mjs` now flush stdout/stderr before exiting (`process.exit()` drops writes still queued in libuv; stdout to a pipe is asynchronous on POSIX). Previously large output could be silently truncated on platforms with a small pipe buffer (macOS lost the tail of `workflow help` in the v2.12.0 Publish run, failing CI and skipping the npm publish). The standalone hook dispatcher (`src/dispatcher.mjs`) writes injection bodies synchronously for the same reason.

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.12.0] - 2026-11-09

### Added

- **Durable run transport on remote refs** (#82) — run refs sync to `origin` on every state transition (throttled via `ADLC_WORKFLOW_PUSH_INTERVAL`, default 60s, `0` = every transition; exit paths push unconditionally). Pushes go through a throwaway staging copy: the wire is redacted, machine-local files (`lease.json`, `.push-ts`) never leave the host, and the local run dir keeps raw values for resume. Symlinks are never followed into pushed trees.
- **Trace bundle v1** (#83) — every run carries `trace/{manifest,events,artifacts}`: ADR-362 event envelopes with canonical types, a manifest recording run-start and post-step SHAs, and content-addressed artifacts. Fail-closed retention (failed runs keep the full bundle; successful runs degrade to manifest-only unless `ADLC_TRACE_SUCCESS_SAMPLE_RATE` samples the run for full retention). Mid-run event streams stay off the remote until a terminal state.
- **Cross-session e2e verification** (#84) — a repeatable drill in `npm test` driving two separate adlc-cli sessions in two clones of one remote (run → pause → park → restore → resume → completed), asserting transport, redaction, envelope and retention invariants end to end.
- **`workflow board` — factory pane of glass v1** (#85) — one view over all factory runs: local run dirs plus remote `refs/factory-runs/*` fetched namespaced (`refs/remotes/<remote>/…`, never touching local refs), with status, current step, trace outcome/retention, and issue ref. `--format json` emits the machine contract for the future dashboard; degrades to a local-only board (warning, exit 0) when the remote is unreachable.

### Security

- **Command injection via `--remote` in `workflow board`** (#85) — remote names are validated by the same `checkRemote` guard as park/restore before reaching `git fetch`; the inline `--remote=--upload-pack=<cmd>` attack form is rejected with a usage error (exit 1).

## [2.11.0] - 2026-11-07

### Added

- **Agent-agnostic collapsed-Markdown format guard** (#80) — deterministic
  detector, reflow, and `format check` / `format fix` CLI for collapsed
  single-line Markdown in agent artifacts. Agent run streams guarded live
  (`stream-guard`), transcript audit (`audit.mjs`) flags violations, and CI
  enforces artifact formatting with LF-pinned fixtures for Windows.

## [2.10.0] - 2026-11-05

### Added

- **Stale-context refresh on session start** (#77) — `session_start` handlers
  re-run boot on cache hits and replace the exact previously injected text by
  identity, so fresh counts land in place instead of stale caches or duplicated
  blocks. `file.edited` events invalidate the shared session_start cache in
  both V1 and V2 paths, and unrelated injected content is never touched.

## [2.9.1] - 2026-11-04

### Fixed

- **skills add preserves workspace primary agent** (#74) — `writeAgent`
  first-write-wins: adding skills for a secondary agent no longer silently
  retargets `.adlc/init-options.json` agent.

## [2.9.0] - 2026-11-04

### Added

- **Factory issue-to-PR workflows and per-agent model/mode support** (#72) —
  bundled `factory-autonomous` and `factory-supervised` workflows. Per-agent
  model and mode options for workflows and CLI runs. Support for `codex` run profile.
- **OpenCode session_end evaluation goldset and grader** (#68) — published
  EVAL-001 criterion, goldset, and deterministic Tier-1 code-based grader for
  OpenCode `session_end` mapping to `session.deleted` lifecycle events (ADR-479).

## [2.8.0] - 2026-11-03

### Added

- **Declarative workflows + catalog** (#70) — the bundled `factory` workflow
  ships as `workflows/factory/workflow.yml` with a `workflows/catalog.json`
  index (published in the package). `WorkflowEngine.loadWorkflow` resolves a
  source in order: https URL → local `.yml`/`.yaml` path → installed
  (`.adlc/workflows/<id>/workflow.yml`) → bundled catalog. New commands:
  `adlc-cli workflow search [query]`, `adlc-cli workflow add <id|url> [--as <name>]`
  (writes the workflow and records it in `.adlc/workflows/workflow-registry.json`,
  symlinked registries refused, atomic replace), and `adlc-cli workflow list`.

### Changed

- `loadWorkflow` is now async for every source; internal callers await it.
  `src/workflow/builtins.mjs` is removed (the factory definition is the YAML
  asset above; no compatibility shim).

### Security

- Remote workflows (which carry `run:` shell steps) require `https:`; plain
  `http:` is accepted only for loopback hosts. Redirects are followed manually
  — every hop is re-validated, capped at 5 hops, under one 30 s deadline and
  the 5 MB size limit.

### Fixed

- `.gitattributes` forces LF on workflow YAML so Windows checkouts and tests
  match the bundled definition byte-for-byte.

## [2.7.0] - 2026-10-31

### Added

- **`team setup --directives <url> / --format` + deterministic wire** (#65) —
  `--directives` accepts https URLs (clone-then-wire), `--format` is parsed
  with a non-TTY fail-loud guard, credentialed-clone hygiene, stale-dest
  guard, and POSIX/Windows/macOS tmpdir handling. `team setup`/`team update`
  chain the MCP install for the configured agent.

### Fixed

- **OpenCode `session_end` delivery via `session.deleted`** (#66) —
  `resolveEvents()` no longer drops the canonical `session_end` for OpenCode;
  it maps to the native `session.deleted` lifecycle event with fire-and-forget
  dispatcher side-effect runners in both plugin entrypoints (V1 generic
  `event` handler + V2 `ctx.event.subscribe()` loop). `session.deleted` and
  `file.edited` type-guard their own native types so the streams never mix.
  Teardown output is scripts-only (no context-injection target post-session).

## [2.6.0] - 2026-10-29

### Added

- **`adlc-cli mcp install [DIR] --agent NAME`** — materialise the project's
  `.mcp.json` into each named agent's own MCP config (`claude-code`,
  `opencode`, `codex`, `cursor`; `claude-code` is a no-op — the standard is
  its file). A name in `.mcp.json` is tool-owned and regenerated on each run;
  the off switch is `disabled: true` in `.mcp.json`, which the tool never
  rewrites. Exit 0 only when every named agent is configured; refusals and
  target-level errors fail the run with exit 1, and an entry that cannot be
  fully expressed is never half-written. A copy-once gap report prints drift
  against the team's `.mcp.json` as warnings on stderr, never changing the
  exit code. JSON targets are normalised to 2-space indent on first write.
  `team setup` and `team update` now chain the install for the configured
  agent (before the agent session and the repair pass respectively); the
  chained run behaves exactly like the standalone command — gap report
  included — and an MCP failure aborts the team command with exit 1.
  Note: an `init-options.json` that records no agent now fails `team update`
  loudly at the chained install (previously such a hand-maintained file
  completed); run `adlc-cli team setup` or pass `-a` to record the agent.
  This also fixes `team update` exiting 1 after a successful repair: the
  repair script's exit status is now honoured (`0` was coerced to `1`).

## [2.5.0] - 2026-10-28

### Added

- **Provider transport interface + coder adapter.** `workspace setup`,
  `agent run`, and `workflow run` accept `--provider coder` and route through
  a run-level transport (ADR-443); the live SSH transport is the default, a
  mock is opt-in for offline tests (`ADLC_CODER_MOCK=1` or an injected
  transport). Commands that ask for a remote workspace never silently fall
  back to a mock or a local run. ([#47], `ee19788`)
- **Remote `workspace setup`**: validates the workspace file, resolves and
  normalizes the name, provisions or reuses the workspace via the persisted
  `.adlc/workspaces/<name>.json` handle, and runs the local setup contract
  on the remote. A remote `--dry-run` is refused before any provision/exec —
  it must not create a workspace just to preview it. ([#47], `ee19788`)
- **Remote `agent run`**: forwards the agent task plus the full local argv
  (`-a`, `--model`, `--format`, `--cwd`, `--timeout`,
  `--require-approval`), reconstructing argv from base64 entries so values
  with spaces, leading dashes, or newlines stay one argument. The stdin task
  form still works. ([#47], `ee19788`)
- **Remote `workflow run`**: forwards `--input` values (base64-encoded per
  key=value pair, decoded into a single argv element) with the workspace,
  provider, and resume path intact. ([#47], `ee19788`)

### Security

- **The provider surface keeps the workspace file location-free** (a
  `provider:` key is rejected), expands `${VAR}` references fail-fast
  naming the missing variable, refuses to silently provision a second
  workspace for one target, carries the hop guard across the transport
  boundary, and streams redacted remote output. ([#47], `ee19788`)

## [2.4.3] - 2026-10-25

### Fixed

- **The factory workflow's `execute` step runs the run's issue.** It ran a
  bare `/factory-mission`: the skill had no mission, asked for one and
  returned 0, and the step counted as completed with no code written. It now
  passes `--issue {{ inputs.issue_ref }}`. ([#59], `73317d4`)
- **`gate-completion` links the code MR.** Its link was `{{ inputs.mr_url }}`,
  which nothing set; it is now the `mr_url` the `execute` step reports
  (ADR-444 step output), with the input as the fallback. ([#59], `73317d4`)

## [2.4.2] - 2026-10-25

### Fixed

- **The factory workflow checks out the intent run branch itself.** A
  `run-branch` shell step runs before each intent stage (`run-branch` first,
  `run-branch-architecture` after `gate-product`, so a resumed or restored
  run is back on the branch), and the publish steps run `run-branch` before
  `open-mr`. An intent step that changed nothing used to leave the workspace
  on `main`, `open-mr` refused it, and the run failed before the gate.
  Missing helpers are skipped and reported as `skipped` in the step output.
  (ADR-431-amendment §1/§3a, [#57], `eadc411`, `e5e5454`)
- **A failed shell step's error includes the tail of its stderr**, so the
  reason reaches logs and notifiers, not only the step result. ([#57],
  `eadc411`)

### Security

- **Credentials are redacted from shell step output before it is stored.**
  stdout, stderr, step-output values and the error are masked before they
  enter the step result, so `state.json` (pushed to `refs/factory-runs/<run_id>`
  when a run parks) and the pod log/Slack hold no raw token. Masked: URL
  userinfo, `Authorization`/`PRIVATE-TOKEN`/`x-api-key` values (to the end of
  the line, keeping only a known scheme), GitLab/GitHub/Slack/`sk-` token
  formats, JWTs, and the values of secret-named env vars. ([#57], `497f97f`,
  `e5e5454`, `6919534`, `18847c6`, `e66464d`)

## [2.4.1] - 2026-10-25

> Supersedes the `2.4.0` version bump, which landed on `main` via [#53] but was
> never tagged or published to npm. This is the first release to carry the
> terminal UI layer.

### Added

- **Terminal UI layer** — zero-dependency terminal rendering with the specify
  visual language: panels, tables, grids, styled writers, colour-mode
  detection, and correct width handling for CJK/wide glyphs. ([#52], `c5fd5a5`)
- **Run context for agent steps** — agent steps receive a run context and may
  return structured output; `ADLC_STEP_OUTPUT` is now only set for path-safe
  run and step ids. (ADR-444, `9764c76`, `e0dbab5`)
- **The factory workflow publishes its intent MR** — shell steps get the run
  context, and `issue_ref` is declared and dispatched. ([#46], `96c2086`,
  `156c980`)

### Fixed

- **`workflow state advance` no longer crashes on its own validation paths.**
  Bad arguments produced `Error: Cannot access 'error' before initialization`
  instead of the usage hint, because a local `const error` shadowed the ui
  writer in the same block. Renamed to `errorFlag`; both validation branches
  now print their intended hint on stderr with exit 1. ([#54], `ae4a117`)
- **ANSI injection in the grid table branch**, plus three review findings.
  ([#52], `0144c98`)
- **Writer-shadowing and writer-sanitisation holes** found by the second
  review of the UI layer. ([#52], `46383b0`)

### Changed

- Removed the unreferenced `src/commands/skill.mjs`. ([#52], `84215f1`)

### Testing

- Workspace skill scripts are vendored so the E2E suite is hermetic, and E2E
  now checks the `.adlc` layout after agent-led workspace init. ([#50],
  `20b9f16`, `76e73c3`, `28f9e70`)
- Regression coverage for the shadowing defect: end-to-end tests for the
  usage hint and the `--status` branch (asserting exit code and stream, not
  just substrings), plus a scan of every command module for bindings named
  after a ui writer it also calls. The scan reads URLs rather than pathname
  strings so it also runs on Windows. ([#54], `6f6cb99`, `5580c07`)

[#50]: https://github.com/tikalk/adlc-cli/pull/50
[#52]: https://github.com/tikalk/adlc-cli/pull/52
[#53]: https://github.com/tikalk/adlc-cli/pull/53
[#54]: https://github.com/tikalk/adlc-cli/pull/54
[#46]: https://github.com/tikalk/adlc-cli/pull/46
[#47]: https://github.com/tikalk/adlc-cli/pull/47
[#57]: https://github.com/tikalk/adlc-cli/pull/57
[#59]: https://github.com/tikalk/adlc-cli/pull/59
