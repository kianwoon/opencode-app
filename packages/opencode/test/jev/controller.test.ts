import { describe, expect, test } from "bun:test"
import {
  CONTROLS_MAX,
  LABEL_MAX,
  buildControllerQuestions,
  buildState,
  foldController,
  type JevAction,
} from "@/jev/controller"

// Shapes below mirror live decisions captures (choice + per-label probabilities).
const ans = (choice: string, probabilities: Record<string, number>) => ({ type: "choice", choice, probabilities })

describe("foldController", () => {
  test("returns the gated action + target when the action clears the threshold", () => {
    const d = foldController(
      {
        answers: {
          action: ans("click", { click: 0.82, wait: 0.18 }),
          target: ans("0:Settings", { "0:Settings": 0.9, none: 0.1 }),
          success: ans("yes", { yes: 0.8, no: 0.2 }),
          stuck: ans("no", { yes: 0.1, no: 0.9 }),
          need_screenshot: ans("yes", { yes: 0.7, no: 0.3 }),
        },
      },
      0.7,
    )
    expect(d?.action).toBe("click")
    expect(d?.target).toBe("Settings")
    expect(d?.success).toBe(true)
    expect(d?.stuck).toBe(false)
    expect(d?.needScreenshot).toBe(true)
    expect(d?.strength).toBeCloseTo(0.82)
  })

  test("fails open to null when the action strength is below the threshold", () => {
    const d = foldController(
      { answers: { action: ans("click", { click: 0.42, wait: 0.58 }) } },
      0.7,
    )
    expect(d).toBeNull()
  })

  test("nulls a target that resolves to `none`", () => {
    const d = foldController(
      { answers: { action: ans("done", { done: 0.99 }), target: ans("none", { none: 0.95 }) } },
      0.7,
    )
    expect(d?.action).toBe("done")
    expect(d?.target).toBeNull()
  })

  test("fails open on a missing answers envelope", () => {
    expect(foldController({}, 0.7)).toBeNull()
    expect(foldController(null, 0.7)).toBeNull()
  })
})

describe("buildControllerQuestions", () => {
  test("emits one record with all five choice questions", () => {
    const q = buildControllerQuestions(["Settings", "Save", "Cancel"])
    expect(Object.keys(q ?? {}).sort()).toEqual(["action", "need_screenshot", "stuck", "success", "target"])
    expect(q?.action.type).toBe("choice")
    // criteria is a label->description record, never an array.
    expect(Array.isArray(q?.action.criteria)).toBe(false)
  })

  test("order-bias guard: every control stays a target option at full count", () => {
    const controls = Array.from({ length: CONTROLS_MAX }, (_, i) => `ctrl-${i}`)
    const q = buildControllerQuestions(controls)
    // 60 controls + the `none` sentinel.
    expect(Object.keys(q?.target.criteria ?? {}).length).toBe(CONTROLS_MAX + 1)
  })

  test("shrinks long labels to LABEL_MAX without dropping options", () => {
    const long = "x".repeat(LABEL_MAX * 3)
    const q = buildControllerQuestions([long, "ok"])
    const keys = Object.keys(q?.target.criteria ?? {}).filter((k) => k !== "none")
    expect(keys.length).toBe(2)
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(LABEL_MAX + 6) // `${i}:`
  })
})

describe("buildState", () => {
  test("clips the composed state to STATE_MAX and keeps goal + last action", () => {
    const s = buildState({ goal: "g".repeat(6000), lastAction: "typed foo", controls: [] })
    expect(s.length).toBe(4000)
    expect(s.startsWith("GOAL: ")).toBe(true)
  })
})

test("JevAction union stays in sync with the question criteria", () => {
  const actions: JevAction[] = ["click", "type", "scroll", "key", "wait", "done"]
  const q = buildControllerQuestions([])
  expect(Object.keys(q?.action.criteria ?? {}).sort()).toEqual([...actions].sort())
})
