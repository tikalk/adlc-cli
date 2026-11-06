# Format Guard

Long agent outputs sometimes arrive as a single collapsed line: headings,
tables, and the Team Context section lose every newline and render as one
unreadable row.

## Synopsis

```bash
adlc-cli format check [paths...] [--json] [--recursive] [--min-length N]
adlc-cli format fix [paths...] [--write] [--stdout] [--json]
cat draft.md | adlc-cli format check
```

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | clean (`check`) / fixed (`fix`) |
| 1 | collapsed Markdown found (`check`) |
| 2 | usage or I/O error |
| 3 | ambiguous table — `fix` refuses to guess |

## Examples

```bash
# CI gate: fail the build when a transcript artifact collapsed.
adlc-cli format check .adlc/runs/latest.md --json

# Repair a collapsed draft in place.
adlc-cli format fix draft.md --write

# Scan every Markdown artifact under a directory.
adlc-cli format check .adlc/runs --recursive
```

`fix` is deterministic: it re-inserts line breaks at headings, the scope
line, and table rows, and preserves every non-whitespace character and pipe.
A table whose cells cannot be grouped unambiguously is refused with exit 3
and left untouched — the guard never guesses.

## Adapter recipes (thin wrappers around the CLI)

Interactive repair is not portable across agents, so adapters only detect
and log. The contract wording (Task 1) and transcript/artifact checks
(Tasks 6-7) are the universal layers.

- **OpenCode**: subscribe to `session.idle`, read the last assistant text,
  and shell out to `adlc-cli format check --json`. Log on collapse;
  default stays log-only.
- **Claude Code**: add a `Stop` hook that runs
  `adlc-cli format check - --json` with the transcript text on stdin and
  logs the result.
- **Generic**: any agent with a post-response shell hook runs
  `adlc-cli format check -` on the response text.

## Transcript audit (read-only)

```bash
adlc-cli format audit --source jsonl --dir ~/.local/share/opencode --json
adlc-cli format audit --source opencode --db session.db --since 7d
```

`long` means a message with at least 800 characters. The audit never
writes or repairs — it reports `scanned / long / collapsed / rate` so a
team can measure the collapse before enforcing the artifact gate below.
