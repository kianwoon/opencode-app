import { describe, expect, test } from "bun:test"
import {
  clampSessionPanelWidth,
  REVIEW_PANE_WIDTH_MIN,
  SESSION_PANEL_WIDTH_MIN,
  sessionPanelWidthMax,
} from "./session-panel-width"

describe("sessionPanelWidthMax", () => {
  test("reserves the review pane minimum", () => {
    expect(sessionPanelWidthMax({ available: 1700 })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
  })

  test("lets the review pane shrink to its minimum", () => {
    expect(REVIEW_PANE_WIDTH_MIN).toBe(100)
  })

  test("lets the chat panel take everything beyond the review pane minimum", () => {
    // Regression: the old cap was 45% of the window, forcing the review pane
    // to at least 55% of the window regardless of content.
    const available = 3440
    expect(sessionPanelWidthMax({ available })).toBeGreaterThan(available * 0.45)
  })

  test("never drops below the chat panel minimum on small windows", () => {
    expect(sessionPanelWidthMax({ available: 500 })).toBe(SESSION_PANEL_WIDTH_MIN)
    expect(sessionPanelWidthMax({ available: 0 })).toBe(SESSION_PANEL_WIDTH_MIN)
  })
})

describe("clampSessionPanelWidth", () => {
  test("keeps widths already within the limit", () => {
    expect(clampSessionPanelWidth({ width: 800, available: 1700 })).toBe(800)
  })

  test("forces the width down when the window shrinks", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 1700 })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
  })

  test("holds the chat panel minimum when there is no room for both", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 500 })).toBe(SESSION_PANEL_WIDTH_MIN)
  })

  test("skips clamping before the layout is measured", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: undefined })).toBe(1600)
  })
})
