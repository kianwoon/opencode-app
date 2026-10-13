import { describe, expect, test } from "bun:test"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Cause, Effect, Exit, Schema } from "effect"
import {
  ALL_MALFORMED_MESSAGE,
  CHOICE_CRITERIA_MESSAGE,
  CHOICE_CRITERIA_REQUIRED_MESSAGE,
  CRITERIA_LENGTH_MESSAGE,
  INSTRUCTIONS_DEFAULTS,
  ParametersJsonSchema,
  SCORE_CRITERIA_MESSAGE,
  SCORE_CRITERIA_REQUIRED_MESSAGE,
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

describe("instructions is optional-with-default on every arm", () => {
  test.each([
    ["c", { id: "c", type: "choice", criteria: { a: "b", c: "d" } }, INSTRUCTIONS_DEFAULTS.choice],
    ["s", { id: "s", type: "score", criteria: ["low", "high"] }, INSTRUCTIONS_DEFAULTS.score],
    ["n", { id: "n", type: "noul" }, INSTRUCTIONS_DEFAULTS.noul],
  ] as const)("%s question without instructions decodes and carries its default", async (id, question, expected) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const params_ = await Effect.runPromise(decode({ goal: "g", questions: [question] } as never))
    expect(toQuestions(params_)[id]).toMatchObject({ instructions: expected })
  })

  test("a mixed batch with no instructions on any arm decodes, defaults applied", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [
          { id: "c", type: "choice", criteria: { a: "b", c: "d" } },
          { id: "s", type: "score", criteria: ["low", "high"] },
          { id: "n", type: "noul" },
        ],
      } as never),
    )
    expect(toQuestions(params_)["c"]).toMatchObject({ instructions: INSTRUCTIONS_DEFAULTS.choice })
    expect(toQuestions(params_)["s"]).toMatchObject({ instructions: INSTRUCTIONS_DEFAULTS.score })
    expect(toQuestions(params_)["n"]).toEqual({ type: "noul", instructions: INSTRUCTIONS_DEFAULTS.noul })
  })
})

// The discriminator is inferable from shape: same normalization rule as
// INSTRUCTIONS_DEFAULTS, one class earlier (the type field instead of instructions).
describe("a question without a `type` infers its arm from shape", () => {
  test.each([
    ["score", { id: "s", instructions: "i", criteria: ["low", "high"] }],
    ["choice", { id: "c", instructions: "i", criteria: { keep: "helps", drop: "irrelevant" } }],
    ["noul", { id: "n", instructions: "i" }],
  ] as const)("array criteria → score, record criteria → choice, absent → noul (%s)", async (arm, question) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const params_ = await Effect.runPromise(decode({ goal: "g", questions: [question] } as never))
    expect(toQuestions(params_)[question.id]).toMatchObject({ type: arm })
  })

  test("a type-less question with no criteria defaults to noul AND its instructions default", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const params_ = await Effect.runPromise(decode({ goal: "g", questions: [{ id: "n" }] } as never))
    expect(toQuestions(params_)["n"]).toEqual({ type: "noul", instructions: INSTRUCTIONS_DEFAULTS.noul })
  })

  test("a non-object question keeps the pre-inference failure", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    await expect(Effect.runPromise(decode({ goal: "g", questions: [42] } as never))).rejects.toThrow()
  })
})

describe("a TYPED question that omits the criteria KEY fails with the arm's guided message", () => {
  test.each([
    ["choice", "choice", CHOICE_CRITERIA_REQUIRED_MESSAGE],
    ["score", "score", SCORE_CRITERIA_REQUIRED_MESSAGE],
  ] as const)("%s", async (_label, type, expected) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(decode({ goal: "g", questions: [{ id: "q", type }] } as never))
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain(expected)
    expect(message).not.toContain("Missing key")
  })
})

const criteriaOf = (row: unknown) =>
  typeof row === "object" && row !== null && "criteria" in row ? row.criteria : undefined

describe("Schema rejects the wire-422 shapes at the tool boundary", () => {
  test("score with record criteria still fails decode", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    // choice with an array criteria no longer belongs here: it is COERCED to a
    // record at decode (see "choice array criteria decodes to a record").
    const args = { goal: "g", questions: [{ id: "b", type: "score", instructions: "i", criteria: { "0": "x" } }] }
    await expect(Effect.runPromise(decode(args as never))).rejects.toThrow()
  })

  test("noul with record criteria decodes and drops the criteria key from the wire payload", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const params_ = await Effect.runPromise(
      decode({ goal: "g", questions: [{ id: "c", type: "noul", instructions: "i", criteria: { x: "y" } }] } as never),
    )
    const wire = toQuestions(params_)["c"]
    expect(criteriaOf(wire)).toBeUndefined()
    expect(wire).toEqual({ type: "noul", instructions: "i" })
  })

  test("noul with array criteria also decodes and drops the criteria key", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const params_ = await Effect.runPromise(
      decode({ goal: "g", questions: [{ id: "c", type: "noul", instructions: "i", criteria: ["a", "b"] }] } as never),
    )
    const wire = toQuestions(params_)["c"]
    expect(criteriaOf(wire)).toBeUndefined()
    expect(wire).toEqual({ type: "noul", instructions: "i" })
  })

  test("choice array criteria decodes to a record with derived labels", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [
          {
            id: "c",
            type: "choice",
            instructions: "i",
            criteria: ["keeps the handoff useful", "totally irrelevant to the fix"],
          },
        ],
      } as never),
    )
    expect(criteriaOf(toQuestions(params_)["c"])).toEqual({
      "keeps-the-handoff": "keeps the handoff useful",
      "totally-irrelevant-to": "totally irrelevant to the fix",
    })
  })

  test("a valid choice record decodes unchanged", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [{ id: "c", type: "choice", instructions: "i", criteria: { keep: "helps", drop: "irrelevant" } }],
      } as never),
    )
    expect(toQuestions(params_)["c"]).toEqual({
      type: "choice",
      instructions: "i",
      criteria: { keep: "helps", drop: "irrelevant" },
    })
  })

  test("the score arm still decodes an array criteria as an array", async () => {
    const questions = toQuestions({
      goal: "g",
      questions: [{ id: "s", type: "score", instructions: "i", criteria: ["low", "high"] }],
    })
    expect(criteriaOf(questions["s"])).toEqual(["low", "high"])
  })

  test.each([
    ["an array containing a non-string", ["a", 5]],
    ["a record with a non-string value", { a: 1 }],
    ["an empty array", []],
  ])("choice criteria that is %s fails decode with guidance", async (_label, criteria) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(
      decode({ goal: "g", questions: [{ id: "c", type: "choice", instructions: "i", criteria }] } as never),
    )
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain(CHOICE_CRITERIA_MESSAGE)
  })

  test("derived labels de-duplicate collisions deterministically within the 64-char bound", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const long = `${"x".repeat(30)} ${"y".repeat(30)} ${"z".repeat(30)}`
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [
          {
            id: "c",
            type: "choice",
            instructions: "i",
            criteria: ["same words here", "same words here", "!!!", long],
          },
        ],
      } as never),
    )
    const labels = Object.keys(criteriaOf(toQuestions(params_)["c"]) ?? {})
    expect(labels).toEqual([
      "same-words-here",
      "same-words-here-2",
      "option",
      `${"x".repeat(30)}-${"y".repeat(30)}-${"z".repeat(2)}`,
    ])
    expect(labels.every((label) => label.length > 0 && label.length <= 64)).toBe(true)
  })

  test.each([
    ["a 25-string array", Array.from({ length: 25 }, (_, index) => `description ${index}`)],
    ["a 25-entry record", Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`k${index}`, `v${index}`]))],
    ["a 1-string array", ["only one"]],
    ["an empty record", {}],
  ])("choice criteria with an out-of-range option count (%s) fails decode", async (_label, criteria) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(
      decode({ goal: "g", questions: [{ id: "c", type: "choice", instructions: "i", criteria }] } as never),
    )
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain(CHOICE_CRITERIA_MESSAGE)
  })

  // Vendor bound: 2000 serialized chars per question, measured on the wire JSON.
  const choiceAt = (chars: number) => {
    const each = Math.ceil((chars - 12) / 2)
    return { keep: "k".repeat(each), drop: "d".repeat(each) }
  }
  const scoreAt = (chars: number) => {
    const each = Math.ceil((chars - 4) / 2)
    return ["l".repeat(each), "m".repeat(each)]
  }

  test("choice criteria past the serialized bound fails with the length guidance", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(
      decode({ goal: "g", questions: [{ id: "c", type: "choice", instructions: "i", criteria: choiceAt(2100) }] } as never),
    )
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(CRITERIA_LENGTH_MESSAGE)
  })

  test("score criteria past the serialized bound fails with the length guidance", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(
      decode({ goal: "g", questions: [{ id: "s", type: "score", instructions: "i", criteria: scoreAt(2100) }] } as never),
    )
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(CRITERIA_LENGTH_MESSAGE)
  })

  test.each([
    ["choice", "choice", choiceAt(1990)],
    ["score", "score", scoreAt(1990)],
  ])("%s criteria just under the serialized bound still decodes", async (_label, type, criteria) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    expect(JSON.stringify(criteria).length).toBeLessThanOrEqual(2000)
    const params_ = await Effect.runPromise(
      decode({ goal: "g", questions: [{ id: "q", type, instructions: "i", criteria }] } as never),
    )
    expect(criteriaOf(toQuestions(params_)["q"])).toEqual(criteria)
  })

  test.each([
    ["1 level", ["only one"]],
    ["11 levels", Array.from({ length: 11 }, (_, index) => `level ${index}`)],
  ])("score criteria with %s fails with guidance", async (_label, criteria) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(
      decode({ goal: "g", questions: [{ id: "s", type: "score", instructions: "i", criteria }] } as never),
    )
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(SCORE_CRITERIA_MESSAGE)
  })

  test("score criteria still rejects a record", async () => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const exit = await Effect.runPromiseExit(
      decode({ goal: "g", questions: [{ id: "s", type: "score", instructions: "i", criteria: { "0": "x" } }] } as never),
    )
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(SCORE_CRITERIA_MESSAGE)
  })

  test.each([2, 10])("score criteria with exactly %i levels still decodes", async (count) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const criteria = Array.from({ length: count }, (_, index) => `level ${index}`)
    const params_ = await Effect.runPromise(
      decode({ goal: "g", questions: [{ id: "s", type: "score", instructions: "i", criteria }] } as never),
    )
    expect(criteriaOf(toQuestions(params_)["s"])).toEqual(criteria)
  })

  test.each([2, 20])("choice criteria with exactly %i options still decodes", async (count) => {
    const decode = Schema.decodeUnknownEffect(Parameters)
    const criteria = Array.from({ length: count }, (_, index) => `description ${index}`)
    const params_ = await Effect.runPromise(
      decode({ goal: "g", questions: [{ id: "c", type: "choice", instructions: "i", criteria }] } as never),
    )
    expect(Object.keys(criteriaOf(toQuestions(params_)["c"]) ?? {})).toHaveLength(count)
  })

  test.each([["a string", "keep it"], ["a number", 5], ["null", null]])(
    "bare scalar criteria (%s) fails decode with guidance",
    async (_label, criteria) => {
      const decode = Schema.decodeUnknownEffect(Parameters)
      const exit = await Effect.runPromiseExit(
        decode({ goal: "g", questions: [{ id: "c", type: "choice", instructions: "i", criteria }] } as never),
      )
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      expect(message).toContain(CHOICE_CRITERIA_MESSAGE)
    },
  )

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

  test("the vendor cap is 8 questions: a 9th is dropped by name", () => {
    const questions = Array.from({ length: QUESTIONS_MAX + 1 }, (_, index) => ({
      id: `q${index}`,
      type: "choice" as const,
      instructions: "i",
      criteria: { keep: "helps", drop: "irrelevant" },
    }))
    expect(QUESTIONS_MAX).toBe(8)
    expect(truncationMarker({ goal: "g", questions })).toBe(
      `questions truncated from ${QUESTIONS_MAX + 1} to ${QUESTIONS_MAX}; dropped ids: q${QUESTIONS_MAX}`,
    )
    expect(Object.keys(toQuestions({ goal: "g", questions }))).toHaveLength(QUESTIONS_MAX)
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

const isSchema = (value: unknown): value is JSONSchema7 =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Navigate the rendered union the way a client does: find the arm whose
// `type` const matches, since the rendered schema is the model's contract.
const armOf = (type: string): JSONSchema7 => {
  const questions = ParametersJsonSchema.properties?.["questions"]
  if (!isSchema(questions)) throw new Error("questions schema missing")
  const items = questions.items
  if (!isSchema(items)) throw new Error("questions items missing")
  const arm = items.anyOf?.find((candidate) => {
    if (!isSchema(candidate)) return false
    const kind = candidate.properties?.["type"]
    return isSchema(kind) && kind.const === type
  })
  if (!isSchema(arm)) throw new Error(`no rendered arm for type=${type}`)
  return arm
}

describe("rendered JSON schema carries each arm's true wire shape", () => {
  test("score arm criteria is a 2-10 item ordered string array", () => {
    const criteria = armOf("score").properties?.["criteria"]
    if (!isSchema(criteria)) throw new Error("score criteria schema missing")
    expect(criteria.type).toBe("array")
    expect(criteria.minItems).toBe(2)
    expect(criteria.maxItems).toBe(10)
  })

  test("choice arm criteria is a string-valued record", () => {
    const criteria = armOf("choice").properties?.["criteria"]
    if (!isSchema(criteria)) throw new Error("choice criteria schema missing")
    expect(criteria.type).toBe("object")
    expect(criteria.additionalProperties).toEqual({ type: "string" })
  })

  test("noul arm renders no criteria property", () => {
    expect(Object.hasOwn(armOf("noul").properties ?? {}, "criteria")).toBe(false)
  })

  // `instructions` is optional-with-default at decode, so the rendered arms must
  // agree: omission accepted in BOTH the Effect schema and the JSON schema.
  test.each(["choice", "score", "noul"])("%s arm does not require instructions", (type) => {
    expect(armOf(type).required ?? []).not.toContain("instructions")
    expect(armOf(type).properties).toHaveProperty("instructions")
  })

  // Tolerance is decode-side only: the hand-authored contract must still teach
  // a model to SEND criteria on the arms that require it.
  test.each(["choice", "score"])("%s arm still REQUIRES criteria in the hand-authored schema", (type) => {
    expect(armOf(type).required ?? []).toContain("criteria")
  })

  test("noul arm does not require criteria", () => {
    expect(armOf("noul").required ?? []).not.toContain("criteria")
  })
})

// Same rejection class as the `instructions` default (commit 116e80d848): a
// mechanically derivable field must never reject a batch — the id is derived at
// the single serialization point (`toQuestions`) and explicit ids always win.
describe("a missing `id` is derived, never rejected", () => {
  const decode = Schema.decodeUnknownEffect(Parameters)

  // (a) omission on EACH arm decodes and serializes to a positional id.
  test.each([
    ["choice", { type: "choice", instructions: "i", criteria: { keep: "helps", drop: "irrelevant" } }],
    ["score", { type: "score", instructions: "i", criteria: ["low", "high"] }],
    ["noul", { type: "noul", instructions: "i" }],
  ] as const)("%s question without an id decodes and serializes as q0", async (arm, question) => {
    const params_ = await Effect.runPromise(decode({ goal: "g", questions: [question] } as never))
    const questions = toQuestions(params_)
    expect(Object.keys(questions)).toEqual(["q0"])
    expect(questions["q0"]).toMatchObject({ type: arm })
  })

  // (b) every id omitted → positional ids q0, q1.
  test("toQuestions fills q0/q1 for a fully id-less batch", async () => {
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [
          { type: "noul", instructions: "i" },
          { type: "noul", instructions: "i" },
        ],
      } as never),
    )
    expect(Object.keys(toQuestions(params_))).toEqual(["q0", "q1"])
  })

  // (b) mixed batch: explicit ids win, omissions get filled.
  test("a mixed batch keeps explicit ids and only fills omissions", async () => {
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [
          { id: "kept", type: "noul", instructions: "i" },
          { type: "noul", instructions: "i" },
          { id: "also-kept", type: "noul", instructions: "i" },
        ],
      } as never),
    )
    expect(Object.keys(toQuestions(params_))).toEqual(["kept", "q1", "also-kept"])
  })

  // (c) both defaults together: no id AND no instructions still decodes.
  test("a question missing BOTH id and instructions still decodes", async () => {
    const params_ = await Effect.runPromise(decode({ goal: "g", questions: [{ type: "noul" }] } as never))
    expect(toQuestions(params_)["q0"]).toMatchObject({ type: "noul", instructions: INSTRUCTIONS_DEFAULTS.noul })
  })

  // Tolerance is decode-side only: the hand-authored schema still lets a model SEND id.
  test.each(["choice", "score", "noul"])("%s arm does not require id but still lists it", (type) => {
    expect(armOf(type).required ?? []).not.toContain("id")
    expect(armOf(type).properties).toHaveProperty("id")
  })

  // (a) GAP 1: an explicit id that collides with an earlier derived default must
  // NOT silently drop a question — the derived id bumps until free, the explicit
  // id is untouched, and both survive on the wire under distinct keys.
  test("an explicit id colliding with a derived default keeps BOTH questions", async () => {
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [
          { type: "noul", instructions: "i" }, // index 0 → base "q0" (collides)
          { id: "q0", type: "noul", instructions: "i" }, // explicit "q0" always wins
        ],
      } as never),
    )
    const questions = toQuestions(params_)
    expect(Object.keys(questions)).toEqual(["q0-2", "q0"])
    expect(questions["q0"]).toMatchObject({ type: "noul" })
    expect(questions["q0-2"]).toMatchObject({ type: "noul" })
  })

  // Unseen input: an explicit id equal to the FIRST bump candidate, forcing a
  // second bump (q0 → q0-2 taken → q0-3).
  test("the derived id keeps bumping past an explicit id equal to the first suffix", async () => {
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [
          { type: "noul", instructions: "i" },
          { id: "q0", type: "noul", instructions: "i" },
          { id: "q0-2", type: "noul", instructions: "i" },
        ],
      } as never),
    )
    expect(Object.keys(toQuestions(params_))).toEqual(["q0-3", "q0", "q0-2"])
  })

  // (b) GAP 2: read-back uses the SAME derived key the wire used, not the raw "".
  test("read-back formats an id-less question under its derived wire key", async () => {
    const params_ = await Effect.runPromise(
      decode({ goal: "g", questions: [{ type: "noul", instructions: "i" }] } as never),
    )
    const { output } = formatAsk(params_, { q0: { noul: 0.3 } })
    expect(output).toContain("q0: noul=0.3")
    expect(output).not.toContain(": unmeasured")
  })
})

// One non-object entry must never fail the WHOLE batch: it is dropped with an
// explicit in-band marker, so the good decisions survive and the drop is stated.
describe("a non-object questions entry is dropped with a stated marker", () => {
  const decode = Schema.decodeUnknownEffect(Parameters)

  test("a trailing string drops while the five valid questions survive, marker naming index 5", async () => {
    const params_ = await Effect.runPromise(
      decode({
        goal: "g",
        questions: [
          { id: "q0", type: "choice", instructions: "i", criteria: { keep: "helps", drop: "irrelevant" } },
          { id: "q1", type: "score", instructions: "i", criteria: ["low", "high"] },
          { id: "q2", type: "noul", instructions: "i" },
          { id: "q3", type: "choice", instructions: "i", criteria: { accept: "yes", refire: "no" } },
          { id: "q4", type: "noul", instructions: "i" },
          "instructions_note_none",
        ],
      } as never),
    )
    expect(Object.keys(toQuestions(params_))).toEqual(["q0", "q1", "q2", "q3", "q4"])
    const { output } = formatAsk(params_, {})
    expect(output).toContain('1 malformed entry dropped (not questions): index 5: "instructions_note_none"')
    expect(output).toContain("q0: unmeasured")
  })

  test.each([
    ["42", 42],
    ["true", true],
    ["null", null],
  ])("a %s entry drops with its own snippet", async (snippet, entry) => {
    const params_ = await Effect.runPromise(
      decode({ goal: "g", questions: [{ id: "q0", type: "noul", instructions: "i" }, entry] } as never),
    )
    expect(Object.keys(toQuestions(params_))).toEqual(["q0"])
    const { output } = formatAsk(params_, {})
    expect(output).toContain(`index 1: ${snippet}`)
  })

  test("a nested array entry also drops, never decoded as a question", async () => {
    const params_ = await Effect.runPromise(
      decode({ goal: "g", questions: [{ id: "q0", type: "noul", instructions: "i" }, ["not", "a", "question"]] } as never),
    )
    expect(Object.keys(toQuestions(params_))).toEqual(["q0"])
    expect(formatAsk(params_, {}).output).toContain('index 1: ["not","a","question"]')
  })

  test("an all-non-object batch FAILS with the stated fix", async () => {
    const exit = await Effect.runPromiseExit(decode({ goal: "g", questions: ["a", 42] } as never))
    const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    expect(message).toContain(ALL_MALFORMED_MESSAGE)
  })

  test("no malformed entries → no marker, output identical to a clean batch", async () => {
    const params_ = await Effect.runPromise(decode(params as never))
    expect(params_.malformedDrops ?? []).toEqual([])
    const output = formatAsk(params_, {}).output
    expect(output).not.toContain("malformed")
    expect(output).toBe(formatAsk(params, {}).output)
  })
})

// Tolerance is decode-side only: the hand-authored model contract is unchanged.
describe("the model-facing schema is untouched by the drop field", () => {
  test("ParametersJsonSchema carries no malformedDrops property anywhere", () => {
    expect(ParametersJsonSchema.properties).not.toHaveProperty("malformedDrops")
    expect(JSON.stringify(ParametersJsonSchema)).not.toContain("malformedDrops")
    expect(ParametersJsonSchema.required ?? []).toEqual(["goal", "questions"])
  })
})
