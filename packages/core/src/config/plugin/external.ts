export * as ConfigExternalPlugin from "./external"

import type { Plugin as EffectPlugin } from "@opencode-ai/plugin/v2/effect"
import type { Plugin as PromisePlugin } from "@opencode-ai/plugin/v2/promise"
import { Cause, Effect, Schema } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { Location } from "../../location"
import { Npm } from "../../npm"
import { define } from "../../plugin/internal"
import { PluginPromise } from "../../plugin/promise"
import { State } from "../../state"

const PluginModule = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare<EffectPlugin["effect"]>(
        (input): input is EffectPlugin["effect"] => typeof input === "function",
      ),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare<PromisePlugin["setup"]>(
        (input): input is PromisePlugin["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

export const Plugin = define({
  id: "config-plugin",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    yield* State.unbatched(
      Effect.gen(function* () {
        const configured: { package: string; options?: Record<string, any> }[] = []

        for (const entry of yield* config.entries()) {
          if (entry.type === "document") {
            const directory = entry.path ? path.dirname(entry.path) : location.directory
            for (const item of entry.info.plugins ?? []) {
              const ref = typeof item === "string" ? { package: item } : item
              const packageName = (() => {
                if (ref.package.startsWith("file://")) return fileURLToPath(ref.package)
                if (ref.package.startsWith("./") || ref.package.startsWith("../")) {
                  return path.resolve(directory, ref.package)
                }
                return ref.package
              })()
              configured.push({ package: packageName, options: ref.options })
            }
          }

          if (entry.type === "directory") {
            const files = yield* fs
              .glob("{plugin,plugins}/*.{ts,js}", {
                cwd: entry.path,
                absolute: true,
                include: "file",
                dot: true,
                symlink: true,
              })
              .pipe(Effect.orElseSucceed(() => []))
            files.sort()
            for (const file of files) configured.push({ package: file })
          }
        }

        // A plugin can be referenced twice: once by a config document's
        // `plugins` array and again by the same directory's
        // `{plugin,plugins}/*` glob (the common setup of declaring plugins
        // explicitly AND dropping the files in plugins/). Both sources
        // resolve to the same absolute path, so dedupe on it — npm specs
        // keep their package name as the key. First occurrence wins so a
        // config document's `options` beat the glob's bare reference.
        const configuredUnique = new Map<string, { package: string; options?: Record<string, any> }>()
        for (const ref of configured) {
          const key = path.isAbsolute(ref.package) ? path.normalize(ref.package) : ref.package
          if (!configuredUnique.has(key)) configuredUnique.set(key, ref)
        }
        const deduped = [...configuredUnique.values()]

        yield* Effect.logInfo("external plugin discovery", {
          entries: deduped.map((item) => item.package),
        })

        for (const ref of deduped) {
          yield* Effect.logInfo("external plugin load", { package: ref.package })
          yield* Effect.gen(function* () {
            const entrypoint = path.isAbsolute(ref.package)
              ? pathToFileURL(ref.package).href
              : (yield* npm.add(ref.package)).entrypoint
            if (!entrypoint) return

            const mod = yield* Effect.promise(() => import(entrypoint))
            const decoded = yield* Schema.decodeUnknownEffect(PluginModule)(mod).pipe(Effect.option)
            if (decoded._tag === "None") {
              // V1-shaped plugin files (default export is a factory function or
              // a { server()/tui() } object) are handled by the legacy V1
              // loader; the V2 directory glob picks them up too. They are not
              // an error on this path — log quietly and skip so the log stream
              // stays signal-rich.
              yield* Effect.logDebug("skipped non-V2 plugin module", { package: ref.package })
              return
            }
            const value = decoded.value.default
            const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
            yield* ctx.plugin.add({
              id: plugin.id,
              effect: (host) => plugin.effect({ ...host, options: ref.options ?? {} }),
            })
          }).pipe(
            Effect.tapCause((cause) =>
              Effect.logError("failed to load external plugin", { package: ref.package, cause: Cause.pretty(cause) }),
            ),
            Effect.ignoreCause,
          )
        }
      }),
    ).pipe(Effect.forkScoped({ startImmediately: true }))
  }),
})
