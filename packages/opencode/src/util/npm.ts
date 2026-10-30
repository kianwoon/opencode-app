// baseline-guard:allow new module: promise bridge for the fork's removed module-level Npm.add
import { Effect } from "effect"
import { Npm } from "@opencode/util/npm"
import { LayerNode } from "@opencode/util/effect/layer-node"

// Promise-facing bridge for the async, non-Effect call sites (plugin and provider
// loading) that used the fork's module-level `Npm.add`.
const layer = LayerNode.compile(Npm.node)

export function add(pkg: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(pkg)
    }).pipe(Effect.provide(layer)),
  )
}
