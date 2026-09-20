// Native JSONL → normalized event objects.
// Ported from agentic-container/packages/runtime/src/engine/process.ts
// (mapOpenCodeEvent L251-282, mapStreamJsonEvent L284-338).
// Canonical shapes (extras stripped for agent-agnosticism):
//   message{text} | tool{phase:"call"|"result",name?,arguments?,result?}
//   permission_request{tool,request_id} | error{message} | complete{} | log{message?}

export function normalizeLine(rawLine, outputFormat) {
  const trimmed = rawLine.trim();
  if (!trimmed) return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ type: "log", message: trimmed }];
  }

  switch (outputFormat) {
    case "json":
      return mapOpenCode(parsed);
    case "stream-json":
      return mapStreamJson(parsed);
    default:
      return [{ type: "log", message: trimmed }];
  }
}

function mapOpenCode(raw) {
  const type = raw.type;
  switch (type) {
    case "step_start":
      return []; // suppress — lifecycle noise, no agent content
    case "text": {
      const text = raw.part?.text ?? raw.content ?? raw.text ?? "";
      return [{ type: "message", text: String(text) }];
    }
    case "tool_use": {
      const part = raw.part ?? {};
      const toolName = part.tool ?? raw.name;
      const state = part.state ?? {};
      const events = [];
      // Tool calls and results arrive combined in one opencode event
      if (state.input !== undefined) {
        events.push({ type: "tool", phase: "call", name: toolName, arguments: state.input });
      }
      if (state.output !== undefined) {
        events.push({ type: "tool", phase: "result", result: state.output });
      }
      return events.length > 0 ? events : [{ type: "tool", phase: "call", name: toolName }];
    }
    case "step_finish": {
      const reason = raw.part?.reason ?? raw.reason;
      // "stop" = agent finished the task; "tool-calls" = just a tool call boundary (suppress)
      if (reason === "stop") return [{ type: "complete" }];
      return []; // suppress — intermediate step boundary
    }
    case "error":
      return [{ type: "error", message: raw.message ?? raw.part?.error ?? String(raw) }];
    case "complete":
    case "completed":
      return [{ type: "complete" }];
    default:
      // Spread after type/raw_type to prevent the raw.type from overwriting "log"
      return [{ ...raw, type: "log", raw_type: type }];
  }
}

function mapStreamJson(raw) {
  const type = raw.type;
  switch (type) {
    case "assistant":
    case "text": {
      const content = raw.content ?? raw.message?.content ?? raw.text ?? "";
      const text = Array.isArray(content)
        ? content.map((c) => c.text ?? "").join("")
        : String(content);
      return [{ type: "message", text }];
    }
    case "tool_use":
    case "tool_call":
      return [{ type: "tool", phase: "call", name: raw.name ?? raw.tool_name, arguments: raw.input ?? raw.arguments }];
    case "tool_result":
    case "toolResult": {
      const content = raw.content ?? raw.output ?? raw.result;
      const result = Array.isArray(content)
        ? content.map((c) => c.text ?? "").join("")
        : content;
      return [{ type: "tool", phase: "result", result }];
    }
    case "can_use_tool":
    case "permission":
    case "permission_request":
      return [{ type: "permission_request", tool: raw.tool ?? raw.tool_name ?? raw.name, request_id: raw.id ?? raw.request_id }];
    case "error":
      return [{ type: "error", message: raw.message ?? raw.error ?? String(raw) }];
    case "result":
      return [{ type: "complete" }];
    case "system":
      return [{ type: "log", message: raw.subtype ?? JSON.stringify(raw) }];
    default:
      if (type !== "init" && type !== "ping") {
        return [{ ...raw, type: "log", raw_type: type }];
      }
      return [];
  }
}
