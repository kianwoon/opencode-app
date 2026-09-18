import { describe, expect, test } from "bun:test"

import {
  DEFAULT_THRESHOLDS,
  buildDecisionState,
  evaluateThresholds,
  fingerprint,
  maxFailureCount,
  repeatedExactFailure,
  resolveClassifierModel,
  ruleBasedDecision,
  shouldActOnRetry,
  type RetrySignals,
} from "@/classifier/retry"
import type { RetryDecision } from "@/classifier/schema"

const state = (overrides: Partial<ReturnType<typeof buildDecisionState>> = {}) =>
  buildDecisionState({
    goal: "make the test pass",
    step: 3,
    latestAction: "bun test",
    latestResult: "1 failing",
    ...overrides,
  })

const signals = (overrides: Partial<RetrySignals> = {}): RetrySignals => ({
  progressMade: 0,
  newInformation: 0,
  sameStrategy: 0,
  strategyExhausted: 0,
  retryUseful: 0,
  switchModel: 0,
  ...overrides,
})

const evaluate = (input: {
  signals?: Partial<RetrySignals>
  attempt?: number
  maxAttempts?: number
  failureCount?: number
  accept?: number
}) => {
  const failures = input.failureCount
    ? [{ signature: "sig", count: input.failureCount }]
    : []
  return evaluateThresholds({
    state: state({ previousFailures: failures }),
    signals: signals(input.signals),
    attempt: input.attempt ?? 2,
    maxAttempts: input.maxAttempts ?? 5,
    thresholds: { retry_switch: { accept: input.accept ?? 0.8 }, retry_act: { accept: 0.8 } },
  })
}

describe("retry fingerprints", () => {
  test("identical triples collide", () => {
    const a = fingerprint({ error: "E", action: "A", result: "R" })
    const b = fingerprint({ error: "E", action: "A", result: "R" })
    expect(a).toBe(b)
  })

  test("differing in any component does not collide", () => {
    const base = fingerprint({ error: "E", action: "A", result: "R" })
    expect(fingerprint({ error: "E2", action: "A", result: "R" })).not.toBe(base)
    expect(fingerprint({ error: "E", action: "A2", result: "R" })).not.toBe(base)
    expect(fingerprint({ error: "E", action: "A", result: "R2" })).not.toBe(base)
  })

  test("undefined components are treated as empty without throwing", () => {
    expect(fingerprint({})).toBe(fingerprint({ error: "", action: "", result: "" }))
  })
})

describe("failure accounting", () => {
  test("repeatedExactFailure requires count >= 2", () => {
    expect(repeatedExactFailure(state({ previousFailures: [{ signature: "s", count: 1 }] }), "s")).toBe(false)
    expect(repeatedExactFailure(state({ previousFailures: [{ signature: "s", count: 2 }] }), "s")).toBe(true)
  })

  test("maxFailureCount returns the highest repeat", () => {
    expect(maxFailureCount(state({ previousFailures: [{ signature: "a", count: 1 }, { signature: "b", count: 4 }] }))).toBe(4)
    expect(maxFailureCount(state())).toBe(0)
  })
})

describe("§6 deterministic guardrails", () => {
  test("attempt 1 always CONTINUE regardless of signals", () => {
    const result = evaluate({ attempt: 1, signals: { strategyExhausted: 1, switchModel: 1 } })
    expect(result.decision).toBe("CONTINUE")
    expect(result.reasonCode).toBe("PROGRESS_MADE")
  })

  test("attempt >= max always STOP", () => {
    const result = evaluate({ attempt: 5, maxAttempts: 5, signals: { progressMade: 1 } })
    expect(result.decision).toBe("STOP")
    expect(result.reasonCode).toBe("MAX_ATTEMPTS")
  })

  test("3+ identical failures prohibit a blind retry even with new information", () => {
    const result = evaluate({ failureCount: 3, signals: { newInformation: 1 } })
    expect(result.decision).not.toBe("RETRY")
  })

  test("2 identical failures with no new info and no usefulness escalates", () => {
    const result = evaluate({ failureCount: 2, signals: { retryUseful: 0.1 } })
    expect(result.decision).toBe("ESCALATE")
    expect(result.reasonCode).toBe("NO_PROGRESS_REPEATED_FAILURE")
  })
})

describe("threshold boundaries around retry_switch.accept", () => {
  test("0.79 < accept: new information does not force a retry", () => {
    const result = evaluate({ accept: 0.8, signals: { newInformation: 0.79, retryUseful: 0.79, strategyExhausted: 0.79 } })
    expect(result.decision).not.toBe("RETRY")
  })

  test("0.80 == accept: new information permits RETRY", () => {
    const result = evaluate({ accept: 0.8, signals: { newInformation: 0.8 } })
    expect(result.decision).toBe("RETRY")
    expect(result.reasonCode).toBe("NEW_INFORMATION")
  })

  test("0.81 > accept: strategy exhaustion dominates when flagged", () => {
    const result = evaluate({ accept: 0.8, signals: { strategyExhausted: 0.81 } })
    expect(result.decision).toBe("SWITCH_STRATEGY")
    expect(result.reasonCode).toBe("STRATEGY_EXHAUSTED")
  })

  test("model incapacity at the threshold switches model", () => {
    const result = evaluate({ accept: 0.8, signals: { switchModel: 0.8 } })
    expect(result.decision).toBe("SWITCH_MODEL")
  })

  test("progress dominates when not blind-retrying", () => {
    const result = evaluate({ signals: { progressMade: 0.9 } })
    expect(result.decision).toBe("CONTINUE")
  })

  test("default threshold is 0.8", () => {
    expect(DEFAULT_THRESHOLDS.retry_switch.accept).toBe(0.8)
  })
})

describe("resolveClassifierModel precedence", () => {
  test("override wins when all three are set", () => {
    expect(
      resolveClassifierModel({ override: "o", brainModel: "b", classifierModel: "c" }),
    ).toBe("o")
  })

  test("brainModel wins over classifierModel when no override", () => {
    expect(resolveClassifierModel({ brainModel: "b", classifierModel: "c" })).toBe("b")
  })

  test("classifierModel used when it is the only one set", () => {
    expect(resolveClassifierModel({ classifierModel: "c" })).toBe("c")
  })

  test("undefined when all are absent", () => {
    expect(resolveClassifierModel({})).toBeUndefined()
  })

  test("empty strings fall through to the next source", () => {
    expect(resolveClassifierModel({ brainModel: "", classifierModel: "m" })).toBe("m")
    expect(resolveClassifierModel({ override: "", brainModel: "b" })).toBe("b")
    expect(resolveClassifierModel({ brainModel: "", classifierModel: "" })).toBeUndefined()
  })
})

describe("RuleBasedClassifier (no network)", () => {
  const rule = (input: Partial<Parameters<typeof ruleBasedDecision>[0]> = {}) =>
    ruleBasedDecision({
      state: state(),
      attempt: 2,
      maxAttempts: 5,
      thresholds: DEFAULT_THRESHOLDS,
      ...input,
    })

  test("decides with zero dependencies", () => {
    const result = rule()
    expect(result.decision).toBeDefined()
    expect(result.reasonCode).toBeDefined()
  })

  test("attempt 1 continues", () => {
    expect(rule({ attempt: 1 }).decision).toBe("CONTINUE")
  })

  test("max attempts stops", () => {
    expect(rule({ attempt: 5, maxAttempts: 5 }).reasonCode).toBe("MAX_ATTEMPTS")
  })

  test("progress signals continue", () => {
    expect(rule({ state: state({ progressSignals: ["file changed"] }) }).decision).toBe("CONTINUE")
  })

  test("3 repeats escalate as no-progress", () => {
    const result = rule({ state: state({ previousFailures: [{ signature: "s", count: 3 }] }) })
    expect(result.decision).toBe("ESCALATE")
    expect(result.reasonCode).toBe("NO_PROGRESS_REPEATED_FAILURE")
  })

  test("2 repeats with no progress escalate for classifier review", () => {
    const result = rule({ state: state({ previousFailures: [{ signature: "s", count: 2 }] }) })
    expect(result.decision).toBe("ESCALATE")
    expect(result.reasonCode).toBe("REPEATED_EXACT_FAILURE")
  })
})

describe("shouldActOnRetry", () => {
  const act = (input: {
    decision: RetryDecision
    confidence: number
    threshold?: number
    fallbackUsed?: boolean
  }) => shouldActOnRetry({ threshold: 0.8, ...input })

  test("STOP above threshold acts", () => {
    expect(act({ decision: "STOP", confidence: 0.9 })).toBe(true)
  })

  test("ESCALATE above threshold acts", () => {
    expect(act({ decision: "ESCALATE", confidence: 0.81 })).toBe(true)
  })

  test("confidence exactly at threshold acts", () => {
    expect(act({ decision: "STOP", confidence: 0.8 })).toBe(true)
  })

  test("confidence just below threshold does not act", () => {
    expect(act({ decision: "STOP", confidence: 0.79 })).toBe(false)
  })

  test("every non-stop/escalate decision does not act", () => {
    const others: RetryDecision[] = [
      "CONTINUE",
      "RETRY",
      "SWITCH_STRATEGY",
      "SWITCH_MODEL",
      "ROLLBACK",
      "ASK_USER",
    ]
    for (const decision of others) {
      expect(act({ decision, confidence: 1 })).toBe(false)
    }
  })

  test("a fallback verdict never acts", () => {
    expect(act({ decision: "STOP", confidence: 1, fallbackUsed: true })).toBe(false)
  })

  test("NaN confidence does not act", () => {
    expect(act({ decision: "ESCALATE", confidence: Number.NaN })).toBe(false)
  })
})
