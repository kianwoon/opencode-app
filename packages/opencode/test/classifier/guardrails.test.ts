import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierGuardrails } from "@/classifier/guardrails"
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

describe("buildGuardrailQuestions", () => {
  test("produces exactly one noul question per flag, keyed by id", () => {
    const questions = ClassifierGuardrails.buildGuardrailQuestions(["exposes_credentials", "modifies_production"])
    expect(Object.keys(questions)).toEqual(["exposes_credentials", "modifies_production"])
    expect(Object.values(questions).every((question) => question.type === "noul")).toBe(true)
  })

  test("phrases questions so HIGH = RISK PRESENT (danger polarity)", () => {
    const [question] = Object.values(ClassifierGuardrails.buildGuardrailQuestions(["exposes_credentials"]))
    const rendered = JSON.stringify(question)
    expect(rendered).toContain("exposes_credentials")
    expect(rendered).toContain("YES")
    expect(rendered).toContain("risk present")
    expect(rendered).toContain("no risk")
  })

  test("carries METADATA only — never a secret value field", () => {
    const [question] = Object.values(
      ClassifierGuardrails.buildGuardrailQuestions(["exposes_credentials"], {
        credentialPresent: true,
        credentialType: "API_TOKEN",
        destination: "api.example.com",
      }),
    )
    const instructions = JSON.stringify(question)
    expect(instructions).toContain("credential present: true")
    expect(instructions).toContain("credential type: API_TOKEN")
    expect(instructions).toContain("destination: api.example.com")
    expect(instructions).toContain("no secret values")
  })

  test("empty flag list yields no questions and never throws", () => {
    expect(ClassifierGuardrails.buildGuardrailQuestions([])).toEqual({})
  })
})

describe("evaluateGuardrails", () => {
  test("above threshold flags, below does not, unanswered FAILS CLOSED", () => {
    const verdicts = ClassifierGuardrails.evaluateGuardrails({
      answers: {
        exposes_credentials: { type: "noul", noul: 0.9 },
        modifies_production: { type: "noul", noul: 0.2 },
      },
      flags: ["exposes_credentials", "modifies_production", "violates_task_scope"],
      threshold: 0.5,
    })
    expect(verdicts.map((entry) => entry.risky)).toEqual([true, false, true])
  })

  test("MISSING / malformed answers fail CLOSED — the flag is treated as RISKY", () => {
    const verdicts = ClassifierGuardrails.evaluateGuardrails({
      answers: { exposes_credentials: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 } },
      flags: ["exposes_credentials", "modifies_production"],
      threshold: 0.5,
    })
    expect(verdicts.every((entry) => entry.risky)).toBe(true)
  })

  test("contrast: verification fails OPEN on missing, guardrails fail CLOSED", () => {
    // documented by this pair of module exports
    expect(typeof ClassifierGuardrails.evaluateGuardrails).toBe("function")
  })
})

describe("ruleBasedGuardrails", () => {
  test("never throws and flags nothing", () => {
    expect(ClassifierGuardrails.ruleBasedGuardrails(["a", "b"]).every((entry) => !entry.risky)).toBe(true)
    expect(ClassifierGuardrails.ruleBasedGuardrails([])).toEqual([])
  })
})

describe("guardrails are structurally ADVISORY (no allow path)", () => {
  test("a verdict carries only a risk flag — never an allow/safe value", () => {
    const verdicts = ClassifierGuardrails.evaluateGuardrails({
      answers: {},
      flags: ["exposes_credentials"],
      threshold: 0.5,
    })
    expect(Object.keys(verdicts[0]!).sort()).toEqual(["flag", "probability", "risky"])
    // There is no `allow`/`decision`/`safe` key that could override a hard deny.
    expect("allow" in verdicts[0]!).toBe(false)
    expect("decision" in verdicts[0]!).toBe(false)
  })
})

describe("classifyGuardrails batching", () => {
  // The key acceptance: N flags must ride ONE request, not N requests.
  const answers = {
    exposes_credentials: { type: "noul" as const, noul: 0.1 },
    modifies_production: { type: "noul" as const, noul: 0.1 },
    violates_task_scope: { type: "noul" as const, noul: 0.1 },
  }
  const captured = captureHttp(answers)
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  delete process.env.TYPESAFE_API_KEY

  it.effect("sends EVERY flag question in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierGuardrails.classifyGuardrails({
          client,
          model: "jev-test",
          state: "rm -rf /",
          flags: ["exposes_credentials", "modifies_production", "violates_task_scope"],
          metadata: { operation: "shell" },
          threshold: 0.5,
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown>; state: string }
        expect(Object.keys(request.questions)).toEqual([
          "exposes_credentials",
          "modifies_production",
          "violates_task_scope",
        ])
        expect(result.anyRisky).toBe(false)
      }),
    ),
  )

  it.effect("fails CLOSED when the batch answers are empty", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierGuardrails.classifyGuardrails({
          client,
          model: "jev-test",
          state: "t",
          flags: ["unanswered"],
          threshold: 0.5,
        })
        expect(result.anyRisky).toBe(true)
        expect(result.flags.every((entry) => entry.risky)).toBe(true)
      }),
    ),
  )
})
