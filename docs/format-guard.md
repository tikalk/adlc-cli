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
