import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierMatching } from "@/classifier/matching"
import { testEffect } from "../lib/effect"

const small = [
  { id: "grep", description: "search text" },
  { id: "glob", description: "find files" },
]
const large = Array.from({ length: 9 }, (_, index) => ({ id: `o${index}`, description: `option ${index}` }))

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

describe("buildMatchQuestions", () => {
  test("small sets use ONE choice question over option ids", () => {
    const questions = ClassifierMatching.buildMatchQuestions("find a tool", small)
    expect(Object.keys(questions)).toEqual([ClassifierMatching.MATCH_CHOICE_KEY])
    expect(questions[ClassifierMatching.MATCH_CHOICE_KEY]!.type).toBe("choice")
  })

  test("large sets use ONE score question per option", () => {
    const questions = ClassifierMatching.buildMatchQuestions("find a tool", large)
    expect(Object.keys(questions)).toHaveLength(9)
    expect(Object.values(questions).every((question) => question.type === "score")).toBe(true)
  })

  test("mode switches at the choice boundary and empty never throws", () => {
    expect(ClassifierMatching.matchMode(small)).toBe("choice")
    expect(ClassifierMatching.matchMode(large)).toBe("score")
    expect(ClassifierMatching.buildMatchQuestions("t", [])).toEqual({})
  })
})

describe("evaluateMatch", () => {
  test("choice mode names the winner; unknown/absent ⇒ no match", () => {
    const hit = ClassifierMatching.evaluateMatch({
      answers: { [ClassifierMatching.MATCH_CHOICE_KEY]: { type: "choice", choice: "glob", probabilities: {}, confidence: 0.9 } },
      options: small,
    })
    expect(hit.winner?.id).toBe("glob")

    const miss = ClassifierMatching.evaluateMatch({
      answers: { [ClassifierMatching.MATCH_CHOICE_KEY]: { type: "choice", choice: "nope", probabilities: {}, confidence: 0.9 } },
      options: small,
    })
    expect(miss.winner).toBeUndefined()
  })

  test("score mode picks the top-scoring option and ranks the rest", () => {
    const answers = Object.fromEntries(
      large.map((option, index) => [option.id, { type: "score" as const, score: index === 4 ? 3 : 1, legend: {}, probabilities: {}, confidence: 0.9 }]),
    )
    const result = ClassifierMatching.evaluateMatch({ answers, options: large })
    expect(result.winner?.id).toBe("o4")
    expect(result.ranked[0]).toEqual({ id: "o4", score: 3 })
  })

  test("MISSING answers fail open to no winner (never guesses)", () => {
    const { winner } = ClassifierMatching.evaluateMatch({ answers: {}, options: small })
    expect(winner).toBeUndefined()
  })

  test("score mode with all-zero scores ⇒ no winner", () => {
    const answers = Object.fromEntries(large.map((option) => [option.id, { type: "score" as const, score: 0, legend: {}, probabilities: {}, confidence: 0.9 }]))
    expect(ClassifierMatching.evaluateMatch({ answers, options: large }).winner).toBeUndefined()
  })
})

describe("ruleBasedMatch", () => {
  test("never throws and returns no match", () => {
    expect(ClassifierMatching.ruleBasedMatch().winner).toBeUndefined()
    expect(ClassifierMatching.ruleBasedMatch().ranked).toEqual([])
  })
})

describe("classifyMatch batching", () => {
  const captured = captureHttp({
    [ClassifierMatching.MATCH_CHOICE_KEY]: { type: "choice", choice: "glob", probabilities: {}, confidence: 0.9 },
  })
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends the whole option set in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierMatching.classifyMatch({
          client,
          model: "jev-test",
          state: "need material",
          need: "find a file",
          options: small,
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown>; state: string }
        expect(Object.keys(request.questions)).toEqual([ClassifierMatching.MATCH_CHOICE_KEY])
        expect(request.state).toBe("need material")
        expect(result.winner?.id).toBe("glob")
      }),
    ),
  )
})
