# adlc-cli

A dual-mode CLI for coding agents: **skill management** (install skills, generate slash commands, wire lifecycle event hooks) + **agent execution** (run any coding agent headlessly with a task — the invocation layer the [Agentic Container](https://github.com/tikalk/agentic-container) delegates to).

> **Renamed from** `adlc-skills-cli` in v1.0.0. The old command surface still works via the deprecated `adlc-skills-cli` alias bin + npm shim during 1.x.

Works with any skills repo: [adlc-team-skills](https://github.com/tikalk/adlc-team-skills), [mattpocock/skills](https://github.com/mattpocock/skills), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), [obra/superpowers](https://github.com/obra/superpowers), or your own.

## Quickstart

```bash
# Install skills + generate commands + wire events
npx adlc-cli skills add tikalk/adlc-team-skills -a opencode

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
| `skill add <source> -a <agent>` | Install skills via `npx skills add` + generate commands + wire events |
| `skills update [-a <agent>]` | Re-generate commands from installed skills; `--pull` re-installs from source |
| `skills remove [-a <agent>]` | Remove generated commands + event configs; cleans dispatcher + `.events.json` |
| `skills [-a <agent>]` | Show what's installed per agent + dispatcher + event status |

### Agent execution

| Command | Description |
|---------|-------------|
| `agent run "<task>" [flags]` | Run a coding agent headlessly with a task |
| `agent list` | List supported agents, command formats, event support, and run profiles |

### Top-level

| Command | Description |
|---------|-------------|
| `version` | Print installed version |
| `help` | Show full help |

## `agent run` flags

| Flag | Description |
|------|-------------|
| `-a <agent>` | Agent: `opencode` \| `claude-code` \| `goose` \| `gemini` (default: `opencode`) |
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
        .opencode/plugin/adlc-skills-events.ts        agent-native hook config
```

## Skill flags

| Flag | Description |
|------|-------------|
| `-a <agent>` | Target agent (repeatable). Run `agent list` to list. |
| `-g, --global` | Install to user directory instead of project |
| `--no-events` | Skip event config generation |
| `--prefix <str>` | Namespace command filenames (e.g., `adlc.team-setup.md`) |
| `--mode <mode>` | `inline` (embeds full skill body) or `wrapper` (references skill by name) |
| `--skill, -s <name>` | Install/generate for one skill only (use `'*'` for all) |
| `--copy` | Copy files instead of symlinking (passthrough to `npx skills`) |
| `-y, --yes` | Skip confirmation prompts |

## Supported agents

24 agents across 3 command formats. 9 agents support event hooks. 4 agents support `agent run`.

| Agent | Commands dir | Format | Events | Run |
|-------|-------------|--------|--------|-----|
| opencode | `.opencode/commands/` | markdown | yes | yes |
| claude-code | `.claude/commands/` | markdown | yes | yes |
| goose | `.goose/recipes/` | yaml | no | yes |
| gemini | `.gemini/commands/` | toml | yes | yes |
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

## Install

```bash
# One-off (no install needed)
npx adlc-cli skills add tikalk/adlc-team-skills -a opencode

# Install as global binary
npm install -g adlc-cli
adlc-cli skills add tikalk/adlc-team-skills -a opencode
```

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

### 7 canonical events

| Event | Fires when | Body path? | Script path? |
|-------|-----------|-----------|-------------|
| `session_start` | Agent session begins | yes | yes |
| `session_compact` | Harness compacts history | yes | yes |
| `user_prompt_submit` | User sends a prompt | yes | yes |
| `pre_tool_use` | Before a tool call | no | yes |
| `post_tool_use` | After a tool call | no | yes |
| `session_end` | Session ends | no | yes |
| `stop` | Agent stops | no | yes |

### Per-agent native hook configuration

| Agent | Config file | Format | Timeout unit |
|-------|------------|--------|-------------|
| opencode | `.opencode/plugin/adlc-skills-events.ts` | TS plugin | seconds |
| claude-code | `.claude/settings.json` (merged) | JSON nested | seconds |
| cursor | `.cursor/hooks.json` (merged) | JSON nested | seconds |
| github-copilot | `.github/hooks/adlc-skills.json` | JSON | seconds |
| codex | `.codex/config.toml` (merged) | TOML | seconds |
| gemini | `.gemini/settings.json` (merged) | JSON nested | milliseconds |
| qwen-code | `.qwen/settings.json` (merged) | JSON nested | milliseconds |
| devin | `.devin/hooks.v1.json` (merged) | JSON root-nested | seconds |
| tabnine | `.tabnine/agent/settings.json` (merged) | JSON nested | milliseconds |

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

## Development

```bash
# Run tests
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
