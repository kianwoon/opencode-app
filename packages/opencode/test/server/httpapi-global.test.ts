import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(LayerNode.compile(FSUtil.node)),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("upgrades to the requested version", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "9.9.9" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects invalid upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: 1 }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects invalid upgrade target versions", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "latest" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects unsupported upgrade content types", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text('{"target":"1.0.0"}', "text/plain")),
        HttpClient.execute,
      )

      expect(response.status).toBe(415)
    }),
  )

  // Reads the real user config/JSONL on this machine: assert the resolved
  // shape only, never contents, so the test stays hermetic.
  it.live("resolves the effort-router config without exposing secrets", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.effortRouter).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as Record<string, unknown>
      const jev = body.jev as Record<string, unknown>
      const guardrail = body.guardrail as Record<string, unknown>
      expect(typeof jev.enabled).toBe("boolean")
      expect(typeof jev.threshold).toBe("number")
      expect(typeof guardrail.enabled).toBe("boolean")
      expect(guardrail.denyBelow as number).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(body.riskyTools)).toBe(true)
      expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|secret|token|password/i)
    }),
  )

  it.live("returns newest-first jev verdicts and honours limit=0", () =>
    Effect.gen(function* () {
      const empty = yield* HttpClientRequest.get(`${GlobalPaths.jevVerdicts}?limit=0`).pipe(HttpClient.execute)
      expect(empty.status).toBe(200)
      expect(yield* empty.json).toEqual([])

      const response = yield* HttpClientRequest.get(`${GlobalPaths.jevVerdicts}?limit=5`).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as Array<Record<string, unknown>>
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBeLessThanOrEqual(5)
      const times = body.map((entry) => entry.ts as number)
      expect(times).toEqual([...times].sort((a, b) => b - a))
    }),
  )

  // Reads the real user context-gate.json on this machine: assert the shape
  // only, never contents, so the test stays hermetic.
  it.live("resolves the context-gate config without exposing secrets", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.gateConfig).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as Record<string, unknown>
      expect(typeof body.scopingEnabled).toBe("boolean")
      expect(typeof body.summarizeEnabled).toBe("boolean")
      expect(typeof body.triageEnabled).toBe("boolean")
      expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|secret|token|password/i)
    }),
  )

  it.live("rejects a gate-config update without a boolean triageEnabled", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch(GlobalPaths.gateConfig).pipe(
        HttpClientRequest.bodyJsonUnsafe({}),
        HttpClient.execute,
      )
      expect(response.status).toBe(400)
    }),
  )
})
