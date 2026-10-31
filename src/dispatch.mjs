// Command dispatch: parse args, route to skill/agent/version/help trees.

import { createRequire } from "node:module";
import { AGENTS } from "./registry.mjs";
import { cmdAdd, cmdUpdate, cmdRemove, cmdStatus } from "./commands/skills.mjs";
import { cmdTeamSetup, cmdTeamUpdate, cmdTeamRepair } from "./commands/team.mjs";
import { cmdFactorySetup } from "./commands/factory.mjs";
import { cmdAgentRun, cmdAgentList } from "./commands/agent.mjs";
import { cmdWorkspaceSetup, cmdWorkspaceInit, cmdWorkspaceStatus } from "./commands/workspace.mjs";
import { cmdWorkflow } from "./commands/workflow.mjs";
import { cmdMcpInstall } from "./commands/mcp.mjs";
import {
  printCliHelp,
  printSkillsHelp,
  printTeamHelp,
  printFactoryHelp,
  printAgentHelp,
  printWorkspaceHelp,
  printWorkflowHelp,
  printMcpHelp,
  printHelp,
} from "./help.mjs";
import { setColorMode, out, err, style, combine } from "./ui/index.mjs";
import {
  resolveProvider,
  providerNames,
  providerCommands,
  providerRoutes,
} from "./providers/registry.mjs";

// Single source of truth: package.json (drifts when hard-coded — v2.1.0
// shipped printing "2.0.0"). dispatch.mjs lives in src/, so ../package.json
// resolves the repo root both in-repo and when installed.
const { version: VERSION } = createRequire(import.meta.url)("../package.json");

export async function dispatch(argv, mode = "legacy") {
  const parsed = parseArgs(argv);
  applyColorMode(argv, parsed.flags);
  return mode === "cli" ? runNewTree(parsed, argv) : runLegacyTree(parsed);
}

// `--format json` output is a machine contract (ADR-406 freezes the JSONL
// vocabulary), so color is refused outright — no ANSI byte may reach stdout.
// `--no-color` / `--color` override TTY detection for human-facing runs.
function applyColorMode(argv, flags) {
  if (requestsJsonFormat(argv)) {
    setColorMode("never");
  } else if (flags.noColor) {
    setColorMode("never");
  } else if (flags.color) {
    setColorMode("always");
  } else {
    setColorMode("auto");
  }
}

function requestsJsonFormat(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format=json") return true;
    if (arg === "--format" && argv[i + 1] === "json") return true;
  }
  return false;
}

function runLegacyTree({ command, args, flags }) {
  switch (command) {
    case "add":
      return cmdAdd(args, flags);
    case "upgrade":
      return cmdUpdate(args, flags);
    case "remove":
      return cmdRemove(args, flags);
    case "status":
      return cmdStatus(args, flags);
    case "agents":
      return cmdAgentList();
    case "help":
      printHelp();
      return 0;
    default:
      err(combine(style("Unknown", "red"), ' ', style(`command: "${command}"`, "gray")));
      printHelp();
      return 1;
  }
}

async function runNewTree({ command, args, flags }, argv) {
  // `--provider` selects a remote transport. Resolve it from the registry:
  // adding a provider must not require editing this generic dispatcher.
  // An unknown value on a provider-capable command must be refused —
  // silently running locally would hand the operator a local run they asked
  // for remotely.
  const providerCapableCommands = providerCommands();
  const providerRequested = flags?.providerSpecified === true;
  if (
    providerRequested &&
    providerCapableCommands.includes(command) &&
    (typeof flags.provider !== "string" || flags.provider.trim() === "")
  ) {
    console.error("Error: --provider requires a provider name.");
    return 1;
  }
  const provider = providerRequested ? resolveProvider(flags.provider) : null;
  if (providerRequested && !provider && providerCapableCommands.includes(command)) {
    console.error(
      `Error: unknown --provider "${flags.provider}" ` +
      `(known: ${providerNames().join(", ")}) for '${command}'.`
    );
    return 1;
  }
  if (provider) {
    const route = provider.routes?.[command];
    const sub = command === "run" ? "*" : (args[0] ?? "");
    const handler = route?.[sub];
    if (!handler) {
      // A known provider on a command it cannot serve must not silently run
      // locally — the operator asked for a remote workspace.
      console.error(
        `Error: --provider ${provider.name} is not supported for '${command}` +
        `${args[0] ? ` ${args[0]}` : ""}' ` +
        `(provider routes: ${providerRoutes(provider).join(", ")}).`
      );
      return 1;
    }
    return handler({ command, args, flags, argv });
  }
  switch (command) {
    case "skills": {
      const sub = args[0] ?? "status";
      const rest = args.slice(1);
      switch (sub) {
        case "add":
          return cmdAdd(rest, flags);
        case "update":
          return cmdUpdate(rest, flags);
        case "remove":
          return cmdRemove(rest, flags);
        case "status":
          return cmdStatus(rest, flags);
        case "help":
          printSkillsHelp();
          return 0;
        default:
          err(combine(style("Unknown", "red"), ' ', style(`skills command: "${sub}"`, "gray")));
          printSkillsHelp();
          return 1;
      }
    }
    case "team": {
      const sub = args[0] ?? "help";
      const rest = args.slice(1);
      switch (sub) {
        case "setup":
          return cmdTeamSetup(rest, flags);
        case "update":
          return cmdTeamUpdate(rest, flags);
        case "repair":
          return cmdTeamRepair(rest, flags);
        case "help":
          printTeamHelp();
          return 0;
        default:
          err(combine(style("Unknown", "red"), ' ', style(`team command: "${sub}"`, "gray")));
          printTeamHelp();
          return 1;
      }
    }
    case "factory": {
      const sub = args[0] ?? "help";
      const rest = args.slice(1);
      switch (sub) {
        case "setup":
          return cmdFactorySetup(rest, flags);
        case "help":
          printFactoryHelp();
          return 0;
        default:
          err(combine(style("Unknown", "red"), ' ', style(`factory command: "${sub}"`, "gray")));
          printFactoryHelp();
          return 1;
      }
    }
    case "agent": {
      const sub = args[0] ?? "help";
      const rest = argv.slice(argv.indexOf(sub) + 1);
      switch (sub) {
        case "run":
          return cmdAgentRun(rest);
        case "list":
          return cmdAgentList();
        case "help":
          printAgentHelp();
          return 0;
        default:
          err(combine(style("Unknown", "red"), ' ', style(`agent command: "${sub}"`, "gray")));
          printAgentHelp();
          return 1;
      }
    }
    // Top-level `run` — compat alias for `agent run` (runtime contract, ADR-368).
    case "run":
      return cmdAgentRun(argv.slice(1));
    case "workspace": {
      const sub = args[0] ?? "status";
      const rest = args.slice(1);
      switch (sub) {
        case "setup":
          return cmdWorkspaceSetup(rest, flags);
        case "init":
          return cmdWorkspaceInit(rest, flags);
        case "status":
          return cmdWorkspaceStatus(rest, flags);
        case "help":
          printWorkspaceHelp();
          return 0;
        default:
          err(combine(style("Unknown", "red"), ' ', style(`workspace command: "${sub}"`, "gray")));
          printWorkspaceHelp();
          return 1;
      }
    }
    case "workflow": {
      const sub = args[0] ?? "help";
      const rest = args.slice(1);
      // Raw argv for repeatable --input parsing (agent.mjs precedent).
      const workflowArgv = argv.slice(argv.indexOf("workflow") + 1);
      switch (sub) {
        case "run":
        case "resume":
        case "status":
        case "validate":
        case "state":
        case "park":
        case "restore":
          return cmdWorkflow([sub, ...rest], flags, workflowArgv);
        case "help":
          printWorkflowHelp();
          return 0;
        default:
          err(combine(style("Unknown", "red"), ' ', style(`workflow command: "${sub}"`, "gray")));
          printWorkflowHelp();
          return 1;
      }
    }
    case "mcp": {
      const sub = args[0] ?? "help";
      const rest = args.slice(1);
      switch (sub) {
        case "install":
          return cmdMcpInstall(rest, flags);
        case "help":
          printMcpHelp();
          return 0;
        default:
          err(combine(style("Unknown", "red"), ' ', style(`mcp command: "${sub}"`, "gray")));
          printMcpHelp();
          return 1;
      }
    }
    case "version":
      out(`adlc-cli ${VERSION}`);
      return 0;
    case "help":
      printCliHelp();
      return 0;
    default:
      err(combine(style("Unknown", "red"), ' ', style(`command: "${command}"`, "gray")));
      printCliHelp();
      return 1;
  }
}

export function parseArgs(argv) {
  const command = argv[0] || "help";
  const rest = argv.slice(1);

  const args = [];
  const flags = { agents: [] };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === "-a" || arg === "--agent" || arg === "--agents") {
      flags.agents.push(rest[++i]);
    } else if (arg === "-g" || arg === "--global") {
      flags.global = true;
    } else if (arg === "--no-events") {
      flags.noEvents = true;
    } else if (arg === "--prefix") {
      flags.prefix = rest[++i];
    } else if (arg === "--mode") {
      flags.mode = rest[++i];
    } else if (arg === "--skill" || arg === "-s") {
      flags.skill = rest[++i];
    } else if (arg === "--copy") {
      flags.copy = true;
    } else if (arg === "--pull") {
      flags.pull = true;
    } else if (arg === "-y" || arg === "--yes") {
      flags.yes = true;
    } else if (arg === "--skip-skills") {
      flags.skipSkills = true;
    } else if (arg === "--directives") {
      flags.directives = rest[++i];
    } else if (arg.startsWith("--directives=")) {
      flags.directives = arg.slice("--directives=".length);
    } else if (arg === "--provider") {
      flags.providerSpecified = true;
      flags.provider = rest[++i];
    } else if (arg.startsWith("--provider=")) {
      flags.providerSpecified = true;
      flags.provider = arg.slice("--provider=".length);
    } else if (arg === "--workspace" || arg === "-w") {
      flags.workspaceSpecified = true;
      flags.workspace = rest[++i];
    } else if (arg.startsWith("--workspace=")) {
      flags.workspaceSpecified = true;
      flags.workspace = arg.slice("--workspace=".length);
    } else if (arg === "--input" || arg === "-i") {
      flags.inputs = flags.inputs ?? [];
      flags.inputs.push(rest[++i]);
    } else if (arg.startsWith("--input=")) {
      flags.inputs = flags.inputs ?? [];
      flags.inputs.push(arg.slice("--input=".length));
    } else if (arg === "--update-confidence") {
      flags.updateConfidence = true;
    } else if (arg === "--build-to-delete") {
      flags.buildToDelete = true;
    } else if (arg === "--validate-drafts") {
      flags.validateDrafts = true;
    } else if (arg === "--commands-dir") {
      flags.commandsDir = rest[++i];
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--link") {
      flags.link = true;
    } else if (arg === "--ignore-only") {
      flags.ignoreOnly = true;
    } else if (arg === "--format") {
      flags.format = rest[++i];
    } else if (arg.startsWith("--format=")) {
      flags.format = arg.slice("--format=".length);
    } else if (arg === "--no-color") {
      flags.noColor = true;
    } else if (arg === "--color") {
      flags.color = true;
    } else if (!arg.startsWith("-")) {
      args.push(arg);
    }
  }

  return { command, args, flags };
}
