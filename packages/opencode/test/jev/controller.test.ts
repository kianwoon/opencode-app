import { describe, expect, test } from "bun:test"
import {
  CHOICE_HARD_MAX,
  CONTROLS_MAX,
  LABEL_MAX,
  buildControllerQuestions,
  buildState,
  controllerMemoKey,
  foldController,
  sampleWithinCap,
  type JevAction,
} from "@/jev/controller"
import { FRONTIER_HARD_MAX } from "@/tool/ui-eyes"

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
    expect(d.verdict).toBe("accepted")
    if (d.verdict !== "accepted") throw new Error("expected accepted")
    expect(d.decision.action).toBe("click")
    expect(d.decision.target).toBe("Settings")
    expect(d.decision.success).toBe(true)
    expect(d.decision.stuck).toBe(false)
    expect(d.decision.needScreenshot).toBe(true)
    expect(d.decision.strength).toBeCloseTo(0.82)
  })

  test("a measured action below the threshold is below_gate, not unavailable", () => {
    const d = foldController({ answers: { action: ans("click", { click: 0.55, wait: 0.45 }) } }, 0.7)
    expect(d.verdict).toBe("below_gate")
    if (d.verdict !== "below_gate") throw new Error("expected below_gate")
    expect(d.choice).toBe("click")
    expect(d.action).toBe("click")
    expect(d.strength).toBeCloseTo(0.55)
  })

  test("nulls a target that resolves to `none`", () => {
    const d = foldController(
      { answers: { action: ans("done", { done: 0.99 }), target: ans("none", { none: 0.95 }) } },
      0.7,
    )
    expect(d.verdict).toBe("accepted")
    if (d.verdict !== "accepted") throw new Error("expected accepted")
    expect(d.decision.action).toBe("done")
    expect(d.decision.target).toBeNull()
  })

  test("fails open on a missing answers envelope", () => {
    expect(foldController({}, 0.7).verdict).toBe("unmeasured")
    expect(foldController(null, 0.7).verdict).toBe("unmeasured")
  })

  test("a choice with no probabilities map is unmeasured (no blind click)", () => {
    // Degraded echo: a label without `probabilities[choice]` carries no score to
    // trust. Emitting the click here would be a blind click at threshold 0.
    expect(foldController({ answers: { action: { type: "choice", choice: "click" } } }, 0).verdict).toBe("unmeasured")
  })

  test("an action strength below the confidence floor is below_gate", () => {
    // threshold 0 but floor 0.3: a 0.1-strength click must not be trusted — but the
    // model DID weigh it, so the outcome is uncertain, not unmeasured.
    const d = foldController({ answers: { action: ans("click", { click: 0.1, wait: 0.9 }) } }, 0, 0.3)
    expect(d.verdict).toBe("below_gate")
    if (d.verdict !== "below_gate") throw new Error("expected below_gate")
    expect(d.strength).toBeCloseTo(0.1)
  })

  test("an unknown action choice is unmeasured, never a below_gate verdict", () => {
    expect(foldController({ answers: { action: ans("teleport", { teleport: 0.99 }) } }, 0.7).verdict).toBe("unmeasured")
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
  test("emits JSON clipped to STATE_MAX and keeps goal + last action", () => {
    const s = buildState({ goal: "g".repeat(6000), lastAction: "typed foo", controls: [] })
    expect(s.length).toBeLessThanOrEqual(4000)
    const parsed = JSON.parse(s)
    expect(parsed.goal.length).toBe(2000)
    expect(parsed.lastAction).toBe("typed foo")
    expect(parsed.controls).toEqual([])
  })

  test("carries the control labels as JSON controls[]", () => {
    const s = buildState({ goal: "open settings", lastAction: "(first step)", controls: ["File", "Settings"] })
    expect(JSON.parse(s).controls).toEqual(["File", "Settings"])
  })
})

// hardcode-guard:allow fixture node ids and labels are the enumerable input under test
describe("navigation map state", () => {
  const map = {
    goal: "buy the widget",
    start: "s1",
    current: "s3",
    frontier: ["c1 AXButton Buy", "c2 AXButton Back"],
    path: ["s1", "s2", "s3"],
  }

  test("the state sent to jev carries goal + start + current + frontier + path", () => {
    const parsed = JSON.parse(buildState({ map, lastAction: "clicked Widget" }))
    expect(parsed.goal).toBe("buy the widget")
    expect(parsed.start).toBe("s1")
    expect(parsed.current).toBe("s3")
    expect(parsed.frontier).toEqual(["c1 AXButton Buy", "c2 AXButton Back"])
    expect(parsed.path).toEqual(["s1", "s2", "s3"])
    expect(parsed.lastAction).toBe("clicked Widget")
  })

  test("the code-enumerated frontier is exactly the target option set (+ none)", () => {
    const q = buildControllerQuestions(map.frontier)
    expect(Object.keys(q?.target.criteria ?? {})).toEqual(["0:c1 AXButton Buy", "1:c2 AXButton Back", "none"])
  })
})

describe("controllerMemoKey", () => {
  const base = ["ctl", "jev-latest", 0.7, 0.5, 30_000, "h1"] as const

  test("identical inputs produce an identical key", () => {
    expect(controllerMemoKey(...base)).toBe(controllerMemoKey(...base))
  })

  test("transport, floor, timeout and threshold each change the key", () => {
    expect(controllerMemoKey("ctl", "other-model", 0.7, 0.5, 30_000, "h1")).not.toBe(controllerMemoKey(...base))
    expect(controllerMemoKey("ctl", "jev-latest", 0.9, 0.5, 30_000, "h1")).not.toBe(controllerMemoKey(...base))
    expect(controllerMemoKey("ctl", "jev-latest", 0.7, 0.9, 30_000, "h1")).not.toBe(controllerMemoKey(...base))
    expect(controllerMemoKey("ctl", "jev-latest", 0.7, 0.5, 60_000, "h1")).not.toBe(controllerMemoKey(...base))
    expect(controllerMemoKey("other", "jev-latest", 0.7, 0.5, 30_000, "h1")).not.toBe(controllerMemoKey(...base))
    expect(controllerMemoKey("ctl", "jev-latest", 0.7, 0.5, 30_000, "h2")).not.toBe(controllerMemoKey(...base))
  })
})

test("JevAction union stays in sync with the question criteria", () => {
  const actions: JevAction[] = ["click", "type", "scroll", "key", "wait", "done"]
  const q = buildControllerQuestions([])
  expect(Object.keys(q?.action.criteria ?? {}).sort()).toEqual([...actions].sort())
})

// hardcode-guard:allow the range values are the enumerable input under test
describe("sampleWithinCap", () => {
  test("returns every item unchanged at or under the cap", () => {
    expect(sampleWithinCap(["a", "b", "c"], 5)).toEqual(["a", "b", "c"])
  })

  test("keeps the first and the last item, spanning the whole range at the cap", () => {
    const items = Array.from({ length: 163 }, (_, i) => `ctrl-${i}`)
    const picked = sampleWithinCap(items, CONTROLS_MAX)
    expect(picked.length).toBe(CONTROLS_MAX)
    expect(picked[0]).toBe("ctrl-0")
    expect(picked[picked.length - 1]).toBe("ctrl-162")
  })

  test("a goal target past the prefix region is still selected", () => {
    const items = Array.from({ length: 163 }, (_, i) => `ctrl-${i}`)
    const picked = sampleWithinCap(items, CONTROLS_MAX)
    // the selection reaches past a 60-wide leading prefix — not narrowed to it
    expect(picked.indexOf("ctrl-85")).toBeGreaterThan(-1)
    expect(picked.filter((item) => item !== undefined).length).toBeGreaterThan(CONTROLS_MAX / 2)
  })
})

// hardcode-guard:allow the frontier literals are the enumerable input under test
describe("choice set completeness — options == eyes world", () => {
  const dense = Array.from({ length: 159 }, (_, i) => `c${i + 1} AXButton control-${i}`)

  test("offers EVERY frontier label past the old 60 cap; a position-150 target is selectable", () => {
    const q = buildControllerQuestions(dense)
    const keys = Object.keys(q?.target.criteria ?? {}).filter((key) => key !== "none")
    // all 159 offered, in order — nothing at positions 61+ is dropped
    expect(keys.length).toBe(159)
    expect(keys).toEqual(dense.map((label, i) => `${i}:${label}`))
    // the label at position 150 is a live choice criterion
    expect(keys[150]).toBe(`150:${dense[150]}`)
    expect(keys.some((key) => key.includes("control-158"))).toBe(true)
  })

  test("no production path still slices the choice set to CONTROLS_MAX", () => {
    const oversize = Array.from({ length: CONTROLS_MAX + 50 }, (_, i) => `x${i}`)
    const q = buildControllerQuestions(oversize)
    // CONTROLS_MAX(60)+50 options survive, plus the `none` sentinel
    expect(Object.keys(q?.target.criteria ?? {}).length).toBe(CONTROLS_MAX + 50 + 1)
  })

  test("the decider's hard max is aligned with the eyes' frontier bound", () => {
    expect(CHOICE_HARD_MAX).toBe(FRONTIER_HARD_MAX)
  })

  test("the state context stays bounded and valid on the dense screen", () => {
    const state = buildState({
      goal: "reach the last control",
      map: { goal: "reach the last control", start: "n0", current: "n1", frontier: dense, path: ["n0", "n1"] },
    })
    expect(state.length).toBeLessThanOrEqual(4000)
    expect(() => JSON.parse(state)).not.toThrow()
  })
})
