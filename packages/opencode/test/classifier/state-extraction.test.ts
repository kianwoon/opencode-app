import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierStateExtraction } from "@/classifier/state-extraction"
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

const choiceAnswer = (choice: string) => ({
  type: "choice",
  choice,
  probabilities: { [choice]: 0.8 },
  confidence: 0.8,
})
const noulAnswer = (noul: number) => ({ type: "noul", noul })

const fields = ["task_type", "error_category"]
const flags = ["has_test_failure", "risk_flag"]

describe("buildExtractionQuestions", () => {
  test("one choice question per field and one noul question per flag", () => {
    const questions = ClassifierStateExtraction.buildExtractionQuestions(fields, flags)
    expect(Object.keys(questions)).toEqual([...fields, ...flags])
    expect(questions.task_type!.type).toBe("choice")
    expect(questions.has_test_failure!.type).toBe("noul")
    expect(Object.keys((questions.task_type as { criteria: object }).criteria)).toEqual([
      "bugfix",
      "feature",
      "refactor",
      "investigation",
      "other",
    ])
  })
})

describe("evaluateExtraction", () => {
  test("folds answers into a compact typed struct", () => {
    const extraction = ClassifierStateExtraction.evaluateExtraction({
      answers: {
        task_type: choiceAnswer("bugfix"),
        has_test_failure: noulAnswer(0.9),
        risk_flag: noulAnswer(0.2),
      } as never,
      fields,
      flags,
    })
    expect(extraction.fields).toEqual({ task_type: "bugfix" })
    expect(extraction.flags).toEqual({ has_test_failure: true, risk_flag: false })
  })

  test("fails open on missing or malformed answers (no throw)", () => {
    const extraction = ClassifierStateExtraction.evaluateExtraction({
      answers: {
        task_type: choiceAnswer("not-an-option"),
        error_category: noulAnswer(0.9),
      } as never,
      fields,
      flags,
    })
    expect(extraction).toEqual({ fields: {}, flags: {} })
  })
})

describe("ruleBasedExtraction", () => {
  test("never throws and returns no facts", () => {
    expect(ClassifierStateExtraction.ruleBasedExtraction()).toEqual({ fields: {}, flags: {} })
  })
})

describe("toExtractionResult", () => {
  test("empty folds to UNSURE; any fact to EXTRACTED", () => {
    expect(ClassifierStateExtraction.toExtractionResult({ fields: {}, flags: {} }).decision).toBe("UNSURE")
    expect(ClassifierStateExtraction.toExtractionResult({ fields: { task_type: "bugfix" }, flags: {} }).decision).toBe(
      "EXTRACTED",
    )
  })
})

describe("classifyExtraction batching", () => {
  const captured = captureHttp({
    task_type: choiceAnswer("bugfix"),
    error_category: choiceAnswer("test"),
    has_test_failure: noulAnswer(0.9),
    risk_flag: noulAnswer(0.1),
  })
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends EVERY field and flag question in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierStateExtraction.classifyExtraction({
          client,
          model: "jev-test",
          state: "messy agent state",
          fields,
          flags,
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown> }
        expect(Object.keys(request.questions)).toEqual([...fields, ...flags])
        expect(result.decision).toBe("EXTRACTED")
        expect(result.extraction.fields.task_type).toBe("bugfix")
        expect(result.extraction.flags.has_test_failure).toBe(true)
      }),
    ),
  )

  it.effect("folds to UNSURE when the batch answers are empty", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierStateExtraction.classifyExtraction({
          client,
          model: "jev-test",
          state: "s",
          fields: ["unanswered_field"],
          flags: [],
        })
        expect(result.decision).toBe("UNSURE")
        expect(result.reasonCode).toBe("FACTS_UNKNOWN")
      }),
    ),
  )
})
