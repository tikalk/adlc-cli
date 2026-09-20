# `.events.json` Schema

A `.events.json` file at the root of a skills repo declares which skills should auto-trigger on agent lifecycle events. When `adlc-skills-cli add` installs skills from a repo, it reads this manifest and generates per-agent native hook configurations.

Repos without `.events.json` are handled gracefully — commands are generated, events are skipped silently.

## Schema

```json
{
  "events": {
    "<canonical_event>": [
      {
        "skill": "<skill-name>",
        "description": "<human-readable description>",
        "timeout": <seconds, default 60>,
        "matcher": "<tool-name regex, for tool events>"
      }
    ]
  }
}
```

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `skill` | yes | string | Skill name (must match `SKILL.md` frontmatter `name`) |
| `description` | no | string | Human-readable description of what the event does |
| `timeout` | no | number | Timeout in seconds (converted to ms for gemini/qwen/tabnine). Default: 60 |
| `matcher` | no | string | Tool-name regex for `pre_tool_use`/`post_tool_use` events. Default: `*` (all tools) |

### Canonical events

| Event | Fires when | Payload (stdin) | Body path |
|-------|-----------|-----------------|-----------|
| `session_start` | Agent session begins | `{}` | yes |
| `session_compact` | Harness compacts/summarizes history (post-compaction re-injection) | `{}` | yes |
| `user_prompt_submit` | User sends a prompt | `{ "prompt": "..." }` | yes |
| `pre_tool_use` | Before a tool call | `{ "tool": "...", "args": {} }` | no (script only) |
| `post_tool_use` | After a tool call | `{ "tool": "...", "result": {} }` | no (script only) |
| `session_end` | Session ends | `{}` | no (script only) |
| `stop` | Agent stops | `{}` | no (script only) |

## Example: adlc-team-skills

```json
{
  "events": {
    "session_start": [
      {
        "skill": "team-boot",
        "description": "Bootstrap session with team constitution and PDR/ADR context",
        "timeout": 60
      }
    ],
    "user_prompt_submit": [
      {
        "skill": "team-discover",
        "description": "Fetch relevant personas, rules, PDRs, and ADRs for the current prompt",
        "timeout": 30
      }
    ]
  }
}
```

## Example: multiple skills per event

```json
{
  "events": {
    "session_start": [
      { "skill": "using-superpowers", "description": "Load skill orientation" },
      { "skill": "team-boot", "description": "Load team context" }
    ]
  }
}
```

Each skill gets its own native hook entry — both fire on session start.

## Example: tool events with matchers

```json
{
  "events": {
    "pre_tool_use": [
      { "skill": "audit-write", "matcher": "write|edit", "timeout": 10 },
      { "skill": "audit-bash", "matcher": "bash", "timeout": 10 }
    ]
  }
}
```

## How the dispatcher resolves skills

When a native hook fires, it calls:
```
node .agents/dispatcher.mjs <event> <skill> <skills_dir> <timeout>
```

The dispatcher:
1. Resolves `<skill>` → finds `SKILL.md` in `<skills_dir>` (by directory name or frontmatter `name`)
2. Parses the frontmatter
3. **If `scripts:` present** → runs the script (sh/ps/py variant) with stdin payload → stdout
4. **Else if body-injection event** (`session_start`, `user_prompt_submit`) → outputs the skill body → stdout
5. **Else** → logs "no script" and exits 0 (fail-open)

The stdout is captured by the agent's native hook and injected as session context.

## Adding `.events.json` to your skills repo

1. Create `.events.json` at the repo root
2. Declare events mapping to skill names (skills must exist in the repo's `skills/` directory)
3. Optionally add `scripts:` blocks to skills that need deterministic execution
4. When users run `adlc-skills-cli add <your-repo> -a <agent>`, events are auto-wired
