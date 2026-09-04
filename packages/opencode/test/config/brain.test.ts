import { expect, describe, test } from "bun:test"
import { ConfigBrainV1 } from "@opencode-ai/core/v1/config/brain"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import path from "path"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ConfigParse } from "../../src/config/parse"
import { Env } from "../../src/env"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
  [Auth.node, AuthTest.empty],
  [Account.node, AccountTest.empty],
  [Npm.node, NpmTest.noop],
  [
    httpClient,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.die(`unexpected http request: ${request.method} ${request.url}`)),
    ),
  ],
])

const it = testEffect(layer)

const invalidate = Config.use.invalidate().pipe(
  Effect.scoped,
  Effect.provide(layer),
  Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())),
)

// Isolate from machine-level config sources: redirect the global config dir and
// clear OPENCODE_CONFIG_DIR so real user agent .md files can't leak into
// assertions (ConfigPaths.directories picks that env var up).
const withIsolatedConfig = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = {
        global: Global.Path.config,
        configDir: process.env.OPENCODE_CONFIG_DIR,
      }
      ;(Global.Path as { config: string }).config = yield* tmpdirScoped()
      delete process.env.OPENCODE_CONFIG_DIR
      yield* invalidate
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous.global
        if (previous.configDir !== undefined) process.env.OPENCODE_CONFIG_DIR = previous.configDir
        else delete process.env.OPENCODE_CONFIG_DIR
        yield* invalidate
      }),
  )

const load = (config: object) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* (yield* FSUtil.Service).writeWithDirs(
      path.join(instance.directory, "opencode.json"),
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
    )
    return yield* withIsolatedConfig(Config.use.get())
  })

describe("brain config schema", () => {
  test("empty-string model decode is treated as unset", () => {
    const config = ConfigParse.schema(
      ConfigV1.Info,
      { brain: { model: "", hands_model: "", reviewer_model: "" } },
      "test",
    )
    // The schema keeps the raw string; the brain agent expansion drops falsy
    // models, so an empty string behaves exactly like an omitted field.
    expect(config.brain).toEqual({ model: "", hands_model: "", reviewer_model: "" })
    for (const field of ["model", "hands_model", "reviewer_model"] as const) {
      expect(Boolean(config.brain?.[field])).toBe(false)
    }
  })

  test("Info schema encodes and decodes round-trip", () => {
    const value = {
      model: "anthropic/brain",
      hands_model: "anthropic/hands",
      reviewer_model: "anthropic/reviewer",
      enforcement: "strict" as const,
    }
    const decoded = ConfigParse.schema(ConfigBrainV1.Info, value, "test")
    expect(decoded).toEqual(value)
    const encoded = JSON.parse(JSON.stringify(decoded))
    expect(ConfigParse.schema(ConfigBrainV1.Info, encoded, "test")).toEqual(value)
  })

  test("invalid enforcement value is rejected", () => {
    expect(() => ConfigParse.schema(ConfigBrainV1.Info, { enforcement: "yolo" }, "test")).toThrow()
    expect(() =>
      ConfigParse.schema(ConfigV1.Info, { brain: { enforcement: "yolo" } }, "test"),
    ).toThrow()
  })
})

describe("brain config expansion", () => {
  it.instance("is a no-op when brain is absent", () =>
    load({ model: "anthropic/claude-sonnet" }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          expect(config.brain).toBeUndefined()
          expect(config.agent?.brain).toBeUndefined()
          expect(config.agent?.explorer).toBeUndefined()
          expect(config.agent?.implementer).toBeUndefined()
          expect(config.agent?.reviewer).toBeUndefined()
        }),
      ),
      Effect.asVoid,
    ),
  )

  it.instance("strict enforcement generates entries and denies edits, bash, and nested tasks", () =>
    load({
      brain: {
        model: "anthropic/brain",
        hands_model: "anthropic/hands",
        reviewer_model: "anthropic/reviewer",
        enforcement: "strict",
      },
    }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          expect(config.agent?.brain).toMatchObject({
            mode: "primary",
            model: "anthropic/brain",
            permission: {
              edit: "deny",
              bash: "deny",
              task: { "*": "deny", explorer: "allow", implementer: "allow", reviewer: "allow" },
            },
          })
          for (const name of ["explorer", "implementer"] as const) {
            expect(config.agent?.[name]).toMatchObject({
              mode: "subagent",
              model: "anthropic/hands",
              permission: { task: "deny" },
            })
          }
          expect(config.agent?.reviewer).toMatchObject({
            mode: "subagent",
            model: "anthropic/reviewer",
            permission: { task: "deny" },
          })
        }),
      ),
      Effect.asVoid,
    ),
  )

  it.instance("advisory enforcement pins models only without permission changes", () =>
    load({
      brain: {
        model: "anthropic/brain",
        hands_model: "anthropic/hands",
        reviewer_model: "anthropic/reviewer",
        enforcement: "advisory",
      },
    }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          expect(config.agent?.brain).toMatchObject({ mode: "primary", model: "anthropic/brain", permission: {} })
          expect(config.agent?.explorer).toMatchObject({ mode: "subagent", model: "anthropic/hands", permission: {} })
          expect(config.agent?.implementer).toMatchObject({
            mode: "subagent",
            model: "anthropic/hands",
            permission: {},
          })
          expect(config.agent?.reviewer).toMatchObject({
            mode: "subagent",
            model: "anthropic/reviewer",
            permission: {},
          })
        }),
      ),
      Effect.asVoid,
    ),
  )

  it.instance("omitted hands_model leaves hands agent models unset", () =>
    load({ brain: { model: "anthropic/brain" } }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          expect(config.agent?.brain).toMatchObject({ mode: "primary", model: "anthropic/brain" })
          for (const name of ["explorer", "implementer", "reviewer"] as const) {
            expect(config.agent?.[name]).toMatchObject({ mode: "subagent" })
            expect(config.agent?.[name]?.model).toBeUndefined()
          }
        }),
      ),
      Effect.asVoid,
    ),
  )

  it.instance("default_agent brain passes validation when brain generates the agent", () =>
    load({
      brain: { model: "anthropic/brain", enforcement: "advisory" },
      default_agent: "brain",
    }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          expect(config.default_agent).toBe("brain")
          expect(config.agent?.brain).toMatchObject({ mode: "primary", model: "anthropic/brain" })
        }),
      ),
      Effect.asVoid,
    ),
  )

  it.instance("user-defined agent entries win over generated ones", () =>
    load({
      brain: {
        model: "anthropic/brain",
        hands_model: "anthropic/hands",
        reviewer_model: "anthropic/reviewer",
        enforcement: "strict",
      },
      agent: {
        brain: { model: "user/brain", permission: { edit: "allow" } },
        explorer: { model: "user/explorer" },
      },
    }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          expect(config.agent?.brain).toMatchObject({ model: "user/brain", permission: { edit: "allow" } })
          expect(config.agent?.brain?.permission).not.toHaveProperty("task")
          expect(config.agent?.explorer).toMatchObject({ model: "user/explorer" })
          expect(config.agent?.explorer?.mode).toBeUndefined()
          expect(config.agent?.explorer?.permission).toEqual({})
          expect(config.agent?.implementer).toMatchObject({ mode: "subagent", model: "anthropic/hands" })
          expect(config.agent?.reviewer).toMatchObject({ mode: "subagent", model: "anthropic/reviewer" })
        }),
      ),
      Effect.asVoid,
    ),
  )
})
