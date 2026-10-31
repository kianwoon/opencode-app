import { expect, test } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { PluginSourceDirectory } from "../src/plugin/source-directory"
import { tmpdir } from "./fixture/tmpdir"
import fs from "node:fs/promises"
import path from "node:path"

test("plugin discovery excludes tests and declarations while retaining source and directory plugins", async () => {
  await using tmp = await tmpdir()
  await Promise.all(
    PluginSourceDirectory.names.map(async (directory) => {
      await fs.mkdir(path.join(tmp.path, directory, "packaged"), { recursive: true })
      await Promise.all(
        ["live.ts", "live.js", "live.test.ts", "live.test.js", "live.spec.ts", "live.spec.js", "live.d.ts"].map(
          (name) => Bun.write(path.join(tmp.path, directory, name), ""),
        ),
      )
    }),
  )

  const targets = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* PluginSourceDirectory.discover(fs, tmp.path)
    }).pipe(Effect.provide(LayerNode.compile(FSUtil.node))),
  )

  expect(targets.map((target) => path.relative(tmp.path, target))).toEqual(
    PluginSourceDirectory.names.flatMap((directory) =>
      ["live.js", "live.ts", "packaged"].map((name) => path.join(directory, name)),
    ),
  )
})
