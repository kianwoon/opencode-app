import { expect, describe, test } from "bun:test"
import { ConfigBrainV1 } from "@opencode/core/v1/config/brain"
import { ConfigV1 } from "@/compat/v1-config/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { Npm } from "@opencode/util/npm"
import { Global } from "@opencode/util/global"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import path from "path"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ConfigBrain } from "../../src/config/brain"
import { ConfigParse } from "../../src/config/parse"
import { Env } from "../../src/env"
import { Permission } from "../../src/permission"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), {
  replacements: [
    Auth.node.replace(AuthTest.empty),
    Account.node.replace(AccountTest.empty),
    Npm.node.replace(NpmTest.noop),
    httpClient.replace(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`unexpected http request: ${request.method} ${request.url}`)),
      ),
    ),
  ],
})

const it = testEffect(layer)

const invalidate = Config.use.invalidate().pipe(
  Effect.scoped,
  Effect.provide(layer),
  Effect.andThen(Effect.promise(() => disposeAllInstances())),
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
    const config = ConfigParse.schema(ConfigV1.Info, { brain: { model: "" } }, "test")
    // The schema keeps the raw string; the brain agent expansion drops falsy
    // models, so an empty string behaves exactly like an omitted field.
    expect(config.brain).toEqual({ model: "" })
    expect(Boolean(config.brain?.model)).toBe(false)
  })

  test("Info schema encodes and decodes round-trip", () => {
    const value = {
      model: "anthropic/brain",
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
        }),
      ),
      Effect.asVoid,
    ),
  )

  it.instance("strict enforcement generates default-deny brain permission with read-only allow-list", () =>
    load({
      brain: {
        model: "anthropic/brain",
        enforcement: "strict",
      },
    }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          const permission = config.agent?.brain?.permission ?? []
          expect(config.agent?.brain).toMatchObject({
            mode: "primary",
            model: "anthropic/brain",
          })
          // Default-deny must stay the FIRST key: Ruleset.findLast makes the last
          // matching rule win, so a non-first "*" would stop denying execution tools.
          expect(permission[0]?.[0]).toBe("*")
          expect(permission[0]?.[1]).toBe("deny")
          const entries = Object.fromEntries(permission)
          expect(entries).toMatchObject({
            read: "allow",
            grep: "allow",
            glob: "allow",
          })
          // Dispatch is registry-driven: any subagent name resolves to allow,
          // with no name list anywhere in the codebase.
          const task = entries.task
          expect(task).toEqual([["*", "allow"]])
          const ruleset = Permission.fromConfig(permission)
          for (const name of ["alpha", "beta", "a-brand-new-hand"]) {
            expect(Permission.evaluate("task", name, ruleset).action).toBe("allow")
          }
          // bash echo-allow + redirect-deny shape; edit falls under the "*" deny.
          expect(entries.bash).toEqual([
            ["*", "deny"],
            ["echo *", "allow"],
            ["*>*", "deny"],
          ])
          expect(entries.edit).toBeUndefined()
        }),
      ),
      Effect.asVoid,
    ),
  )

  it.instance("advisory enforcement pins the brain model without permission changes", () =>
    load({
      brain: {
        model: "anthropic/brain",
        enforcement: "advisory",
      },
    }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          expect(config.agent?.brain).toMatchObject({ mode: "primary", model: "anthropic/brain", permission: {} })
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

  it.instance("a subagent model comes only from its own agent block", () =>
    load({
      brain: { model: "anthropic/brain", enforcement: "strict" },
      agent: {
        helper: { mode: "subagent", model: "anthropic/helper" },
        bare: { mode: "subagent" },
      },
    }).pipe(
      Effect.tap((config) =>
        Effect.sync(() => {
          // No name or capability table exists any more: a declared model is
          // preserved verbatim, and brain no longer injects a task permission.
          expect(config.agent?.helper).toMatchObject({ mode: "subagent", model: "anthropic/helper" })
          expect(Object.fromEntries(config.agent?.helper?.permission ?? []).task).toBeUndefined()
          expect(config.agent?.bare).toMatchObject({ mode: "subagent" })
          expect(config.agent?.bare?.model).toBeUndefined()
        }),
      ),
      Effect.asVoid,
    ),
  )

  test("brain.model overwrites a user-set brain agent model and nothing else", () => {
    const config = ConfigParse.schema(
      ConfigV1.Info,
      {
        brain: { model: "anthropic/brain" },
        agent: { brain: { model: "user/brain" }, other: { model: "user/other" } },
      },
      "test",
    )
    ConfigBrain.expand(config)
    expect(config.agent?.brain?.model).toBe("anthropic/brain")
    expect(config.agent?.other?.model).toBe("user/other")
  })
})
