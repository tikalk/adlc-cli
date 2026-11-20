// Machine-readable CLI exit codes (mission tikalk/adlc-cli#22).
//
// Pure classifiers — no side effects, no imports. Callers:
//   - src/commands/agent.mjs    → classifyAgentExit (post-spawn child result)
//   - src/commands/workflow.mjs → classifyWorkflowStatus (terminal run status)

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
//
// `timedOut` (optional): the run failed because a step was killed by its own
// time limit. A time-out says nothing about the answer being wrong, so it
// exits 1 (infra-class: the lane retries it) instead of 10 (logical failure:
// never retried). The run itself stays "failed", so it can still be resumed.
export function classifyWorkflowStatus(status, { timedOut = false } = {}) {
  switch (status) {
    case "completed":
      return { exitCode: 0 };
    case "paused":
      return { exitCode: 3 };
    case "failed":
      return { exitCode: timedOut === true ? 1 : 10 };
    case "aborted":
      return { exitCode: 1 };
    default:
      return { exitCode: 1 };
  }
}
