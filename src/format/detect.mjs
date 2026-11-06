// Detector for collapsed Markdown output (format-guard).
//
// A text is collapsed when it is long, has zero newlines, is not a
// protected single-line shape, and either starts with the Team Context
// preamble or carries at least MIN_MARKERS structural markers.

export const DETECT_DEFAULTS = { minLength: 200, minMarkers: 2 };

const SEPARATOR_RE = /\|\s*:?-{2,}:?\s*\|/;

function isProtectedShape(trimmed) {
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // Not JSON — fall through to marker analysis.
    }
  }
  if (/^https?:\/\/\S+$/.test(trimmed)) return true;
  if (
    trimmed.startsWith("```") &&
    trimmed.endsWith("```") &&
    (trimmed.match(/```/g) ?? []).length === 2
  ) {
    return true;
  }
  return false;
}

function countMarkers(trimmed) {
  let markers = 0;
  const reasons = [];
  if (trimmed.includes("## ")) {
    markers += 1;
    reasons.push("heading");
  }
  if (trimmed.includes("_Scope:")) {
    markers += 1;
    reasons.push("scope-line");
  }
  if (trimmed.includes("- **")) {
    markers += 1;
    reasons.push("bullets");
  }
  if (SEPARATOR_RE.test(trimmed)) {
    markers += 1;
    reasons.push("table-separator");
  }
  if ((trimmed.match(/\|/g) ?? []).length >= 6) {
    markers += 1;
    reasons.push("pipes");
  }
  return { markers, reasons };
}

export function detectCollapsed(text, options = {}) {
  const { minLength, minMarkers } = { ...DETECT_DEFAULTS, ...options };
  const trimmed = String(text ?? "").trim();

  if (trimmed.length < minLength) {
    return { collapsed: false, family: "none", reasons: ["too-short"], markers: 0 };
  }
  if (isProtectedShape(trimmed)) {
    return { collapsed: false, family: "none", reasons: ["protected-shape"], markers: 0 };
  }
  if (trimmed.includes("\n")) {
    return { collapsed: false, family: "none", reasons: ["has-newlines"], markers: 0 };
  }

  const { markers, reasons } = countMarkers(trimmed);
  const teamContext = trimmed.startsWith("## Team Context & Decisions");
  const collapsed = teamContext || markers >= minMarkers;
  const family = teamContext ? "team-context" : collapsed ? "markdown" : "none";

  return {
    collapsed,
    family,
    reasons: ["zero-newlines", ...(teamContext ? ["team-context-prefix"] : reasons)],
    markers,
  };
}
