// Help texts for each command tree.

export function printCliHelp() {
  console.log(`
adlc-cli — dual-mode CLI for coding agents: skill management + agent execution

USAGE:
  adlc-cli <command> [options]

COMMANDS:
  skills add <source> -a <agent>   Install skills + generate commands + wire events
  skills update [-a <agent>]       Regenerate commands from installed skills
  skills remove [-a <agent>]       Remove generated commands + event configs
  skills status [-a <agent>]       Report installed commands/events state
  team setup <source> -a <agent>   Install skills + configure team-ai-directives
  team update                      Git pull + skills update + confidence update
  team repair                      Validate and repair team-ai-directives state
  agent run "<task>" [flags]       Run a coding agent headlessly with a task
  agent list                       List supported agents + run profiles
  workspace setup [file]            Apply workspace file (git modules, skills, commands, goal)
  workspace init [--link]          Brownfield init: .adlc/ structure + discover child repos
  workspace status                 Audit workspace health (branch, dirty, unpushed, drift)
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
  npx adlc-cli skills add ...      one-off (no install needed)
  npm install -g adlc-cli          install as global binary

EXAMPLES:
  adlc-cli skills add tikalk/adlc-team-skills -a opencode
  adlc-cli team setup tikalk/adlc-team-skills -a opencode
  adlc-cli agent run "Fix the failing auth test" -a opencode
  adlc-cli workspace setup -a opencode --dry-run
  cat brief.md | adlc-cli agent run - --format json
`);
}

export function printSkillsHelp() {
  console.log(`
USAGE:
  adlc-cli skills <command> [flags]

COMMANDS:
  add <source>       Install skills via npx skills + generate commands + events
  update [--pull]    Re-generate commands from currently-installed skills
  remove             Remove generated commands + event configs
  (no subcommand)    Show what's installed per agent
  help               Show this help

FLAGS: -a, -g, --no-events, --prefix, --mode, --skill, --copy, --pull, -y
Run 'adlc-cli help' for the full list.
`);
}

export function printTeamHelp() {
  console.log(`
USAGE:
  adlc-cli team <command> [flags]

COMMANDS:
  setup <source> -a <agent>   Install skills + configure team-ai-directives
  update                      Git pull directives + update skills + confidence
  repair                      Validate and repair team-ai-directives state

REPAIR FLAGS:
  --update-confidence         Update confidence scores (deterministic, no agent)
  --validate-drafts           Validate draft files without modifying them
  --build-to-delete            Propose rules the model no longer needs
  -a <agent>                  Agent for interactive repair (default: from init-options)

SETUP FLAGS:
  --skip-skills               Skip skill installation (just configure directives)
  -a <agent>                  Agent key (default: from init-options.json)

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

export function printWorkspaceHelp() {
  console.log(`
USAGE:
  adlc-cli workspace <command> [flags]

COMMANDS:
  setup [file]        Apply workspace file (.adlc/workspace.yml, path, or URL)
  init                Brownfield init: create .adlc/ structure, discover child repos
  status              Audit workspace health (branch, dirty, unpushed, SHA drift)

SETUP FLAGS:
  -a <agent>          Agent key (default: workspace agent:, then init-options.json)
  --dry-run           Print planned actions without executing

INIT FLAGS:
  -a <agent>          Agent key (default: from init-options.json)
  --link              Register discovered child repos as submodules
  --ignore-only       Add child repos to .gitignore instead of submodules
  --dry-run           Preview without executing

WORKSPACE FILE (.adlc/workspace.yml):
  workspace.git[]     repos to clone (repo, path, branch, ref) — deterministic
  workspace.dirs[]    empty directories to create (greenfield scaffolding) — deterministic
  workspace.init      create .adlc/ structure via /workspace skill — agent-led
  workspace.link      register cloned repos as submodules — agent-led
  skills.sources[]    skill sources installed via skills add — deterministic
  commands[]          sequential commands: skills add | team setup | agent run
  goal                first-boot workspace-finishing prompt — agent-led, runs
                      ONLY when this run assembled the workspace (cloned a repo
                      or created a dir). Re-runs converge and skip it silently.

  Source resolution: explicit arg > ADLC_WORKSPACE_FILE env > local file
  When the goal is absent or skipped, run your intent via
  'adlc-cli agent run "<prompt>"' after setup.

EXAMPLES:
  adlc-cli workspace setup                          # use .adlc/workspace.yml
  adlc-cli workspace setup https://host/w.yml       # fetch workspace file over HTTP
  adlc-cli workspace setup -a opencode --dry-run    # preview planned actions
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
