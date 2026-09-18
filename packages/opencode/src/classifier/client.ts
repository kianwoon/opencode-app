/**
 * TypeSafe System One HTTP client (`POST /v1/systemone`).
 *
 * One method, `ask`, takes a `state` plus a map of questions. The API evaluates
 * every question in PARALLEL and in ISOLATION against the same `state`, so
 * batching many questions into one call barely changes latency — callers should
 * batch rather than fan out.
 *
 * Failure is always a typed `SystemOneError`; the client never throws into the
 * caller. Missing `TYPESAFE_API_KEY` is a typed failure so the classifier can
 * fall back deterministically.
 *
 * @module @opencode-ai/opencode/classifier/client
 */
export * as ClassifierClient from "./client"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Duration, Effect, Layer, Schema, Context } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { withTransientReadRetry } from "@/util/effect-http-client"
import { type Json, Question, SystemOneRequest, SystemOneResponse, Usage } from "./schema"

export const SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone"

/** Explicit timeout so a hung upstream becomes a fallback, not a stall. */
export const SYSTEMONE_TIMEOUT = Duration.seconds(20)

/**
 * Tighter bound for the AWAITED turn-path relevance call: pruning requires the
 * verdict before the messages go on the wire, so this stall is user-visible
 * (~10x Jev's ~300ms answer) unlike the detached shadow path above.
 */
export const RELEVANCE_TURN_TIMEOUT = Duration.seconds(3)

export class SystemOneError extends Schema.TaggedErrorClass<SystemOneError>()("Classifier.SystemOneError", {
  /** Coarse failure kind so callers can branch without parsing messages. */
  kind: Schema.Literals(["missing_api_key", "http", "decode", "timeout"]),
  message: Schema.String,
}) {}

export interface AskInput {
  readonly model: string
  readonly state: string | Json
  readonly questions: Record<string, Question>
}

export interface Interface {
  /** Ask many questions in one request; returns the decoded response. */
  readonly ask: (input: AskInput) => Effect.Effect<SystemOneResponse, SystemOneError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ClassifierSystemOneClient") {}

const apiKey = () => process.env.TYPESAFE_API_KEY

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = withTransientReadRetry(yield* HttpClient.HttpClient)
    const httpOk = HttpClient.filterStatusOk(http)

    const ask = Effect.fn("ClassifierClient.ask")(function* (input: AskInput) {
      const key = apiKey()
      if (!key) {
        return yield* new SystemOneError({
          kind: "missing_api_key",
          message: "TYPESAFE_API_KEY is not set",
        })
      }

      const request = yield* HttpClientRequest.post(SYSTEMONE_URL).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.schemaBodyJson(SystemOneRequest)(input),
        Effect.mapError(
          () => new SystemOneError({ kind: "http", message: "Failed to encode System One request body" }),
        ),
      )

      const response = yield* httpOk.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new SystemOneError({
              kind: "http",
              message: HttpClientError.isHttpClientError(cause) ? cause.message : "System One request failed",
            }),
        ),
        Effect.timeoutOrElse({
          duration: SYSTEMONE_TIMEOUT,
          orElse: () =>
            Effect.fail(new SystemOneError({ kind: "timeout", message: "System One request timed out" })),
        }),
      )

      return yield* HttpClientResponse.schemaBodyJson(SystemOneResponse)(response).pipe(
        Effect.mapError(
          (cause) => new SystemOneError({ kind: "decode", message: `Failed to decode response: ${cause.message}` }),
        ),
      )
    })

    return Service.of({ ask })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [httpClient] })

/** Re-exported so decision consumers don't reach into the wire module. */
export { Usage }
