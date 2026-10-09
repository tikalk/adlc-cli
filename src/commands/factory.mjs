// Factory commands: setup for factory tracker provider configuration.

import { readAgent } from "../utils/init-options.mjs";
import { findInstalledSkills } from "../source.mjs";
import { getAgent } from "../registry.mjs";

const PROVIDERS = ["github", "gitlab", "linear", "jira"];

// ── setup ──────────────────────────────────────────────────────────────
export async function cmdFactorySetup(args, flags) {
  const provider = flags.provider;
  if (provider && !PROVIDERS.includes(provider)) {
    console.error(`Error: --provider must be one of: ${PROVIDERS.join(", ")}`);
    return 1;
  }

  const agentKey = flags.agents[0] || readAgent();
  if (!agentKey) {
    console.error("Error: Agent required (-a <agent> or set in init-options.json)");
    return 1;
  }

  // No auto-install: the skills source is unknown at this layer (unlike
  // `team setup`, which receives it as an argument). Fail loudly instead —
  // guessing a source would install untrusted skill content.
  const agent = getAgent(agentKey);
  if (agent) {
    const projectRoot = process.cwd();
    const skillsDir = flags.global ? agent.global_skills_dir : agent.skills_dir;
    if (skillsDir) {
      const skills = await findInstalledSkills(skillsDir, projectRoot);
      if (!skills.some((s) => s.name === "factory-setup")) {
        console.error(
          "Error: factory-setup skill not installed. Run 'adlc-cli skills add <source>' (or 'adlc-cli team setup <source>') first."
        );
        return 1;
      }
    }
  }

  const { cmdAgentRun } = await import("./agent.mjs");
  const prompt = provider
    ? `Run /factory-setup to configure the factory tracker provider for this project (provider preselected: ${provider})`
    : "Run /factory-setup to configure the factory tracker provider for this project";
  const runArgs = ["-a", agentKey, "--timeout", "300"];
  if (flags.format) runArgs.push("--format", flags.format);
  if (flags.cwd) runArgs.push("--cwd", flags.cwd);
  runArgs.push(prompt);
  return cmdAgentRun(runArgs);
}
