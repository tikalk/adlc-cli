# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
