import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { streamText } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { DEFAULT_IDLE_TIMEOUT, resolveIdleTimeouts } from "@/provider/provider"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

it.live("heartbeat-only stream still stalls at chunkTimeout", () =>
  Effect.gen(function* () {
    // Gateway keep-alive comments must not re-arm the stall guard: pings
    // every 10ms with zero payload must still abort at the 400ms deadline.
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => heartbeatServer({ interval: 10, duration: 30_000 })),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const error = yield* Effect.promise(async () => {
            try {
              for await (const part of result.fullStream) {
                if (part.type === "error") return part.error
              }
            } catch (error) {
              return error
            }
          })
          expect(error).toBeInstanceOf(ProviderError.ChunkStallError)
        }),
      { config: providerConfig(server.url, { chunkTimeout: 400 }) },
    )
  }),
)

it.live("healthy data stream does not stall", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        spacedChunksServer([
          { delay: 0, chunk: "a" },
          { delay: 30, chunk: "b" },
          { delay: 30, chunk: "c" },
        ]),
      ),
      (server) => Effect.sync(() => server.server.close()),
    )

    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
          const result = streamText({
            model: yield* provider.getLanguage(model),
            messages: [{ role: "user", content: "hello" }],
          })

          expect(yield* Effect.promise(() => result.text)).toBe("abc")
        }),
      { config: providerConfig(server.url, { chunkTimeout: 500 }) },
    )
  }),
)

function providerConfig(url: string, options: Record<string, unknown> = {}) {
  const config = testProviderConfig(url)
  return {
    ...config,
    provider: {
      test: {
        ...config.provider.test,
        options: { ...config.provider.test.options, ...options },
      },
    },
  }
}

// Sends only SSE comment heartbeats (`: ping`) at `interval` ms, never any
// `data:` payload, for `duration` ms. Mirrors the gateway keep-alive that
// defeated the per-read stall guard.
async function heartbeatServer(options: { interval: number; duration: number }): Promise<{
  server: Server
  url: string
}> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const id = setInterval(() => res.write(": ping\n\n"), options.interval)
    setTimeout(() => {
      clearInterval(id)
      res.end("data: [DONE]\n\n")
    }, options.duration)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function spacedChunksServer(chunks: { delay: number; chunk: string }[]): Promise<{
  server: Server
  url: string
}> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    let elapsed = 0
    for (const { delay, chunk } of chunks) {
      elapsed += delay
      setTimeout(() => {
        res.write(`data: {"choices":[{"delta":{"content":"${chunk}"}}]}\n\n`)
      }, elapsed)
    }
    setTimeout(() => res.end("data: [DONE]\n\n"), elapsed + 20)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

describe("resolveIdleTimeouts", () => {
  test("defaults both phases to DEFAULT_IDLE_TIMEOUT when nothing is configured", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({})
    expect(chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(headerMs).toBe(DEFAULT_IDLE_TIMEOUT)
  })

  test("timeout: false disables both phases entirely", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ timeout: false })
    expect(chunkMs).toBeUndefined()
    expect(headerMs).toBeUndefined()
  })

  test("chunkTimeout: false disables only the chunk-gap guard", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ chunkTimeout: false })
    expect(chunkMs).toBeUndefined()
    expect(headerMs).toBe(DEFAULT_IDLE_TIMEOUT)
  })

  test("headerTimeout: false disables only the headers guard", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ headerTimeout: false })
    expect(chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(headerMs).toBeUndefined()
  })

  test("explicit timeout applies to both phases", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ timeout: 60_000 })
    expect(chunkMs).toBe(60_000)
    expect(headerMs).toBe(60_000)
  })

  test("explicit phase timeouts win over timeout for their phase", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({
      timeout: 60_000,
      chunkTimeout: 10_000,
      headerTimeout: 20_000,
    })
    expect(chunkMs).toBe(10_000)
    expect(headerMs).toBe(20_000)
  })

  test("string timeout is coerced", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ timeout: "45000" })
    expect(chunkMs).toBe(45_000)
    expect(headerMs).toBe(45_000)
  })

  test("non-positive and empty string timeouts fall through to the default", () => {
    expect(resolveIdleTimeouts({ timeout: 0 }).chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(resolveIdleTimeouts({ timeout: -1 }).chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(resolveIdleTimeouts({ timeout: "" }).chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(resolveIdleTimeouts({ timeout: "abc" }).chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
  })
})
