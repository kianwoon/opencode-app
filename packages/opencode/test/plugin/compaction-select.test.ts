import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const selectHook = "experimental.compaction.select"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerCompactionSelect = Effect.fn("PluginTriggerTest.triggerCompactionSelect")(function* () {
  const plugin = yield* Plugin.Service
  const out: { tail_start_id?: string } = {}
  yield* plugin.trigger(
    selectHook,
    {
      budget: 100,
      turns: [
        { id: "m1", start: 0, end: 2 },
        { id: "m2", start: 2, end: 4 },
      ],
    },
    out,
  )
  return out
})

describe("plugin.compaction.select", () => {
  it.instance("mutates output.tail_start_id from a registered plugin", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(selectHook)}: (_input, output) => {`,
        '    output.tail_start_id = "m2"',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect((yield* triggerCompactionSelect()).tail_start_id).toEqual("m2")
      }),
    ),
    { timeout: 15000 },
  )

  it.instance("leaves tail_start_id undefined when the plugin does not set it", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(selectHook)}: async (_input, _output) => {`,
        "    await Bun.sleep(1)",
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect((yield* triggerCompactionSelect()).tail_start_id).toBeUndefined()
      }),
    ),
    { timeout: 15000 },
  )
})
