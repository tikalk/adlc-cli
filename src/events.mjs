// Events layer — DEPRECATED alias of ./hooks.mjs.
//
// `hooks` is the canonical name (`.hooks.json` manifest, resolveHooks,
// installHooks, HOOK_AGENTS, CANONICAL_HOOKS). Everything here re-exports
// the canonical implementation so existing `events` imports keep working
// until v3. New code must import from `./hooks.mjs`.

export {
  getDispatcherContent,
  installDispatcher,
  readLocalHooksManifest,
  readLocalHooksManifest as readLocalEventsManifest,
  fetchHooksManifest,
  fetchHooksManifest as fetchEventsManifest,
  fetchSkillsDeps,
  expandSkillSelection,
  resolveHooks,
  resolveHooks as resolveEvents,
  installHooks,
  installHooks as installEvents,
  removeHooks,
  removeHooks as removeEvents,
} from "./hooks.mjs";
