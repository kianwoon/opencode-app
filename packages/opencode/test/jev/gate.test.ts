import { describe, expect, test } from "bun:test"
import { applyDrops, boosterPush, type BoosterVerdict } from "@/jev/gate"

const verdict = (label: string, emitted: boolean, text?: string): BoosterVerdict => ({ label, emitted, text })

describe("boosterPush — change-detect on the folded label", () => {
  test("first-ever emission (no memo) pushes", () => {
    const push = boosterPush(undefined, verdict("verify", true, "[Advisory] verify."))
    expect(push.changed).toBe(true)
    expect(push.advisory).toBe("[Advisory] verify.")
  })

  test("a repeated label is a no-op (changed=false, nothing pushed)", () => {
    // prev label equals this turn's label → prefix untouched.
    const push = boosterPush("verify", verdict("verify", true, "[Advisory] verify."))
    expect(push.changed).toBe(false)
    expect(push.advisory).toBeUndefined()
  })

  test("a label flip pushes", () => {
    const push = boosterPush("continue", verdict("verify", true, "[Advisory] verify."))
    expect(push.changed).toBe(true)
    expect(push.advisory).toBe("[Advisory] verify.")
  })

  test("unmeasured row (no verdict) → nothing, not even changed", () => {
    const push = boosterPush("verify", undefined)
    expect(push.changed).toBe(false)
    expect(push.advisory).toBeUndefined()
  })

  test("flip to `continue` reports changed but pushes no block", () => {
    const push = boosterPush("verify", verdict("continue", false))
    expect(push.changed).toBe(true)
    expect(push.advisory).toBeUndefined()
  })
})

describe("applyDrops — indexed section drop", () => {
  test("removes exactly the dropped indexes (identity when empty)", () => {
    const blocks = ["a", "b", "c", "d"]
    expect(applyDrops(blocks, new Set([1, 3]))).toEqual(["a", "c"])
    expect(applyDrops(blocks, new Set())).toBe(blocks)
  })
})