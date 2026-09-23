#!/usr/bin/env bash
# E2E: brownfield workspace setup with the team-directives fixture profile.
#
# Scenario (single, brownfield):
#   1. Temp workspace with a pre-cloned real brownfield repo (hermes demo).
#   2. `adlc-cli workspace setup <fixture>` — profile passed explicitly.
#   3. Asserts: public HTTPS clone of team-ai-directives, workspace.dirs
#      scaffolding, agent-led .adlc/ init, skills from the remote GitHub
#      source (+ events wiring), team setup command, brownfield discovery +
#      submodule registration of BOTH the pre-cloned repo and the profile
#      clone. Ends with a direct `agent run` marker proving post-setup
#      agent execution (intent ≡ agent run arg).
#
# Requires: network (GitHub), local opencode auth, npx.
# Usage: tests/e2e-profiles.sh [--skip-agent]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/../bin/adlc-cli.mjs"
PROFILE="$HERE/e2e/profiles/team-directives-profile.yml"
SKIP_AGENT="${1:-}"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; echo "E2E-PROFILES FAILED (artifacts: $ROOT)"; exit 1; }
assert_exists() { [ -e "$1" ] && pass "exists $1" || fail "missing $1"; }

echo "== Preparing brownfield workspace =="
ROOT="$(mktemp -d /tmp/adlc-e2e-profiles.XXXXXX)"
WS="$ROOT/ws"
mkdir -p "$WS"
( cd "$WS" && git init -q -b main && git config user.email e2e@test && git config user.name e2e )

# Pre-cloned brownfield repo — NOT in the profile; must be discovered at depth 1
echo "Cloning hermes brownfield demo (shallow)..."
git clone -q --depth 1 https://github.com/mnriem/spec-kit-go-brownfield-demo.git "$WS/hermes-project" \
  || fail "hermes clone failed (network?)"
HERMES_HEAD="$( git -c safe.directory='*' -C "$WS/hermes-project" rev-parse HEAD )"
[ -e "$WS/hermes-project/go.mod" ] && pass "hermes-project cloned (Go codebase present)" \
  || fail "hermes-project content missing"

echo; echo "== workspace setup (fixture profile) =="
OUT="$( cd "$WS" && node "$BIN" workspace setup "$PROFILE" )" \
  || { echo "$OUT"; fail "workspace setup exited non-zero"; }
echo "$OUT" | grep -q "Team AI Directives Demo Workspace" || { echo "$OUT"; fail "profile name missing"; }
echo "$OUT" | grep -q "git clone https://github.com/tikalk/agentic-sdlc-team-ai-directives.git agentic-sdlc-team-ai-directives" \
  || { echo "$OUT"; fail "directives clone missing from plan"; }
echo "$OUT" | grep -q "mkdir -p adlc-team-skills" || { echo "$OUT"; fail "dirs scaffold missing"; }
echo "$OUT" | grep -q "Workspace setup complete" || { echo "$OUT"; fail "setup did not complete"; }

# Deterministic asserts
assert_exists "$WS/agentic-sdlc-team-ai-directives/README.md"
[ -d "$WS/adlc-team-skills" ] && [ -z "$(ls -A "$WS/adlc-team-skills")" ] \
  && pass "adlc-team-skills is an empty dir (greenfield scaffold)" \
  || fail "adlc-team-skills not empty or missing"

# Agent-led init (workspace skill) — unless skipped
if [ "$SKIP_AGENT" = "--skip-agent" ]; then
  echo; echo "== post-setup asserts skipped after init (--skip-agent halts before agent steps) =="
  echo "NOTE: rerun without --skip-agent for full coverage"
  rm -rf "$ROOT"
  echo; echo "E2E-PROFILES PASSED (deterministic subset)"
  exit 0
fi

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
# mode for team setup when the directives path is known (e.g. from profile git).
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

echo; echo "== post-setup goal: direct agent run =="
OUT="$( cd "$WS" && node "$BIN" agent run "Reply with exactly: E2E-GOAL-OK and nothing else." -a opencode )" \
  || { echo "$OUT"; fail "agent run exited non-zero"; }
echo "$OUT" | grep -q "E2E-GOAL-OK" && pass "agent run output contains E2E-GOAL-OK" \
  || { echo "$OUT"; fail "E2E-GOAL-OK missing from agent run output"; }

echo; echo "E2E-PROFILES PASSED (all assertions green)"
rm -rf "$ROOT"
