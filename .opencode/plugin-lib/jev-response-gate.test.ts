import { describe, expect, test } from "bun:test"
import {
  ANSWER_EXCERPT_CHARS,
  CHOICE_STATE,
  DEFAULT_RESPONSE_GATE,
  MIN_GATE_CHARS,
  MODE_GATE,
  MODE_OPTIONS,
  OBSERVED_ERROR_EXCERPT_CHARS,
  OBSERVED_OUTPUT_EXCERPT_CHARS,
  PREMISE_ADVISE_MAX,
  PREMISE_SOFT_MAX,
  QUESTION_EXCERPT_CHARS,
  advisableProbability,
  buildBatchQuestions,
  excerpt,
  extractObservedOutputs,
  extractTurnObservedOutputs,
  modeAdvisory,
  newRequestTail,
  parseBatchAnswers,
  pickExchange,
  premiseTier,
  resolveResponseGateConfig,
} from "./jev-response-gate.ts"

const Q = "Why did the compaction fire twice? Check the config and the overflow thresholds."
const A = "The answer cites the overflow threshold and the config flag. ".repeat(8)
const REQUEST = "Rewrite the response gate so it ranks work modes before the model commits."

const user = (text: string) => ({ info: { role: "user" }, parts: [{ type: "text", text }] })
const assistant = (text: string) => ({ info: { role: "assistant" }, parts: [{ type: "text", text }] })

/** Real ToolPart shape (schema session.ts): only `completed` carries a string output. */
const toolPart = (tool: string, status: string, output: string) => ({
  id: `prt_${tool}`,
  sessionID: "ses_test",
  messageID: "msg_test",
  type: "tool",
  callID: `call_${tool}`,
  tool,
  state: { status, input: {}, output, title: tool, metadata: {}, time: { start: 1, end: 2 } },
})
const completedTool = (tool: string, output: string) => toolPart(tool, "completed", output)
/** Real ToolPart shape (schema session.ts): a ToolStateError carries `error`, never `output`. */
const errorTool = (tool: string, error: string) => ({
  ...toolPart(tool, "error", ""),
  state: { status: "error", error, input: {}, title: tool, metadata: {}, time: { start: 1, end: 2 } },
})

describe("pickExchange", () => {
  test("a clean exchange yields the question and the answer", () => {
    expect(pickExchange([user(Q), assistant(A), user("thanks, now the plugin")])).toEqual({ question: Q, answer: A, observed: "" })
  })

  test("the tail must be a user message", () => {
    expect(pickExchange([user(Q), assistant(A)])).toBeNull()
    expect(pickExchange([user(Q), assistant(A), assistant(A)])).toBeNull()
  })

  test("an answer under the 240-char minimum is not gradeable", () => {
    expect(MIN_GATE_CHARS).toBe(240)
    expect(A.length).toBeGreaterThanOrEqual(MIN_GATE_CHARS)
    expect(pickExchange([user(Q), assistant("too short"), user("next")])).toBeNull()
    expect(pickExchange([user(Q), assistant("x".repeat(239)), user("next")])).toBeNull()
    expect(pickExchange([user(Q), assistant("x".repeat(240)), user("next")])).toEqual({ question: Q, answer: "x".repeat(240), observed: "" })
  })

  test("a missing preceding question yields null", () => {
    expect(pickExchange([assistant(A), assistant(A), user("next")])).toBeNull()
    expect(pickExchange([])).toBeNull()
    expect(pickExchange(undefined)).toBeNull()
  })

  test("multi-part text is joined and non-text parts ignored", () => {
    const first = "First half of the answer. "
    const second = "Second half. ".repeat(30)
    const messages = [
      user(Q),
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", state: { output: "TOOL NOISE" } },
          { type: "text", text: first },
          { type: "reasoning", text: "SHOULD NOT APPEAR" },
          { type: "text", text: second },
        ],
      },
      user("next"),
    ]
    const exchange = pickExchange(messages)
    expect(exchange?.answer).toBe(`${first}\n${second}`)
    expect(exchange?.answer).not.toContain("TOOL NOISE")
    expect(exchange?.answer).not.toContain("SHOULD NOT APPEAR")
    expect(exchange?.question).toBe(Q)
    expect(exchange?.observed).toBe("")
  })

  test("the nearest PRECEDING user message is the question", () => {
    const exchange = pickExchange([user("stale first question"), assistant("stale answer ".repeat(30)), user("second question"), assistant(A), user("next")])
    expect(exchange?.question).toBe("second question")
  })

  test("v7 threads the observed tool output of the SAME answer message through", () => {
    const exchange = pickExchange([
      user(Q),
      { info: { role: "assistant" }, parts: [{ type: "text", text: A }, completedTool("read", "file contents here")] },
      user("next"),
    ])
    expect(exchange?.observed).toBe("[tool read]\nfile contents here")
    expect(exchange?.answer).toBe(A)
  })
})

describe("extractObservedOutputs", () => {
  test("a completed tool part is included under its [tool name] header", () => {
    const message = { parts: [completedTool("read", "file contents here")] }
    expect(extractObservedOutputs(message)).toBe("[tool read]\nfile contents here")
  })

  test("only COMPLETED states carry output — running, pending, and an error part with no error text are skipped", () => {
    for (const status of ["running", "pending", "error"]) {
      expect(extractObservedOutputs({ parts: [toolPart("read", status, "SHOULD NOT APPEAR")] })).toBe("")
    }
  })

  test("a message with no tool parts yields an empty string", () => {
    expect(extractObservedOutputs({ parts: [{ type: "text", text: A }] })).toBe("")
    expect(extractObservedOutputs({})).toBe("")
    expect(extractObservedOutputs(undefined)).toBe("")
  })

  test("multiple completed parts are joined in order, each labelled by tool", () => {
    const message = { parts: [completedTool("read", "alpha"), completedTool("bash", "beta"), completedTool("grep", "gamma")] }
    expect(extractObservedOutputs(message)).toBe("[tool read]\nalpha\n\n[tool bash]\nbeta\n\n[tool grep]\ngamma")
  })

  test("a completed part with an empty output contributes nothing", () => {
    expect(extractObservedOutputs({ parts: [completedTool("read", ""), completedTool("bash", "beta")] })).toBe("[tool bash]\nbeta")
  })

  test("a 5000-char tool output is head-capped to exactly 2500 chars", () => {
    expect(OBSERVED_OUTPUT_EXCERPT_CHARS).toBe(2500)
    const long = "x".repeat(5000)
    const cut = extractObservedOutputs({ parts: [completedTool("read", long)] })
    expect(cut).toBe(`[tool read]\n${"x".repeat(2500 - "[tool read]\n".length)}`)
    expect(cut.length).toBe(2500)
  })

  test("v7.3 an ERROR tool part is harvested as a [FAIL <tool>: <error>] entry", () => {
    expect(extractObservedOutputs({ parts: [errorTool("bash", "permission denied")] })).toBe("[FAIL bash: permission denied]")
  })

  test("the FAIL error text collapses newlines and multi-space, and truncates at 140 chars", () => {
    expect(OBSERVED_ERROR_EXCERPT_CHARS).toBe(140)
    expect(extractObservedOutputs({ parts: [errorTool("task", "line one\n\n  line   two\t")] })).toBe("[FAIL task: line one line two]")
    const long = extractObservedOutputs({ parts: [errorTool("task", "z".repeat(500))] })
    expect(long).toBe(`[FAIL task: ${"z".repeat(140)}]`)
    expect(long.length).toBe("[FAIL task: ".length + 140 + "]".length)
  })

  test("completed and error parts interleave in part order", () => {
    const message = { parts: [errorTool("task", "permission denied"), completedTool("read", "alpha"), errorTool("bash", "not found"), completedTool("grep", "gamma")] }
    expect(extractObservedOutputs(message)).toBe("[FAIL task: permission denied]\n\n[tool read]\nalpha\n\n[FAIL bash: not found]\n\n[tool grep]\ngamma")
  })

  test("the 2500 cap still holds with FAIL entries present", () => {
    const cut = extractObservedOutputs({ parts: [errorTool("task", "permission denied"), completedTool("read", "x".repeat(5000))] })
    expect(cut.length).toBe(2500)
    expect(cut.startsWith("[FAIL task: permission denied]\n\n[tool read]\nxxx")).toBe(true)
  })
})

describe("extractTurnObservedOutputs", () => {
  /** The real persisted shape of a dispatched hand's tool part (msg_0e72baa800033). */
  const taskDispatch = {
    id: "prt_task",
    sessionID: "ses_test",
    messageID: "msg_0e72baa800033",
    type: "tool",
    callID: "call_task",
    tool: "task",
    state: { status: "completed", output: "hand report text", input: {}, title: "t", metadata: {}, time: { start: 1, end: 2 } },
  }

  test("v7.2 the completed tool output on a SIBLING assistant message is collected", () => {
    const messages = [user(Q), { info: { role: "assistant" }, parts: [taskDispatch] }, assistant(A), user("next")]
    expect(extractTurnObservedOutputs(messages, messages.length - 2)).toBe("[tool task]\nhand report text")
    expect(pickExchange(messages)?.observed).toBe("[tool task]\nhand report text")
  })

  test("a single assistant message is unchanged", () => {
    const messages = [user(Q), { info: { role: "assistant" }, parts: [{ type: "text", text: A }, completedTool("read", "file contents here")] }, user("next")]
    expect(extractTurnObservedOutputs(messages, messages.length - 2)).toBe("[tool read]\nfile contents here")
  })

  test("a non-ToolStateError error part (no error text) on a sibling contributes nothing", () => {
    const messages = [user(Q), { info: { role: "assistant" }, parts: [toolPart("task", "error", "SHOULD NOT APPEAR")] }, assistant(A), user("next")]
    expect(extractTurnObservedOutputs(messages, messages.length - 2)).toBe("")
    expect(pickExchange(messages)?.observed).toBe("")
  })

  test("v7.3 a real ToolStateError on a sibling is harvested as a [FAIL] entry", () => {
    const messages = [user(Q), { info: { role: "assistant" }, parts: [errorTool("bash", "permission denied")] }, assistant(A), user("next")]
    expect(extractTurnObservedOutputs(messages, messages.length - 2)).toBe("[FAIL bash: permission denied]")
    expect(pickExchange(messages)?.observed).toBe("[FAIL bash: permission denied]")
  })

  test("v7.3 a turn-level error part truncates and collapses the same way a message-level one does", () => {
    const noisy = `  first line\n\nsecond   line\t${"z".repeat(400)}`
    const messages = [user(Q), { info: { role: "assistant" }, parts: [errorTool("task", noisy)] }, assistant(A), user("next")]
    const observed = extractTurnObservedOutputs(messages, messages.length - 2)
    expect(observed.startsWith("[FAIL task: first line second line ")).toBe(true)
    expect(observed).not.toContain("\n")
    expect(observed.length).toBe("[FAIL task: ".length + 140 + "]".length)
  })

  test("the scan STOPS at the user boundary — an earlier turn's tool part is not collected", () => {
    const messages = [
      user("old question"),
      { info: { role: "assistant" }, parts: [completedTool("read", "STALE TURN OUTPUT")] },
      user(Q),
      assistant(A),
      user("next"),
    ]
    expect(extractTurnObservedOutputs(messages, messages.length - 2)).toBe("")
  })

  test("the aggregate across the cluster is head-capped to exactly 2500 chars", () => {
    const long = "x".repeat(5000)
    const messages = [user(Q), { info: { role: "assistant" }, parts: [completedTool("read", long)] }, { info: { role: "assistant" }, parts: [completedTool("bash", long)] }, user("next")]
    const aggregate = extractTurnObservedOutputs(messages, messages.length - 2)
    expect(aggregate.length).toBe(2500)
    expect(aggregate.startsWith("[tool read]\nxxx")).toBe(true)
  })

  test("a non-array tail yields an empty string", () => {
    expect(extractTurnObservedOutputs(undefined, 1)).toBe("")
    expect(extractTurnObservedOutputs([], 1)).toBe("")
  })
})

describe("excerpt", () => {
  test("the question is capped at 400 chars and the answer at 4000", () => {
    expect(QUESTION_EXCERPT_CHARS).toBe(400)
    expect(ANSWER_EXCERPT_CHARS).toBe(4000)
    const long = "x".repeat(5000)
    expect(excerpt(long, QUESTION_EXCERPT_CHARS).length).toBe(400)
    expect(excerpt(long, ANSWER_EXCERPT_CHARS).length).toBe(4000)
  })

  test("a 5000-char answer keeps its head and cuts to exactly 4000 chars", () => {
    const long = "x".repeat(5000)
    const cut = excerpt(long, ANSWER_EXCERPT_CHARS)
    expect(cut.length).toBe(4000)
    expect(cut.startsWith(long.slice(0, 100))).toBe(true)
  })

  test("text at or under the cap is untouched", () => {
    expect(excerpt(Q, QUESTION_EXCERPT_CHARS)).toBe(Q)
    expect(excerpt("x".repeat(400), QUESTION_EXCERPT_CHARS)).toBe("x".repeat(400))
  })
})

describe("resolveResponseGateConfig", () => {
  test("the v7.1 config is {enabled} only — adviseBelow is gone", () => {
    expect(resolveResponseGateConfig({ enabled: true })).toEqual({ enabled: true })
    expect(resolveResponseGateConfig({ enabled: false })).toEqual({ enabled: false })
  })

  test("a config still carrying the dead adviseBelow key ignores it", () => {
    expect(resolveResponseGateConfig({ enabled: true, adviseBelow: 0.35 })).toEqual({ enabled: true })
    expect(resolveResponseGateConfig({ enabled: false, adviseBelow: 0.9 })).toEqual({ enabled: false })
  })

  test("missing / non-object fails to defaults", () => {
    expect(DEFAULT_RESPONSE_GATE).toEqual({ enabled: true })
    expect(resolveResponseGateConfig(undefined)).toEqual(DEFAULT_RESPONSE_GATE)
    expect(resolveResponseGateConfig(null)).toEqual(DEFAULT_RESPONSE_GATE)
    expect(resolveResponseGateConfig("nope")).toEqual(DEFAULT_RESPONSE_GATE)
  })

  test("an absent or invalid enabled key falls back to enabled", () => {
    expect(resolveResponseGateConfig({}).enabled).toBe(true)
    expect(resolveResponseGateConfig({ enabled: "yes" })).toEqual(DEFAULT_RESPONSE_GATE)
  })

  test("boolean enabled passes through both ways", () => {
    expect(resolveResponseGateConfig({ enabled: true }).enabled).toBe(true)
    expect(resolveResponseGateConfig({ enabled: false }).enabled).toBe(false)
  })

  test("the v1 annotateBelow key is dead — its value is never reinterpreted", () => {
    expect(resolveResponseGateConfig({ annotateBelow: 0.1 })).toEqual(DEFAULT_RESPONSE_GATE)
    expect(resolveResponseGateConfig({ enabled: false, annotateBelow: 0.1 })).toEqual({ enabled: false })
  })
})

describe("newRequestTail", () => {
  test("a clean new request yields its text", () => {
    expect(newRequestTail([user(REQUEST)])).toBe(REQUEST)
    expect(newRequestTail([user(Q), assistant("short ack"), user(REQUEST)])).toBe(REQUEST)
  })

  test("a user tail after a LONG assistant answer still yields its text (v4.1)", () => {
    expect(newRequestTail([user(Q), assistant(A), user("thanks, now the plugin")])).toBe("thanks, now the plugin")
  })

  test("a non-user tail or an empty tail yields null", () => {
    expect(newRequestTail([user(Q), assistant(A)])).toBeNull()
    expect(newRequestTail([assistant(A)])).toBeNull()
    expect(newRequestTail([])).toBeNull()
    expect(newRequestTail(undefined)).toBeNull()
    expect(newRequestTail([user("")])).toBeNull()
  })
})

describe("MODE_OPTIONS", () => {
  test("exactly the three v6 modes, by label", () => {
    expect(Object.keys(MODE_OPTIONS)).toEqual(["direct", "enumerate-first", "investigate-first"])
  })

  test("every description is a real instruction (>=20 chars, trimmed)", () => {
    for (const [label, description] of Object.entries(MODE_OPTIONS)) {
      expect(description.trim().length).toBeGreaterThanOrEqual(20)
      expect(description.trim()).toBe(description)
      expect(label.length).toBeGreaterThan(0)
    }
  })

  test("descriptions are distinct — the Choice criteria keys must not collide", () => {
    const values = Object.values(MODE_OPTIONS)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe("buildBatchQuestions", () => {
  const exchange = { question: Q, answer: A, observed: "" }

  test("an exchange adds the grounding id alongside the approach id (one batch, two ids)", () => {
    const questions = buildBatchQuestions(REQUEST, exchange)
    expect(Object.keys(questions)).toEqual(["approach", "premise", "grounding"])
    expect(questions.approach?.type).toBe("choice")
    expect(questions.grounding?.type).toBe("noul")
  })

  test("no exchange asks the mode + premise ids only — never an empty grading id", () => {
    const questions = buildBatchQuestions(REQUEST, null)
    expect(Object.keys(questions)).toEqual(["approach", "premise"])
    expect("grounding" in questions).toBe(false)
  })

  test("no request asks the grading id only", () => {
    const questions = buildBatchQuestions(null, exchange)
    expect(Object.keys(questions)).toEqual(["grounding"])
    expect("approach" in questions).toBe(false)
  })

  test("neither asks nothing at all", () => {
    expect(buildBatchQuestions(null, null)).toEqual({})
  })

  test("a null request asks NO premise id — the premise is a property of the request", () => {
    expect("premise" in buildBatchQuestions(null, exchange)).toBe(false)
  })

  test("the premise id is a noul riding the same batch, and carries NO criteria", () => {
    const questions = buildBatchQuestions(REQUEST, exchange)
    expect(questions.premise?.type).toBe("noul")
    expect("criteria" in (questions.premise ?? {})).toBe(false)
  })

  test("the premise question asks the truth of the NEW request's central premise", () => {
    const instructions = buildBatchQuestions(REQUEST, exchange).premise?.instructions ?? ""
    expect(instructions).toContain(REQUEST)
    expect(instructions).toContain("Is the central premise of Q factually true as stated?")
    expect(instructions).not.toContain(A)
  })

  test("the premise question is head-capped to 400 chars like every other question", () => {
    const long = "p".repeat(1000)
    const instructions = buildBatchQuestions(long, exchange).premise?.instructions ?? ""
    expect(instructions).toContain(excerpt(long, QUESTION_EXCERPT_CHARS))
    expect(instructions).not.toContain("p".repeat(401))
  })

  test("the noul id carries NO criteria — it emits no probabilities", () => {
    expect("criteria" in (buildBatchQuestions(REQUEST, exchange).grounding ?? {})).toBe(false)
  })

  test("the approach criteria are keyed on the DESCRIPTIONS, in label order", () => {
    const questions = buildBatchQuestions(REQUEST, exchange)
    expect(Object.keys(questions.approach?.criteria ?? {})).toEqual(Object.values(MODE_OPTIONS))
    expect(questions.approach?.criteria[MODE_OPTIONS.direct]).toBe(MODE_OPTIONS.direct)
  })

  test("each id is asked in its own vocabulary over the excerpted text", () => {
    const questions = buildBatchQuestions("r".repeat(1000), exchange)
    expect(questions.approach?.instructions).toContain(excerpt("r".repeat(1000), QUESTION_EXCERPT_CHARS))
    expect(questions.approach?.instructions).toContain("Which of these approaches best answers Q?")
    expect(questions.grounding?.instructions).toContain(Q)
    expect(questions.grounding?.instructions).toContain(excerpt(A, ANSWER_EXCERPT_CHARS))
  })

  test("a non-empty observed section asks WITH the O block, between the answer and the question", () => {
    const withO = buildBatchQuestions(REQUEST, { question: Q, answer: A, observed: "[tool read]\nfile contents here" })
    const instructions = withO.grounding?.instructions ?? ""
    expect(instructions).toContain('\nOBSERVED OUTPUT (O): "[tool read]\nfile contents here"')
    expect(instructions.indexOf("ANSWER (A):")).toBeLessThan(instructions.indexOf("OBSERVED OUTPUT (O):"))
    expect(instructions.indexOf("OBSERVED OUTPUT (O):")).toBeLessThan(instructions.indexOf("How well does A answer Q?"))
  })

  test("an empty observed section OMITS the O block entirely", () => {
    const withoutO = buildBatchQuestions(REQUEST, { question: Q, answer: A, observed: "" })
    expect(withoutO.grounding?.instructions).not.toContain("OBSERVED OUTPUT (O)")
    expect(withoutO.grounding?.instructions).toBe(buildBatchQuestions(REQUEST, exchange).grounding?.instructions)
  })

  test("the O section is head-capped to 2500 chars inside the question", () => {
    const long = "y".repeat(5000)
    const withO = buildBatchQuestions(REQUEST, { question: Q, answer: A, observed: long })
    expect(withO.grounding?.instructions).toContain(excerpt(long, OBSERVED_OUTPUT_EXCERPT_CHARS))
    expect(withO.grounding?.instructions).not.toContain("y".repeat(2501))
  })

  test("v7.3 the question makes the grader answer for a [FAIL] entry in O", () => {
    const instructions = buildBatchQuestions(REQUEST, { question: Q, answer: A, observed: "[FAIL bash: permission denied]" }).grounding?.instructions ?? ""
    expect(instructions).toContain("If O contains entries marked [FAIL, an answer that does not acknowledge those failures scores low.")
    expect(instructions.indexOf("OBSERVED OUTPUT (O):")).toBeLessThan(instructions.indexOf("If O contains entries marked [FAIL"))
  })
})

describe("advisableProbability", () => {
  test("the gate is 0.7 — max(stable threshold, confidenceFloor)", () => {
    expect(MODE_GATE).toBe(0.7)
  })

  test("exactly at the gate advises (the boundary is inclusive)", () => {
    expect(advisableProbability(0.7)).toBe(0.7)
  })

  test("a hair under the gate is the flat verdict this gate exists to reject", () => {
    expect(advisableProbability(0.69)).toBeNull()
    expect(advisableProbability(0)).toBeNull()
  })

  test("an unmeasured row never advises", () => {
    expect(advisableProbability(null)).toBeNull()
  })

  test("a confident-but-measured pick passes", () => {
    expect(advisableProbability(1)).toBe(1)
    expect(advisableProbability(0.95)).toBe(0.95)
  })
})

describe("premise advisory gate", () => {
  // Mirrors the handler decision: measured and at or below PREMISE_ADVISE_MAX advises STRONGLY.
  const advises = (noul: number | null) => premiseTier(noul) !== undefined

  test("the strong gate is 0.3 and the soft ceiling 0.45", () => {
    expect(PREMISE_ADVISE_MAX).toBe(0.3)
    expect(PREMISE_SOFT_MAX).toBe(0.45)
  })

  test("exactly at the gate advises (the boundary is inclusive)", () => {
    expect(advises(0.3)).toBe(true)
    expect(advises(0.0)).toBe(true)
  })

  test("0.31 is telemetry only — a mid-range read is the flat verdict this rejects", () => {
    expect(advises(0.46)).toBe(false)
    expect(advises(0.5)).toBe(false)
    expect(advises(1)).toBe(false)
  })

  test("an unmeasured premise never advises", () => {
    expect(advises(null)).toBe(false)
    expect(advises(parseBatchAnswers({ answers: {} }).premise)).toBe(false)
  })

  test("the gate is a separate threshold from MODE_GATE — a weak mode pick never advises", () => {
    expect(PREMISE_ADVISE_MAX).toBeLessThan(MODE_GATE)
    expect(PREMISE_SOFT_MAX).toBeLessThan(MODE_GATE)
  })

  test("v7.3 the tier mapping: 0.29 and below strong, 0.39 soft, 0.46 and above none", () => {
    expect(premiseTier(0.29)).toBe("strong")
    expect(premiseTier(0.3)).toBe("strong")
    expect(premiseTier(0.31)).toBe("soft")
    expect(premiseTier(0.39)).toBe("soft")
    expect(premiseTier(0.45)).toBe("soft")
    expect(premiseTier(0.46)).toBeUndefined()
    expect(premiseTier(1)).toBeUndefined()
    expect(premiseTier(null)).toBeUndefined()
  })
})

describe("parseBatchAnswers", () => {
  const approach = (choice: string, probabilities?: unknown, confidence?: unknown) => ({
    answers: { approach: { choice, ...(probabilities === undefined ? {} : { probabilities }), ...(confidence === undefined ? {} : { confidence }) } },
  })

  test("both rows of one record are read back under their own ids", () => {
    const result = parseBatchAnswers({
      answers: {
        approach: { choice: MODE_OPTIONS["investigate-first"], probabilities: { [MODE_OPTIONS["investigate-first"]]: 0.83 }, confidence: 0.9 },
        grounding: { noul: 0.42 },
        premise: { noul: 0.18 },
      },
    })
    expect(result).toEqual({
      score: 0.42,
      premise: 0.18,
      mode: { choice: "investigate-first", probability: 0.83, confidence: 0.9 },
    })
  })

  test("the premise row maps to its own noul, independent of the grounding score", () => {
    expect(parseBatchAnswers({ answers: { premise: { noul: 0.31 } } })).toEqual({ score: null, mode: null, premise: 0.31 })
    expect(parseBatchAnswers({ answers: { grounding: { noul: 0.9 }, premise: { noul: 0.05 } } })).toEqual({ score: 0.9, mode: null, premise: 0.05 })
  })

  test("a non-numeric or missing premise noul fails open to null, never a fabricated 0", () => {
    expect(parseBatchAnswers({ answers: { premise: { noul: "0.2" } } }).premise).toBeNull()
    expect(parseBatchAnswers({ answers: { premise: {} } }).premise).toBeNull()
    expect(parseBatchAnswers({ answers: { grounding: { noul: 0.5 } } }).premise).toBeNull()
    expect(parseBatchAnswers({}).premise).toBeNull()
  })

  test("a known label with no measured probability keeps the pick at a null strength", () => {
    expect(parseBatchAnswers(approach(MODE_OPTIONS.direct, {}))).toEqual({ score: null, mode: { choice: "direct", probability: null, confidence: null }, premise: null })
    expect(parseBatchAnswers(approach(MODE_OPTIONS.direct))).toEqual({ score: null, mode: { choice: "direct", probability: null, confidence: null }, premise: null })
  })

  test("a non-numeric probability is unmeasured, not a zero", () => {
    const result = parseBatchAnswers(approach(MODE_OPTIONS.direct, { [MODE_OPTIONS.direct]: "0.9" }))
    expect(result.mode?.probability).toBeNull()
  })

  test("a choice outside MODE_OPTIONS is not ours and fails open to a null mode", () => {
    expect(parseBatchAnswers(approach("Some other approach", { "Some other approach": 0.99 })).mode).toBeNull()
  })

  test("a non-numeric or absent noul is a null score, never a fabricated 0", () => {
    expect(parseBatchAnswers({ answers: { grounding: { noul: "0.5" } } }).score).toBeNull()
    expect(parseBatchAnswers({ answers: { grounding: {} } }).score).toBeNull()
    expect(parseBatchAnswers({ answers: {} })).toEqual({ score: null, mode: null, premise: null })
    expect(parseBatchAnswers({})).toEqual({ score: null, mode: null, premise: null })
    expect(parseBatchAnswers(undefined)).toEqual({ score: null, mode: null, premise: null })
    expect(parseBatchAnswers({ answers: { approach: { choice: 7 } } })).toEqual({ score: null, mode: null, premise: null })
  })

  test("a non-numeric confidence renders null and never reaches the gate", () => {
    expect(parseBatchAnswers(approach(MODE_OPTIONS.direct, { [MODE_OPTIONS.direct]: 0.99 }, "high")).mode?.confidence).toBeNull()
  })
})

describe("modeAdvisory", () => {
  test("names the chosen mode with its probability and confidence", () => {
    const text = modeAdvisory("enumerate-first", 0.42, 0.7)
    expect(text).toContain("enumerate-first")
    expect(text).toContain("p=0.42")
    expect(text).toContain("confidence=0.70")
    expect(text).toContain("Shape this answer accordingly.")
    expect(text.split("\n").length).toBe(1)
  })

  test("a null confidence renders n/a", () => {
    expect(modeAdvisory("direct", 0.1, null)).toContain("confidence=n/a")
  })
})

describe("CHOICE_STATE", () => {
  test("it names every mode it is ranking", () => {
    expect(CHOICE_STATE).toContain("direct")
    expect(CHOICE_STATE).toContain("enumerate-first")
    expect(CHOICE_STATE).toContain("investigate-first")
  })

  test("it defaults to no mode", () => {
    expect(CHOICE_STATE).toContain("none is preferred by default")
  })

  test("the approach-ranking bias that under-picked enumerate-first is gone", () => {
    expect(CHOICE_STATE).not.toContain("prefer grounded")
  })
})
