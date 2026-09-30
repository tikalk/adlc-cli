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

export function classifyWorkflowStatus(status) {
  switch (status) {
    case "COMPLETED":
      return { exitCode: 0 };
    case "PAUSED":
      return { exitCode: 3 };
    case "FAILED":
      return { exitCode: 10 };
    case "ABORTED":
      return { exitCode: 1 };
    default:
      return { exitCode: 1 };
  }
}
