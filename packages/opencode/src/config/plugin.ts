import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import { fileURLToPath, pathToFileURL } from "url"
import { isPathPluginSpec, parsePluginSpecifier, resolvePathPluginTarget } from "@/plugin/shared"
import path from "path"

export type Scope = "global" | "local"

// Origin keeps the original config provenance attached to a spec.
// After multiple config files are merged, callers still need to know which file declared the plugin
// and whether it should behave like a global or project-local plugin.
export type Origin = {
  spec: ConfigPluginV1.Spec
  source: string
  scope: Scope
}

export async function load(dir: string) {
  // Memoize discovery per process: with ×N project dirs open, each dir paid a
  // full glob on every bootstrap even though plugin files rarely change within
  // one process run. Keyed by dir; bounded so long-lived processes can't leak.
  const cached = discoveryCache.get(dir)
  if (cached) return [...cached]
  const plugins: ConfigPluginV1.Spec[] = []

  for (const item of await Glob.scan("{plugin,plugins}/*.{ts,js}", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    plugins.push(pathToFileURL(item).href)
  }
  if (discoveryCache.size >= MAX_CACHED_DIRS) discoveryCache.clear()
  discoveryCache.set(dir, plugins)
  return plugins
}

const discoveryCache = new Map<string, readonly ConfigPluginV1.Spec[]>()
const MAX_CACHED_DIRS = 64

// Drop memoized plugin-file discovery so the next load() re-scans disk. Per-dir
// when a dir is given, everything otherwise (config writes may affect any dir).
export function invalidate(dir?: string) {
  if (dir === undefined) discoveryCache.clear()
  else discoveryCache.delete(dir)
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ConfigPlugin.NotFoundError", {
  spec: Schema.String,
}) {
  override get message() {
    return `Plugin "${this.spec}" not found or not file-backed`
  }
}

// Removes a file-backed plugin spec from disk. npm specs live in
// node_modules/config arrays, so callers must handle them by editing config
// instead ({arrayOnly:true}). Only the single plugin file is removed — never
// recursive — so a spec pointing at a directory fails rather than nuking it.
export const removePluginFile = Effect.fn("ConfigPlugin.removePluginFile")(function* (spec: string) {
  if (!spec.startsWith("file://")) {
    if (!spec) return yield* new NotFoundError({ spec })
    return { arrayOnly: true as const }
  }
  const file = fileURLToPath(spec)
  const fsys = yield* FSUtil.Service
  if (!(yield* fsys.existsSafe(file))) return yield* new NotFoundError({ spec })
  yield* fsys.remove(file, { force: true })
  yield* Effect.logInfo("plugin file removed", { file })
  return { file }
})

export function pluginSpecifier(plugin: ConfigPluginV1.Spec): string {
  return Array.isArray(plugin) ? plugin[0] : plugin
}

export function pluginOptions(plugin: ConfigPluginV1.Spec): ConfigPluginV1.Options | undefined {
  return Array.isArray(plugin) ? plugin[1] : undefined
}

// Path-like specs are resolved relative to the config file that declared them so merges later on do not
// accidentally reinterpret `./plugin.ts` relative to some other directory.
export async function resolvePluginSpec(
  plugin: ConfigPluginV1.Spec,
  configFilepath: string,
): Promise<ConfigPluginV1.Spec> {
  const spec = pluginSpecifier(plugin)
  if (!isPathPluginSpec(spec)) return plugin

  const base = path.dirname(configFilepath)
  const file = (() => {
    if (spec.startsWith("file://")) return spec
    if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return pathToFileURL(spec).href
    return pathToFileURL(path.resolve(base, spec)).href
  })()

  const resolved = await resolvePathPluginTarget(file).catch(() => file)

  if (Array.isArray(plugin)) return [resolved, plugin[1]]
  return resolved
}

// Dedupe on the load identity (package name for npm specs, exact file URL for local specs), but keep the
// full Origin so downstream code still knows which config file won and where follow-up writes should go.
export function deduplicatePluginOrigins(plugins: Origin[]): Origin[] {
  const seen = new Set<string>()
  const list: Origin[] = []

  for (const plugin of plugins.toReversed()) {
    const spec = pluginSpecifier(plugin.spec)
    const name = spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
    if (seen.has(name)) continue
    seen.add(name)
    list.push(plugin)
  }

  return list.toReversed()
}

export * as ConfigPlugin from "./plugin"
