import { beforeEach, describe, expect, test } from "bun:test"

import { ClassifierVerdict } from "@/classifier/verdict"
import type { Verdict } from "@/classifier/verdict"

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  decision: "STOP",
  confidence: 0.9,
  reasonCode: "MAX_ATTEMPTS",
  fingerprint: "abc",
  attempt: 3,
  ...overrides,
})

describe("classifier verdict store", () => {
  beforeEach(() => ClassifierVerdict.clear())

  test("put/get roundtrips the full verdict", () => {
    const value = verdict()
    ClassifierVerdict.put("session-a", value)
    expect(ClassifierVerdict.get("session-a")).toEqual(value)
  })

  test("unknown key is undefined", () => {
    expect(ClassifierVerdict.get("missing")).toBeUndefined()
  })

  test("a verdict for session A is not returned for session B", () => {
    ClassifierVerdict.put("session-a", verdict({ fingerprint: "a" }))
    ClassifierVerdict.put("session-b", verdict({ fingerprint: "b" }))
    expect(ClassifierVerdict.get("session-a")?.fingerprint).toBe("a")
    expect(ClassifierVerdict.get("session-b")?.fingerprint).toBe("b")
  })

  test("newest verdict per session wins", () => {
    ClassifierVerdict.put("session-a", verdict({ attempt: 1 }))
    ClassifierVerdict.put("session-a", verdict({ attempt: 2 }))
    expect(ClassifierVerdict.get("session-a")?.attempt).toBe(2)
  })

  test("take consumes the verdict", () => {
    ClassifierVerdict.put("session-a", verdict())
    expect(ClassifierVerdict.take("session-a")?.decision).toBe("STOP")
    expect(ClassifierVerdict.get("session-a")).toBeUndefined()
  })

  test("clear drops one session without touching others", () => {
    ClassifierVerdict.put("session-a", verdict())
    ClassifierVerdict.put("session-b", verdict())
    ClassifierVerdict.clear("session-a")
    expect(ClassifierVerdict.get("session-a")).toBeUndefined()
    expect(ClassifierVerdict.get("session-b")).toBeDefined()
  })

  test("evicts the oldest entries past the cap", () => {
    for (let index = 0; index < 300; index++) {
      ClassifierVerdict.put(`session-${index}`, verdict({ attempt: index }))
    }
    expect(ClassifierVerdict.get("session-0")).toBeUndefined()
    expect(ClassifierVerdict.get("session-299")?.attempt).toBe(299)
  })
})
