import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import {
  Answer,
  Question,
  SystemOneRequest,
  SystemOneResponse,
} from "@/classifier/schema"

// Documented TypeSafe System One payloads, decoded through the REAL schemas.
// This is decoding real documented data, not mocking.
const REQUEST = {
  state: "Customer says: my order arrived damaged and I am furious",
  model: "jev-latest",
  questions: {
    department: {
      type: "choice",
      instructions: "Which department should handle this?",
      criteria: {
        billing: "Billing and payments",
        support: "Product support",
        logistics: "Shipping and logistics",
      },
    },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["calm", "mild", "upset", "furious"],
    },
    is_urgent: {
      type: "noul",
      instructions: "Does this need same-day handling?",
      criteria: { true: "urgent", false: "not urgent" },
    },
  },
}

const RESPONSE = {
  model: "jev-latest",
  answers: {
    department: {
      type: "choice",
      choice: "logistics",
      probabilities: { billing: 0.05, support: 0.1, logistics: 0.85 },
      confidence: 0.85,
    },
    frustration: {
      type: "score",
      score: 3,
      legend: { "0": "calm", "1": "mild", "2": "upset", "3": "furious" },
      probabilities: { "0": 0.01, "1": 0.04, "2": 0.1, "3": 0.85 },
      confidence: 0.85,
    },
    is_urgent: { type: "noul", noul: 0.9 },
  },
  usage: { input_tokens: 42, output_tokens: 7 },
}

describe("System One schema decode", () => {
  test("decodes the documented request", () => {
    const decoded = Schema.decodeUnknownSync(SystemOneRequest)(REQUEST)
    expect(decoded.questions.department.type).toBe("choice")
    expect(decoded.questions.frustration.type).toBe("score")
    expect(decoded.questions.is_urgent.type).toBe("noul")
  })

  test("decodes the documented response including all three answer types", () => {
    const decoded = Schema.decodeUnknownSync(SystemOneResponse)(RESPONSE)
    expect(decoded.answers.department.type).toBe("choice")
    expect(decoded.answers.frustration.type).toBe("score")
    expect(decoded.answers.is_urgent.type).toBe("noul")
    expect(decoded.usage).toEqual({ input_tokens: 42, output_tokens: 7 })
  })

  test("noul answer has no confidence or probabilities", () => {
    const decoded = Schema.decodeUnknownSync(Answer)(RESPONSE.answers.is_urgent)
    expect(decoded.type).toBe("noul")
    expect("confidence" in decoded).toBe(false)
    expect("probabilities" in decoded).toBe(false)
  })

  test("score answer legend keys are strings", () => {
    const decoded = Schema.decodeUnknownSync(Answer)(RESPONSE.answers.frustration)
    if (decoded.type !== "score") throw new Error("expected score")
    expect(Object.keys(decoded.legend)).toEqual(["0", "1", "2", "3"])
  })

  test("rejects an unknown question type", () => {
    expect(() =>
      Schema.decodeUnknownSync(Question)({ type: "mystery", instructions: "?" }),
    ).toThrow()
  })

  test("accepts object instructions on a question", () => {
    const decoded = Schema.decodeUnknownSync(Question)({
      type: "choice",
      instructions: { prompt: "pick one" },
      criteria: { a: null, b: "B" },
    })
    expect(decoded.type).toBe("choice")
  })
})
