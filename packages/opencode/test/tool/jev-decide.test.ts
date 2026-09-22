import { describe, expect, test } from "bun:test"
import {
  formatDecision,
  formatUnavailable,
  toControlLabels,
  toControllerInput,
  toLastAction,
} from "@/tool/jev-decide"
import { CONTROLS_MAX, LABEL_MAX } from "@/jev/controller"

describe("toControlLabels caps", () => {
  test("clips to CONTROLS_MAX preserving order", () => {
    const controls = Array.from({ length: CONTROLS_MAX + 10 }, (_, i) => ({
      id: `${i}`,
      action: "click",
      label: `label-${i}`,
    }))
    const labels = toControlLabels(controls)
    expect(labels.length).toBe(CONTROLS_MAX)
    expect(labels[0].startsWith("0 click label-0")).toBe(true)
  })

  test("clips each label to LABEL_MAX", () => {
    const labels = toControlLabels([{ id: "12", action: "click", label: "x".repeat(200) }])
    expect(labels[0].length).toBeLessThanOrEqual(LABEL_MAX)
  })
})

describe("toLastAction", () => {
  test("keeps last 10 recent entries", () => {
    const recent = Array.from({ length: 15 }, (_, i) => `action-${i}`)
    const last = toLastAction(undefined, recent)
    expect(last).toBe(recent.slice(-10).join(" | "))
  })

  test("returns undefined when empty", () => {
    expect(toLastAction(undefined, undefined)).toBeUndefined()
  })
})

describe("toControllerInput mapping", () => {
  test("maps goal, controls, state, recent into ControllerInput", () => {
    const input = toControllerInput(
      {
        goal: "open settings",
        controls: [{ id: "3", action: "click", label: "Settings" }],
        state: "http://x | title",
        recent: ["clicked home"],
      },
      "key-123",
    )
    expect(input.goal).toBe("open settings")
    expect(input.controls).toEqual(["3 click Settings"])
    expect(input.key).toBe("key-123")
    expect(input.lastAction).toContain("http://x")
    expect(input.lastAction).toContain("clicked home")
  })
})

describe("decision output shaping", () => {
  test("formatDecision titles jev: click [12]", () => {
    const { title, output } = formatDecision({
      action: "click",
      target: "12",
      success: true,
      stuck: false,
      needScreenshot: false,
      strength: 0.9,
    })
    expect(title).toBe("jev: click [12]")
    expect(output).toContain("click")
    expect(output).toContain("12")
  })

  test("formatUnavailable is fail-open null shape", () => {
    const { output } = formatUnavailable()
    expect(output).toBe(JSON.stringify({ decision: null, reason: "unavailable" }))
  })
})
