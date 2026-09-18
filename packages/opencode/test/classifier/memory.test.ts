import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierMemory } from "@/classifier/memory"
import { testEffect } from "../lib/effect"

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

describe("buildMemoryQuestions", () => {
  test("emits the four expected questions with correct types and YES-polarity", () => {
    const questions = ClassifierMemory.buildMemoryQuestions("lesson", ["existing"])
    expect(Object.keys(questions)).toEqual([
      ClassifierMemory.MEMORY_KEYS.worthStoring,
      ClassifierMemory.MEMORY_KEYS.duplicateOfExisting,
      ClassifierMemory.MEMORY_KEYS.isStale,
      ClassifierMemory.MEMORY_KEYS.scope,
    ])
    expect(questions[ClassifierMemory.MEMORY_KEYS.worthStoring]!.type).toBe("noul")
    expect(questions[ClassifierMemory.MEMORY_KEYS.duplicateOfExisting]!.type).toBe("noul")
    expect(questions[ClassifierMemory.MEMORY_KEYS.isStale]!.type).toBe("noul")
    expect(questions[ClassifierMemory.MEMORY_KEYS.scope]!.type).toBe("choice")
    // polarity: yes = keep outcome
    const worth = questions[ClassifierMemory.MEMORY_KEYS.worthStoring]
    expect(worth.type === "noul" && worth.criteria?.true).toBe("worth storing")
  })

  test("bounds huge candidate and existing excerpts", () => {
    const huge = "x".repeat(5000)
    const questions = ClassifierMemory.buildMemoryQuestions(huge, [huge])
    expect((questions[ClassifierMemory.MEMORY_KEYS.worthStoring]!.instructions as string).length).toBeLessThan(500)
    expect(questions[ClassifierMemory.MEMORY_KEYS.worthStoring]!.instructions).toContain("…")
  })
})

describe("evaluateMemory", () => {
  const noul = (noul: number) => ({ type: "noul" as const, noul })
  const choice = (choice: string) => ({ type: "choice" as const, choice, probabilities: {}, confidence: 0.9 })

  test("maps yes-answers to store/duplicate/stale and reads scope", () => {
    const result = ClassifierMemory.evaluateMemory({
      answers: {
        [ClassifierMemory.MEMORY_KEYS.worthStoring]: noul(0.9),
        [ClassifierMemory.MEMORY_KEYS.duplicateOfExisting]: noul(0.8),
        [ClassifierMemory.MEMORY_KEYS.isStale]: noul(0.7),
        [ClassifierMemory.MEMORY_KEYS.scope]: choice("global"),
      },
    })
    expect(result).toEqual({ store: true, duplicate: true, stale: true, scope: "global" })
  })

  test("MISSING answers fail open — store is false, scope is none", () => {
    expect(ClassifierMemory.evaluateMemory({ answers: {} })).toEqual({
      store: false,
      duplicate: false,
      stale: false,
      scope: "none",
    })
  })

  test("an unrecognised scope choice falls back to none", () => {
    const result = ClassifierMemory.evaluateMemory({
      answers: {
        [ClassifierMemory.MEMORY_KEYS.worthStoring]: noul(0.9),
        [ClassifierMemory.MEMORY_KEYS.scope]: choice("garbage"),
      },
    })
    expect(result.scope).toBe("none")
    expect(result.store).toBe(true)
  })
})

describe("ruleBasedMemory", () => {
  test("never throws and is conservative (store: false)", () => {
    expect(ClassifierMemory.ruleBasedMemory()).toEqual({ store: false, duplicate: false, stale: false, scope: "none" })
  })
})

describe("classifyMemory batching", () => {
  const captured = captureHttp({
    [ClassifierMemory.MEMORY_KEYS.worthStoring]: { type: "noul", noul: 0.9 },
    [ClassifierMemory.MEMORY_KEYS.scope]: { type: "choice", choice: "project", probabilities: {}, confidence: 0.9 },
  })
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends all four memory questions in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierMemory.classifyMemory({
          client,
          model: "jev-test",
          state: "memory material",
          candidate: "lesson",
          existing: ["old lesson"],
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown>; state: string }
        expect(Object.keys(request.questions)).toHaveLength(4)
        expect(request.state).toBe("memory material")
        expect(result.store).toBe(true)
        expect(result.scope).toBe("project")
      }),
    ),
  )
})
