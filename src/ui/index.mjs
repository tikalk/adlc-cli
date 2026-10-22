// Terminal UI layer — the single entry point for every human-facing print.
//
// Zero runtime dependencies (the package ships dependency-free). Everything
// here is presentation only: no business logic, no I/O beyond stdout/stderr,
// and nothing that depends on a module outside `src/ui/` — so the module
// ports unchanged if adlc-cli is rewritten (ADR-409).

export {
  setColorMode,
  colorEnabled,
  style,
  tint,
  combine,
  asText,
  SafeString,
  stripAnsi,
  visibleWidth,
  sanitize,
  sanitizeLines,
  padEnd,
  padStart,
  terminalWidth,
  wrapText,
  wrapStyled,
} from "./ansi.mjs";

export { ACCENT, sym, statusStyle } from "./theme.mjs";

export {
  out,
  err,
  write,
  blank,
  heading,
  step,
  success,
  failure,
  warn,
  error,
  note,
  detail,
  item,
} from "./console.mjs";

export { panel, stepList } from "./panel.mjs";
export { table, keyValue } from "./table.mjs";
export { createStepTracker } from "./tree.mjs";
