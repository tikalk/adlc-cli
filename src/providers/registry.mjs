// Provider registry: name -> { routes, createTransport, help }.
//
// This is the only generic file that knows which adapters exist. Adding a
// provider means adding one entry here; the dispatcher and help renderer
// consume the registry and never name a provider themselves.

import { provider as coder } from "./coder/index.mjs";

const providers = new Map([[coder.name, coder]]);

export function resolveProvider(name) {
  if (name === undefined || name === null) return null;
  return providers.get(String(name).toLowerCase()) ?? null;
}

export function providerNames() {
  return [...providers.keys()].sort();
}

// Commands that any registered provider can serve (workspace, agent, run,
// workflow). Used by the dispatcher to decide whether an unknown --provider
// value is an error or irrelevant to the command.
export function providerCommands() {
  return [...new Set([...providers.values()].flatMap((provider) => Object.keys(provider.routes)))];
}

// Human-readable route list for the "not supported for this command" error.
export function providerRoutes(provider) {
  return Object.entries(provider.routes).flatMap(([command, routes]) =>
    Object.keys(routes).map((sub) => (sub === "*" ? command : `${command} ${sub}`))
  );
}

// Provider help rows for a help section. The rows live with the adapter, so
// src/help.mjs stays provider-agnostic.
export function providerHelp(section) {
  return [...providers.values()].flatMap((provider) => provider.help?.[section] ?? []);
}
