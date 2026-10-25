// The coder provider: routes, transport selection, handle adapter, and the
// coder-specific help rows. Everything that knows the word "coder" lives in
// this directory; the generic dispatcher only sees a registry entry.

import {
  cmdCoderWorkspaceSetup,
  cmdCoderAgentRun,
  cmdCoderWorkflowRun,
  resolveCoderTransport,
} from "./route.mjs";
import { createCoderSshTransport } from "./ssh.mjs";
import { createCoderProvider } from "./handle.mjs";

// Raw argv after `command` (e.g. ["run", "--input", "k=v", "factory"]).
function afterCommand(argv, command) {
  const index = argv.indexOf(command);
  return index < 0 ? argv : argv.slice(index + 1);
}

// Raw argv after `command sub` (e.g. the task and flags after `agent run`).
function afterSubcommand(argv, command, sub) {
  const after = afterCommand(argv, command);
  const index = after.indexOf(sub);
  return index < 0 ? after : after.slice(index + 1);
}

// Route descriptor: command -> subcommand -> handler. "*" is a whole-command
// route (the top-level `run` alias). The dispatcher supplies the parsed
// context and never branches on a provider name.
export const routes = {
  workspace: {
    setup: ({ args, flags, argv }) => cmdCoderWorkspaceSetup(args.slice(1), flags, argv),
  },
  agent: {
    run: ({ argv }) => cmdCoderAgentRun(afterSubcommand(argv, "agent", "run"), argv),
  },
  run: {
    "*": ({ argv }) => cmdCoderAgentRun(argv.slice(1), argv),
  },
  workflow: {
    run: ({ args, flags, argv }) =>
      cmdCoderWorkflowRun(args.slice(1), flags, afterCommand(argv, "workflow")),
  },
};

export const help = {
  agent: [
    [
      "--provider coder",
      "Run the task on the remote workspace via the provider transport (SSH). Secrets stay env-only on the wire and are redacted from the output.",
    ],
    [
      "--workspace <name>",
      "Target workspace (default: the workspace file's name, else 'default').",
    ],
  ],
  workspace: [
    [
      "--provider coder",
      "Route through the coder provider transport (SSH). The workspace file stays location-free — a 'provider:' key inside it is rejected, never ignored.",
    ],
    ["--workspace <name>", "Target workspace (default: the workspace file's name)."],
    [
      "--dry-run",
      "Local preview only. The remote provider path refuses it: a dry-run must not provision or execute remotely.",
    ],
  ],
  workflow: [
    [
      "--provider coder",
      "Run the workflow on the remote workspace via the provider transport (SSH). --input, --format, and --headless are forwarded; output is streamed and redacted.",
    ],
    [
      "--workspace <name>",
      "Target workspace (default: the workspace file's name). A missing handle is refused rather than provisioning a second machine.",
    ],
  ],
  examples: [
    ["adlc-cli workspace setup --provider coder", "remote workspace setup"],
    ["adlc-cli workflow run factory --provider coder", "remote workflow"],
  ],
};

export function createTransport() {
  return resolveCoderTransport().transport;
}

export const provider = {
  name: "coder",
  routes,
  createTransport,
  help,
};

export { createCoderProvider, createCoderSshTransport, resolveCoderTransport };
export default provider;
