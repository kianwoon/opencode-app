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

it.live("headerTimeout does not abort delayed SSE body after headers arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(1_000)),
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

          expect(yield* Effect.promise(() => result.text)).toBe("late")
        }),
      { config: providerConfig(server.url, { headerTimeout: 500 }) },
    )
  }),
)

it.live("chunkTimeout raises a response stream error when SSE body stalls", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedBodyServer(250)),
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
          expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
        }),
      { config: providerConfig(server.url, { chunkTimeout: 50 }) },
    )
  }),
)

it.live("headerTimeout aborts when response headers do not arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(250)),
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

          const errors = yield* Effect.promise(async () => {
            const errors: string[] = []
            for await (const part of result.fullStream) {
              if (part.type === "error") errors.push(String(part.error))
            }
            return errors
          })
          expect(errors.join("\n")).toContain("response headers timed out")
        }),
      { config: providerConfig(server.url, { headerTimeout: 50 }) },
    )
  }),
)

it.live("headerTimeout is opt-in for non-OpenAI providers", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(100)),
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

          expect(yield* Effect.promise(() => result.text)).toBe("ok")
        }),
      { config: providerConfig(server.url) },
    )
  }),
)

it.live("idle guard raises ChunkStallError when the SSE body stalls", () =>
  Effect.gen(function* () {
    // Mirrors the 2026-08-30 silent-canyon stall: a provider stream that goes
    // silent mid-body. The idle guard (explicit or defaulted) must raise the
    // distinct ChunkStallError — never wait forever, never fire on healthy gaps.
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => stalledChunksServer({ after: 0, stall: 60_000 })),
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
          expect((error as ProviderError.ChunkStallError).ms).toBeGreaterThan(0)
        }),
      { config: providerConfig(server.url, { timeout: 50 }) },
    )
  }),
)

it.live("idle guard raises ChunkStallError even without SSE content-type", () =>
  Effect.gen(function* () {
    // Regression: wrapSSE used to skip the guard unless content-type included
    // `text/event-stream`, so a gateway response with a streamed (or
    // unlabelled) body that goes silent mid-body parked the session forever.
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => stalledChunksServer({ after: 0, stall: 60_000, contentType: "application/json" })),
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
      { config: providerConfig(server.url, { timeout: 50 }) },
    )
  }),
)

it.live("timeout: false disables the default idle guard", () =>
  Effect.gen(function* () {
    // Explicit escape hatch: a 250ms inter-chunk gap must pass untouched even
    // though the default idle guard (300s) would never fire here anyway — this
    // proves the guard machinery is fully disarmed, not merely slow.
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        spacedChunksServer([
          { delay: 0, chunk: "a" },
          { delay: 250, chunk: "b" },
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

          expect(yield* Effect.promise(() => result.text)).toBe("ab")
        }),
      { config: providerConfig(server.url, { timeout: false, headerTimeout: false }) },
    )
  }),
)

it.live("OpenAI Codex headerTimeout default can be disabled by config", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const provider = yield* Provider.Service
              const openai = yield* provider.getProvider(ProviderV2.ID.openai)
              expect(openai.options.headerTimeout).toBe(false)
            }),
          { config: { provider: { openai: { options: { headerTimeout: false } } } } },
        )
      }),
    )
  }),
)

it.live("OpenAI API auth gets default headerTimeout", () =>
  Effect.gen(function* () {
    yield* withAuthContent(
      Effect.gen(function* () {
        yield* provideTmpdirInstance(() =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const openai = yield* provider.getProvider(ProviderV2.ID.openai)
            expect(openai.options.headerTimeout).toBe(300_000)
          }),
        )
      }),
      { openai: { type: "api", key: "sk-test" } },
    )
  }),
)

it.live("timeout does not abort a healthy SSE stream mid-body (regression: 300s kill)", () =>
  Effect.gen(function* () {
    // Gaps of 200ms between chunks, 1000ms idle limit: every idle gap passes
    // with a wide margin, while total body duration (1200ms) still exceeds the
    // limit. The margin matters: the Effect test runtime batches socket writes,
    // so a nominal 30ms gap can surface as ~90ms of event-loop silence. A tight
    // limit (e.g. 50ms) therefore fires on a "healthy" stream and parks
    // `result.text` until the test times out. The old hard whole-request
    // AbortSignal.timeout would still have killed this stream.
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        spacedChunksServer([
          { delay: 0, chunk: "a" },
          { delay: 200, chunk: "b" },
          { delay: 200, chunk: "c" },
          { delay: 200, chunk: "d" },
          { delay: 200, chunk: "e" },
          { delay: 200, chunk: "f" },
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

          expect(yield* Effect.promise(() => result.text)).toBe("abcdef")
        }),
      { config: providerConfig(server.url, { timeout: 1_000 }) },
    )
  }),
)

it.live("timeout aborts when response headers never arrive", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => delayedHeaderServer(250)),
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

          const errors = yield* Effect.promise(async () => {
            const errors: string[] = []
            for await (const part of result.fullStream) {
              if (part.type === "error") errors.push(String(part.error))
            }
            return errors
          })
          expect(errors.join("\n")).toContain("response headers timed out")
        }),
      { config: providerConfig(server.url, { timeout: 50 }) },
    )
  }),
)

const gatewayModels = {
  "native passthrough": "anthropic/claude-sonnet-4-6",
  "REST catalog": "google/gemini-2.5-flash",
}

for (const [route, modelID] of Object.entries(gatewayModels)) {
  it.live(`cloudflare-ai-gateway ${route} applies chunkTimeout when the SSE body stalls`, () =>
    Effect.gen(function* () {
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const urls = yield* setupGateway(() =>
              Promise.resolve(new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })),
            )
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(
              ProviderV2.ID.make("cloudflare-ai-gateway"),
              ModelV2.ID.make(modelID),
            )
            const result = streamText({
              model: yield* provider.getLanguage(model),
              onError() {},
              messages: [{ role: "user", content: "hello" }],
            })

            const error = yield* Effect.promise(() => firstStreamError(result.fullStream))
            expect(urls).toHaveLength(1)
            expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
          }),
        { config: gatewayConfig({ chunkTimeout: 50 }) },
      )
    }),
  )
}

it.live("cloudflare-ai-gateway applies headerTimeout when response headers do not arrive", () =>
  Effect.gen(function* () {
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const urls = yield* setupGateway(
            (init) =>
              new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
          )
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(
            ProviderV2.ID.make("cloudflare-ai-gateway"),
            ModelV2.ID.make(gatewayModels["native passthrough"]),
          )
          const result = streamText({
            model: yield* provider.getLanguage(model),
            onError() {},
            messages: [{ role: "user", content: "hello" }],
          })

          const error = yield* Effect.promise(() => firstStreamError(result.fullStream))
          expect(urls).toEqual(["https://gateway.ai.cloudflare.com/v1/test-account/test-gateway"])
          expect(String(error)).toContain("response headers timed out")
        }),
      { config: gatewayConfig({ headerTimeout: 50 }) },
    )
  }),
)

it.live("timeout acts as idle guard between SSE chunks when chunkTimeout is unset", () =>
  Effect.gen(function* () {
    // First chunk arrives immediately; the second never does, so the idle
    // guard (50ms) must raise a response stream error.
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => stalledChunksServer({ after: 0, stall: 60_000 })),
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
          expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
        }),
      { config: providerConfig(server.url, { timeout: 50 }) },
    )
  }),
)

// Routes the gateway provider's requests to `respond` through the configured custom fetch, which
// the timeout wrapper calls instead of the global fetch. Returns the requested URLs.
function setupGateway(respond: (init?: RequestInit) => Promise<Response>) {
  return Effect.gen(function* () {
    yield* Env.use.set("CLOUDFLARE_ACCOUNT_ID", "test-account")
    yield* Env.use.set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
    yield* Env.use.set("CLOUDFLARE_API_TOKEN", "test-token")
    const provider = yield* Provider.Service
    const configured = yield* provider.getProvider(ProviderV2.ID.make("cloudflare-ai-gateway"))
    const urls: string[] = []
    configured.options.fetch = (input: string, init?: RequestInit) => {
      urls.push(input)
      return respond(init)
    }
    return urls
  })
}

function gatewayConfig(options: Record<string, unknown>) {
  return {
    provider: {
      "cloudflare-ai-gateway": {
        options,
        models: {
          // The gateway loader builds its own client; a bundled npm keeps resolveSDK off the network.
          [gatewayModels["REST catalog"]]: { name: "Gemini 2.5 Flash", provider: { npm: "@ai-sdk/openai-compatible" } },
        },
      },
    },
  }
}

async function firstStreamError(stream: AsyncIterable<{ type: string; error?: unknown }>) {
  try {
    for await (const part of stream) {
      if (part.type === "error") return part.error
    }
  } catch (error) {
    return error
  }
}

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

async function delayedHeaderServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function delayedBodyServer(delay: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    setTimeout(() => {
      res.end('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

// Sends the first chunk immediately and the next after `after` ms, then keeps
// the connection open (no [DONE]) so an idle-between-chunks guard can fire.
async function stalledChunksServer(options: {
  after: number
  stall: number
  contentType?: string
}): Promise<{ server: Server; url: string }> {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": options.contentType ?? "text/event-stream" })
    res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n')
    }, options.after)
    // stall longer than any test timeout; server closes on test cleanup
    setTimeout(() => res.end("data: [DONE]\n\n"), options.stall)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

// Streams chunks with gaps: chunk i arrives options[i].delay ms after the
// previous one. Total body duration can exceed an idle `timeout` while still
// delivering every chunk.
async function spacedChunksServer(
  chunks: { delay: number; chunk: string }[],
): Promise<{ server: Server; url: string }> {
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

function withAuthContent<A, E, R>(self: Effect.Effect<A, E, R>, value: Record<string, unknown> = defaultAuthContent()) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(value)
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }),
  )
}

function defaultAuthContent() {
  return {
    openai: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
  }
}
