import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierVerification } from "@/classifier/verification"
import { testEffect } from "../lib/effect"

/** Records every request body the REAL client sends, then answers with `answers`. */
function captureHttp(answers: Record<string, { type: "noul"; noul: number }>) {
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

describe("buildVerificationQuestions", () => {
  test("produces exactly one noul question per check, keyed by id", () => {
    const questions = ClassifierVerification.buildVerificationQuestions(["tests_passed", "scope_matches"])
    expect(Object.keys(questions)).toEqual(["tests_passed", "scope_matches"])
    expect(Object.values(questions).every((question) => question.type === "noul")).toBe(true)
  })

  test("phrases questions so HIGH = SATISFIED (the good outcome)", () => {
    const [question] = Object.values(ClassifierVerification.buildVerificationQuestions(["tests_passed"]))
    const rendered = JSON.stringify(question)
    expect(rendered).toContain("tests_passed")
    expect(rendered).toContain("satisfied")
    expect(rendered).toContain("not satisfied")
  })

  test("carries the task and a bounded artifact excerpt, never the whole artifact", () => {
    const huge = "x".repeat(5000)
    const [question] = Object.values(
      ClassifierVerification.buildVerificationQuestions(["tests_passed"], { task: "fix the test", artifact: huge }),
    )
    const rendered = JSON.stringify(question)
    expect(rendered).toContain("fix the test")
    expect(rendered).toContain("…")
    expect(rendered.length).toBeLessThan(700)
  })

  test("empty check list yields no questions and never throws", () => {
    expect(ClassifierVerification.buildVerificationQuestions([])).toEqual({})
  })
})

describe("evaluateVerification", () => {
  test("above threshold satisfies, below fails, unanswered FAILS OPEN", () => {
    const checked = ClassifierVerification.evaluateVerification({
      answers: {
        tests_passed: { type: "noul", noul: 0.9 },
        scope_matches: { type: "noul", noul: 0.2 },
      },
      checks: ["tests_passed", "scope_matches", "no_unresolved_blocker"],
      threshold: 0.5,
    })
    expect(checked.map((entry) => entry.satisfied)).toEqual([true, false, true])
  })

  test("MISSING / malformed answers fail OPEN — the check is satisfied", () => {
    const checked = ClassifierVerification.evaluateVerification({
      answers: { tests_passed: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 } },
      checks: ["tests_passed", "addresses_request"],
      threshold: 0.5,
    })
    expect(checked.every((entry) => entry.satisfied)).toBe(true)
  })
})

describe("ruleBasedVerification + verdict", () => {
  test("rule-based never throws and passes everything", () => {
    const checked = ClassifierVerification.ruleBasedVerification(["a", "b"])
    expect(checked.every((entry) => entry.satisfied)).toBe(true)
    expect(ClassifierVerification.verdict(checked).decision).toBe("PASS")
    expect(ClassifierVerification.verdict([]).decision).toBe("UNCERTAIN")
  })

  test("verdict reports FAIL with the failed check names", () => {
    const checked = [
      { check: "tests_passed", satisfied: true, probability: 0.9 },
      { check: "scope_matches", satisfied: false, probability: 0.1 },
    ]
    expect(ClassifierVerification.verdict(checked)).toEqual({ decision: "FAIL", failed: ["scope_matches"] })
  })
})

describe("classifyVerification batching", () => {
  // The key acceptance: N checks must ride ONE request, not N requests.
  const answers = {
    tests_passed: { type: "noul" as const, noul: 0.9 },
    addresses_request: { type: "noul" as const, noul: 0.9 },
    scope_matches: { type: "noul" as const, noul: 0.1 },
  }
  const captured = captureHttp(answers)
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends EVERY check question in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierVerification.classifyVerification({
          client,
          model: "jev-test",
          state: "fix the failing test",
          checks: ["tests_passed", "addresses_request", "scope_matches"],
          threshold: 0.5,
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown>; state: string }
        expect(Object.keys(request.questions)).toEqual(["tests_passed", "addresses_request", "scope_matches"])
        expect(request.state).toBe("fix the failing test")
        expect(result.decision).toBe("FAIL")
        expect(result.failed).toEqual(["scope_matches"])
      }),
    ),
  )

  it.effect("fails OPEN when the batch answers are empty", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierVerification.classifyVerification({
          client,
          model: "jev-test",
          state: "t",
          checks: ["unanswered"],
          threshold: 0.5,
        })
        expect(result.decision).toBe("PASS")
        expect(result.checked.every((entry) => entry.satisfied)).toBe(true)
      }),
    ),
  )
})
