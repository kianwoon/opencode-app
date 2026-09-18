import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierAnomaly } from "@/classifier/anomaly"
import { testEffect } from "../lib/effect"

const steps = ["read file", "edit file", "run test"]

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

describe("buildAnomalyQuestions", () => {
  test("emits one choice for class plus two noul questions", () => {
    const questions = ClassifierAnomaly.buildAnomalyQuestions({ steps })
    expect(Object.keys(questions)).toEqual([
      ClassifierAnomaly.ANOMALY_KEYS.class,
      ClassifierAnomaly.ANOMALY_KEYS.needsHumanReview,
      ClassifierAnomaly.ANOMALY_KEYS.urgent,
    ])
    expect(questions[ClassifierAnomaly.ANOMALY_KEYS.class]!.type).toBe("choice")
    expect(questions[ClassifierAnomaly.ANOMALY_KEYS.needsHumanReview]!.type).toBe("noul")
    expect(questions[ClassifierAnomaly.ANOMALY_KEYS.urgent]!.type).toBe("noul")
    const review = questions[ClassifierAnomaly.ANOMALY_KEYS.needsHumanReview]
    expect(review.type === "noul" && review.criteria?.true).toBe("needs review")
  })

  test("summarises a huge trace instead of dumping it", () => {
    const huge = Array.from({ length: 200 }, () => "z".repeat(5000))
    const questions = ClassifierAnomaly.buildAnomalyQuestions({ steps: huge })
    const text = questions[ClassifierAnomaly.ANOMALY_KEYS.class]!.instructions as string
    expect(text.length).toBeLessThan(40 * 210 + 500)
    expect(text).toContain("0:")
  })
})

describe("evaluateAnomaly", () => {
  const noul = (noul: number) => ({ type: "noul" as const, noul })
  const choice = (choice: string, confidence = 0.9) => ({
    type: "choice" as const,
    choice,
    probabilities: {},
    confidence,
  })

  test("maps a known class and review flags", () => {
    const result = ClassifierAnomaly.evaluateAnomaly({
      answers: {
        [ClassifierAnomaly.ANOMALY_KEYS.class]: choice("stuck"),
        [ClassifierAnomaly.ANOMALY_KEYS.needsHumanReview]: noul(0.9),
        [ClassifierAnomaly.ANOMALY_KEYS.urgent]: noul(0.8),
      },
    })
    expect(result).toEqual({ class: "stuck", needsHumanReview: true, urgent: true, confidence: 0.9 })
  })

  test("MISSING answers fail open to normal / no escalation", () => {
    expect(ClassifierAnomaly.evaluateAnomaly({ answers: {} })).toEqual({
      class: "normal",
      needsHumanReview: false,
      urgent: false,
      confidence: 0,
    })
  })

  test("an unknown class string falls back to normal", () => {
    const result = ClassifierAnomaly.evaluateAnomaly({
      answers: { [ClassifierAnomaly.ANOMALY_KEYS.class]: choice("garbage") },
    })
    expect(result.class).toBe("normal")
  })
})

describe("ruleBasedAnomaly", () => {
  test("never throws and returns normal", () => {
    expect(ClassifierAnomaly.ruleBasedAnomaly()).toEqual({
      class: "normal",
      needsHumanReview: false,
      urgent: false,
      confidence: 0,
    })
  })
})

describe("classifyAnomaly batching", () => {
  const captured = captureHttp({
    [ClassifierAnomaly.ANOMALY_KEYS.class]: { type: "choice", choice: "off_policy", probabilities: {}, confidence: 0.9 },
    [ClassifierAnomaly.ANOMALY_KEYS.needsHumanReview]: { type: "noul", noul: 0.95 },
  })
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends all anomaly questions in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierAnomaly.classifyAnomaly({
          client,
          model: "jev-test",
          state: "trace material",
          steps,
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown>; state: string }
        expect(Object.keys(request.questions)).toHaveLength(3)
        expect(request.state).toBe("trace material")
        expect(result.class).toBe("off_policy")
        expect(result.needsHumanReview).toBe(true)
      }),
    ),
  )
})
