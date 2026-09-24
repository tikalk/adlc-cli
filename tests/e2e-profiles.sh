#!/usr/bin/env bash
# E2E: brownfield workspace setup with the team-directives fixture workspace file.
#
# Scenario (single, brownfield):
#   1. Temp workspace with a pre-cloned real brownfield repo (hermes demo).
#   2. `adlc-cli workspace setup <fixture>` — workspace file passed explicitly.
#   3. Asserts: public HTTPS clone of team-ai-directives, workspace.dirs
#      scaffolding, agent-led .adlc/ init, skills from the remote GitHub
#      source (+ events wiring), team setup command, brownfield discovery +
#      submodule registration of BOTH the pre-cloned repo and the fixture's
#      clone. First-boot goal executes (workspace was assembled this run).
#   4. Re-run: everything skips (idempotent), and the goal is skipped too —
#      proves the first-boot-only gate (no LLM cost on convergence re-runs).
#
# Requires: network (GitHub), local opencode auth, npx.
# Usage: tests/e2e-profiles.sh [--skip-agent]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../bin/adlc-cli.mjs"
WORKSPACE_FILE="$HERE/e2e/profiles/team-directives-workspace.yml"
SKIP_AGENT="${1:-}"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; echo "E2E-PROFILES FAILED (artifacts: $ROOT)"; exit 1; }
assert_exists() { [ -e "$1" ] && pass "exists $1" || fail "missing $1"; }

echo "== Preparing brownfield workspace =="
ROOT="$(mktemp -d /tmp/adlc-e2e-profiles.XXXXXX)"
WS="$ROOT/ws"
mkdir -p "$WS"
( cd "$WS" && git init -q -b main && git config user.email e2e@test && git config user.name e2e )

# Pre-cloned brownfield repo — NOT in the workspace file; must be discovered at depth 1
echo "Cloning hermes brownfield demo (shallow)..."
git clone -q --depth 1 https://github.com/mnriem/spec-kit-go-brownfield-demo.git "$WS/hermes-project" \
  || fail "hermes clone failed (network?)"
HERMES_HEAD="$( git -c safe.directory='*' -C "$WS/hermes-project" rev-parse HEAD )"
[ -e "$WS/hermes-project/go.mod" ] && pass "hermes-project cloned (Go codebase present)" \
  || fail "hermes-project content missing"

if [ "$SKIP_AGENT" = "--skip-agent" ]; then
  echo; echo "== workspace setup --dry-run (deterministic subset, --skip-agent) =="
  OUT="$( cd "$WS" && node "$BIN" workspace setup "$WORKSPACE_FILE" --dry-run )" \
    || { echo "$OUT"; fail "workspace setup --dry-run exited non-zero"; }
  echo "$OUT" | grep -q "Team AI Directives Demo Workspace" || { echo "$OUT"; fail "workspace name missing"; }
  echo "$OUT" | grep -q "git clone https://github.com/tikalk/agentic-sdlc-team-ai-directives.git agentic-sdlc-team-ai-directives" \
    || { echo "$OUT"; fail "directives clone missing from plan"; }
  echo "$OUT" | grep -q "mkdir -p adlc-team-skills" || { echo "$OUT"; fail "dirs scaffold missing"; }
  echo "$OUT" | grep -q 'goal (agent-led, first boot)' && pass "dry-run predicts first-boot goal" \
    || { echo "$OUT"; fail "dry-run did not predict goal"; }
  echo; echo "E2E-PROFILES PASSED (deterministic subset, --skip-agent)"
  rm -rf "$ROOT"
  exit 0
fi

echo; echo "== workspace setup (fixture workspace file, first boot) =="
OUT="$( cd "$WS" && node "$BIN" workspace setup "$WORKSPACE_FILE" )" \
  || { echo "$OUT"; fail "workspace setup exited non-zero"; }
echo "$OUT" | grep -q "Team AI Directives Demo Workspace" || { echo "$OUT"; fail "workspace name missing"; }
echo "$OUT" | grep -q "git clone https://github.com/tikalk/agentic-sdlc-team-ai-directives.git agentic-sdlc-team-ai-directives" \
  || { echo "$OUT"; fail "directives clone missing from plan"; }
echo "$OUT" | grep -q "mkdir -p adlc-team-skills" || { echo "$OUT"; fail "dirs scaffold missing"; }
echo "$OUT" | grep -q "Workspace setup complete" || { echo "$OUT"; fail "setup did not complete"; }
echo "$OUT" | grep -q 'goal (agent-led, first boot)' || { echo "$OUT"; fail "goal step did not run on first boot"; }
echo "$OUT" | grep -q "E2E-GOAL-OK" && pass "first-boot goal executed (E2E-GOAL-OK)" \
  || { echo "$OUT"; fail "E2E-GOAL-OK missing — goal did not execute on first boot"; }

# Deterministic asserts
assert_exists "$WS/agentic-sdlc-team-ai-directives/README.md"
[ -d "$WS/adlc-team-skills" ] && [ -z "$(ls -A "$WS/adlc-team-skills")" ] \
  && pass "adlc-team-skills is an empty dir (greenfield scaffold)" \
  || fail "adlc-team-skills not empty or missing"

assert_exists "$WS/.adlc/product"
assert_exists "$WS/.adlc/architecture"
assert_exists "$WS/.adlc/context"
pass "agent-led workspace init created .adlc/ tree"

# Skills from remote GitHub source
assert_exists "$WS/.agents/skills/team-boot/SKILL.md"
assert_exists "$WS/.opencode/commands/team-boot.md"
assert_exists "$WS/.events.json"
assert_exists "$WS/.agents/dispatcher.mjs"
assert_exists "$WS/.opencode/plugin/adlc-skills-events.ts"
pass "skills installed from remote GitHub source + events wired"

# team setup command ran — deterministic part (agent + skills_source) configured.
# NOTE: team_ai_directives wiring requires the interactive /team-setup skill
# (mode selection) — headless runs can't answer it. Follow-up: non-interactive
# mode for team setup when the directives path is known (e.g. from the
# workspace file's git section).
[ -f "$WS/.adlc/init-options.json" ] || fail "init-options.json missing (team setup did not run)"
grep -q '"agent"' "$WS/.adlc/init-options.json" && pass "init-options has agent" || fail "init-options missing agent"
grep -q '"skills_source"' "$WS/.adlc/init-options.json" && pass "init-options has skills_source" \
  || fail "init-options missing skills_source"

# Brownfield: pre-cloned repo untouched by clone phase, discovered + linked
[ "$( git -c safe.directory='*' -C "$WS/hermes-project" rev-parse HEAD )" = "$HERMES_HEAD" ] \
  && pass "hermes-project HEAD unchanged by setup" || fail "hermes-project was modified"
[ -f "$WS/.gitmodules" ] || fail ".gitmodules missing (link did not run)"
grep -q "hermes-project" "$WS/.gitmodules" && pass "hermes-project registered as submodule (brownfield discovery)" \
  || { cat "$WS/.gitmodules"; fail "hermes-project not in .gitmodules"; }
grep -q "agentic-sdlc-team-ai-directives" "$WS/.gitmodules" && pass "directives clone registered as submodule" \
  || { cat "$WS/.gitmodules"; fail "directives not in .gitmodules"; }
# Adopted repos register as gitlinks (mode 160000) in the parent index —
# git keeps their standalone .git dir ("Adding existing repo to the index"),
# so the gitfile form is NOT the marker here.
git -c safe.directory='*' -C "$WS" ls-files --stage 2>/dev/null | grep -qE "^160000.*[[:space:]]hermes-project$" \
  && pass "hermes-project registered as gitlink in parent index" \
  || fail "hermes-project gitlink missing from parent index"
git -c safe.directory='*' -C "$WS" ls-files --stage 2>/dev/null | grep -qE "^160000.*[[:space:]]agentic-sdlc-team-ai-directives$" \
  && pass "directives registered as gitlink in parent index" \
  || fail "directives gitlink missing from parent index"

# Empty dirs must NOT be registered as submodules
! grep -q "adlc-team-skills" "$WS/.gitmodules" && pass "empty dir adlc-team-skills not in .gitmodules" \
  || fail "empty dir incorrectly registered as submodule"

echo; echo "== workspace setup RE-RUN (idempotent convergence, goal must skip) =="
OUT2="$( cd "$WS" && node "$BIN" workspace setup "$WORKSPACE_FILE" )" \
  || { echo "$OUT2"; fail "re-run exited non-zero"; }
echo "$OUT2" | grep -q "= agentic-sdlc-team-ai-directives (exists, skipping clone)" \
  && pass "re-run skips existing clone" || { echo "$OUT2"; fail "re-run did not skip clone"; }
echo "$OUT2" | grep -q "= adlc-team-skills (exists, skipping)" \
  && pass "re-run skips existing dir" || { echo "$OUT2"; fail "re-run did not skip dir"; }
echo "$OUT2" | grep -q 'goal (first-boot only — nothing assembled this run, skipping)' \
  && pass "re-run SKIPS the goal (no LLM cost on convergence)" \
  || { echo "$OUT2"; fail "re-run did not skip the goal"; }
echo "$OUT2" | grep -q "E2E-GOAL-OK" \
  && fail "goal executed again on re-run — first-boot gate not honored" \
  || pass "goal output absent on re-run (confirmed skipped)"
echo "$OUT2" | grep -q 'Next: adlc-cli agent run' \
  && pass "handoff hint shown when goal is skipped" || { echo "$OUT2"; fail "handoff hint missing"; }

echo; echo "== post-setup: direct agent run against the converged workspace =="
OUT3="$( cd "$WS" && node "$BIN" agent run "Reply with exactly: E2E-DIRECT-OK and nothing else." -a opencode )" \
  || { echo "$OUT3"; fail "agent run exited non-zero"; }
echo "$OUT3" | grep -q "E2E-DIRECT-OK" && pass "direct agent run output contains E2E-DIRECT-OK" \
  || { echo "$OUT3"; fail "E2E-DIRECT-OK missing from agent run output"; }

echo; echo "E2E-PROFILES PASSED (all assertions green)"
rm -rf "$ROOT"
