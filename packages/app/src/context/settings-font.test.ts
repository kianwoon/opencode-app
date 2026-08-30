import { describe, expect, test } from "bun:test"
import {
  fontColor,
  messageFontFamily,
  monoFontFamily,
  sansFontFamily,
  terminalFontFamily,
  weightFamilyNames,
} from "./settings"

describe("font family stack", () => {
  test("includes the weight-qualified family name ahead of the base family", () => {
    expect(monoFontFamily("IBM Plex Mono", 300)).toBe(
      '"IBM Plex Mono Light", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    )
  })

  test("emits multiple candidates for weights with ambiguous family names", () => {
    expect(weightFamilyNames("IBM Plex Mono", 600)).toEqual([
      "IBM Plex Mono SemiBold",
      "IBM Plex Mono Semi-Bold",
      "IBM Plex Mono DemiBold",
      "IBM Plex Mono Semibold",
    ])
  })

  test("keeps the base family only for regular weight", () => {
    expect(monoFontFamily("IBM Plex Mono", 400)).toBe(
      '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    )
  })

  test("does not weight-quality an empty family", () => {
    expect(weightFamilyNames("", 300)).toEqual([])
    expect(monoFontFamily("", 300)).toBe(
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    )
  })

  test("applies weights independently to each family", () => {
    expect(sansFontFamily("Inter", 700)).toBe(
      '"Inter Bold", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    )
    expect(terminalFontFamily("JetBrainsMono Nerd Font Mono", 500)).toBe(
      '"JetBrainsMono Nerd Font Mono Medium", "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    )
  })

  test("message font uses the sans stack", () => {
    expect(messageFontFamily("Inter", 700)).toBe(
      '"Inter Bold", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    )
    expect(messageFontFamily("", 300)).toBe(
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    )
  })

  test("weight undefined keeps the plain stack", () => {
    expect(sansFontFamily("Inter")).toBe(
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    )
  })
})

describe("font color", () => {
  test("empty colors produce an empty override", () => {
    expect(fontColor("", "")).toBe("")
  })

  test("builds a light-dark value when both schemes are set", () => {
    expect(fontColor("#111111", "#eeeeee")).toBe("light-dark(#111111, #eeeeee)")
  })

  test("uses the single color for both schemes when only one is set", () => {
    expect(fontColor("#ff0000", "")).toBe("#ff0000")
  })
})
