import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import {
  CHOICE_CRITERIA_MESSAGE,
  NOUL_CRITERIA_MESSAGE,
  Parameters,
  QUESTIONS_MAX,
  askQuestions,
  formatAsk,
  formatUnavailable,
  toAskInput,
  toQuestions,
  truncationMarker,
} from "@/tool/jev-ask"
import { jevAsk, type JevTransport } from "@/jev/client"

const params = {
  goal: "decide whether the handoff is done",
  questions: [
    { id: "verdict", type: "choice" as const, instructions: "Is the result done?", criteria: { accept: "yes", refire: "no" } },
    { id: "relevance", type: "score" as const, instructions: "How relevant is it?", criteria: ["irrelevant", "must read"] },
    { id: "cheap", type: "noul" as const, instructions: "Is this cheap to answer?" },
  ],
}

const transport = (endpoint: string): Pick<JevTransport, "endpoint" | "id"> => ({ endpoint, id: "jev-latest" })

describe("toQuestions — per-type wire shape", () => {
  test("choice criteria is a record, score criteria is an array, noul carries none", () => {
    const questions = toQuestions(params)
    expect(questions["verdict"]).toEqual({
      type: "choice",
      instructions: "Is the result done?",
      criteria: { accept: "yes", refire: "no" },
    })
    expect(questions["relevance"]).toEqual({
      type: "score",
      instructions: "How relevant is it?",
      criteria: ["irrelevant", "must read"],
    })
    expect(questions["cheap"]).toEqual({ type: "noul", instructions: "Is this cheap to answer?" })
    expect(Object.hasOwn(questions["cheap"] as object, "criteria")).toBe(false)
  })

  test("toAskInput sends goal as state and resolves the default model spec", () => {
    const input = toAskInput(params, "key-123")
    expect(input.state).toBe("decide whether the handoff is done")
    expect(input.key).toBe("key-123")
    expect(input.model).toBe("typesafe/jev-latest")
    expect(Object.keys(input.questions)).toEqual(["verdict", "relevance", "cheap"])
  })
})

describe("Schema rejects the wire-422 shapes at the tool boundary", () => {
  test("choice with array criteria, score with record criteria, and noul with criteria all fail decode", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const bad = [
      { goal: "g", questions: [{ id: "a", type: "choice", instructions: "i", criteria: ["x"] }] },
      { goal: "g", questions: [{ id: "b", type: "score", instructions: "i", criteria: { "0": "x" } }] },
      { goal: "g", questions: [{ id: "c", type: "noul", instructions: "i", criteria: { x: "y" } }] },
    ]
    for (const args of bad) await expect(Effect.runPromise(decode(args as never))).rejects.toThrow()
  })

  test("noul with criteria fails decode with guidance naming `instructions`, not `Expected never`", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(
      decode({ goal: "g", questions: [{ id: "c", type: "noul", instructions: "i", criteria: { x: "y" } }] } as never),
    )
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain(NOUL_CRITERIA_MESSAGE)
    expect(message).not.toContain("Expected never")
  })

  test("choice with array criteria fails decode with guidance naming the record shape", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(
      decode({ goal: "g", questions: [{ id: "c", type: "choice", instructions: "i", criteria: ["x"] }] } as never),
    )
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain(CHOICE_CRITERIA_MESSAGE)
  })

  test("the well-formed shape decodes and carries three questions", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    await expect(Effect.runPromise(decode(params as never))).resolves.toMatchObject({ questions: expect.anything() })
  })
})

describe("formatAsk / formatUnavailable", () => {
  test("one compact primary-field line per id, plus the full typed rows", () => {
    const answers = {
      verdict: { choice: "accept", probabilities: { accept: 0.91 }, confidence: 0.91 },
      relevance: { score: 1, legend: { "0": "irrelevant", "1": "must read" } },
      cheap: { noul: 0.4 },
    }
    const { title, output } = formatAsk(params, answers)
    expect(title).toBe("jev: ask")
    expect(output).toContain("verdict: choice=accept")
    expect(output).toContain("relevance: score=1")
    expect(output).toContain("cheap: noul=0.4")
    expect(output).toContain(JSON.stringify(answers))
  })

  test("an unparsed row reads as unmeasured instead of vanishing", () => {
    const { output } = formatAsk(params, { verdict: {}, relevance: {}, cheap: {} })
    expect(output).toContain("verdict: unmeasured")
  })

  test("QUESTIONS_MAX truncation is marked explicitly with the dropped ids", () => {
    const oversize = {
      goal: "g",
      questions: Array.from({ length: QUESTIONS_MAX + 2 }, (_, i) => ({
        id: i === QUESTIONS_MAX + 1 ? "tail-a" : `q${i}`,
        type: "noul" as const,
        instructions: "i",
      })),
    }
    const marker = truncationMarker(oversize)
    expect(marker).toBe(
      `questions truncated from ${QUESTIONS_MAX + 2} to ${QUESTIONS_MAX}; dropped ids: q${QUESTIONS_MAX}, tail-a`,
    )
    const { output } = formatAsk(oversize, {})
    expect(output.startsWith(marker!)).toBe(true)
    expect(output).not.toContain("tail-a: unmeasured")
  })

  test("a question list at the cap emits no marker", () => {
    const exact = {
      goal: "g",
      questions: Array.from({ length: QUESTIONS_MAX }, (_, i) => ({
        id: `q${i}`,
        type: "noul" as const,
        instructions: "i",
      })),
    }
    expect(truncationMarker(exact)).toBeUndefined()
    expect(formatAsk(exact, {}).output).not.toContain("truncated")
  })

  test("formatUnavailable is the fail-open null shape", () => {
    expect(formatUnavailable()).toEqual({
      title: "jev: unavailable",
      output: JSON.stringify({ decision: null, reason: "unavailable" }),
    })
  })
})

describe("jevAsk over the transport seam", () => {
  test("posts all three typed questions and returns the answers record", async () => {
    let body: { questions?: Record<string, { type?: string; criteria?: unknown }> } = {}
    const answers = {
      verdict: { choice: "accept", probabilities: { accept: 0.91 } },
      relevance: { score: 1, legend: { "0": "irrelevant", "1": "must read" } },
      cheap: { noul: 0.4 },
    }
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        body = (await req.json()) as typeof body
        return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 12 } })
      },
    })
    try {
      const got = await jevAsk({
        ...toAskInput(params, "test-key"),
        transport: transport(`http://127.0.0.1:${server.port}/v1/systemone`),
      })
      expect(got).toEqual(answers)
      expect(body.questions?.["verdict"]?.type).toBe("choice")
      expect(body.questions?.["verdict"]?.criteria).toEqual({ accept: "yes", refire: "no" })
      expect(body.questions?.["relevance"]?.type).toBe("score")
      expect(Array.isArray(body.questions?.["relevance"]?.criteria)).toBe(true)
      expect(Object.hasOwn(body.questions?.["cheap"] as object, "criteria")).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("an envelope WITHOUT the model echo is not a decision response (fail open)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ answers: { verdict: { choice: "accept", probabilities: { accept: 0.9 } } } }),
    })
    try {
      const got = await jevAsk({
        ...toAskInput(params, "test-key"),
        transport: transport(`http://127.0.0.1:${server.port}/v1/systemone`),
      })
      expect(got).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })
})

describe("askQuestions — fail-open at the tool boundary", () => {
  test("a missing key short-circuits BEFORE any request is built", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++
        return Response.json({ model: "jev-1.13.0", answers: {} })
      },
    })
    try {
      const got = await askQuestions(params, undefined, transport(`http://127.0.0.1:${server.port}/v1/systemone`))
      expect(got).toBeUndefined()
      expect(hits).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test("an envelope WITHOUT the model echo folds to unavailable, not the raw answers", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ answers: { verdict: { choice: "accept", probabilities: { accept: 0.9 } }, cheap: { noul: 0.2 } } }),
    })
    try {
      const got = await askQuestions(params, "test-key", transport(`http://127.0.0.1:${server.port}/v1/systemone`))
      expect(got).toBeUndefined()
    } finally {
      server.stop(true)
    }
  })

  test("the happy path returns the titled per-id summary plus the full rows", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          model: "jev-1.13.0",
          answers: {
            verdict: { choice: "accept", probabilities: { accept: 0.9 } },
            relevance: { score: 1, legend: { "0": "irrelevant", "1": "must read" } },
            cheap: { noul: 0.2 },
          },
        }),
    })
    try {
      const got = await askQuestions(params, "test-key", transport(`http://127.0.0.1:${server.port}/v1/systemone`))
      expect(got?.title).toBe("jev: ask")
      expect(got?.output).toContain("verdict: choice=accept")
      expect(got?.output).toContain("relevance: score=1")
      expect(got?.output).toContain("cheap: noul=0.2")
      expect(got?.output).toContain('"probabilities":{"accept":0.9}')
    } finally {
      server.stop(true)
    }
  })
})
