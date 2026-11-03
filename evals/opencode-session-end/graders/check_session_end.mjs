/**
 * check_session_end.mjs — code-based grader for EVAL-001
 * (opencode-session-end-plugin-wiring, ADR-479).
 *
 * Binary pass/fail only (EDD Principle II): returns 1.0 (pass) or 0.0 (fail).
 * No LLM judge — deterministic string assertions on the generator output.
 *
 * Trace-to-grader synthesis inputs (from goldset.json):
 * - pass_condition → checks 1–3 below
 * - fail_condition → check 4 (single-entry + branch separation)
 * - axial coding note ("null-mapping drops are silent") → check 1 asserts
 *   the resolved mapping AND the artifact, never one alone.
 *
 * Holdout lock: this grader NEVER reads `.adlc/memory/evals/holdout.json`.
 * Holdout cases (ADV-4 timeout loss, ADV-5 wrong native signal) are reserved
 * for unbiased validation via /evals-validate.
 */

export function gradeSessionEnd({ resolved, pluginContent, expectFileEdited = false }) {
  const failures = [];

  // Check 1 — resolution: canonical session_end survives with native fallback.
  const runs = resolved?.session_end;
  if (!Array.isArray(runs) || runs.length === 0) {
    failures.push("resolved.session_end is missing or empty (event dropped)");
  } else {
    const run = runs[0];
    if (run.nativeEvent !== "session.deleted") {
      failures.push(`nativeEvent is ${JSON.stringify(run.nativeEvent)}, expected "session.deleted"`);
    }
    if (!run.skill) {
      failures.push("resolved run is missing skill name");
    }
    if (typeof run.timeout !== "number") {
      failures.push(`timeout is ${JSON.stringify(run.timeout)}, expected manifest number (propagation check)`);
    }
  }

  // Checks 2–4 — generated artifact.
  if (typeof pluginContent !== "string" || pluginContent.length === 0) {
    failures.push("plugin content is missing (no artifact emitted)");
  } else {
    // Check 2 — V1 session.deleted branch dispatching canonical session_end.
    if (!pluginContent.includes('event.type === "session.deleted"')) {
      failures.push('V1 branch event.type === "session.deleted" absent');
    }
    if (!pluginContent.includes('"session_end"')) {
      failures.push('canonical "session_end" dispatch absent from plugin');
    }
    // Check 3 — V2 event-stream subscription.
    if (!pluginContent.includes("ctx.event.subscribe")) {
      failures.push("V2 ctx.event.subscribe absent (V1-only regression)");
    }
    if (!pluginContent.includes("session.deleted")) {
      failures.push('"session.deleted" absent from plugin entirely');
    }
    // Check 4 — single V1 "event" entry with separated branches.
    // (Duplicate object keys would silently drop a handler at runtime —
    // review fix b9382cc. Zero, two, or unguarded entries all fail.)
    const entries = pluginContent.match(/"event": async \(\{ event \}\) => \{/g) || [];
    if (entries.length !== 1) {
      failures.push(`expected exactly ONE V1 "event" entry, found ${entries.length}`);
    }
    if (expectFileEdited && !pluginContent.includes('event.type === "file.edited"')) {
      failures.push('file.edited branch absent while file_edited is declared (stream separation broken)');
    }
  }

  return { score: failures.length === 0 ? 1.0 : 0.0, failures };
}
