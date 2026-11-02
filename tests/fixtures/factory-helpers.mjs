// Test fixture: no-op factory publish helpers where the built-in factory
// workflow looks for them first (factory-runbook, adlc-team-skills #121). A
// missing helper fails its step, so a fixture that runs
// the built-in workflow without exercising publishing installs these.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export function installNoopFactoryHelpers(dir, skill = "factory-runbook") {
  const bash = join(dir, ".agents", "skills", skill, "scripts", "bash");
  mkdirSync(bash, { recursive: true });
  for (const name of ["run-branch.sh", "open-mr.sh"]) {
    const p = join(bash, name);
    writeFileSync(p, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(p, 0o755);
  }
  return bash;
}
