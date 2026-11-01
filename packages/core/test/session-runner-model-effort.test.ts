import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AISDK } from "@opencode/core/aisdk"
import { Agent } from "@opencode/core/agent"
import { Integration } from "@opencode/core/integration"
import { Info, Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { Npm } from "@opencode/util/npm"
import { it } from "./lib/effect"

const providerID = Provider.ID.make("test-provider")
const catalog = Info.make({
  id: Model.ID.make("test-model"),
  modelID: Model.ID.make("test-model"),
  providerID,
  name: "Test model",
  package: "@opencode/ai/providers/openai",
  settings: { baseURL: "https://openai.example/v1" },
  variants: [{ id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } }],
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 100, output: 20 },
})

const agents = new Map<Agent.ID, Agent.Info>()
const agent = (id: string, effort: string | undefined) => {
  const info = Agent.Info.make({ ...Agent.Info.default(Agent.ID.make(id)), mode: "subagent", effort })
  agents.set(info.id, info)
  return info.id
}

const integrations = Layer.mock(Integration.Service, {
  revision: () => 0,
  connection: {
    active: () => Effect.undefined,
    resolve: () => Effect.die("unused"),
    key: () => Effect.die("unused"),
    external: () => Effect.die("unused"),
    activate: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
  },
  oauth: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
  command: {
    connect: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  },
})

const layer = SessionRunnerModel.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ModelResolver.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Provider.Service, { get: () => Effect.succeed(undefined) }),
            Layer.mock(Model.Service, {
              get: () => Effect.die("unused"),
              available: () => Effect.succeed([catalog]),
              default: () => Effect.succeed(catalog),
            }),
            integrations,
            Layer.mock(Npm.Service, { add: () => Effect.die("unused"), which: () => Effect.die("unused") }),
            Layer.mock(AISDK.Service, {
              hook: { sdk: () => Effect.die("unused"), language: () => Effect.die("unused") },
              model: () => Effect.die("unused"),
            }),
          ),
        ),
      ),
      Layer.mock(Agent.Service, { select: (id) => Effect.succeed({ id: id!, info: agents.get(id!) }) }),
    ),
  ),
)

const session = (input: { parentID: SessionSchema.ID | undefined; agent: Agent.ID; variant?: Model.VariantID }) =>
  ({
    id: SessionSchema.ID.create(),
    parentID: input.parentID,
    projectID: "prj_test",
    agent: input.agent,
    model: Model.Ref.make({
      id: Model.ID.make("test-model"),
      providerID,
      ...(input.variant === undefined ? {} : { variant: input.variant }),
    }),
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: {},
  }) as unknown as SessionSchema.Info

const resolve = (value: SessionSchema.Info) =>
  SessionRunnerModel.Service.use((runner) => runner.resolve(value, () => Effect.succeed([catalog])))

describe("SessionRunnerModel effort", () => {
  it.effect("applies a subagent's configured effort to the variant it inherited", () =>
    Effect.gen(function* () {
      const parentID = SessionSchema.ID.create()
      // The session projection records "no variant" as `default`, which the effort is free to replace.
      const resolved = yield* resolve(
        session({ parentID, agent: agent("reviewer", "high"), variant: Model.VariantID.make("default") }),
      )

      expect(resolved.ref).toMatchObject({ variant: Model.VariantID.make("high") })
      expect(resolved.model.route.defaults.providerOptions).toMatchObject({ reasoningEffort: "high" })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("falls back to a reasoningEffort setting when no variant has the effort id", () =>
    Effect.gen(function* () {
      const parentID = SessionSchema.ID.create()
      const resolved = yield* resolve(session({ parentID, agent: agent("reviewer", "max") }))

      expect(resolved.ref.variant).toBeUndefined()
      expect(resolved.model.route.defaults.providerOptions).toMatchObject({ reasoningEffort: "max" })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("keeps a caller-pinned variant over the agent's effort", () =>
    Effect.gen(function* () {
      const parentID = SessionSchema.ID.create()
      const resolved = yield* resolve(
        session({ parentID, agent: agent("reviewer", "max"), variant: Model.VariantID.make("high") }),
      )

      expect(resolved.ref).toMatchObject({ variant: Model.VariantID.make("high") })
      expect(resolved.model.route.defaults.providerOptions).toMatchObject({ reasoningEffort: "high" })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("inherits the session variant when the agent configures no effort", () =>
    Effect.gen(function* () {
      const parentID = SessionSchema.ID.create()
      const resolved = yield* resolve(
        session({ parentID, agent: agent("reviewer", undefined), variant: Model.VariantID.make("high") }),
      )

      expect(resolved.ref).toMatchObject({ variant: Model.VariantID.make("high") })
      expect(resolved.model.route.defaults.providerOptions).toMatchObject({ reasoningEffort: "high" })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("leaves primary sessions on their configured variant", () =>
    Effect.gen(function* () {
      const resolved = yield* resolve(
        session({ parentID: undefined, agent: agent("build", "max"), variant: Model.VariantID.make("high") }),
      )

      expect(resolved.ref).toMatchObject({ variant: Model.VariantID.make("high") })
      expect(resolved.model.route.defaults.providerOptions).toMatchObject({ reasoningEffort: "high" })
    }).pipe(Effect.provide(layer)),
  )
})
