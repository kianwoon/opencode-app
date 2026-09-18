import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierScoring } from "@/classifier/scoring"
import { testEffect } from "../lib/effect"

const dimensions = ["quality", "risk", "urgency", "complexity", "confidence"]

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

const scoreAnswer = (score: number, confidence = 0.9) => ({
  type: "score",
  score,
  legend: { "0": "low", "1": "medium", "2": "high" },
  probabilities: {},
  confidence,
})

describe("buildScoreQuestions", () => {
  test("produces exactly one score question per dimension, keyed by name", () => {
    const questions = ClassifierScoring.buildScoreQuestions("subj", dimensions)
    expect(Object.keys(questions)).toEqual(dimensions)
    expect(Object.values(questions).every((question) => question.type === "score")).toBe(true)
    expect(questions.quality!.criteria).toEqual(["low", "medium", "high"])
  })
})

describe("evaluateScores", () => {
  test("maps each score answer to label + normalised value", () => {
    const scores = ClassifierScoring.evaluateScores({
      answers: { quality: scoreAnswer(2), risk: scoreAnswer(0) } as never,
      dimensions,
    })
    expect(scores.quality).toEqual({ level: "high", value: 1, confidence: 0.9 })
    expect(scores.risk).toEqual({ level: "low", value: 0, confidence: 0.9 })
    expect(scores.urgency).toBeUndefined()
  })

  test("fails open on missing or malformed answers (no throw)", () => {
    const scores = ClassifierScoring.evaluateScores({
      answers: { quality: { type: "noul", noul: 0.7 } as never },
      dimensions,
    })
    expect(scores).toEqual({})
  })
})

describe("ruleBasedScores", () => {
  test("never throws and returns a neutral score per dimension", () => {
    const scores = ClassifierScoring.ruleBasedScores(dimensions)
    expect(Object.keys(scores)).toEqual(dimensions)
    expect(scores.quality).toEqual({ level: "unknown", value: 0.5, confidence: 0 })
  })
})

describe("toScoresResult", () => {
  test("empty result folds to UNSURE; a real score to RATED", () => {
    expect(ClassifierScoring.toScoresResult({}).decision).toBe("UNSURE")
    expect(ClassifierScoring.toScoresResult({ quality: { level: "high", value: 1, confidence: 0.9 } }).decision).toBe(
      "RATED",
    )
  })
})

describe("classifyScores batching", () => {
  const captured = captureHttp({
    quality: scoreAnswer(2),
    risk: scoreAnswer(1),
    urgency: scoreAnswer(0),
    complexity: scoreAnswer(2),
    confidence: scoreAnswer(1),
  })
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends EVERY dimension question in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierScoring.classifyScores({
          client,
          model: "jev-test",
          state: "some state",
          subject: "the subject",
          dimensions,
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown> }
        expect(Object.keys(request.questions)).toEqual(dimensions)
        expect(result.decision).toBe("RATED")
        expect(result.reasonCode).toBe("SCORES_RATED")
        expect(result.scores.quality!.level).toBe("high")
      }),
    ),
  )

  it.effect("folds to UNSURE when the batch answers are empty", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierScoring.classifyScores({
          client,
          model: "jev-test",
          state: "s",
          subject: "t",
          dimensions: ["unanswered"],
        })
        expect(result.decision).toBe("UNSURE")
        expect(result.reasonCode).toBe("SCORES_UNKNOWN")
      }),
    ),
  )
})
