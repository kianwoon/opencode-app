import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { ClassifierClient } from "@/classifier/client"
import { ClassifierRelevance } from "@/classifier/relevance"
import { ClassifierService } from "@/classifier/service"
import { ReasonCode, RelevanceDecision } from "@/classifier/schema"
import { testEffect } from "../lib/effect"

const sections = [
  { id: "system", text: "You are an implementation specialist." },
  { id: "history", text: "user: fix the failing test" },
  { id: "docs", text: "Apache Kafka retention defaults" },
]

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

describe("buildSectionQuestions", () => {
  test("produces exactly one noul question per section, keyed by id", () => {
    const questions = ClassifierRelevance.buildSectionQuestions("fix the test", sections)
    expect(Object.keys(questions)).toEqual(["system", "history", "docs"])
    expect(Object.values(questions).every((question) => question.type === "noul")).toBe(true)
  })

  test("does NOT interpolate the full task; carries a bounded excerpt", () => {
    const huge = "x".repeat(5000)
    const questions = ClassifierRelevance.buildSectionQuestions("fix the test", [{ id: "big", text: huge }])
    // De-dup: the task rides in `state` once, not in every instruction.
    expect(questions.big.instructions).not.toContain("fix the test")
    expect(questions.big.instructions).toContain("…")
    expect(questions.big.instructions.length).toBeLessThan(500)
  })

  test("de-dup keeps count, keying, type and criteria unchanged", () => {
    const questions = ClassifierRelevance.buildSectionQuestions("task", sections)
    expect(Object.keys(questions)).toEqual(["system", "history", "docs"])
    expect(Object.values(questions).every((q) => q.type === "noul")).toBe(true)
    expect(questions.system.criteria).toEqual({ true: "relevant", false: "irrelevant" })
  })

  test("an empty section list yields no questions and never throws", () => {
    expect(ClassifierRelevance.buildSectionQuestions("t", [])).toEqual({})
  })
})

describe("capSections", () => {
  test("under the cap: everything is requested, nothing skipped", () => {
    const capped = ClassifierRelevance.capSections(sections)
    expect(capped).toMatchObject({ considered: 3, requested: 3, skipped: 0 })
    expect(capped.sections).toEqual(sections)
  })

  test("over the cap: only the tail is requested and the skip is reported", () => {
    const many = Array.from({ length: ClassifierRelevance.MAX_SECTIONS_PER_REQUEST + 5 }, (_, i) => ({
      id: `s${i}`,
      text: `t${i}`,
    }))
    const capped = ClassifierRelevance.capSections(many)
    expect(capped.considered).toBe(many.length)
    expect(capped.requested).toBe(ClassifierRelevance.MAX_SECTIONS_PER_REQUEST)
    expect(capped.skipped).toBe(5)
    // Most RECENT N — the tail, not the head.
    expect(capped.sections[0]?.id).toBe("s5")
    expect(capped.sections.at(-1)?.id).toBe(`s${many.length - 1}`)
  })
})

describe("failOpen", () => {
  /**
   * The un-swallow contract, tested at the handler itself. `failOpen` is the
   * exact handler wired into every prompt.ts/processor.ts seam via
   * `Effect.catchCause`; a full-loop test would need a whole session turn, so we
   * assert the two properties that matter directly: (1) a WARNING is logged with
   * the seam name and session id, and (2) the effect SUCCEEDS (error channel
   * `never`) — i.e. fail-open, the turn still proceeds.
   */
  const it = testEffect(
    Logger.layer([
      Logger.make<unknown, void>((options) => {
        const [name, payload] = options.message as ReadonlyArray<unknown>
        if (name === "classifier seam failed (fail-open)" && typeof payload === "object" && payload !== null) {
          events.push(payload as Record<string, unknown>)
        }
      }),
    ]),
  )
  const events: Array<Record<string, unknown>> = []

  it.effect("logs a WARNING and still succeeds when the seam fails", () =>
    Effect.gen(function* () {
      events.length = 0
      const failing = yield* Effect.fail(new Error("HTTP 400 over budget")).pipe(
        Effect.catchCause(ClassifierClient.failOpen("relevance", "ses_123")),
        Effect.exit,
      )
      expect(failing._tag).toBe("Success")
      expect(events[0]).toMatchObject({ seam: "relevance", "session.id": "ses_123" })
      expect(String(events[0]?.cause)).toContain("400")
    }),
  )

  it.effect("also swallows a defect (throw), never dying into the loop", () =>
    Effect.gen(function* () {
      events.length = 0
      const died = yield* Effect.die(new Error("boom")).pipe(
        Effect.catchCause(ClassifierClient.failOpen("scoring", "ses_9")),
        Effect.exit,
      )
      expect(died._tag).toBe("Success")
      expect(events[0]).toMatchObject({ seam: "scoring", "session.id": "ses_9" })
    }),
  )
})

describe("evaluateRelevance", () => {
  const answers = (noul: number | undefined) => ({
    system: { type: "noul" as const, noul: noul ?? 0 },
    history: { type: "noul" as const, noul: 0.9 },
  })

  test("above the threshold keeps, below prunes, unanswered keeps", () => {
    const verdicts = ClassifierRelevance.evaluateRelevance({
      answers: { ...answers(0.9), docs: { type: "noul", noul: 0.2 } },
      sections,
      threshold: 0.5,
    })
    expect(verdicts.map((verdict) => verdict.keep)).toEqual([true, true, false])
  })

  test("threshold comparison is inclusive at the boundary", () => {
    const verdicts = ClassifierRelevance.evaluateRelevance({
      answers: { system: { type: "noul", noul: 0.5 } },
      sections: [sections[0]!],
      threshold: 0.5,
    })
    expect(verdicts[0]!.keep).toBe(true)
  })

  test("MISSING answers fail open — the section is kept", () => {
    const verdicts = ClassifierRelevance.evaluateRelevance({
      answers: { system: { type: "noul", noul: 0.1 } },
      sections,
      threshold: 0.5,
    })
    expect(verdicts.map((verdict) => verdict.keep)).toEqual([false, true, true])
    expect(ClassifierRelevance.prunableSections(verdicts).map((verdict) => verdict.id)).toEqual(["system"])
  })

  test("non-noul and non-finite answers fail open", () => {
    const verdicts = ClassifierRelevance.evaluateRelevance({
      answers: {
        system: { type: "choice", choice: "irrelevant", probabilities: { irrelevant: 0.99 }, confidence: 0.9 },
        history: { type: "noul", noul: Number.NaN },
      },
      sections,
      threshold: 0.5,
    })
    expect(verdicts.every((verdict) => verdict.keep)).toBe(true)
  })

  test("empty input does not crash", () => {
    expect(ClassifierRelevance.evaluateRelevance({ answers: {}, sections: [], threshold: 0.5 })).toEqual([])
    expect(ClassifierRelevance.toRelevanceResult([]).decision).toBe("UNSURE")
  })
})

describe("ruleBasedRelevance", () => {
  const verdicts = (noul: number[]) =>
    noul.map((value, index) => ({ id: `s${index}`, noul: value, keep: value >= 0.5 }))

  test("keeps everything, with no network", () => {
    const result = ClassifierRelevance.ruleBasedRelevance(verdicts([0.1, 0.9]))
    expect(result.decision).toBe("KEEP")
    expect(result.reasonCode).toBe("CONTEXT_RELEVANT")
    // half the (already-decided) verdicts were kept
    expect(result.confidence).toBe(0.5)
  })

  test("never throws on empty, absent or hostile input", () => {
    expect(ClassifierRelevance.ruleBasedRelevance([]).decision).toBe("KEEP")
    expect(ClassifierRelevance.keepAllVerdicts(sections).every((verdict) => verdict.keep)).toBe(true)
  })
})

describe("RelevanceDecision reasoning", () => {
  const code = (noul: number[]) =>
    ClassifierRelevance.toRelevanceResult(noul.map((value, index) => ({ id: `s${index}`, noul: value, keep: value >= 0.5 })))

  test("every new ReasonCode and RelevanceDecision member is actually emitted", () => {
    const emitted = {
      // PRUNE: a real answer below threshold
      prune: code([0.1]),
      // KEEP: a real answer above threshold
      keep: code([0.9]),
      // UNSURE: no answer at all (fail-open), and no sections at all
      unsure: code([1]),
      empty: code([]),
    }
    expect(emitted.prune.reasonCode).toBe("CONTEXT_IRRELEVANT")
    expect(emitted.keep.reasonCode).toBe("CONTEXT_RELEVANT")
    expect(emitted.unsure.reasonCode).toBe("CONTEXT_UNKNOWN")
    expect(emitted.empty.reasonCode).toBe("CONTEXT_UNKNOWN")
    // fail-open: an unanswered section can never produce a prune confidence
    expect(emitted.unsure.decision).toBe("UNSURE")
    expect(emitted.prune.decision).toBe("PRUNE")
    expect(emitted.keep.decision).toBe("KEEP")
    // each emitted code/decision is a declared member of the shared vocabularies
    for (const result of [emitted.prune, emitted.keep, emitted.unsure, emitted.empty]) {
      expect(Schema.decodeUnknownSync(ReasonCode)(result.reasonCode)).toBe(result.reasonCode)
      expect(Schema.decodeUnknownSync(RelevanceDecision)(result.decision)).toBe(result.decision)
    }
    expect(Schema.decodeUnknownSync(RelevanceDecision)("UNSURE")).toBe("UNSURE")
  })

  test("shouldActOnRelevance refuses a fallback verdict", () => {
    expect(ClassifierRelevance.shouldActOnRelevance({ decision: "PRUNE", confidence: 0.9, threshold: 0.5 })).toBe(true)
    expect(
      ClassifierRelevance.shouldActOnRelevance({ decision: "PRUNE", confidence: 0.9, threshold: 0.5, fallbackUsed: true }),
    ).toBe(false)
    expect(ClassifierRelevance.shouldActOnRelevance({ decision: "UNSURE", confidence: 1, threshold: 0.5 })).toBe(false)
  })
})

describe("classifyRelevance batching", () => {
  // The key acceptance: N sections must ride ONE request, not N requests.
  const answers = {
    system: { type: "noul" as const, noul: 0.9 },
    history: { type: "noul" as const, noul: 0.9 },
    docs: { type: "noul" as const, noul: 0.1 },
  }
  const captured = captureHttp(answers)
  const it = testEffect(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))

  // The key is read per-ask; the env fallback keeps this offline and deterministic.
  delete process.env.TYPESAFE_API_KEY

  it.effect("sends EVERY section question in exactly ONE call", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierRelevance.classifyRelevance({
          client,
          model: "jev-test",
          task: "fix the failing test",
          sections,
          threshold: 0.5,
        })
        expect(captured.bodies).toHaveLength(1)
        const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown>; state: string }
        expect(Object.keys(request.questions)).toEqual(["system", "history", "docs"])
        expect(request.state).toBe("fix the failing test")
        expect(result.decision).toBe("PRUNE")
        expect(result.reasonCode).toBe("CONTEXT_IRRELEVANT")
        expect(result.verdicts.map((verdict) => verdict.id)).toEqual(["system", "history", "docs"])
      }),
    ),
  )

  it.effect("keeps every section when the batch answers are empty", () =>
    withEnvKey(
      Effect.gen(function* () {
        const client = yield* ClassifierClient.Service
        const result = yield* ClassifierRelevance.classifyRelevance({
          client,
          model: "jev-test",
          task: "fix the failing test",
          sections: [{ id: "unanswered", text: "?" }],
          threshold: 0.5,
        })
        expect(result.decision).toBe("UNSURE")
        expect(ClassifierRelevance.prunableSections(result.verdicts)).toEqual([])
      }),
    ),
  )
})

describe("service dispatch for the relevance seam", () => {
  const it = testEffect(ClassifierService.ruleBasedLayer)

  it.effect("rule-based layer keeps every section without a network", () =>
    Effect.gen(function* () {
      const classifier = yield* ClassifierService.Service
      const decision = yield* classifier.classifyRelevance({ task: "t", sections, threshold: 0.5 })
      expect(decision.decision).toBe("KEEP")
      expect(decision.classifier).toBe("rule-based")
      expect(decision.fallbackUsed).toBe(false)
      expect(typeof decision.latencyMs).toBe("number")
    }),
  )
})

describe("relevance prune guard", () => {
  // The removed `alternates` requirement was unsatisfiable for any single-message
  // removal from a user→assistant sequence, so `pruned` was permanently false.
  // These tests pin the corrected guard: a single doomed message in an
  // alternating sequence now yields pruned = true.
  const shouldPrune = (roles: string[], doomed: ReadonlySet<number>) => {
    const kept = roles.filter((_, index) => !doomed.has(index))
    return doomed.size > 0 && kept.length > 0 && kept.includes("user")
  }

  test("single doomed assistant message in an alternating sequence ⇒ pruned", () => {
    expect(shouldPrune(["user", "assistant", "user", "assistant"], new Set([1]))).toBe(true)
  })

  test("single doomed user message in an alternating sequence ⇒ pruned", () => {
    expect(shouldPrune(["user", "assistant", "user", "assistant"], new Set([2]))).toBe(true)
  })

  test("no doomed messages ⇒ not pruned", () => {
    expect(shouldPrune(["user", "assistant", "user", "assistant"], new Set())).toBe(false)
  })

  test("pruning that would remove every user turn ⇒ not pruned", () => {
    expect(shouldPrune(["user", "assistant"], new Set([0]))).toBe(false)
  })
})

describe("gating extras (#7 context gating)", () => {
  const extras = ["include_in_context", "still_relevant", "duplicate", "superseded", "needs_full_read"] as const

  test("no-extras path is byte-identical to the legacy single-question batch", () => {
    const questions = ClassifierRelevance.buildSectionQuestions("t", sections)
    // exactly the section ids, one question each — no `:extra` keys leak in
    expect(Object.keys(questions)).toEqual(["system", "history", "docs"])
    expect(Object.values(questions).every((question) => question.type === "noul")).toBe(true)
  })

  test("extras path adds one keyed question per (section, extra) with no collision", () => {
    const questions = ClassifierRelevance.buildSectionQuestions("t", sections, extras)
    const keys = Object.keys(questions)
    expect(keys).toHaveLength(sections.length * (1 + extras.length))
    expect(keys).toContain(ClassifierRelevance.extraQuestionKey("system", "duplicate"))
    for (const section of sections) for (const extra of extras) {
      expect(keys).toContain(ClassifierRelevance.extraQuestionKey(section.id, extra))
    }
    expect(Object.values(questions).every((question) => question.type === "noul")).toBe(true)
  })

  test("extras batching sends ALL questions (base + extras) in ONE call", async () => {
    const answers = {
      system: { type: "noul" as const, noul: 0.9 },
      [ClassifierRelevance.extraQuestionKey("system", "duplicate")]: { type: "noul" as const, noul: 0.9 },
    }
    const captured = captureHttp(answers)
    const result = await Effect.runPromise(
      withEnvKey(
        Effect.gen(function* () {
          const client = yield* ClassifierClient.Service
          return yield* ClassifierRelevance.classifyRelevance({
            client,
            model: "jev-test",
            task: "fix the test",
            sections: [{ id: "system", text: "You are an implementation specialist." }],
            threshold: 0.5,
            extras,
          })
        }),
      ).pipe(Effect.provide(ClassifierClient.layer.pipe(Layer.provide(captured.layer)))),
    )

    expect(captured.bodies).toHaveLength(1)
    const request = JSON.parse(captured.bodies[0]!) as { questions: Record<string, unknown> }
    expect(Object.keys(request.questions)).toHaveLength(1 + extras.length)
    expect(result.gating[0]!.duplicate).toBe(true)
  })

  test("evaluateGating is fail-open on absent/malformed answers", () => {
    const verdicts = ClassifierRelevance.evaluateGating({
      answers: { system: { type: "choice", choice: "x", probabilities: {}, confidence: 0.9 } },
      sections,
    })
    for (const verdict of verdicts) {
      expect(verdict).toEqual({
        id: verdict.id,
        include: true,
        stillRelevant: true,
        duplicate: false,
        superseded: false,
        needsFullRead: true,
      })
    }
  })

  test("a finite answer flips exactly its flag (non-finite fails open)", () => {
    const verdicts = ClassifierRelevance.evaluateGating({
      answers: {
        [ClassifierRelevance.extraQuestionKey("system", "include_in_context")]: { type: "noul", noul: 0.1 },
        [ClassifierRelevance.extraQuestionKey("system", "needs_full_read")]: { type: "noul", noul: Number.NaN },
      },
      sections: [{ id: "system", text: "s" }],
    })
    expect(verdicts[0]!.include).toBe(false)
    expect(verdicts[0]!.needsFullRead).toBe(true)
  })
})
