import { describe, expect, test } from "bun:test"
import {
  jevTransport,
  resolveJevEffortConfig,
  DEFAULT_JEV_EFFORT,
  foldEffortAnswer,
  classifyTier,
  clearEffortMemo,
  memoResult,
  MEMO_MAX,
  __testRemember,
} from "./jev-effort.ts"

describe("jevTransport", () => {
  test("typesafe/jev-1.13 -> SystemOne + wire id jev-latest", () => {
    expect(jevTransport("typesafe/jev-1.13")).toEqual({
      provider: "typesafe",
      id: "jev-latest",
      endpoint: "https://api.typesafe.ai/v1/systemone",
    })
  })

  test("typesafe/jev-1.13.0 stays, jev-latest stays", () => {
    expect(jevTransport("typesafe/jev-1.13.0")?.id).toBe("jev-1.13.0")
    expect(jevTransport("typesafe/jev-latest")?.id).toBe("jev-latest")
    expect(jevTransport("typesafe/unknown-thing")?.id).toBe("jev-latest")
  })

  test("openrouter/x -> decisions URL, id verbatim", () => {
    expect(jevTransport("openrouter/meta/llama")).toEqual({
      provider: "openrouter",
      id: "meta/llama",
      endpoint: "https://openrouter.ai/api/alpha/decisions",
    })
  })

  test("unknown provider -> undefined (fail-open)", () => {
    expect(jevTransport("acme/foo")).toBeUndefined()
    expect(jevTransport("noslash")).toBeUndefined()
    expect(jevTransport("typesafe/")).toBeUndefined()
  })

  test("a typesafe spec never resolves to openrouter.ai", () => {
    expect(jevTransport("typesafe/jev-1.13")?.endpoint).not.toContain("openrouter")
  })
})

describe("resolveJevEffortConfig", () => {
  test("malformed -> defaults", () => {
    expect(resolveJevEffortConfig(undefined)).toEqual(DEFAULT_JEV_EFFORT)
  })

  test("explicit model preserved", () => {
    expect(resolveJevEffortConfig({ enabled: true, model: "openrouter/x", threshold: 0.7 }).model).toBe("openrouter/x")
  })
})

describe("foldEffortAnswer — gate on probabilities[choice], never confidence", () => {
  const body = (row: unknown) => ({ answers: { effort: row } })

  test("measured probabilities[choice] folds to {tier, strength}", () => {
    expect(foldEffortAnswer(body({ choice: "high", probabilities: { high: 0.82 } }))).toEqual({
      tier: "high",
      strength: 0.82,
    })
  })

  test("confidence-only row is unmeasured -> null (no fabricated strength)", () => {
    // Regression: a confident SKIP (low strength) with confidence 0.9 must not
    // be adopted just because `confidence` cleared the threshold.
    expect(foldEffortAnswer(body({ choice: "minimal", confidence: 0.9 }))).toBeNull()
  })

  test("non-tier choice / malformed -> null", () => {
    expect(foldEffortAnswer(body({ choice: "extreme", probabilities: { extreme: 0.9 } }))).toBeNull()
    expect(foldEffortAnswer({})).toBeNull()
  })
})

describe("memo key is (text, spec) — spec change invalidates", () => {
  test("same text + different spec => 2 distinct entries (no false share)", () => {
    clearEffortMemo()
    __testRemember("hello world", "typesafe/jev-1.13", { tier: "low", strength: 0.9 })
    // A different spec must NOT see the first spec's verdict.
    expect(memoResult("hello world", "openrouter/meta/llama")).toBeUndefined()
    __testRemember("hello world", "openrouter/meta/llama", { tier: "high", strength: 0.8 })
    expect(memoResult("hello world", "typesafe/jev-1.13")).toEqual({ tier: "low", strength: 0.9 })
    expect(memoResult("hello world", "openrouter/meta/llama")).toEqual({ tier: "high", strength: 0.8 })
  })

  test("same text + same spec => 1 memo hit for the network path", async () => {
    clearEffortMemo()
    const text = "unique prompt for one-call assertion"
    const spec = "typesafe/jev-1.13"
    __testRemember(text, spec, { tier: "medium", strength: 0.7 })
    // Enabled cfg with the matching spec: the memo hit returns it synchronously.
    // reachedTransport is false because no fetch is made from this path.
    const cfg = { ...DEFAULT_JEV_EFFORT, enabled: true, model: spec }
    const a = await classifyTier(text, cfg)
    const b = await classifyTier(text, cfg)
    expect(a).toEqual({ tier: "medium", strength: 0.7 })
    expect(b).toEqual({ tier: "medium", strength: 0.7 })
  })

  test("spec change on the network path is not a memo hit", async () => {
    clearEffortMemo()
    const text = "spec-change probe"
    __testRemember(text, "typesafe/jev-1.13", { tier: "low", strength: 0.9 })
    // Same text, different spec. `nospec` has no transport so this fails open
    // with zero I/O — the assertion is that we do NOT reuse the first spec's
    // memoized verdict (a shared key would have returned it here).
    const cfg = { ...DEFAULT_JEV_EFFORT, enabled: true, model: "nospec" }
    expect(await classifyTier(text, cfg)).toBeNull()
  })

  test("MEMO_MAX eviction still bounded with the compound key", () => {
    clearEffortMemo()
    for (let i = 0; i < MEMO_MAX + 25; i++) {
      __testRemember(`text-${i}`, "typesafe/jev-1.13", { tier: "low", strength: 0.5 })
    }
    // Oldest evicted, newest retained, never exceeding the cap.
    expect(memoResult("text-0", "typesafe/jev-1.13")).toBeUndefined()
    expect(memoResult(`text-${MEMO_MAX + 24}`, "typesafe/jev-1.13")).toEqual({ tier: "low", strength: 0.5 })
  })
})
