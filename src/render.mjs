// Rendering: text-mode event output + inline HITL prompt.
import { createInterface } from "node:readline";

export function renderTextEvent(event) {
  switch (event.type) {
    case "message":
      process.stdout.write(String(event.text ?? ""));
      break;
    case "tool":
      if (event.phase === "call") {
        console.log(`\n[tool] ${event.name ?? "?"}(${JSON.stringify(event.arguments ?? {}).slice(0, 200)})`);
      } else {
        console.log(`[tool] → ${String(event.result ?? "").slice(0, 200)}`);
      }
      break;
    case "permission_request":
      console.log(`\n[permission_request] tool="${event.tool}" id=${event.request_id}`);
      break;
    case "error":
      console.error(`[error] ${event.message ?? ""}`);
      break;
    case "complete":
      break;
    case "log":
      console.log(`[log] ${event.message ?? JSON.stringify(event).slice(0, 300)}`);
      break;
  }
}

export async function handleInlineHitl(event, kill) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `\n[HITL] Allow tool "${event.tool}"? (id: ${event.request_id}) [a]llow / [o]nce / [d]eny / a[l]ways: `,
      (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        if (a === "d" || a === "deny") {
          kill("SIGTERM");
        }
        resolve();
      },
    );
  });
}
