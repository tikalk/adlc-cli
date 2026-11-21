// Machine-readable CLI exit codes (mission tikalk/adlc-cli#22).
//
// Pure classifiers — no side effects, no imports. Callers:
//   - src/commands/agent.mjs    → classifyAgentExit (post-spawn child result)
//   - src/commands/workflow.mjs → classifyWorkflowStatus (terminal run status)
//   - src/commands/workflow.mjs → classifyWorkflowError (run|resume threw)

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
export function classifyWorkflowStatus(status) {
  switch (status) {
    case "completed":
      return { exitCode: 0 };
    case "paused":
      return { exitCode: 3 };
    case "failed":
      return { exitCode: 10 };
    case "aborted":
      return { exitCode: 1 };
    default:
      return { exitCode: 1 };
  }
}

// Operating-system faults that a new pod may well not hit again: disk full or
// over quota, I/O error, out of file handles or memory, resource busy, timed
// out. A run that threw one of these keeps the generic exit code 1 (retried).
const TRANSIENT_SYSTEM_ERRORS = new Set([
  "ENOSPC", "EDQUOT", "EIO", "EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "EBUSY", "ETIMEDOUT",
]);

// Exit code for an error thrown by `workflow run|resume`.
//
// When the engine threw while the run was executing, it first saved the run
// as failed and tagged the error with `adlcRun` (engine.mjs markRunFailed).
// Such an error is deterministic in almost every case (an unknown template
// filter, a malformed expression, an invalid step at run time): running it
// again gives the same result, so it exits with the "failed" code and the
// lane does not retry it. An error without the tag (lease held by another
// session, run not found, bad usage) keeps exit 1, as does a transient
// operating-system fault.
export function classifyWorkflowError(error) {
  const status = error?.adlcRun?.status;
  if (status !== "failed") return { exitCode: 1 };
  if (typeof error?.code === "string" && TRANSIENT_SYSTEM_ERRORS.has(error.code)) return { exitCode: 1 };
  return classifyWorkflowStatus(status);
}
