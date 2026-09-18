import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierScreening } from "@/classifier/screening"
import { testEffect } from "../lib/effect"

const candidates = [
  { id: "a", text: "alpha" },
  { id: "b", text: "beta" },
  { id: "c", text: "gamma" },
]

/** Records every request body the REAL client sends, then answers with `answers`. */
function captureHttp(answers: Record<string, { type: "score"; score: number; legend: Record<string, string> }>) {
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

describe("buildScreeningQuestions", () => {
  test("produces exactly one score question per candidate, keyed by id", () => {
    const questions = ClassifierScreening.buildScreeningQuestions("pick", candidates)
    expect(Object.keys(questions)).toEqual(["a", "b", "c"])
    expect(Object.values(questions).every((question) => question.type === "score")).toBe(true)
  })

  test("carries the task and a bounded excerpt, never the whole candidate", () => {
    const huge = "x".repeat(5000)
    const questions = ClassifierScreening.buildScreeningQuestions("pick", [{ id: "big", text: huge }])
    expect(questions.big.instructions).toContain("pick")
    expect(questions.big.instructions).toContain("…")
    expect((questions.big.instructions as string).length).toBeLessThan(500)
  })

  test("an empty candidate list yields no questions and never throws", () => {
    expect(ClassifierScreening.buildScreeningQuestions("t", [])).toEqual({})
  })
})

describe("evaluateScreening — ranking, not filtering", () => {
  const score = (score: number) => ({ type: "score" as const, score, legend: {}, probabilities: {}, confidence: 0.9 })

  test("ranks by descending score and returns exactly top-K", () => {
    const ranked = ClassifierScreening.evaluateScreening({
      answers: { a: score(1), b: score(3), c: score(2) },
      candidates,
      keep: 2,
    })
    expect(ranked.map((verdict) => verdict.id)).toEqual(["b", "c"])
    expect(ranked.map((verdict) => verdict.score)).toEqual([3, 2])
  })

  test("MISSING answers fail open to the LOWEST score and are NOT promoted", () => {
    const ranked = ClassifierScreening.evaluateScreening({
      answers: { a: score(3) },
      candidates,
      keep: 2,
    })
    // a wins; b and c are unanswered (score -1, stable input order)
    expect(ranked.map((verdict) => verdict.id)).toEqual(["a", "b"])
    expect(ranked[0]!.score).toBe(3)
    expect(ranked.slice(1).every((verdict) => verdict.score === -1)).toBe(true)
  })

  test("a non-score answer fails open too", () => {
    const ranked = ClassifierScreening.evaluateScreening({
      answers: {
        a: { type: "choice", choice: "irrelevant", probabilities: {}, confidence: 0.9 },
        b: score(2),
      },
      candidates,
      keep: 3,
    })
    expect(ranked[0]!.id).toBe("b")
    expect(ranked.find((verdict) => verdict.id === "a")!.score).toBe(-1)
  })

  test("keep larger than the candidate set is safe; empty input never throws", () => {
    expect(ClassifierScreening.evaluateScreening({ answers: {}, candidates, keep: 99 })).toHaveLength(3)
    expect(ClassifierScreening.evaluateScreening({ answers: {}, candidates: [], keep: 3 })).toEqual([])
  })
})

describe("ruleBasedScreening", () => {
  test("keeps the first keep candidates, stable, no network", () => {
    expect(ClassifierScreening.ruleBasedScreening(candidates, 2).map((v) => v.id)).toEqual(["a", "b"])
  })

  test("never throws on empty or negative keep", () => {
    expect(ClassifierScreening.ruleBasedScreening([], 2)).toEqual([])
    expect(ClassifierScreening.ruleBasedScreening(candidates, -1)).toEqual([])
  })
})

describe("classifyScreening batching", () => {
  const answers = {
    a: { type: "score" as const, score: 0, legend: {}, probabilities: {}, confidence: 0.9 },
    b: { type: "score" as const, score: 3, legend: {}, probabilities: {}, confidence: 0.9 },
    c: { type: "score" as const, score: 1, legend: {}, probabilities: {}, confidence: 0.9 },
  }
  const captured = captureHttp(answers)
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends EVERY candidate question in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierScreening.classifyScreening({
          client,
          model: "jev-test",
          state: "full candidate material",
          task: "pick the best",
          candidates,
          keep: 2,
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown>; state: string }
        expect(Object.keys(request.questions)).toEqual(["a", "b", "c"])
        expect(request.state).toBe("full candidate material")
        expect(result.map((verdict) => verdict.id)).toEqual(["b", "c"])
      }),
    ),
  )
})

describe("classifyScreening fail-open on empty answers", () => {
  const captured = captureHttp({})
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("ranks nothing when the batch answers are empty (fail-open)", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierScreening.classifyScreening({
          client,
          model: "jev-test",
          state: "s",
          task: "pick",
          candidates,
          keep: 2,
        })
        expect(captured.bodies).toHaveLength(1)
        expect(result.every((verdict) => verdict.score === -1)).toBe(true)
      }),
    ),
  )
})

test("module is exported as a namespace", () => {
  expect(typeof ClassifierScreening.classifyScreening).toBe("function")
})
