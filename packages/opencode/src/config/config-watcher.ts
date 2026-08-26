export * as ConfigWatcher from "./config-watcher"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Context, Duration, Effect, FileSystem, Layer, Option, Schedule, Scope } from "effect"
import path from "path"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstanceStore } from "@/project/instance-store"
import { Config } from "./config"

export interface Interface {
  /**
   * Checks watched config files once; when an external edit is detected,
   * waits for writes to settle and then reloads configs.
   */
  readonly scan: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigWatcher") {}

// Only these file names count as configuration.
const NAMES = ["opencode.json", "opencode.jsonc", "config.json"]

// Editors save via rename chains (write temp -> rename), so one stat can catch
// an intermediate state. Reload only after the fingerprint stops moving.
const SETTLE = Duration.millis(400)
const POLL = Duration.seconds(2)

type Fingerprint = { mtime: number; size: bigint }

const fingerprintOf = (stat: { mtime: Option.Option<Date>; size: FileSystem.Size }): Fingerprint => ({
  mtime: Option.getOrElse(stat.mtime, () => new Date(0)).getTime(),
  size: stat.size,
})

const same = (a: Fingerprint | undefined, b: Fingerprint) =>
  a !== undefined && a.mtime === b.mtime && a.size === b.size

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const instances = yield* InstanceStore.Service
    const global = yield* Global.Service
    if (Flag.OPENCODE_DISABLE_CONFIG_WATCHER) return Service.of({ scan: () => Effect.void })

    // Provide the yielded store up front so every later invocation of this
    // effect stays free of deferred requirements.
    const reloadAll = disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }).pipe(
      Effect.provideService(InstanceStore.Service, instances),
    )

    // Fingerprint of each watched file keyed by absolute path. Unseen paths
    // never count as changes, so the startup scan and first observations of
    // newly created files stay silent.
    const fingerprints = new Map<string, Fingerprint>()

    const watchTargets = () => NAMES.map((name) => path.join(global.config, name))

    const statFile = (file: string) =>
      Effect.map(
        fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined))),
        (stat) => (stat ? Option.some(fingerprintOf(stat)) : Option.none()),
      )

    const detect = Effect.fn("ConfigWatcher.detect")(function* () {
      let changed = false
      for (const file of watchTargets()) {
        const before = fingerprints.get(file)
        const after = yield* statFile(file)
        if (!before) {
          if (Option.isSome(after)) fingerprints.set(file, after.value)
          continue
        }
        if (Option.isNone(after)) {
          fingerprints.delete(file)
          continue
        }
        if (same(before, after.value)) continue
        changed = true
      }
      return changed
    })

    // Wait until no watched file changes within a settle window, then run the
    // established "reload configs" sequence: drop the cached global config so
    // the next read re-parses disk, then dispose all instances so catalogs
    // rebuild. Clients react to the emitted `global.disposed` /
    // `server.instance.disposed` events by refetching providers and models,
    // which is how newly added opencode.json providers and models reach the
    // model picker without restarting the app or server.
    const settleAndReload = Effect.fn("ConfigWatcher.settleAndReload")(function* () {
      while (true) {
        const before = new Map(fingerprints)
        yield* Effect.sleep(SETTLE)
        yield* detect()
        const stable = [...before].every(([file, value]) => same(fingerprints.get(file), value))
        if (stable) break
      }
      yield* Effect.logInfo("config file changed on disk, reloading configs")
      yield* config.invalidate()
      yield* reloadAll
    })

    return Service.of({
      scan: () =>
        Effect.gen(function* () {
          if (!(yield* detect())) return
          yield* settleAndReload()
        }),
    })
  }),
)

/** Background poll loop that runs scan() every POLL interval. */
export const pollLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const watcher = yield* Service
    const scope = yield* Scope.Scope
    yield* watcher.scan().pipe(
      Effect.catchCause((cause) => Effect.logWarning("config watcher poll failed", { cause })),
      Effect.repeat(Schedule.spaced(POLL)),
      Effect.forkIn(scope),
    )
  }),
)

export const nodeWithoutPolling = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Config.node, InstanceStore.node, Global.node],
})

export const node = makeGlobalNode({
  name: "config-watcher",
  layer: Layer.merge(layer, pollLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Config.node, InstanceStore.node, Global.node],
})
