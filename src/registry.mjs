// Agent registry — data-driven table of all supported coding agents.
// Each entry declares where npx skills installs SKILL.md files (skills_dir),
// where we generate command files (commands_dir), the file format, and whether
// the agent supports session_start context-injection events.
//
// ── user_invoked_mode ──────────────────────────────────────────────────
// For user-invoked skills (disable-model-invocation: true) on wrapper-default
// agents, `user_invoked_mode` picks the command body strategy:
//   "wrapper"   — thin "Invoke the X skill." command (opencode). The skill is
//                 in <available_skills> (opencode ignores the flag), so the
//                 model calls skill({name}) and the skill loads via the tool.
//   "execution" — inline the full body as imperative steps (default). Used
//                 when the agent respects disable-model-invocation (claude-code
//                 hides such skills from the model, so a skill-tool call fails).

export const AGENTS = {
  // ── Markdown command agents ──────────────────────────────────────────
  opencode: {
    name: "OpenCode",
    npx_agent: "opencode",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.config/opencode/skills",
    commands_dir: ".opencode/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "wrapper",
    events: true,
    user_invoked_mode: "wrapper",
  },
  "claude-code": {
    name: "Claude Code",
    npx_agent: "claude-code",
    skills_dir: ".claude/skills",
    global_skills_dir: "~/.claude/skills",
    commands_dir: ".claude/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "wrapper",
    events: true,
  },
  cursor: {
    name: "Cursor",
    npx_agent: "cursor",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.cursor/skills",
    commands_dir: ".cursor/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "wrapper",
    events: true,
  },
  "github-copilot": {
    name: "GitHub Copilot",
    npx_agent: "github-copilot",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.copilot/skills",
    commands_dir: ".github/prompts",
    commands_ext: ".prompt.md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "wrapper",
    events: true,
  },
  codex: {
    name: "Codex",
    npx_agent: "codex",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.codex/skills",
    commands_dir: "~/.codex/prompts",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "wrapper",
    events: true,
  },
  devin: {
    name: "Devin",
    npx_agent: "devin",
    skills_dir: ".devin/skills",
    global_skills_dir: "~/.config/devin/skills",
    commands_dir: ".devin/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: true,
  },
  amp: {
    name: "Amp",
    npx_agent: "amp",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.config/agents/skills",
    commands_dir: ".agents/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  augment: {
    name: "Augment",
    npx_agent: "augment",
    skills_dir: ".augment/skills",
    global_skills_dir: "~/.augment/skills",
    commands_dir: ".augment/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  bob: {
    name: "IBM Bob",
    npx_agent: "bob",
    skills_dir: ".bob/skills",
    global_skills_dir: "~/.bob/skills",
    commands_dir: ".bob/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  codebuddy: {
    name: "CodeBuddy",
    npx_agent: "codebuddy",
    skills_dir: ".codebuddy/skills",
    global_skills_dir: "~/.codebuddy/skills",
    commands_dir: ".codebuddy/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  cline: {
    name: "Cline",
    npx_agent: "cline",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.agents/skills",
    commands_dir: ".clinerules/workflows",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  firebender: {
    name: "Firebender",
    npx_agent: "firebender",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.firebender/skills",
    commands_dir: ".firebender/commands",
    commands_ext: ".mdc",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  forge: {
    name: "ForgeCode",
    npx_agent: null,
    skills_dir: ".agents/skills",
    global_skills_dir: null,
    commands_dir: ".forge/commands",
    commands_ext: ".md",
    args_placeholder: "{{parameters}}",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  junie: {
    name: "Junie",
    npx_agent: "junie",
    skills_dir: ".junie/skills",
    global_skills_dir: "~/.junie/skills",
    commands_dir: ".junie/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  kilo: {
    name: "Kilo Code",
    npx_agent: "kilo",
    skills_dir: ".kilocode/skills",
    global_skills_dir: "~/.kilocode/skills",
    commands_dir: ".kilocode/workflows",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  "kiro-cli": {
    name: "Kiro CLI",
    npx_agent: "kiro-cli",
    skills_dir: ".kiro/skills",
    global_skills_dir: "~/.kiro/skills",
    commands_dir: ".kiro/prompts",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  omp: {
    name: "OMP",
    npx_agent: null,
    skills_dir: ".agents/skills",
    global_skills_dir: null,
    commands_dir: ".omp/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  pi: {
    name: "Pi",
    npx_agent: "pi",
    skills_dir: ".pi/skills",
    global_skills_dir: "~/.pi/agent/skills",
    commands_dir: ".pi/prompts",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  qoder: {
    name: "Qoder",
    npx_agent: "qoder",
    skills_dir: ".qoder/skills",
    global_skills_dir: "~/.qoder/skills",
    commands_dir: ".qoder/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  "qwen-code": {
    name: "Qwen Code",
    npx_agent: "qwen-code",
    skills_dir: ".qwen/skills",
    global_skills_dir: "~/.qwen/skills",
    commands_dir: ".qwen/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: true,
  },
  shai: {
    name: "Shai",
    npx_agent: null,
    skills_dir: ".agents/skills",
    global_skills_dir: null,
    commands_dir: ".shai/commands",
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
  // ── TOML command agents ──────────────────────────────────────────────
  "gemini-cli": {
    name: "Gemini CLI",
    npx_agent: "gemini-cli",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.gemini/skills",
    commands_dir: ".gemini/commands",
    commands_ext: ".toml",
    args_placeholder: "{{args}}",
    format: "toml",
    default_mode: "inline",
    events: true,
  },
  "tabnine-cli": {
    name: "Tabnine CLI",
    npx_agent: "tabnine-cli",
    skills_dir: ".tabnine/agent/skills",
    global_skills_dir: "~/.tabnine/agent/skills",
    commands_dir: ".tabnine/agent/commands",
    commands_ext: ".toml",
    args_placeholder: "{{args}}",
    format: "toml",
    default_mode: "inline",
    events: true,
  },
  // ── YAML command agents ──────────────────────────────────────────────
  goose: {
    name: "Goose",
    npx_agent: "goose",
    skills_dir: ".goose/skills",
    global_skills_dir: "~/.config/goose/skills",
    commands_dir: ".goose/recipes",
    commands_ext: ".yaml",
    args_placeholder: "{{args}}",
    format: "yaml",
    default_mode: "inline",
    events: false,
  },
  // ── Generic fallback ─────────────────────────────────────────────────
  generic: {
    name: "Generic (custom commands dir)",
    npx_agent: "universal",
    skills_dir: ".agents/skills",
    global_skills_dir: "~/.config/agents/skills",
    commands_dir: null,
    commands_ext: ".md",
    args_placeholder: "$ARGUMENTS",
    format: "markdown",
    default_mode: "inline",
    events: false,
  },
};

export const GENERATED_HEADER = "<!-- generated by adlc-skills-cli";
export const GENERATED_TEXT = "generated by adlc-skills-cli";
export const SOURCE_MARKER = "source:";

export function getAgent(key) {
  return AGENTS[key] || null;
}

export function getEventAgents() {
  return Object.entries(AGENTS)
    .filter(([, a]) => a.events)
    .map(([key, a]) => ({ key, ...a }));
}

export function getCommandAgents() {
  return Object.entries(AGENTS)
    .filter(([key]) => key !== "generic")
    .map(([key, a]) => ({ key, ...a }));
}

export function resolveNpxAgent(agent) {
  const entry = AGENTS[agent];
  if (!entry) return null;
  return entry.npx_agent || "universal";
}

// ── Events ─────────────────────────────────────────────────────────────
// Canonical event names (snake_case). The dispatcher and .events.json use
// these. Each agent adapter translates them to the agent's native casing.

export const CANONICAL_EVENTS = [
  "session_start",
  "session_compact",
  "pre_tool_use",
  "post_tool_use",
  "session_end",
  "user_prompt_submit",
  "stop",
];

// Events where the body-injection path (superpowers model) applies.
// Script path (spec-kit model) applies to ALL events.
export const BODY_INJECTION_EVENTS = new Set(["session_start", "session_compact", "user_prompt_submit"]);

// Context-injection envelope for hook stdout, per agent + canonical event.
//
// Not every agent injects a hook's plain-text stdout as model context:
//   - Claude Code and Codex DO (plain stdout → context on session_start and
//     user_prompt_submit). No envelope needed.
//   - Gemini/Tabnine/Qwen/Devin are JSON-only protocols: plain stdout becomes
//     user-facing noise (Gemini/Tabnine treat it as `systemMessage`), never
//     context. Injection requires a JSON envelope.
//   - Copilot CLI discards non-JSON stdout; sessionStart accepts a top-level
//     `additionalContext` field. Its userPromptSubmitted output is NOT
//     processed (per-prompt injection impossible).
//   - Cursor parses stdout as JSON; sessionStart accepts a top-level
//     `additional_context` (snake_case) field. Its beforeSubmitPrompt output
//     schema has no context field (per-prompt injection impossible).
//   - opencode hooks are in-process TS functions (no stdout); the generated
//     plugin captures dispatcher output and pushes it into hook outputs.
//
// Envelope tokens (resolved per event, with "*" as the fallback key):
//   "hookSpecificOutput" → {"hookSpecificOutput": {"additionalContext": ...}}
//   "additionalContext"  → {"additionalContext": ...}   (top-level, Copilot)
//   "additional_context" → {"additional_context": ...}  (top-level, Cursor)
//   "suppress"           → emit nothing (strict-JSON agents on events whose
//                          output can't be used — avoids parse errors and
//                          user-facing systemMessage noise)
// Absent (no matching key and no "*") → plain stdout passthrough.
export const CONTEXT_ENVELOPES = {
  hookSpecificOutput: (text) => JSON.stringify({ hookSpecificOutput: { additionalContext: text } }),
  additionalContext: (text) => JSON.stringify({ additionalContext: text }),
  additional_context: (text) => JSON.stringify({ additional_context: text }),
};

// Resolve the envelope token for an agent + canonical event.
// Event key wins; "*" is the fallback; undefined → plain passthrough.
export function resolveEnvelope(agentConfig, canonicalEvent) {
  const map = agentConfig && agentConfig.context_envelope;
  if (!map) return undefined;
  if (canonicalEvent in map) return map[canonicalEvent];
  return map["*"];
}

// Per-agent event configuration metadata. Agents that support native hooks
// declare: config_file (where native hooks live), format (how to merge),
// canonical_to_native (event name translation), timeout_unit (s or ms).
export const EVENT_AGENTS = {
  opencode: {
    config_file: ".opencode/plugin/adlc-skills-events.ts",
    format: "ts-plugin",
    // opencode doesn't have lifecycle event hooks (session.start, etc.).
    // Instead it has fixed hook keys. Map canonical events to opencode hooks:
    //   session_start       → experimental.chat.messages.transform (first user message injection — active instructions)
    //   user_prompt_submit  → chat.message (fires on each user message)
    //   pre_tool_use        → tool.execute.before
    //   post_tool_use       → tool.execute.after
    //   session_end / stop  → (no equivalent; skip)
    canonical_to_native: {
      session_start: "experimental.chat.messages.transform",
      session_compact: null, // covered by the per-step messages.transform + live dedup (compaction self-heals)
      pre_tool_use: "tool.execute.before",
      post_tool_use: "tool.execute.after",
      session_end: null,
      user_prompt_submit: "chat.message",
      stop: null,
    },
    timeout_unit: "s",
  },
  "claude-code": {
    config_file: ".claude/settings.json",
    format: "json-nested",
    merge_key: "hooks",
    canonical_to_native: {
      session_start: "SessionStart",
      session_compact: null, // unmatched SessionStart fires on ALL sources incl. compact — a compact-matched second entry would double-inject
      pre_tool_use: "PreToolUse",
      post_tool_use: "PostToolUse",
      session_end: "SessionEnd",
      user_prompt_submit: "UserPromptSubmit",
      stop: "Stop",
    },
    timeout_unit: "s",
  },
  cursor: {
    config_file: ".cursor/hooks.json",
    format: "json-nested",
    merge_key: "hooks",
    canonical_to_native: {
      session_start: "sessionStart",
      session_compact: null, // no native compaction surface yet
      pre_tool_use: "preToolUse",
      post_tool_use: "postToolUse",
      session_end: "sessionEnd",
      user_prompt_submit: "beforeSubmitPrompt",
      stop: "stop",
    },
    timeout_unit: "s",
    // Cursor sessionStart: {"additional_context": ...} (top-level, snake_case).
    // beforeSubmitPrompt has no context output field (block/allow only), and
    // plain text on any hook fails Cursor's JSON parse — suppress the rest.
    context_envelope: {
      "*": "suppress",
      session_start: "additional_context",
    },
  },
  "github-copilot": {
    config_file: ".github/hooks/adlc-skills.json",
    format: "copilot-json",
    canonical_to_native: {
      session_start: "sessionStart",
      session_compact: null, // no native compaction surface yet
      pre_tool_use: "preToolUse",
      post_tool_use: "postToolUse",
      session_end: "sessionEnd",
      user_prompt_submit: "userPromptSubmitted",
      stop: "agentStop",
    },
    timeout_unit: "s",
    // Copilot sessionStart: {"additionalContext": ...} (top-level).
    // userPromptSubmitted output is NOT processed (per-prompt injection
    // impossible); non-JSON stdout is discarded harmlessly — no suppress.
    context_envelope: {
      session_start: "additionalContext",
    },
  },
  codex: {
    config_file: ".codex/config.toml",
    format: "toml",
    canonical_to_native: {
      session_start: "SessionStart",
      session_compact: null, // no native compaction surface yet
      pre_tool_use: "PreToolUse",
      post_tool_use: "PostToolUse",
      session_end: "SessionEnd",
      user_prompt_submit: "UserPromptSubmit",
      stop: "Stop",
    },
    timeout_unit: "s",
  },
  "gemini-cli": {
    config_file: ".gemini/settings.json",
    format: "json-nested",
    merge_key: "hooks",
    canonical_to_native: {
      session_start: "SessionStart",
      session_compact: null, // no native compaction surface yet
      pre_tool_use: "BeforeTool",
      post_tool_use: "AfterTool",
      session_end: "SessionEnd",
      user_prompt_submit: "BeforeAgent",
      stop: "AfterAgent",
    },
    timeout_unit: "ms",
    // Gemini mandates JSON-only stdout ("silence is mandatory"): plain text
    // becomes a user-facing systemMessage, never context. Inject via
    // hookSpecificOutput.additionalContext; suppress everything else.
    context_envelope: {
      "*": "suppress",
      session_start: "hookSpecificOutput",
      user_prompt_submit: "hookSpecificOutput",
    },
  },
  "qwen-code": {
    config_file: ".qwen/settings.json",
    format: "json-nested",
    merge_key: "hooks",
    canonical_to_native: {
      session_start: "SessionStart",
      session_compact: null, // no native compaction surface yet
      pre_tool_use: "PreToolUse",
      post_tool_use: "PostToolUse",
      session_end: "SessionEnd",
      user_prompt_submit: "UserPromptSubmit",
      stop: "Stop",
    },
    timeout_unit: "ms",
    // Qwen hooks are a JSON stdin/stdout protocol (Gemini-derived).
    context_envelope: {
      "*": "suppress",
      session_start: "hookSpecificOutput",
      user_prompt_submit: "hookSpecificOutput",
    },
  },
  devin: {
    config_file: ".devin/hooks.v1.json",
    format: "json-root-nested",
    canonical_to_native: {
      session_start: "SessionStart",
      session_compact: null, // no native compaction surface yet
      pre_tool_use: "PreToolUse",
      post_tool_use: "PostToolUse",
      session_end: "SessionEnd",
      user_prompt_submit: "UserPromptSubmit",
      stop: "Stop",
    },
    timeout_unit: "s",
    // Devin hooks.v1.json: JSON stdout protocol; additionalContext is the
    // documented injection field for SessionStart/UserPromptSubmit.
    context_envelope: {
      "*": "suppress",
      session_start: "hookSpecificOutput",
      user_prompt_submit: "hookSpecificOutput",
    },
  },
  "tabnine-cli": {
    config_file: ".tabnine/agent/settings.json",
    format: "json-nested",
    merge_key: "hooks",
    canonical_to_native: {
      session_start: "SessionStart",
      session_compact: null, // no native compaction surface yet
      pre_tool_use: "BeforeTool",
      post_tool_use: "AfterTool",
      session_end: "SessionEnd",
      user_prompt_submit: "BeforeAgent",
      stop: "AfterAgent",
    },
    timeout_unit: "ms",
    // Tabnine is Gemini-hooks-compatible (JSON-only stdout).
    context_envelope: {
      "*": "suppress",
      session_start: "hookSpecificOutput",
      user_prompt_submit: "hookSpecificOutput",
    },
  },
};

export function getEventAgentConfig(agentKey) {
  return EVENT_AGENTS[agentKey] || null;
}

export function getEventCapableAgents() {
  return Object.keys(EVENT_AGENTS);
}

// Marker injected into every native hook entry we generate, so idempotent
// merge and surgical teardown can identify our entries without a manifest DB.
export const EVENT_MARKER = "_adlc_skills_cli";

// Path where the generic dispatcher is shipped inside a project.
export const DISPATCHER_REL = ".agents/dispatcher.mjs";
