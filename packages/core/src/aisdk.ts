export * as AISDK from "./aisdk"

import { makeLocationNode } from "./effect/app-node"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Cause, Context, Effect, Layer, Schema, Scope } from "effect"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { State } from "./state"

type SDK = any

// Sibling of ProviderError.ChunkStallError in packages/opencode (core cannot
// import the opencode package). message-v2 matches stalls by the shared
// `ProviderChunkStallError` name + `ms` field, so this must keep both.
export class ChunkStallError extends Error {
  public override readonly name = "ProviderChunkStallError"

  constructor(public readonly ms: number) {
    super(`No SSE chunk received for ${ms}ms; the stream stalled and was aborted`)
  }
}

export interface SDKEvent {
  readonly model: ModelV2.Info
  readonly package: string
  readonly options: Record<string, any>
  sdk?: SDK
}

export interface LanguageEvent {
  readonly model: ModelV2.Info
  readonly sdk: SDK
  readonly options: Record<string, any>
  language?: LanguageModelV3
}

export function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  // No content-type gate: gateways (and the fetchFreshConnection node-stream
  // bridge, which builds a Response with no content-type at all) can omit
  // `text/event-stream` on streaming responses. Applies to ANY streamed body.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  // Deadline for the next payload-bearing chunk. Heartbeat-only reads (SSE
  // comments, whitespace keep-alives) must NOT push this forward — otherwise
  // a gateway pinging `: ping` defeats the stall guard while no real content
  // arrives. Only chunks carrying payload re-arm it.
  let deadline = 0
  let stalled: ChunkStallError | undefined
  // Trailing partial line held across reads so a heartbeat split over two
  // TCP segments (`: pi` + `ng\n\n`) is not mistaken for payload.
  let tail = ""

  const failStalled = () => {
    if (stalled) return stalled
    stalled = new ChunkStallError(ms)
    ctl.abort(stalled)
    reader.cancel(stalled).catch(() => {})
    return stalled
  }

  const read = async () => {
    const part = await reader.read()
    if (!part.done || !stalled) return part
    throw stalled
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (stalled) throw stalled
      if (deadline === 0) deadline = Date.now() + ms
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => reject(failStalled()), Math.max(deadline - Date.now(), 0))

        const onRead = async () => {
          try {
            resolve(await read())
          } catch (err) {
            reject(err)
          } finally {
            clearTimeout(id)
          }
        }
        void onRead()
      })

      if (stalled) throw stalled

      if (part.done) {
        deadline = 0
        tail = ""
        ctrl.close()
        return
      }

      const text = tail + decoder.decode(part.value, { stream: true })
      const lines = text.split("\n")
      // Keep the trailing partial line in the check: a `data:` line split
      // across two TCP segments must still count as payload on arrival.
      tail = lines.pop() ?? ""
      const payload = [...lines, tail].some((line) => {
        const trimmed = line.trim()
        return trimmed !== "" && !trimmed.startsWith(":")
      })
      if (payload) deadline = Date.now() + ms
      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      deadline = 0
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function prepareOptions(model: ModelV2.Info, pkg: string) {
  const options: Record<string, any> = {
    name: model.providerID,
    ...(model.api.type === "aisdk" ? (model.api.settings ?? {}) : {}),
    ...model.request.body,
  }
  if (model.api.type === "aisdk" && model.api.url) options.baseURL = model.api.url

  const customFetch = options.fetch
  const chunkTimeout = options.chunkTimeout
  delete options.chunkTimeout
  options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const opts = { ...(init ?? {}) }
    const signals = [
      opts.signal,
      typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined,
      options.timeout !== undefined && options.timeout !== null && options.timeout !== false
        ? AbortSignal.timeout(options.timeout)
        : undefined,
    ].filter((item): item is AbortSignal | AbortController => Boolean(item))
    const chunkAbortCtl = signals.find((item): item is AbortController => item instanceof AbortController)
    const abortSignals = signals.map((item) => (item instanceof AbortController ? item.signal : item))
    if (abortSignals.length === 1) opts.signal = abortSignals[0]
    if (abortSignals.length > 1) opts.signal = AbortSignal.any(abortSignals)

    if (
      (pkg === "@ai-sdk/openai" || pkg === "@ai-sdk/azure" || pkg === "@ai-sdk/amazon-bedrock/mantle") &&
      opts.body &&
      opts.method === "POST"
    ) {
      const body = JSON.parse(opts.body as string)
      if (body.store !== true && Array.isArray(body.input)) {
        for (const item of body.input) {
          if ("id" in item) delete item.id
        }
        opts.body = JSON.stringify(body)
      }
    }

    const res = await (typeof customFetch === "function" ? customFetch : fetch)(input, {
      ...opts,
      timeout: false,
    })
    if (!chunkAbortCtl || typeof chunkTimeout !== "number") return res
    return wrapSSE(res, chunkTimeout, chunkAbortCtl)
  }

  return options
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("AISDK.InitError", {
  providerID: ProviderV2.ID,
  cause: Schema.Defect(),
}) {}

function initError(providerID: ProviderV2.ID) {
  return Effect.catchCause((cause) => Effect.fail(new InitError({ providerID, cause: Cause.squash(cause) })))
}

export interface Interface {
  readonly hook: {
    readonly sdk: (
      callback: (event: SDKEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly language: (
      callback: (event: LanguageEvent) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  readonly runSDK: (event: SDKEvent) => Effect.Effect<SDKEvent>
  readonly runLanguage: (event: LanguageEvent) => Effect.Effect<LanguageEvent>
  readonly language: (model: ModelV2.Info) => Effect.Effect<LanguageModelV3, InitError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AISDK") {}

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let sdkHooks: ((event: SDKEvent) => Effect.Effect<void> | void)[] = []
    let languageHooks: ((event: LanguageEvent) => Effect.Effect<void> | void)[] = []
    const languages = new Map<string, LanguageModelV3>()
    const sdks = new Map<string, SDK>()

    const register = <Event>(
      hooks: () => ((event: Event) => Effect.Effect<void> | void)[],
      update: (hooks: ((event: Event) => Effect.Effect<void> | void)[]) => void,
    ) =>
      Effect.fn("AISDK.hook")(function* (callback: (event: Event) => Effect.Effect<void> | void) {
        const scope = yield* Scope.Scope
        let active = true
        update([...hooks(), callback])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          update(hooks().filter((item) => item !== callback))
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    const run = Effect.fnUntraced(function* <Event>(
      hooks: readonly ((event: Event) => Effect.Effect<void> | void)[],
      event: Event,
    ) {
      for (const hook of hooks) {
        const result = hook(event)
        if (Effect.isEffect(result)) yield* result
      }
      return event
    })

    const service = Service.of({
      hook: {
        sdk: register(
          () => sdkHooks,
          (next) => (sdkHooks = next),
        ),
        language: register(
          () => languageHooks,
          (next) => (languageHooks = next),
        ),
      },
      runSDK: (event) => run(sdkHooks, event),
      runLanguage: (event) => run(languageHooks, event),
      language: Effect.fn("AISDK.language")(function* (model) {
        const key = `${model.providerID}/${model.id}/${model.request.variant ?? "default"}`
        const existing = languages.get(key)
        if (existing) return existing
        if (model.api.type !== "aisdk")
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error(`Unsupported api ${model.api.type}`),
          })

        const options = prepareOptions(model, model.api.package)
        const sdkKey = JSON.stringify({
          providerID: model.providerID,
          api: model.api,
          options,
        })
        const sdk =
          sdks.get(sdkKey) ??
          (yield* service.runSDK({ model, package: model.api.package, options }).pipe(initError(model.providerID))).sdk
        if (!sdk)
          return yield* new InitError({
            providerID: model.providerID,
            cause: new Error("No AISDK provider plugin returned an SDK"),
          })
        sdks.set(sdkKey, sdk)
        const result = yield* service.runLanguage({ model, sdk, options }).pipe(initError(model.providerID))
        const language = yield* Effect.sync(() => result.language ?? sdk.languageModel(model.api.id)).pipe(
          initError(model.providerID),
        )
        languages.set(key, language)
        return language
      }),
    })
    return service
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [] })
