import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { Auth } from "@/auth"
import { ClassifierClient } from "@/classifier/client"
import { ClassifierOpenRouter } from "@/classifier/openrouter"
import { testEffect } from "../lib/effect"

// Real HttpClient driver answering 400 — no mocks, no globals.
const failingHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("bad request", { status: 400 }))),
  ),
)

// A 200 whose body is not JSON, to exercise the decode branch end-to-end.
const garbageHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("not json at all", { status: 200 }))),
  ),
)

// No stored openrouter credential → real missing_api_key path.
const noAuth = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

// Keeps ClassifierClient.Service in the test layer's requirements so the tests
// drive the real adapter through the service tag.
const withHttp = (http: Layer.Layer<HttpClient.HttpClient>) =>
  ClassifierOpenRouter.layer.pipe(Layer.provide(Layer.mergeAll(http, noAuth)))

const it = testEffect(withHttp(failingHttp))
const itGarbage = testEffect(withHttp(garbageHttp))

// The key is read per-ask, so the missing-key path is reachable only when neither
// the store (stubbed empty) nor the env supplies one.
delete process.env.OPENROUTER_API_KEY

const askError = Effect.gen(function* () {
  const client = yield* ClassifierClient.Service
  return yield* client.ask(input).pipe(Effect.flip)
})

/** Set the env fallback for the duration of a test, then restore it. */
const withEnvKey = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const saved = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = "test-key"
  return effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (saved === undefined) delete process.env.OPENROUTER_API_KEY
        else process.env.OPENROUTER_API_KEY = saved
      }),
    ),
  )
}

const questions = {
  progress: {
    type: "noul" as const,
    instructions: "Is the agent making progress?",
    criteria: { true: "progressing", false: "stalled" },
  },
  same_strategy: {
    type: "noul" as const,
    instructions: "Should the agent keep the same strategy?",
  },
  escalate: {
    type: "choice" as const,
    instructions: "What should the agent do next?",
    criteria: { escalate: "Escalate to the user", continue: "Keep going" },
  },
}

const input = {
  model: "~typesafe/jev-latest",
  state: "agent has failed the same test 3 times",
  questions,
}

/** Verbatim live 200 body, including members our schema does not model. */
const CAPTURED = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    progress: { type: "noul", noul: 0.06 },
    same_strategy: { type: "noul", noul: 0.71 },
    escalate: {
      type: "choice",
      choice: "escalate",
      probabilities: { escalate: 0.99, continue: 0.01 },
      confidence: 0.97,
    },
  },
  usage: { input_tokens: 310, output_tokens: 37, cost: 0.00001302 },
  id: "gen-dec-1789736766-SUFfxmhQt2dkZWpDh5b",
  provider: "TypeSafe",
}

describe("ClassifierOpenRouter.buildRequest", () => {
  it.effect("batches EVERY question into one request body", () =>
    Effect.gen(function* () {
      const request = ClassifierOpenRouter.buildRequest(input)
      expect(Object.keys(request.questions)).toHaveLength(3)
      expect(Object.keys(request.questions)).toEqual(["progress", "same_strategy", "escalate"])
      expect(request.model).toBe("~typesafe/jev-latest")
      expect(request.state).toBe(input.state)
      // criteria/instructions travel verbatim so the model knows the option set
      expect(request.questions.escalate).toEqual(questions.escalate)
      expect(ClassifierOpenRouter.OPENROUTER_DECISIONS_URL).toBe("https://openrouter.ai/api/alpha/decisions")
    }),
  )
})

describe("ClassifierOpenRouter.parseResponse", () => {
  it.effect("decodes the real captured payload verbatim, extras and all", () =>
    Effect.gen(function* () {
      const response = yield* ClassifierOpenRouter.parseResponse(CAPTURED)
      expect(response.model).toBe("typesafe/jev-1.13-20260917")
      expect(response.answers.progress).toEqual({ type: "noul", noul: 0.06 })
      expect(response.answers.same_strategy).toEqual({ type: "noul", noul: 0.71 })
      // The key acceptance: a choice answer keeps its probabilities + confidence.
      expect(response.answers.escalate).toEqual({
        type: "choice",
        choice: "escalate",
        probabilities: { escalate: 0.99, continue: 0.01 },
        confidence: 0.97,
      })
      expect(response.usage.input_tokens).toBe(310)
      expect(response.usage.output_tokens).toBe(37)
      // provenance: this transport proxies native Jev, so numbers are calibrated
      expect(response.transport).toBe("openrouter")
      expect(response.answers.progress).not.toHaveProperty("transport")
    }),
  )

  it.effect("rejects a malformed body as decode, without throwing", () =>
    Effect.gen(function* () {
      const error = yield* ClassifierOpenRouter.parseResponse({ answers: "nope" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ClassifierClient.SystemOneError)
      expect(error.kind).toBe("decode")
    }),
  )
})

describe("ClassifierOpenRouter.layer", () => {
  it.effect("reports missing_api_key when no credential is stored and none is in env", () =>
    Effect.gen(function* () {
      const error = yield* askError
      expect(error).toBeInstanceOf(ClassifierClient.SystemOneError)
      expect(error.kind).toBe("missing_api_key")
    }),
  )

  it.effect("maps a non-2xx response to http, without throwing", () =>
    withEnvKey(
      Effect.gen(function* () {
        const error = yield* askError
        expect(error).toBeInstanceOf(ClassifierClient.SystemOneError)
        expect(error.kind).toBe("http")
      }),
    ),
  )

  itGarbage.effect("maps an unparseable 200 body to decode, without throwing", () =>
    withEnvKey(
      Effect.gen(function* () {
        const error = yield* askError
        expect(error).toBeInstanceOf(ClassifierClient.SystemOneError)
        expect(error.kind).toBe("decode")
      }),
    ),
  )
})
