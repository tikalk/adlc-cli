# adlc-cli

The CLI layer of the ADLC toolchain for coding agents: **skill management**
(install skills, generate slash commands, wire lifecycle event hooks),
**team directives** (configure and maintain a team-ai-directives repo),
**workspaces** (multi-repo bootstrap), **agent execution** (run any coding
agent headlessly with a task — the invocation layer the
[Agentic Container](https://github.com/tikalk/agentic-container) delegates to),
and a **workflow engine** (a full JS port of the `github/spec-kit` workflow
engine — ADR-390 + amendments).

> **Renamed from** `adlc-skills-cli`. The deprecated `adlc-skills-cli` bin
> still ships (the legacy `add`/`upgrade`/`remove`/`status`/`agents` surface),
> along with the `shim/adlc-skills-cli` npm package forwarding to it.

Works with any skills repo: [adlc-team-skills](https://github.com/tikalk/adlc-team-skills), [mattpocock/skills](https://github.com/mattpocock/skills), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), [obra/superpowers](https://github.com/obra/superpowers), or your own.

## Quickstart

```bash
# Install skills + generate commands + wire events
npx adlc-cli skills add tikalk/adlc-team-skills -a opencode

# Install skills AND configure team-ai-directives
# (opens the agent's interactive UI on /team-setup when run in a terminal;
#  piped/CI runs fall back to a headless one-shot run)
npx adlc-cli team setup tikalk/adlc-team-skills -a opencode

# Works with any skills repo — events auto-skip if no .events.json
npx adlc-cli skills add mattpocock/skills -a claude-code --no-events
npx adlc-cli skills add addyosmani/agent-skills -a opencode -a cursor

# Run a coding agent headlessly with a task
npx adlc-cli agent run "Fix the failing auth test" -a opencode

# List supported agents + run profiles
npx adlc-cli agent list

# Print version
npx adlc-cli version
```

## Commands

### Skill management

| Command | Description |
|---------|-------------|
| `skills add <source> -a <agent>` | Install skills via `npx skills add` + generate commands + wire events |
| `skills update [-a <agent>]` | Re-generate commands from installed skills; `--pull` re-installs from source |
| `skills remove [-a <agent>]` | Remove generated commands + event configs; cleans dispatcher + `.events.json` |
| `skills [-a <agent>]` | Show what's installed per agent + dispatcher + event status |

### Team directives

| Command | Description |
|----------|-------------|
| `team setup <source> -a <agent>` | Install skills + write `.adlc/init-options.json` + run `/team-setup` (interactive UI on a TTY, headless in CI/pipes; `--skip-skills` to skip installation) |
| `team update` | `git pull` the team-ai-directives repo + re-install skills from source + `team repair --update-confidence` |
| `team repair [--update-confidence\|--validate-drafts\|--build-to-delete]` | Run `/team-repair` headlessly (agent-driven), or the deterministic `setup-team.sh` path for `--update-confidence` / `--validate-drafts` |

The `team` tree reads its targets from `.adlc/init-options.json` (see below);
`-a` defaults to the configured agent.

### Workspace

| Command | Description |
|----------|-------------|
| `workspace setup [file]` | Apply a workspace file: clone `git:` modules, create `dirs:`, install skills, generate commands, run `/workspace --init`, and (first boot only) hand the agent the workspace `goal` |
| `workspace init [--link\|--ignore-only]` | Run `/workspace --init` headlessly (`.adlc/` structure, discover/link child repos) |
| `workspace status` | Run `/workspace --status` headlessly (audit branch, dirty, unpushed, SHA drift) |

Workspace file resolution: explicit argument → `ADLC_WORKSPACE_FILE` env →
`.adlc/workspace.yml`. Schema requires `schema_version` plus any of
`workspace.git[]` (repo/path/branch/ref), `workspace.dirs[]`, `workspace.init`,
`workspace.link`, `skills.sources[]`, `commands[]`, `goal`. Deterministic
steps (git, dirs) run directly; agent-led steps go through `agent run`.
`--dry-run` prints the plan without executing on the local path. The remote
provider path refuses `--dry-run` rather than provisioning a workspace just to
preview it.

### Provider transport (remote workspaces)

`workspace setup`, `agent run`, `workflow run`, and `workflow resume` accept
`--provider coder` to run the work on a remote workspace over the SSH-based
provider transport.

```bash
# provision (or reuse) a remote workspace from the repo's workspace file.
# The repo's .adlc/workspace.yml declares the per-run values it needs; every
# ${VAR} it references must be supplied, or setup fails fast naming it:
#   WORKSPACE_NAME  the workspace name  (e.g. repo-mission-42)
#   BRANCH          the branch to clone
WORKSPACE_NAME=repo-mission-42 BRANCH=main adlc-cli workspace setup --provider coder

# run a step on that workspace
adlc-cli workflow run factory --input run_id=r-7 --provider coder --workspace repo-mission-42
```

| Flag | Meaning |
|------|---------|
| `--provider coder` | Route through the provider transport (SSH) instead of running locally. An unknown value is **refused** (never silently run locally) |
| `--workspace <name>` | Target workspace. `workspace setup` uses the workspace file's name (a conflicting `--workspace` is refused); `agent run` / `workflow run` reuse the handle persisted at `.adlc/workspaces/<name>.json`. Without `--workspace`, they use the workspace file's name and **refuse to provision a second machine** when no handle exists; an explicit `--workspace <name>` targets that workspace and provisions it if no handle exists |

Contract:

- **Location-free workspace files** — a `provider:` key (at any level) inside a workspace file is **rejected**, never ignored; the provider is selected only by the flag.
- **`${VAR}` expansion, fail-fast** — a missing or empty variable fails with its name. Process-env values expand in place; values sourced from `secrets.env`/Docker secrets are never inlined into the config — they travel only in the transport's `vars` channel, referenced-only. A secret-sourced variable may not *name* a workspace (it would leak into the handle filename).
- **Secrets env-only on the wire** — `secrets.env` (gitignored) → Docker secrets → process env. Referenced values are forwarded to the remote; the outbound stream is scrubbed (referenced secret values, `--input` values and the task text never reach the terminal verbatim). On the remote, `workspace setup` deliberately persists the referenced vars at `$HOME/.adlc/secrets.env` (mode 0600 before the write; the step fails closed if the mode cannot be enforced) so the developer's later session inherits them; that is at-rest storage on a developer-owned workspace, not an env-only-at-rest claim.
- **Flag fidelity** — the provider route forwards `agent run` flags (`-a`, `--model`, `--format`, `--cwd`, `--timeout`, `--require-approval`), `workflow run` execution flags (`--format`, `--headless`), and `workflow resume`'s `--format`; `--input` values remain in their base64-safe channel. A remote `workspace setup` also receives the operator's `-a` selection.
- **Recursion guard** — at most 2 hops (`ADLC_HOP_DEPTH`); a malformed, negative or whitespace depth fails closed.
- **Transport timeout** — remote SSH transport has a default 15-minute cap (`ADLC_TRANSPORT_TIMEOUT_MS` in milliseconds); set a higher value for long-running workflows.
- **Loud failure** — a remote non-zero exit (its code is propagated), a corrupt handle, a missing handle, an invalid workspace file, or a transport that returns no result exits non-zero with the remote's stderr. There is no silent fallback.

The live SSH transport is the default: `--provider coder` provisions or reuses a real Coder workspace and runs the step over `coder ssh`. The mock transport is opt-in for offline contract tests via `ADLC_CODER_MOCK=1` (or an injected `globalThis.__ADLC_CODER_TRANSPORT__`); there is no `--live` flag and `ADLC_CODER_LIVE` is not read. The default is deliberate: a command that asks for a remote workspace must never silently get a mock.

### Agent execution

| Command | Description |
|----------|-------------|
| `agent run "<task>" [flags]` | Run a coding agent headlessly with a task |
| `agent list` | List supported agents, command formats, event support, and run profiles |
| `run "<task>" [flags]` | Top-level alias for `agent run` (runtime contract, ADR-368) |

### Workflows

| Command | Description |
|----------|-------------|
| `workflow run <source>` | Execute a workflow — YAML path, installed ID, or built-in (`factory` = the outer loop) |
| `workflow resume <run_id>` | Resume a paused/failed run; gates re-prompt (or bind a `verdict_input` via `--input`) |
| `workflow status [run_id]` | List runs / show one run's step states |
| `workflow validate <source>` | Validate a definition; `--headless` requires gates to declare `verdict_input` |
| `workflow state …` | LLM-executor helpers: `start/advance/pause/fail/show` (ADR-395) |

Full JS port of the upstream `github/spec-kit` workflow engine (zero Python —
ADR-390 + amendments). **Dual-executor architecture (ADR-395):** the same
`workflow.yml` + `state.json` run either in-session (skills via the `state`
helpers) or headless (the CLI engine) — a run parked at a gate by one
executor resumes on the other. Step types: `command`, `prompt`, `shell`,
`gate`, `if`, `switch`, `while`, `do-while`, `fan-out` (with
`max_concurrency`), `fan-in`, `slot`.

```
.adlc/workflows/<id>/workflow.yml      installed · curated definitions
.adlc/workflows/<run_id>/workflow.yml  generated-by-slug definitions (ADR-391-amendment)
.adlc/workflows/runs/<run_id>/         run state: state.json, inputs.json, log.jsonl,
                                       frozen workflow.yml, lease.json + mission
                                       artifacts (brief.md, mission.yml, scratchpads/…)
refs/factory-runs/<run_id>             git-refs Tier-3 (ADR-393)
```

```bash
# Run → gate pauses (non-TTY) → resume headlessly
adlc-cli workflow run mission --input spec="Fix auth"
adlc-cli workflow resume <run_id> --input verdict=approve

# The bundled outer loop (stages = command steps + gates)
adlc-cli workflow run factory --input verdict=approve

# CI: JSONL lifecycle events (run_started/step_*/gate_paused/…/run_completed)
adlc-cli workflow run factory --format json

# LLM executor drives state via helpers (set ADLC_WORKFLOW_SESSION per session)
export ADLC_WORKFLOW_SESSION=my-session
adlc-cli workflow state start --workflow mission --input spec="Fix auth"
adlc-cli workflow state advance <run_id> --step specify --status completed
adlc-cli workflow state pause <run_id> --step review      # gate → human
```

**Environment variables:**

| Variable | Meaning |
|----------|---------|
| `ADLC_WORKFLOW_SESSION` | Session id — makes the run lease persist across sequential CLI invocations instead of per-command |
| `ADLC_WORKFLOW_RUN_ID` | Set for step processes so nested commands address their own run |
| `ADLC_WORKFLOW_LEASE_TTL` | Lease TTL in seconds (default 900) |
| `ADLC_WORKSPACE_FILE` | Workspace file path override for `workspace setup` |

SIGINT/SIGTERM trigger a clean pause (resumable) rather than a corrupt
partial state.

Known constraint (inherited upstream): a gate nested inside
`if`/`switch`/`while` bodies that pauses will re-run the parent control-flow
step and its nested body on resume. Keep gates at the top level, or bind a
`verdict_input` on the gate.

**Agent-step run context and output (ADR-444).** `command` and `prompt` steps
run the agent with these environment variables:

- `ADLC_RUN_ID` and `ADLC_STEP_ID`.
- `ADLC_STEP_OUTPUT`, the path `.adlc/workflows/runs/<run_id>/steps/<step_id>.output.json`. Any leftover file there is deleted before the step starts.
- `ADLC_ISSUE_REF`, only when the run has an `issue_ref` input.

A step can return a few named strings by writing a JSON object to
`ADLC_STEP_OUTPUT`. The rules:

- At most 16 fields.
- Keys must match `^[a-z][a-z0-9_]{0,39}$`.
- Values must be strings of at most 2048 characters.
- No reserved keys (`stdout`, `exit_code`, …).

After a successful exit, these fields are merged into the step output, so a
later step or gate can read them, for example
`context.link: "{{ steps.intent-product.output.mr_url }}"`. If any field breaks
a rule, the file is ignored with a log line. Stdout is never parsed for
results.

### Top-level

| Command | Description |
|---------|-------------|
| `version` | Print installed version |
| `help` | Show full help |

## Terminal output

Human-facing output uses a shared UI layer (`src/ui/`) with the same visual
language as the `specify` CLI: a cyan accent, bordered panels, aligned tables
and a step tree for workflow runs. The package stays **dependency-free** — the
layer is hand-rolled, so `npx adlc-cli` installs instantly and the npm
provenance surface is unchanged.

```
▸ OpenCode (opencode)
  → npx --yes skills@latest add tikalk/adlc-team-skills -a opencode
  ✓ Found 12 skill(s) in .agents/skills
  ✓ Generated 12 command file(s) in .opencode/command
```

### Color control

| Mechanism | Effect |
|-----------|--------|
| TTY detection | Color is on automatically in a terminal, off when piped |
| `NO_COLOR=1` | Disables color (any value; [no-color.org](https://no-color.org)) |
| `FORCE_COLOR=1` | Forces color on, even when piped |
| `--color` | Forces color on for this invocation |
| `--no-color` | Disables color for this invocation |
| `--format json` | **Always** disables color — the JSONL stream is a machine contract (ADR-406) |

The `workflow state` helper family is also always unstyled: it is the
LLM-executor's machine API (ADR-395).

### Untrusted output is sanitized

Repo URLs, step labels, agent names and file contents are stripped of control
characters before they are printed, so a hostile value cannot inject ANSI
sequences or rewrite the terminal.

## `.adlc/init-options.json`

Written by `team setup` (and by the `/team-setup` skill), read by the `team`
and `workspace` trees to resolve defaults:

```json
{
  "agent": "opencode",
  "skills_source": "tikalk/adlc-team-skills",
  "team_ai_directives": "./tikal-team-ai-directives"
}
```

`agent` and `skills_source` default every later `-a` / re-install;
`team_ai_directives` is where `team update` pulls and `team repair` indexes.

## `agent run` flags

| Flag | Description |
|------|-------------|
| `-a <agent>` | Run profile: `opencode` \| `claude-code` \| `goose` \| `gemini` (default: `opencode`) |
| `--model <id>` | Model id passed to the agent CLI (optional — agent picks its own if absent) |
| `--format <fmt>` | Output: `text` (default, human-readable) \| `json` (normalized JSONL for container/CI) |
| `--cwd <path>` | Working directory (default: current directory) |
| `--timeout <s>` | Kill agent after N seconds (CI safety) |
| `--require-approval <tools>` | Comma-separated tools that pause for human approval (e.g., `Bash,Write`) |
| `-` | Read the task from stdin |

### `agent run` examples

```bash
# One-shot run (text output)
adlc-cli agent run "Fix the failing auth test" -a opencode

# JSON output (normalized JSONL — what the Agentic Container consumes)
adlc-cli agent run "echo hello" -a opencode --format json

# Read task from stdin
cat brief.md | adlc-cli agent run - --format json

# Run in a specific workspace with a timeout
adlc-cli agent run "refactor utils" -a opencode --cwd ./my-project --timeout 120

# Require approval for dangerous tools (HITL)
adlc-cli agent run "deploy to staging" -a opencode --require-approval Bash,Write
```

### Normalized JSONL event vocabulary

`agent run --format json` emits one JSON object per line:

| Type | Payload | Meaning |
|------|---------|---------|
| `message` | `{text}` | Agent text output |
| `tool` | `{phase: "call"\|"result", name?, arguments?, result?}` | Tool invocation or result |
| `permission_request` | `{tool, request_id}` | HITL permission gate |
| `error` | `{message}` | Error |
| `complete` | `{}` | Agent finished |
| `log` | `{message?}` | Non-structured log line |

## How skill installation works

```
adlc-cli skills add <source> -a <agent>
  │
  ├─ 1. npx skills add <source> -a <npx_agent>     ← installs SKILL.md files
  │
  ├─ 2. Discover installed skills                   ← reads SKILL.md frontmatter
  │
  ├─ 3. Generate command files                      ← slash commands (/name)
  │     .opencode/commands/<name>.md                   inline: embeds skill body
  │                                                    wrapper: references skill
  │
  └─ 4. Wire events (if .events.json in source)     ← lifecycle hooks
        .agents/dispatcher.mjs                        generic dispatcher (shipped)
        .opencode/plugins/adlc-skills-events.ts       agent-native hook config
```

## Skill flags

| Flag | Description |
|------|-------------|
| `-a <agent>` | Target agent (repeatable). Run `agent list` to list. |
| `-g, --global` | Install to user directory instead of project |
| `--no-events` | Skip event config generation |
| `--prefix <str>` | Namespace command filenames (e.g., `adlc.team-setup.md`) |
| `--mode <mode>` | `inline` (embeds full skill body) or `wrapper` (references skill by name) |
| `--skill, -s <name>` | Install/generate for one skill only (use `'*'` for all). The selection is expanded through the source's `.skills-deps.json` closure: borrowers auto-pull their canonical homes (e.g. `--skill architect-implement` also installs `architect-clarify`) |
| `--copy` | Copy files instead of symlinking (passthrough to `npx skills`) |
| `--pull` | (`update`) re-install from the locked source |
| `-y, --yes` | Skip confirmation prompts |

## Supported agents

24 command agents across 3 command formats (plus a `generic` fallback), 9
agents with event hooks, 4 run profiles.

> **Gemini key split (current behavior):** the agent registry key is
> `gemini-cli` (skills/commands/events), but the run profile is keyed
> `gemini`. So: `skills add -a gemini-cli`, but `agent run -a gemini` — and
> `agent list` shows gemini-cli without a run profile. Use the two keys as
> shown.

| Agent | Commands dir | Format | Events | Run |
|-------|-------------|--------|--------|-----|
| opencode (1.x + 2.x hybrid plugin) | `.opencode/commands/` | markdown | yes | yes |
| claude-code | `.claude/commands/` | markdown | yes | yes |
| goose | `.goose/recipes/` | yaml | no | yes |
| gemini-cli | `.gemini/commands/` | toml | yes | `agent run -a gemini` |
| ...and 20 more | | | | |

Run `adlc-cli agent list` for the full table.

## Command generation: two modes

### Inline

Embeds the full `SKILL.md` body in the command file — self-contained, works on any agent:

```markdown
---
description: Clone, scaffold, or configure a team AI directives repository
---

<!-- generated by adlc-cli; source: tikalk/adlc-team-skills — do not edit -->

Base directory for this skill: /project/.agents/skills/team-setup

# Team Setup

[full skill body...]

$ARGUMENTS
```

### Wrapper

Thin command that references the installed skill — requires the agent to have skill support:

```markdown
---
description: Clone, scaffold, or configure a team AI directives repository
---

<!-- generated by adlc-cli; source: tikalk/adlc-team-skills — do not edit -->

Invoke the `team-setup` skill.

<skill summary>

## User Input

$ARGUMENTS
```

The `## User Input` block is generated for **both modes** so the args placeholder is framed as workflow input rather than trailing text.

## User-invoked skills: wrapper vs execution mode

User-invoked skills (`disable-model-invocation: true` in frontmatter) are meant to be triggered explicitly. The command body strategy depends on the agent:

| Mode | Used by | Why |
|------|---------|-----|
| `wrapper` | opencode | Ignores `disable-model-invocation` — skill stays available, model calls `skill({name})` |
| `execution` | claude-code, cursor, copilot, codex | Respects `disable-model-invocation` — skill hidden, body must be inlined |

## Events: lifecycle hooks

For agents with native hook support (9 agents), the CLI wires event hooks that auto-trigger skills at lifecycle points.

Events are **auto-enabled** when:
1. The agent supports events
2. The source repo declares a `.events.json` manifest
3. `--no-events` is not set

### `.events.json` manifest

```json
{
  "events": {
    "session_start": [
      { "skill": "team-boot", "description": "Bootstrap session with team context", "timeout": 60 }
    ],
    "user_prompt_submit": [
      { "skill": "team-discover", "description": "Fetch relevant context", "timeout": 30 }
    ]
  }
}
```

Repos without `.events.json` get commands only — events are skipped silently.

### The dispatcher: two execution paths

A generic dispatcher (`.agents/dispatcher.mjs`) is shipped to the project. When a native hook fires, it calls the dispatcher:

| Path | When | How |
|------|------|-----|
| **Script** | Skill has `scripts:` in frontmatter | Runs the script → stdout |
| **Body** | No `scripts:` block | Outputs the skill's markdown body → stdout |

Both paths feed the **stdout → context injection** pipeline.

### 8 canonical events

| Event | Fires when | Body path? | Script path? |
|-------|-----------|-----------|-------------|
| `session_start` | Agent session begins | yes | yes |
| `session_compact` | Harness compacts history | yes | yes |
| `user_prompt_submit` | User sends prompt | yes | yes |
| `pre_tool_use` | Before tool call | no | yes |
| `post_tool_use` | After tool call | no | yes |
| `file_edited` | A file was edited (e.g. decision drafts) | no | yes |
| `session_end` | Session ends | no | yes |
| `stop` | Agent stops | no | yes |

#### `file_edited` per-agent delivery

| Agent | Native hook | Delivery |
|-------|------------|----------|
| opencode | `file.edited` (generic `event` subscription) | script stdout stashed → injected into the last user message on the next `messages.transform` pass (before the session-start dedup guard) |
| claude-code | `PostToolUse` (+ `matcher` e.g. `Edit\|Write`) | `hookSpecificOutput.additionalContext` — direct context injection |
| codex | `PostToolUse` | envelope suppressed (tool-hook output sink unverified — safe no-op) |
| cursor | `postToolUse` | envelope suppressed (tool-hook output sink unverified — safe no-op) |
| others | — | `null` mapping until a native surface is documented |

Skill scripts see `ADLC_EVENT` in their environment and the event payload on stdin.

### Per-agent native hook configuration

| Agent | Config file | Format | Timeout unit |
|-------|------------|--------|-------------|
| opencode (hybrid: V1 `server()` + V2 `setup()`, requires opencode 1.x >= 1.18.29 or any 2.x; project needs `@opencode/plugin` installed for the generated import) | `.opencode/plugins/adlc-skills-events.ts` | TS plugin | seconds |
| claude-code | `.claude/settings.json` (merged) | JSON nested | seconds |
| cursor | `.cursor/hooks.json` (merged) | JSON nested | seconds |
| github-copilot | `.github/hooks/adlc-skills.json` | JSON | seconds |
| codex | `.codex/config.toml` (merged) | TOML | seconds |
| gemini-cli | `.gemini/settings.json` (merged) | JSON nested | milliseconds |
| qwen-code | `.qwen/settings.json` (merged) | JSON nested | milliseconds |
| devin | `.devin/hooks.v1.json` (merged) | JSON root-nested | seconds |
| tabnine-cli | `.tabnine/agent/settings.json` (merged) | JSON nested | milliseconds |

### Safety patterns (ported from spec-kit)

- **Idempotent merge**: re-install never duplicates hook entries
- **Surgical teardown**: `remove` strips only our entries, preserves user hooks
- **JSONC preservation**: malformed JSON aborts, never resets user content
- **Safe-destination validation**: rejects symlink redirects outside project root
- **Shell-safe argv**: `execFileSync` with argv arrays, no shell injection
- **stdin payload forwarding**: `user_prompt_submit` receives the user's prompt

## Self-describing files

Every generated file includes a `<!-- generated by adlc-cli -->` header. Event hook entries carry a `_adlc_skills_cli: true` marker (JSON) or `adlc_skills_marker = true` (TOML). This enables:
- `remove` to safely delete only our files
- `upgrade` to overwrite our files while skipping user-modified ones

No manifest database or state file needed.

## Install

```bash
# One-off (no install needed)
npx adlc-cli skills add tikalk/adlc-team-skills -a opencode

# Install as global binary
npm install -g adlc-cli
adlc-cli skills add tikalk/adlc-team-skills -a opencode
```

## Development

```bash
# Run tests (300+ tests via node --test)
npm test

# Run the CLI locally
node bin/adlc-cli.mjs help
node bin/adlc-cli.mjs agent list
node bin/adlc-cli.mjs skills -a opencode

# Run a task locally
node bin/adlc-cli.mjs agent run "say hello" -a opencode --format text
```

Zero runtime dependencies. Requires Node.js >= 18.

## License

MIT
