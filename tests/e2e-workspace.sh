#!/usr/bin/env bash
# E2E: adlc-cli workspace setup — real execution (not dry-run).
#
# Covers:
#   1. Deterministic pass: git module clones (branch + ref pin), skills install
#      from a local source (incl. .events.json wiring), command routing.
#   2. Idempotent re-run: existing paths skipped, exit 0.
#   3. Agent-led goal: real `opencode run` via cmdAgentRun (requires local opencode auth).
#   4. Agent-led workspace init: installed /workspace skill executes its bash script.
#
# Usage: tests/e2e-workspace.sh [--skip-agent]   (--skip-agent skips parts 3+4)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../bin/adlc-cli.mjs"
ADLC_REPO="$(cd "$HERE/.." && pwd)"
# Hermetic default: vendored fixture. Sibling ../adlc-team-skills checkout is an
# optional fallback; SKILL_SRC env always wins.
VENDORED_SRC="$HERE/fixtures/skills-src/skills/team/workspace"
SIBLING_SRC="$(cd "$ADLC_REPO/../adlc-team-skills/skills/team/workspace" 2>/dev/null && pwd || true)"
if [ -z "${SKILL_SRC:-}" ]; then
  SKILL_SRC="$VENDORED_SRC"
  if [ ! -f "$SKILL_SRC/SKILL.md" ] && [ -n "$SIBLING_SRC" ]; then
    SKILL_SRC="$SIBLING_SRC"
  fi
fi
SKIP_AGENT="${1:-}"

if [ -z "$SKILL_SRC" ] || [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "FATAL: workspace skill source not found (set SKILL_SRC env)"; exit 1
fi

ROOT="$(mktemp -d /tmp/adlc-e2e-ws.XXXXXX)"
# Windows (Git Bash/msys, cygwin): mktemp yields an msys-virtual /tmp path that
# bash-side git resolves but Node-spawned native git.exe cannot. Normalize to
# Windows form (forward-slash C:/...) so bash, git.exe, and node all agree.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  if command -v cygpath >/dev/null 2>&1; then
    ROOT="$(cygpath -m "$ROOT")"
  else
    echo "WARNING: cygpath not found; continuing with unconverted ROOT=$ROOT" >&2
  fi
fi
FIX="$ROOT/fixtures"; WS="$ROOT/ws"
mkdir -p "$FIX" "$WS/.adlc"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; echo "E2E FAILED (artifacts: $ROOT)"; exit 1; }
assert_exists() { [ -e "$1" ] && pass "exists $1" || fail "missing $1"; }

# Run an agent-led command, keeping stdout and stderr apart.
#
# stdout goes in $OUT (the assertions grep it); stderr goes to a file that is
# dumped only on failure. The CLI reports agent failures on stderr, so without
# this the log showed the agent's transcript and then a bare "exited
# non-zero" with no indication of the actual cause.
ERRLOG="$ROOT/agent-stderr.log"
run_agent() {
  OUT="$( cd "$WS" && "$@" 2>"$ERRLOG" )" || {
    echo "$OUT"
    [ -s "$ERRLOG" ] && { echo "--- agent stderr ---"; cat "$ERRLOG"; }
    fail "$AGENT_FAIL_MSG"
  }
}

# ── Fixtures ────────────────────────────────────────────────────────────
echo "== Building fixtures =="
# backend.git — bare repo, main + tag v1.0 (on a second commit), plus a dev branch off main
git init -q --bare "$FIX/backend.git"
git init -q -b main "$ROOT/backend-work"
( cd "$ROOT/backend-work"
  git config user.email e2e@test && git config user.name e2e
  echo one > file.txt && git add . && git commit -qm one
  echo two > file.txt && git add . && git commit -qm two
  git tag v1.0
  git branch -q dev
  git push -q "$FIX/backend.git" main dev v1.0 )
V1_SHA="$( git -C "$ROOT/backend-work" rev-parse v1.0 )"

# frontend.git — bare repo whose default branch is dev
git init -q --bare -b dev "$FIX/frontend.git"
git init -q -b dev "$ROOT/frontend-work"
( cd "$ROOT/frontend-work"
  git config user.email e2e@test && git config user.name e2e
  echo front > f.txt && git add . && git commit -qm front
  git push -q "$FIX/frontend.git" dev )

# skills-src — mirrors adlc-team-skills shape: skills/team/<skill>/ + .events.json at root
mkdir -p "$FIX/skills-src/skills/team"
cp -r "$SKILL_SRC" "$FIX/skills-src/skills/team/workspace"
cat > "$FIX/skills-src/.events.json" <<'EOF'
{
  "events": {
    "session_start": [
      { "skill": "workspace", "description": "E2E wiring check", "timeout": 60 }
    ]
  }
}
EOF

# workspace repo (mounted-workspace pattern)
( cd "$WS" && git init -q -b main && git config user.email e2e@test && git config user.name e2e )

cat > "$WS/.adlc/workspace.yml" <<EOF
schema_version: "1.0"
name: "E2E Workspace"
version: "1.0.0"
agent: opencode
workspace:
  git:
    - repo: $FIX/backend.git
      path: backend
      ref: v1.0
    - repo: $FIX/frontend.git
      path: frontend
      branch: dev
skills:
  sources:
    - ../fixtures/skills-src
commands:
  - skills add ../fixtures/skills-src
EOF
pass "fixtures ready"

# ── 1. Deterministic pass ───────────────────────────────────────────────
echo; echo "== 1. workspace setup (deterministic) =="
OUT="$( cd "$WS" && node "$BIN" workspace setup )" || { echo "$OUT"; fail "setup exited non-zero"; }
echo "$OUT" | grep -q "git clone $FIX/backend.git backend" || { echo "$OUT"; fail "backend clone not in plan"; }
echo "$OUT" | grep -q "exists, skipping clone" && fail "first run should clone, not skip" || true
pass "clones executed"

assert_exists "$WS/backend/file.txt"
assert_exists "$WS/frontend/f.txt"
[ "$( git -C "$WS/backend" rev-parse HEAD )" = "$V1_SHA" ] && pass "backend pinned at v1.0 ($V1_SHA)" \
  || fail "backend HEAD != v1.0 tag"
[ "$( git -C "$WS/frontend" branch --show-current )" = "dev" ] && pass "frontend on branch dev" \
  || fail "frontend not on dev"

assert_exists "$WS/.agents/skills/workspace/SKILL.md"
assert_exists "$WS/.opencode/commands/workspace.md"
grep -q "generated by adlc-cli" "$WS/.opencode/commands/workspace.md" && pass "command file is generated" \
  || fail "command file missing generated marker"
assert_exists "$WS/.events.json"
assert_exists "$WS/.agents/dispatcher.mjs"
assert_exists "$WS/.opencode/plugins/adlc-skills-events.ts"
pass "events wiring installed"

# ── 2. Idempotent re-run ────────────────────────────────────────────────
echo; echo "== 2. idempotent re-run =="
OUT="$( cd "$WS" && node "$BIN" workspace setup )" || { echo "$OUT"; fail "re-run exited non-zero"; }
echo "$OUT" | grep -q "= backend (exists, skipping clone)" || { echo "$OUT"; fail "backend not skipped on re-run"; }
echo "$OUT" | grep -q "= frontend (exists, skipping clone)" || { echo "$OUT"; fail "frontend not skipped on re-run"; }
pass "existing modules skipped"

# ── 3. Post-setup goal: direct agent run (intent ≡ agent run arg) ───────
if [ "$SKIP_AGENT" = "--skip-agent" ]; then
  echo; echo "== 3+4. skipped (--skip-agent) =="
else
  echo; echo "== 3. goal via direct agent run (real opencode) =="
  AGENT_FAIL_MSG="agent run exited non-zero"
  run_agent node "$BIN" agent run "Reply with exactly: E2E-OK and nothing else." -a opencode
  echo "$OUT" | grep -q "E2E-OK" && pass "agent run output contains E2E-OK" || { echo "$OUT"; fail "E2E-OK missing from agent run output"; }

  # ── 4. Agent-led workspace init (installed skill runs its bash script) ──
  echo; echo "== 4. workspace init (agent-led, /workspace skill) =="
  AGENT_FAIL_MSG="workspace init exited non-zero"
  run_agent node "$BIN" workspace init -a opencode
  assert_exists "$WS/.adlc/product"
  assert_exists "$WS/.adlc/architecture"
  assert_exists "$WS/.adlc/context"
  assert_exists "$WS/.adlc/drafts"
  pass "workspace skill created .adlc/ structure via agent"
fi

echo; echo "E2E PASSED (all assertions green)"
rm -rf "$ROOT"
