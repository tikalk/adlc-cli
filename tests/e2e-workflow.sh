#!/usr/bin/env bash
# E2E: adlc-cli workflow — engine run (gate pause/resume), event stream,
# cross-executor handoff (state helpers ↔ engine), bundled `factory`.
# Run from adlc-cli/ or anywhere.
set -euo pipefail

CLI="$(cd "$(dirname "$0")/.." && pwd)/bin/adlc-cli.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/.adlc/workflows/build"
cat > "$WORK/.adlc/workflows/build/workflow.yml" << 'EOF'
schema_version: "1.0"
workflow:
  id: build
  name: Build
  version: "1.0.0"
inputs:
  verdict:
    type: string
steps:
  - id: compile
    type: shell
    run: "echo compiled"
  - id: review
    type: gate
    message: "Approve the build?"
    options: [approve, reject]
    verdict_input: verdict
  - id: report
    type: shell
    run: "echo approved={{ steps.review.output.choice }}"
EOF

cd "$WORK"

echo "── validate (+--headless)"
node "$CLI" workflow validate build --headless | grep -q "valid" || { echo "FAIL: validate"; exit 1; }

echo "── run (expect PAUSED at gate)"
set +e
node "$CLI" workflow run build
RUN_EXIT=$?
set -e
[ "$RUN_EXIT" -eq 1 ] || { echo "FAIL: expected exit 1 (paused), got $RUN_EXIT"; exit 1; }

RUN_ID=$(node "$CLI" workflow status | grep -E "^\s+⏸" | awk '{print $2}')
[ -n "$RUN_ID" ] || { echo "FAIL: no paused run listed"; exit 1; }

echo "── event stream: gate_paused + permission_request on --format json resume"
set +e
node "$CLI" workflow resume "$RUN_ID" --input verdict=approve --format json > events.jsonl
RESUME_EXIT=$?
set -e
[ "$RESUME_EXIT" -eq 0 ] || { echo "FAIL: resume exit $RESUME_EXIT"; cat events.jsonl; exit 1; }
grep -q '"type":"run_started"' events.jsonl || { echo "FAIL: no run_started"; exit 1; }
grep -q '"type":"step_completed"' events.jsonl || { echo "FAIL: no step_completed"; exit 1; }
grep -q '"type":"run_completed"' events.jsonl || { echo "FAIL: no run_completed"; exit 1; }
node "$CLI" workflow status "$RUN_ID" | grep -q "completed" || { echo "FAIL: run not completed"; exit 1; }

echo "── verdict flowed through step context"
grep -q '"choice": "approve"' ".adlc/workflows/runs/$RUN_ID/state.json" || { echo "FAIL: verdict not recorded"; exit 1; }

echo "── cross-executor handoff: state helpers → engine resume"
cat > handoff.yml << 'EOF'
schema_version: "1.0"
workflow:
  id: handoff
  name: Handoff
  version: "1.0.0"
inputs:
  verdict: {type: string}
steps:
  - id: first
    type: shell
    run: "echo first"
  - id: gate
    type: gate
    message: "Handoff gate?"
    options: [approve, reject]
    verdict_input: verdict
  - id: last
    type: shell
    run: "echo last"
EOF
H_RUN=$(node "$CLI" workflow state start --workflow handoff.yml)
node "$CLI" workflow state advance "$H_RUN" --step first --status completed | grep -q "gate" || { echo "FAIL: advance did not move to gate"; exit 1; }
node "$CLI" workflow state pause "$H_RUN" --step gate | grep -q "paused at gate" || { echo "FAIL: pause"; exit 1; }
node "$CLI" workflow resume "$H_RUN" --input verdict=approve > /dev/null || { echo "FAIL: engine resume of helper run"; exit 1; }
node "$CLI" workflow state show "$H_RUN" | grep -q '"status": "completed"' || { echo "FAIL: handoff run not completed"; exit 1; }

echo "── bundled factory definition"
node "$CLI" workflow validate factory --headless | grep -q "valid" || { echo "FAIL: builtin factory validation"; exit 1; }

echo
echo "E2E OK — engine=$RUN_ID handoff=$H_RUN"
