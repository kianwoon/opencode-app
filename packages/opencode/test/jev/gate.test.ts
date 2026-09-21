import { afterEach, describe, expect, test } from "bun:test"
import { applyDrops, boosterAdvisory, boosterPush, boosterVerdict, foldDrops } from "@/jev/gate"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const answers = (row: unknown) =>
  (async () => new Response(JSON.stringify({ answers: { advice: row } }), { status: 200 })) as unknown as typeof fetch

describe("boosterAdvisory — require a MEASURED probabilities[choice]", () => {
  test("emits when the measured strength clears the threshold", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "verify", probabilities: { verify: 0.9, continue: 0.1 } })
    const text = await boosterAdvisory({ key: "k", state: "s", config: { enabled: true } })
    expect(text).toContain("verification")
  })

  test("emits NOTHING when probabilities[choice] is absent (no fabricated strength=1)", async () => {
    // The Critical-2 regression: `confidence` is confidence in the LABEL, not a
    // score. A confident `switch` label with no probability map must not emit.
    globalThis.fetch = answers({ type: "choice", choice: "switch", confidence: 0.99 })
    const text = await boosterAdvisory({ key: "k", state: "s", config: { enabled: true } })
    expect(text).toBeUndefined()
  })

  test("emits nothing for `continue` and sub-threshold rows", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "continue", probabilities: { continue: 0.99 } })
    expect(await boosterAdvisory({ key: "k", state: "s", config: { enabled: true } })).toBeUndefined()
    globalThis.fetch = answers({ type: "choice", choice: "switch", probabilities: { switch: 0.2 } })
    expect(await boosterAdvisory({ key: "k", state: "s", config: { enabled: true } })).toBeUndefined()
  })
})

describe("boosterPush — change-detect on the folded label", () => {
  test("first-ever emission (no memo) pushes", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "verify", probabilities: { verify: 0.9 } })
    const verdict = await boosterVerdict({ key: "k", state: "s", config: { enabled: true } })
    const push = boosterPush(undefined, verdict)
    expect(push.changed).toBe(true)
    expect(push.advisory).toContain("verification")
  })

  test("a repeated label is a no-op (changed=false, nothing pushed)", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "verify", probabilities: { verify: 0.9 } })
    const verdict = await boosterVerdict({ key: "k", state: "s", config: { enabled: true } })
    // prev label equals this turn's label → prefix untouched.
    const push = boosterPush("verify", verdict)
    expect(push.changed).toBe(false)
    expect(push.advisory).toBeUndefined()
  })

  test("a label flip pushes", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "verify", probabilities: { verify: 0.9 } })
    const verdict = await boosterVerdict({ key: "k", state: "s", config: { enabled: true } })
    const push = boosterPush("continue", verdict)
    expect(push.changed).toBe(true)
    expect(push.advisory).toContain("verification")
  })

  test("unmeasured row (no probabilities[choice]) → nothing, not even changed", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "switch", confidence: 0.99 })
    const verdict = await boosterVerdict({ key: "k", state: "s", config: { enabled: true } })
    expect(verdict).toBeUndefined()
    const push = boosterPush("verify", verdict)
    expect(push.changed).toBe(false)
    expect(push.advisory).toBeUndefined()
  })

  test("flip to `continue` reports changed but pushes no block", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "continue", probabilities: { continue: 0.99 } })
    const verdict = await boosterVerdict({ key: "k", state: "s", config: { enabled: true } })
    const push = boosterPush("verify", verdict)
    expect(push.changed).toBe(true)
    expect(push.advisory).toBeUndefined()
  })
})

describe("foldDrops — sticky drop-set (Phase 2)", () => {
  test("a drop persists across turns: next turn's empty decision cannot re-add it", () => {
    const turn1 = foldDrops(new Set(), new Set([2]))
    expect([...turn1]).toEqual([2])
    // Turn 2 re-decides keep for section 2 → an empty drop set. Sticky keeps it.
    const turn2 = foldDrops(turn1, new Set())
    expect([...turn2]).toEqual([2])
  })

  test("the set only grows within a task (monotonic, no oscillation)", () => {
    const t1 = foldDrops(new Set(), new Set([1]))
    const t2 = foldDrops(t1, new Set([3]))
    expect([...t2].sort((a, b) => a - b)).toEqual([1, 3])
    // A later turn re-keeping 1 and 3 changes nothing — no drop→re-add→drop cycle.
    const t3 = foldDrops(t2, new Set())
    expect([...t3].sort((a, b) => a - b)).toEqual([1, 3])
  })

  test("a task boundary resets the set (the only restore path)", () => {
    const withinTask = foldDrops(new Set(), new Set([0]))
    expect([...withinTask]).toEqual([0])
    // Caller passes a fresh empty set on a new user message → restored.
    const newTask = foldDrops(new Set(), new Set())
    expect([...newTask]).toEqual([])
  })

  test("applyDrops removes exactly the sticky indexes (identity when empty)", () => {
    const blocks = ["a", "b", "c", "d"]
    expect(applyDrops(blocks, new Set([1, 3]))).toEqual(["a", "c"])
    expect(applyDrops(blocks, new Set())).toBe(blocks)
  })
})
