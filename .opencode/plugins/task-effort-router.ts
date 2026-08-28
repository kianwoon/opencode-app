/**
 * Effort Router — auto-discovery wrapper.
 *
 * The loader globs only `{plugin,plugins}/*.{ts,js}` (packages/opencode/src/config/plugin.ts),
 * never `plugin-lib/`. This file re-exports the real implementation from
 * `../plugin-lib/task-effort-router.ts` so it activates without duplicating logic.
 *
 * Requires the plugin in plugin-lib/ to be tracked in the repo — do not delete it.
 */

export { TaskEffortRouterPlugin as default } from "../plugin-lib/task-effort-router"
