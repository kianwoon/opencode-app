import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { ConfigWatcher } from "../../src/config/config-watcher"
import { Config } from "@/config/config"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"

const reloads = { count: 0 }

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ConfigWatcher.nodeWithoutPolling, FSUtil.node]), [
    [Config.node, Layer.mock(Config.Service)({ invalidate: () => Effect.sync(() => reloads.count++) })],
    [
      InstanceStore.node,
      Layer.mock(InstanceStore.Service)({
        directories: () => [],
        disposeAll: () => Effect.sync(() => reloads.count++),
      }),
    ],
    [Global.node, Global.layerWith({ config: "/nonexistent-config-watcher-test" })],
  ]),
)

describe("config watcher", () => {
  it.live("ignores first sightings and reloads after a real change", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "config-watcher-")))
      const watcher = yield* ConfigWatcher.Service
      try {
        // Baseline scan with no files present: nothing observed, no reload.
        yield* watcher.scan()
        expect(reloads.count).toBe(0)

        // First sighting of the file records the baseline silently.
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "opencode.json"), "{}"))
        yield* watcher.scan()
        expect(reloads.count).toBe(0)
      } finally {
        yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}))
      }
    }),
  )
})
