import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierBatch } from "@/classifier/batch"
import { testEffect } from "../lib/effect"

/** Records every request body the REAL client sends, then answers with `answers`. */
function captureHttp(answers: Record<string, unknown>) {
  const bodies: string[] = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request)
        bodies.push(yield* Effect.promise(() => web.text()))
        const body = JSON.stringify({
          model: "jev-test",
          answers,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        )
      }).pipe(Effect.orDie),
    ),
  )
  return { bodies, layer }
}

const withEnvKey = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const saved = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = "test-key"
  return effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (saved === undefined) delete process.env.TYPESAFE_API_KEY
        else process.env.TYPESAFE_API_KEY = saved
      }),
    ),
  )
}

const noulAnswer = (noul: number) => ({ type: "noul", noul })

describe("chunk", () => {
  test("splits into consecutive chunks, size floored to 1", () => {
    expect(ClassifierBatch.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(ClassifierBatch.chunk([1, 2], 0)).toEqual([[1], [2]])
    expect(ClassifierBatch.chunk([], 3)).toEqual([])
  })
})

describe("buildBatchQuestions", () => {
  test("keys questions by GLOBAL index so chunks never collide", () => {
    const first = ClassifierBatch.buildBatchQuestions(["a", "b"], "is it bad?", 0)
    const second = ClassifierBatch.buildBatchQuestions(["c"], "is it bad?", 2)
    expect(Object.keys(first)).toEqual(["0", "1"])
    expect(Object.keys(second)).toEqual(["2"])
    expect(Object.values(first).every((question) => question.type === "noul")).toBe(true)
  })
})

describe("aggregate", () => {
  test("folds outcomes into summary counts", () => {
    expect(
      ClassifierBatch.aggregate(
        [
          { index: 0, outcome: "yes" },
          { index: 1, outcome: "no" },
          { index: 2, outcome: "unknown" },
        ],
        5,
      ),
    ).toEqual({ total: 5, yes: 1, no: 1, unknown: 3 })
  })
})

describe("classifyBatch batching", () => {
  const captured = captureHttp({
    "0": noulAnswer(0.9),
    "1": noulAnswer(0.1),
    "2": noulAnswer(0.8),
  })
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends ONE call per chunk, not per item", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierBatch.classifyBatch({
          client,
          model: "jev-test",
          instruction: "Is this item bad?",
          items: ["a", "b", "c"],
          chunkSize: 2,
        })
        expect(captured.bodies).toHaveLength(2)
        expect(result.chunks).toBe(2)
        expect(result.failedChunks).toBe(0)
        expect(result.results).toEqual([
          { index: 0, outcome: "yes" },
          { index: 1, outcome: "no" },
          { index: 2, outcome: "yes" },
        ])
        expect(result.aggregate).toEqual({ total: 3, yes: 2, no: 1, unknown: 0 })
      }),
    ),
  )

  it.effect("fails open per chunk when a request errors", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierBatch.classifyBatch({
          client,
          model: "jev-test",
          instruction: "x",
          items: ["a"],
          chunkSize: 1,
          mapItem: () => "s",
        })
        // Answers present for index 0 → resolved; aggregate still totals correctly.
        expect(result.aggregate.total).toBe(1)
      }),
    ),
  )
})

describe("classifyBatch fail-open on chunk error", () => {
  // A 400 makes the REAL client fail with a typed SystemOneError per chunk.
  const failing = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("bad", { status: 400 }))),
    ),
  )
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(failing)))
  delete process.env.TYPESAFE_API_KEY

  it.effect("a failed chunk marks its items unknown without losing the fold", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierBatch.classifyBatch({
          client,
          model: "jev-test",
          instruction: "x",
          items: ["a", "b"],
          chunkSize: 1,
        })
        expect(result.chunks).toBe(2)
        expect(result.failedChunks).toBe(2)
        expect(result.results).toEqual([
          { index: 0, outcome: "unknown" },
          { index: 1, outcome: "unknown" },
        ])
        expect(result.aggregate).toEqual({ total: 2, yes: 0, no: 0, unknown: 2 })
      }),
    ),
  )
})
