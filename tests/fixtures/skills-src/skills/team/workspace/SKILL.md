---
name: workspace
description: Use when coordinating a multi-repo workspace — init the .adlc/ structure, discover and link child repos as submodules, or audit workspace health (branch, dirty, unpushed, SHA drift).
---

# workspace

> Vendored E2E fixture: trimmed from the upstream workspace skill for
> hermetic `tests/e2e-workspace.sh` runs. Covers init/link/status only;
> see the upstream skill for the full coordinator reference.

## Overview

A multi-repo workspace coordinator for shared team context. The parent
repository holds shared decisions (PDRs, ADRs, CDRs) under `.adlc/`.
Child implementation repositories are discovered at depth 1 and optionally
linked as Git submodules.

## Commands

| Command | Purpose |
|---|---|
| `/workspace --init` | Initialize: create `.adlc/` structure, configure `.gitignore`, discover child repos |
| `/workspace` | Discover child repos, show summary status (read-only) |
| `/workspace --link` | Convert child repos to Git submodules (requires clean parent tree) |
| `/workspace --status` | Detailed audit: branch, dirty, unpushed, SHA drift, `.adlc` presence |

## Execution

### Init Mode (`--init`)

Run the init setup script to create `.adlc/` structure, check `.gitignore`
conventions, and discover child repos:

```bash
scripts/bash/setup-workspace.sh --json
```

Init creates `.adlc/product/`, `.adlc/architecture/`, `.adlc/context/`,
`.adlc/skills/`, and `.adlc/drafts/` (`pdr/`, `adr/`, `cdr/`, `skills/`,
`evals/`). Idempotent: already-existing directories are not recreated.

### Audit/Link Mode (default, `--link`, `--status`)

Run the workspace coordinator script:

```bash
"$(dirname "$0")/../scripts/bash/workspace.sh" --json [--link] [--status] [--dry-run] $ARGUMENTS
```

Parse the JSON output and present it to the user.

## Safety

- Read-only by default: `/workspace` and `/workspace --status` make no changes.
- `--link` requires a clean parent tree; already-registered submodules are skipped.
- `--dry-run` previews all changes without executing.
