// Help texts for each command tree.
//
// Rendered as bordered panels so the shape reads at a glance in a terminal —
// the same layout the specify CLI uses for its help output.

import { out, panel, style, tint, combine, wrapText, terminalWidth, ACCENT } from "./ui/index.mjs";

/**
 * Render a titled panel of body lines.
 * @param {string} title
 * @param {string[]} lines
 */
function section(title, lines) {
  return panel({ title, lines });
}

/**
 * Lay out `label  description` pairs with the labels aligned in a column.
 * Descriptions wrap with a hanging indent so the column stays readable in a
 * narrow terminal.
 * @param {Array<[string, string]>} rows
 * @param {string} [labelColor]
 */
function pairs(rows, labelColor = ACCENT) {
  const labelWidth = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  const descWidth = Math.max(24, terminalWidth() - labelWidth - 6);
  const out = [];
  for (const [label, description] of rows) {
    if (!description) {
      out.push(style(label, labelColor));
      continue;
    }
    const chunks = wrapText(description, descWidth);
    out.push(
      combine(
        style(label, labelColor),
        " ".repeat(labelWidth - label.length),
        "  ",
        tint(chunks[0], "gray"),
      ),
    );
    for (const chunk of chunks.slice(1)) {
      out.push(combine(" ".repeat(labelWidth + 2), tint(chunk, "gray")));
    }
  }
  return out;
}

export function printCliHelp() {
  out("");
  out(
    `${style("adlc-cli", ACCENT, "bold")} ${tint("— dual-mode CLI for coding agents: skill management + agent execution", "gray")}`,
  );
  out("");

  out(
    section("Usage", [tint("adlc-cli <command> [options]", "bold")]),
  );

  out(
    section("Commands", [
      ...pairs([
        ["skills add <source> -a <agent>", "Install skills + generate commands + wire events"],
        ["skills update [-a <agent>]", "Regenerate commands from installed skills"],
        ["skills remove [-a <agent>]", "Remove generated commands + event configs"],
        ["skills status [-a <agent>]", "Report installed commands/events state"],
        ["team setup <source> -a <agent>", "Install skills + configure team-ai-directives"],
        ["team update", "Git pull + skills update + confidence update"],
        ["team repair", "Validate and repair team-ai-directives state"],
        ["factory setup [--provider <p>] -a <agent>", "Configure factory tracker provider"],
        ['agent run "<task>" [flags]', "Run a coding agent headlessly with a task"],
        ["agent list", "List supported agents + run profiles"],
        ["workspace setup [file]", "Apply workspace file (git modules, skills, commands, goal)"],
        ["workspace init [--link]", "Brownfield init: .adlc/ structure + discover child repos"],
        ["workspace status", "Audit workspace health (branch, dirty, unpushed, drift)"],
        ["workflow run <src> --input k=v", "Execute a workflow (gates pause+resume; --format json streams events)"],
        ["workflow resume <run_id>", "Resume a paused/failed run (optionally with --input)"],
        ["workflow park <run_id>", "Save a gate-paused run + thread handle to the remote run ref"],
        ["workflow restore <run_id>", "Restore a parked run from the remote run ref"],
        ["workflow status [run_id]", "List runs / show one run's step states"],
        ["workflow validate <src>", "Validate a workflow definition (--headless checks gate verdicts)"],
        ["workflow state …", "LLM-executor helpers: start/advance/pause/fail/show"],
        ["version", "Print installed version"],
        ["help", "Show this help"],
      ]),
    ]),
  );

  out(
    section("Agent Run Flags", [
      ...pairs([
        ["-a <agent>", "Agent: opencode | claude-code | goose | gemini (default: opencode)"],
        ["--model <id>", "Model id passed to the agent CLI"],
        ["--format <fmt>", "Output: text (default, human) | json (normalized JSONL)"],
        ["--cwd <path>", "Working directory (default: current)"],
        ["--timeout <seconds>", "Kill agent after N seconds (CI safety)"],
        ["--require-approval <tools>", "Tools that pause for human approval (comma-separated)"],
        ["-", "Read the task from stdin"],
      ]),
    ]),
  );

  out(
    section("Install", [
      ...pairs([
        ["npx adlc-cli skills add ...", "one-off (no install needed)"],
        ["npm install -g adlc-cli", "install as global binary"],
      ]),
    ]),
  );

  out(
    section("Color Control", [
      ...pairs([
        ["--color", "Force ANSI color on, even when piped"],
        ["--no-color", "Force ANSI color off"],
        ["NO_COLOR=1", "Disable color (any value; no-color.org)"],
        ["FORCE_COLOR=1", "Force color on (overrides TTY detection)"],
        ["--format json", "Always disables color — the JSONL stream is a machine contract"],
      ]),
      tint("Color follows TTY detection by default: on in a terminal, off when piped.", "gray"),
    ]),
  );

  out(
    section("Examples", [
      ...pairs([
        ["adlc-cli skills add tikalk/adlc-team-skills -a opencode", ""],
        ["adlc-cli team setup tikalk/adlc-team-skills -a opencode", ""],
        ['adlc-cli agent run "Fix the failing auth test" -a opencode', ""],
        ["adlc-cli workspace setup -a opencode --dry-run", ""],
        ["cat brief.md | adlc-cli agent run - --format json", ""],
      ]),
    ]),
  );
  out("");
}

export function printSkillsHelp() {
  out("");
  out(section("Usage", [tint("adlc-cli skills <command> [flags]", "bold")]));
  out(
    section("Commands", [
      ...pairs([
        ["add <source>", "Install skills via npx skills + generate commands + events"],
        ["update [--pull]", "Re-generate commands from currently-installed skills"],
        ["remove", "Remove generated commands + event configs"],
        ["(no subcommand)", "Show what's installed per agent"],
        ["help", "Show this help"],
      ]),
    ]),
  );
  out(
    section("Flags", [
      tint(
        "-a, -g, --no-events, --prefix, --mode, --skill, --copy, --pull, -y",
        "bold",
      ),
    ]),
  );
  out(section("More", [tint("Run 'adlc-cli help' for the full list.", "gray")]));
  out("");
}

export function printTeamHelp() {
  out("");
  out(section("Usage", [tint("adlc-cli team <command> [flags]", "bold")]));
  out(
    section("Commands", [
      ...pairs([
        ["setup <source> -a <agent>", "Install skills + configure team-ai-directives"],
        ["update", "Git pull directives + update skills + confidence"],
        ["repair", "Validate and repair team-ai-directives state"],
      ]),
    ]),
  );
  out(
    section("Repair Flags", [
      ...pairs([
        ["--update-confidence", "Update confidence scores (deterministic, no agent)"],
        ["--validate-drafts", "Validate draft files without modifying them"],
        ["--build-to-delete", "Propose rules the model no longer needs"],
        ["-a <agent>", "Agent for interactive repair (default: from init-options)"],
      ]),
    ]),
  );
  out(
    section("Setup Flags", [
      ...pairs([
        ["--skip-skills", "Skip skill installation (just configure directives)"],
        ["-a <agent>", "Agent key (default: from init-options.json)"],
      ]),
    ]),
  );
  out(section("More", [tint("Run 'adlc-cli help' for the full list.", "gray")]));
  out("");
}

export function printFactoryHelp() {
  out("");
  out(section("Usage", [tint("adlc-cli factory <command> [flags]", "bold")]));
  out(
    section("Commands", [
      ...pairs([
        ["setup [--provider <p>] -a <agent>", "Configure factory tracker provider (.adlc/issues-provider.yml)"],
        ["help", "Show this help"],
      ]),
    ]),
  );
  out(
    section("Setup Flags", [
      ...pairs([
        ["--provider <p>", "Preselect provider: github | gitlab | linear | jira (skips the question, headless-safe)"],
        ["-a <agent>", "Agent key (default: from init-options.json)"],
      ]),
    ]),
  );
  out(section("More", [tint("Run 'adlc-cli help' for the full list.", "gray")]));
  out("");
}

export function printAgentHelp() {
  out("");
  out(section("Usage", [tint("adlc-cli agent <command> [flags]", "bold")]));
  out(
    section("Commands", [
      ...pairs([
        ['run "<task>"', "Run a coding agent headlessly with a task"],
        ["list", "List supported agents + run profiles"],
      ]),
    ]),
  );
  out(
    section("Run Flags", [
      ...pairs([
        ["-a <agent>", "Agent key (default: opencode)"],
        ["--model <id>", "Model id"],
        ["--format <fmt>", "text (default) | json"],
        ["--cwd <path>", "Working directory"],
        ["--timeout <s>", "Timeout in seconds"],
        ["--require-approval <tools>", "Comma-separated tool list"],
        ["-", "Read task from stdin"],
      ]),
    ]),
  );
  out("");
}

export function printWorkspaceHelp() {
  out("");
  out(section("Usage", [tint("adlc-cli workspace <command> [flags]", "bold")]));
  out(
    section("Commands", [
      ...pairs([
        ["setup [file]", "Apply workspace file (.adlc/workspace.yml, path, or URL)"],
        ["init", "Brownfield init: create .adlc/ structure, discover child repos"],
        ["status", "Audit workspace health (branch, dirty, unpushed, SHA drift)"],
      ]),
    ]),
  );
  out(
    section("Setup Flags", [
      ...pairs([
        ["-a <agent>", "Agent key (default: workspace agent:, then init-options.json)"],
        ["--dry-run", "Print planned actions without executing"],
      ]),
    ]),
  );
  out(
    section("Init Flags", [
      ...pairs([
        ["-a <agent>", "Agent key (default: from init-options.json)"],
        ["--link", "Register discovered child repos as submodules"],
        ["--ignore-only", "Add child repos to .gitignore instead of submodules"],
        ["--dry-run", "Preview without executing"],
      ]),
    ]),
  );
  out(
    section("Workspace File (.adlc/workspace.yml)", [
      ...pairs([
        ["workspace.git[]", "repos to clone (repo, path, branch, ref) — deterministic"],
        ["workspace.dirs[]", "empty directories to create (greenfield scaffolding) — deterministic"],
        ["workspace.init", "create .adlc/ structure via /workspace skill — agent-led"],
        ["workspace.link", "register cloned repos as submodules — agent-led"],
        ["skills.sources[]", "skill sources installed via skills add — deterministic"],
        ["commands[]", "sequential commands: skills add | team setup | agent run"],
        ["goal", "first-boot workspace-finishing prompt — agent-led, runs ONLY when this run assembled the workspace (cloned a repo or created a dir). Re-runs converge and skip it silently."],
      ]),
    ]),
  );
  out(
    section("Examples", [
      ...pairs([
        ["adlc-cli workspace setup", "use .adlc/workspace.yml"],
        ["adlc-cli workspace setup https://host/w.yml", "fetch workspace file over HTTP"],
        ["adlc-cli workspace setup -a opencode --dry-run", "preview planned actions"],
      ]),
    ]),
  );
  out("");
}

export function printHelp() {
  out("");
  out(
    `${style("adlc-skills-cli", ACCENT, "bold")} ${tint("(legacy alias for adlc-cli)", "gray")}`,
  );
  out("");
  out(
    section("Usage", [
      tint("adlc-skills-cli add <source> -a <agent> [-a ...] [flags]", "bold"),
      tint("adlc-skills-cli upgrade [-a <agent>]", "bold"),
      tint("adlc-skills-cli remove [-a <agent>]", "bold"),
      tint("adlc-skills-cli status [-a <agent>]", "bold"),
      tint("adlc-skills-cli agents", "bold"),
    ]),
  );
  out(
    section("Commands", [
      ...pairs([
        ["add <source>", "Install skills via npx skills + generate commands + events"],
        ["upgrade [--pull]", "Re-generate commands from currently-installed skills"],
        ["remove", "Remove generated commands + event configs"],
        ["status", "Show what's installed per agent"],
        ["agents", "List supported agents"],
      ]),
    ]),
  );
  out(
    section("Flags", [
      ...pairs([
        ["-a <agent>", "Target agent (repeatable). Run 'agents' to list."],
        ["-g, --global", "Install to user directory instead of project"],
        ["--no-events", "Skip event config generation"],
        ["--prefix <str>", "Namespace command filenames"],
        ["--mode <mode>", "inline (default) | wrapper"],
        ["--skill <name>", "Install/generate for one skill only (use '*' for all)"],
        ["--copy", "Copy files instead of symlinking"],
        ["--pull", "Pull latest from source before regenerating (upgrade only)"],
        ["-y, --yes", "Skip confirmation prompts"],
      ]),
    ]),
  );
  out(
    section("Install", [
      ...pairs([
        ["npx adlc-skills-cli add ...", ""],
        ["npm install -g adlc-skills-cli", ""],
      ]),
    ]),
  );
  out(
    section("Examples", [
      ...pairs([
        ["adlc-skills-cli add tikalk/adlc-team-skills -a opencode", ""],
        ["adlc-skills-cli status", ""],
        ["adlc-skills-cli agents", ""],
      ]),
    ]),
  );
  out("");
}

export function printWorkflowHelp() {
  out("");
  out(section("Usage", [tint("adlc-cli workflow <command> [flags]", "bold")]));
  out(
    section("Commands", [
      ...pairs([
        ["run <source>", "Execute a workflow (YAML path, installed ID, or built-in like 'factory' — the outer loop)"],
        ["resume <run_id>", "Resume a paused/failed run (gates re-prompt)"],
        ["park <run_id>", "Save a gate-paused run (+ --handle-file <json>) to refs/factory-runs/<run_id> on --remote (default origin)"],
        ["restore <run_id>", "Fetch refs/factory-runs/<run_id> from --remote into .adlc/workflows/runs/<run_id>/ (refuses an existing run dir or a different --issue-ref)"],
        ["status [run_id]", "List all runs / show one run's step states"],
        ["validate <source>", "Validate a workflow definition"],
        ["state <command>", "LLM-executor helpers (see below)"],
        ["help", "Show this help"],
      ]),
    ]),
  );
  out(
    section("Flags", [
      ...pairs([
        ["--input key=value", "Provide/repeat workflow inputs (run + resume + state start)"],
        ["--format json", "JSONL lifecycle events on stdout (run_started/step_started/step_completed/gate_paused/permission_request/run_paused/run_completed/run_failed)"],
        ["--headless", "validate/run: require every gate to declare verdict_input"],
      ]),
    ]),
  );
  out(
    section("Run State (namespace v3 — ADR-391-amendment)", [
      ...pairs([
        [".adlc/workflows/runs/<run_id>/", "state.json, inputs.json, log.jsonl, workflow.yml (frozen copy), lease.json, brief.md, mission.yml, scratchpads/…"],
        [".adlc/workflows/<id>/workflow.yml", "installed definitions"],
        ["refs/factory-runs/<run_id>", "git-refs Tier-3 (ADR-393)"],
      ]),
    ]),
  );
  out(
    section("Gates", [
      tint(
        "Interactive terminals prompt for a choice; non-interactive runs PAUSE and exit. Resume headlessly by binding a gate's verdict_input:",
        "gray",
      ),
      tint("adlc-cli workflow resume <run_id> --input verdict=approve", "bold"),
    ]),
  );
  out(
    section("State Helpers (ADR-395 — the LLM executor writes state ONLY through these)", [
      ...pairs([
        ["adlc-cli workflow state start --workflow <src> [--run-id <id>] [--input k=v]", ""],
        ["adlc-cli workflow state advance <run_id> --step <id> --status completed|failed [--output-file <path> | --output-json <json>] [--error <msg>]", ""],
        ["adlc-cli workflow state pause <run_id> --step <id>", ""],
        ["adlc-cli workflow state fail <run_id> --error <msg>", ""],
        ["adlc-cli workflow state show <run_id>", ""],
      ]),
    ]),
  );
  out(
    section("Step Types", [
      tint("command | prompt | shell | gate | if | switch | while | do-while | fan-out (max_concurrency) | fan-in | slot", "gray"),
    ]),
  );
  out(
    section("Examples", [
      ...pairs([
        ['adlc-cli workflow run .adlc/workflows/mission/workflow.yml --input spec="Fix auth"', ""],
        ["adlc-cli workflow run factory", "bundled outer loop"],
        ["adlc-cli workflow run deploy --format json", "CI: stream events"],
        ["adlc-cli workflow resume abc12345 --input verdict=approve", ""],
        ["adlc-cli workflow validate factory --headless", ""],
      ]),
    ]),
  );
  out("");
}
