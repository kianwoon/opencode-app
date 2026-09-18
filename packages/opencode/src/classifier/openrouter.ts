/**
 * OpenRouter `/alpha/decisions` transport adapter for the classifier.
 *
 * Sibling of `./client`: the same `ClassifierClient.Service` seam, a different
 * transport. `/alpha/decisions` is a native decision endpoint — it proxies the
 * real Jev model, so `probabilities`/`confidence` are the model's own and NOT
 * self-reported text — unlike a `/chat/completions` adapter, which would only
 * ever carry the model's own prose.
 *
 * The endpoint takes the wire contract verbatim: ONE `ask` over MANY questions,
 * every question in a single POST. Failure is always a typed `SystemOneError`;
 * this adapter never throws into the caller.
 *
 * @module @opencode-ai/opencode/classifier/openrouter
 */
export * as ClassifierOpenRouter from "./openrouter"

import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Duration, Effect, Layer, Result, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"

import { Auth } from "@/auth"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ClassifierClient } from "./client"
import { Question, SystemOneResponse, Usage } from "./schema"

/** POST-only; a GET returns 404. */
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions"

/** Explicit timeout so a hung upstream becomes a fallback, not a stall. */
export const DECISIONS_TIMEOUT = Duration.seconds(20)

export const DecisionsRequest = Schema.Struct({
  model: Schema.String,
  state: Schema.Union([Schema.String, Schema.Json]),
  questions: Schema.Record(Schema.String, Question),
})
export type DecisionsRequest = Schema.Schema.Type<typeof DecisionsRequest>

/** One POST body carrying every question — batching is the point of this seam. */
export const buildRequest = (input: ClassifierClient.AskInput): DecisionsRequest => ({
  model: input.model,
  state: input.state,
  questions: input.questions,
})

const decodeResponse = Schema.decodeUnknownResult(SystemOneResponse)

const decodeError = (message: string) => new ClassifierClient.SystemOneError({ kind: "decode", message })

/**
 * Map a `/alpha/decisions` body into the native System One response. Unknown
 * members (`id`, `provider`, `usage.cost`) are ignored by the decoder, so the
 * live payload needs no schema widening.
 */
export const parseResponse = (body: unknown): Effect.Effect<SystemOneResponse, ClassifierClient.SystemOneError> => {
  const decoded = decodeResponse(body)
  if (Result.isFailure(decoded)) return Effect.fail(decodeError("Failed to decode the decisions response body"))
  // Provenance marker only: the model behind this transport is native Jev, so
  // the numbers are calibrated and must not be treated as text self-reports.
  return Effect.succeed({ ...decoded.success, transport: "openrouter" })
}

export const layer: Layer.Layer<ClassifierClient.Service, never, HttpClient.HttpClient | Auth.Service> =
  Layer.effect(
    ClassifierClient.Service,
    Effect.gen(function* () {
      const http = withTransientReadRetry(yield* HttpClient.HttpClient)
      const httpOk = HttpClient.filterStatusOk(http)
      const auth = yield* Auth.Service

      const apiKey = Effect.fn("ClassifierOpenRouter.apiKey")(function* () {
        const stored = yield* auth.get("openrouter").pipe(Effect.orElseSucceed(() => undefined))
        return (stored?.type === "api" ? stored.key : undefined) ?? process.env.OPENROUTER_API_KEY
      })

      const ask = Effect.fn("ClassifierOpenRouter.ask")(function* (input: ClassifierClient.AskInput) {
        const key = yield* apiKey()
        if (!key) {
          return yield* new ClassifierClient.SystemOneError({
            kind: "missing_api_key",
            message: "No openrouter credential in auth.json and OPENROUTER_API_KEY is not set",
          })
        }

        const request = HttpClientRequest.post(OPENROUTER_DECISIONS_URL).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.bodyJsonUnsafe(buildRequest(input)),
        )

        const response = yield* httpOk.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new ClassifierClient.SystemOneError({
                kind: "http",
                message: HttpClientError.isHttpClientError(cause) ? cause.message : "OpenRouter decisions request failed",
              }),
          ),
          Effect.timeoutOrElse({
            duration: DECISIONS_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ClassifierClient.SystemOneError({
                  kind: "timeout",
                  message: "OpenRouter decisions request timed out",
                }),
              ),
          }),
        )

        const body = yield* response.json.pipe(
          Effect.mapError(() => decodeError("Failed to read the decisions response body")),
        )
        return yield* parseResponse(body)
      })

      return ClassifierClient.Service.of({ ask })
    }),
  )

export const node = LayerNode.make({ service: ClassifierClient.Service, layer, deps: [httpClient, Auth.node] })

/** Re-exported so decision consumers don't reach into the wire module. */
export { Usage }
