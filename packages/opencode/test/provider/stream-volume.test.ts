import { afterEach, expect } from "bun:test"
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
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

it.live("streamMaxBytes aborts a flooding SSE body with StreamVolumeError", () =>
  Effect.gen(function* () {
    // Mirrors the 2026-09-09 OOM deaths: flash-tier gateway models flooding
    // deltas with no inter-chunk gaps, so the idle guard never fires and the
    // unbounded response OOM-aborts the process. The volume guard must abort
    // with the distinct non-retryable StreamVolumeError instead.
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => floodingServer(64_000)),
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
          expect(error).toBeInstanceOf(ProviderError.StreamVolumeError)
          expect((error as ProviderError.StreamVolumeError).bytes).toBe(1000)
        }),
      { config: providerConfig(server.url, { timeout: false, headerTimeout: false, streamMaxBytes: 1000 }) },
    )
  }),
)

it.live("streamMaxBytes passes a healthy stream through untouched", () =>
  Effect.gen(function* () {
    // The cap must not disturb normal streaming: total volume far below the
    // configured limit, with no idle guard active at all (timeout: false).
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => floodingServer(6)),
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

          expect(yield* Effect.promise(() => result.text)).toBe("abcdefgh".repeat(6))
        }),
      { config: providerConfig(server.url, { timeout: false, headerTimeout: false, streamMaxBytes: 1_000_000 }) },
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

// Streams `count` chunks back-to-back with no gaps (so an idle guard would
// never fire) totalling ~count bytes, then closes normally.
async function floodingServer(count: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (let i = 0; i < count; i++) {
      res.write(`data: {"choices":[{"delta":{"content":"abcdefgh"}}]}\n\n`)
    }
    res.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}
