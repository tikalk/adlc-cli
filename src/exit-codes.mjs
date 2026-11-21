// Machine-readable CLI exit codes (mission tikalk/adlc-cli#22).
//
// Pure classifiers — no side effects, no imports. Callers:
//   - src/commands/agent.mjs    → classifyAgentExit (post-spawn child result)
//   - src/commands/workflow.mjs → classifyWorkflowStatus (terminal run status)
//
// ADR-542: a run whose agent step failed fast (non-zero exit within
// FAST_FAILURE_THRESHOLD_SECONDS of spawn) is an infrastructure failure, not
// a wrong answer — classifyWorkflowStatus maps it to the retryable code.

export function classifyAgentExit({ code, signal } = {}) {
  if (signal) return { exitCode: 130 };
  if (code === 0) return { exitCode: 0 };
  return { exitCode: 10 };
}

// Deliberately no import of RunStatus (src/workflow/base.mjs) to keep this
// file import-free per the header contract — but that means these case
// labels must be hand-kept in sync with RunStatus's actual *lowercase*
// values ("completed", "paused", "failed", "aborted"). They previously
// used the uppercase enum KEY names instead of the VALUES, so every real
// status silently fell through to the `default` 1 — confirmed empirically:
// classifyWorkflowStatus("completed") returned exitCode 1, not 0, breaking
// the Argo retry-gate contract documented in workflow.mjs
// (`asInt(lastRetry.exitCode) != 10 && != 3` was always true).
export function classifyWorkflowStatus(status, { fastFailure } = {}) {
  switch (status) {
    case "completed":
      return { exitCode: 0 };
    case "paused":
      return { exitCode: 3 };
    case "failed":
      // ADR-542: an agent that exits non-zero within 60 s of spawn is an
      // infrastructure failure (cold-pod crash, gateway blip) — retryable.
      // A failure past the threshold stays a logical failure (exit 10).
      return { exitCode: fastFailure === true ? 1 : 10 };
    case "aborted":
      return { exitCode: 1 };
    default:
      return { exitCode: 1 };
  }
}
