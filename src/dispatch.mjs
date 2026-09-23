// Command dispatch: parse args, route to skill/agent/version/help trees.

import { AGENTS } from "./registry.mjs";
import { cmdAdd, cmdUpdate, cmdRemove, cmdStatus } from "./commands/skills.mjs";
import { cmdTeamSetup, cmdTeamUpdate, cmdTeamRepair } from "./commands/team.mjs";
import { cmdAgentRun, cmdAgentList } from "./commands/agent.mjs";
import { cmdWorkspaceSetup, cmdWorkspaceInit, cmdWorkspaceStatus } from "./commands/workspace.mjs";
import {
  printCliHelp,
  printSkillsHelp,
  printTeamHelp,
  printAgentHelp,
  printWorkspaceHelp,
  printHelp,
} from "./help.mjs";

const VERSION = "1.0.2";

export async function dispatch(argv, mode = "legacy") {
  const parsed = parseArgs(argv);
  return mode === "cli" ? runNewTree(parsed, argv) : runLegacyTree(parsed);
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
    default:
      printHelp();
      return 0;
  }
}

function runNewTree({ command, args, flags }, argv) {
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
          console.error(`Unknown skills command: "${sub}"`);
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
          console.error(`Unknown team command: "${sub}"`);
          printTeamHelp();
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
          console.error(`Unknown agent command: "${sub}"`);
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
          console.error(`Unknown workspace command: "${sub}"`);
          printWorkspaceHelp();
          return 1;
      }
    }
    case "version":
      console.log(`adlc-cli ${VERSION}`);
      return 0;
    case "help":
    default:
      printCliHelp();
      return 0;
  }
}

function parseArgs(argv) {
  const command = argv[0] || "help";
  const rest = argv.slice(1);

  const args = [];
  const flags = { agents: [] };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === "-a" || arg === "--agent") {
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
    } else if (!arg.startsWith("-")) {
      args.push(arg);
    }
  }

  return { command, args, flags };
}
