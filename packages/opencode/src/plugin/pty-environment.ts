export * as PluginPtyEnvironment from "./pty-environment"

import { PtyEnvironment } from "@/compat/pty-environment"
import { makeGlobalNode, Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { Plugin } from "."

export const layer: Layer.Layer<
  PtyEnvironment.Service,
  never,
  Plugin.Service | InstanceStore.Service
> = Layer.effect(
  PtyEnvironment.Service,
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const instances = yield* InstanceStore.Service
    return PtyEnvironment.Service.of({
      get: Effect.fn("PtyEnvironment.get")(function* (input) {
        return yield* instances.provide(
          { directory: input.directory },
          plugin
            .trigger("shell.env", { cwd: input.cwd }, { env: {} as Record<string, string> })
            .pipe(Effect.map((result) => result.env)),
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: PtyEnvironment.Service,
  layer,
  deps: [Plugin.node, InstanceStore.node],
}) as unknown as LayerNode.Provider<PtyEnvironment.Service, never, typeof Node.tags.values.global>
