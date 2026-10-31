/**
 * config.mjs — evaluation configuration for the opencode-session-end goldset.
 *
 * Tier 1 only: this criterion is fully deterministic (code-based grader on
 * generator output, no LLM judge), so no Tier 2 pipeline exists.
 * SLA: grader unit tests <2s; full `node --test` suite <5s.
 */
export const evalConfig = {
  system: "opencode-session-end",
  goldset: "./goldset.json",
  holdout: "../../.adlc/memory/evals/holdout.json",
  tiers: {
    1: {
      graders: ["./graders/check_session_end.mjs"],
      unitTests: ["./tests/test_check_session_end.mjs"],
      sla: "<2s",
      type: "deterministic",
    },
  },
  // Holdout lock: validation runners must never import the holdout file
  // during grader development or self-tuning.
  holdoutLocked: true,
};
