// Help texts for each command tree.

export function printCliHelp() {
  console.log(`
adlc-cli — dual-mode CLI for coding agents: skill management + agent execution

USAGE:
  adlc-cli <command> [options]

COMMANDS:
  skill add <source> -a <agent>    Install skills + generate commands + wire events
  skill upgrade [-a <agent>]       Regenerate commands from installed skills
  skill remove [-a <agent>]        Remove generated commands + event configs
  skill status [-a <agent>]        Report installed commands/events state
  agent run "<task>" [flags]        Run a coding agent headlessly with a task
  agent list                       List supported agents + run profiles
  version                           Print installed version
  help                              Show this help

AGENT RUN FLAGS:
  -a <agent>                       Agent: opencode | claude-code | goose | gemini (default: opencode)
  --model <id>                     Model id passed to the agent CLI
  --format <fmt>                   Output: text (default, human) | json (normalized JSONL)
  --cwd <path>                     Working directory (default: current)
  --timeout <seconds>              Kill agent after N seconds (CI safety)
  --require-approval <tools>       Tools that pause for human approval (comma-separated)
  -                                Read the task from stdin

INSTALL:
  npx adlc-cli skill add ...       one-off (no install needed)
  npm install -g adlc-cli          install as global binary

EXAMPLES:
  adlc-cli skill add tikalk/adlc-team-skills -a opencode
  adlc-cli agent run "Fix the failing auth test" -a opencode
  cat brief.md | adlc-cli agent run - --format json
`);
}

export function printSkillHelp() {
  console.log(`
USAGE:
  adlc-cli skill <command> [flags]

COMMANDS:
  add <source>       Install skills via npx skills + generate commands + events
  upgrade [--pull]   Re-generate commands from currently-installed skills
  remove             Remove generated commands + event configs
  status             Show what's installed per agent
  help               Show this help

FLAGS: -a, -g, --no-events, --prefix, --mode, --skill, --copy, --pull, -y
Run 'adlc-cli help' for the full list.
`);
}

export function printAgentHelp() {
  console.log(`
USAGE:
  adlc-cli agent <command> [flags]

COMMANDS:
  run "<task>"       Run a coding agent headlessly with a task
  list               List supported agents + run profiles

RUN FLAGS:
  -a <agent>          Agent key (default: opencode)
  --model <id>        Model id
  --format <fmt>      text (default) | json
  --cwd <path>        Working directory
  --timeout <s>       Timeout in seconds
  --require-approval <tools>  Comma-separated tool list
  -                   Read task from stdin
`);
}

export function printHelp() {
  console.log(`
adlc-skills-cli (legacy alias for adlc-cli)

USAGE:
  adlc-skills-cli add <source> -a <agent> [-a ...] [flags]
  adlc-skills-cli upgrade [-a <agent>]
  adlc-skills-cli remove [-a <agent>]
  adlc-skills-cli status [-a <agent>]
  adlc-skills-cli agents

COMMANDS:
  add <source>       Install skills via npx skills + generate commands + events
  upgrade [--pull]    Re-generate commands from currently-installed skills
  remove             Remove generated commands + event configs
  status             Show what's installed per agent
  agents             List supported agents

FLAGS:
  -a <agent>         Target agent (repeatable). Run 'agents' to list.
  -g, --global       Install to user directory instead of project
  --no-events        Skip event config generation
  --prefix <str>     Namespace command filenames
  --mode <mode>      inline (default) | wrapper
  --skill <name>     Install/generate for one skill only (use '*' for all)
  --copy             Copy files instead of symlinking
  --pull             Pull latest from source before regenerating (upgrade only)
  -y, --yes          Skip confirmation prompts

INSTALL:
  npx adlc-skills-cli add ...
  npm install -g adlc-skills-cli

EXAMPLES:
  adlc-skills-cli add tikalk/adlc-team-skills -a opencode
  adlc-skills-cli status
  adlc-skills-cli agents
`);
}
