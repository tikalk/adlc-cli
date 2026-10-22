// Rendering: text-mode event output + inline HITL prompt.
import { createInterface } from "node:readline";
import { out, err, style, tint, sym, ACCENT } from "./ui/index.mjs";

export function renderTextEvent(event) {
  switch (event.type) {
    case "message":
      process.stdout.write(String(event.text ?? ""));
      break;
    case "tool":
      if (event.phase === "call") {
        out(
          `${style(sym.step, ACCENT)} ${style("tool", "bold")} ${tint(event.name ?? "?", ACCENT)} ${tint(
            JSON.stringify(event.arguments ?? {}).slice(0, 200),
            "gray",
          )}`,
        );
      } else {
        out(
          `${style(sym.arrow, "gray")} ${style("tool", "bold")} ${tint(
            String(event.result ?? "").slice(0, 200),
            "gray",
          )}`,
        );
      }
      break;
    case "permission_request":
      out("");
      out(
        `${style(sym.warn, "yellow")} ${style("permission_request", "bold")} ${tint(
          `tool="${event.tool}" id=${event.request_id}`,
          "gray",
        )}`,
      );
      break;
    case "error":
      err(`${style(sym.failure, "red")} ${style("error", "bold")} ${tint(event.message ?? "", "gray")}`);
      break;
    case "complete":
      break;
    case "log":
      out(`${style(sym.info, "gray")} ${tint(event.message ?? JSON.stringify(event).slice(0, 300), "gray")}`);
      break;
  }
}

export async function handleInlineHitl(event, kill) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `\n${style(sym.warn, "yellow")} ${style("HITL", "bold")} ${tint(
        `Allow tool "${event.tool}"? (id: ${event.request_id})`,
        "gray",
      )} ${style("[a]llow / [o]nce / [d]eny / a[l]ways", ACCENT)}: `,
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
