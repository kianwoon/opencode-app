import { describe, expect, test } from "bun:test"
import { defaultSettings, fontColor, messageFontFamily, monoFontFamily, sansFontFamily, terminalFontFamily, weightFamilyNames } from "./settings"

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

describe("message appearance settings", () => {
  test("defaults preserve the current look", () => {
    expect(defaultSettings.appearance.messageAlign).toBe("right")
    expect(defaultSettings.appearance.messageBorderWidth).toBe(0)
    expect(defaultSettings.appearance.messageBorderColorLight).toBe("")
    expect(defaultSettings.appearance.messageBorderColorDark).toBe("")
    expect(defaultSettings.appearance.messageBackgroundLight).toBe("")
    expect(defaultSettings.appearance.messageBackgroundDark).toBe("")
    expect(defaultSettings.appearance.userMessageTextColorLight).toBe("")
    expect(defaultSettings.appearance.userMessageTextColorDark).toBe("")
    expect(defaultSettings.appearance.userMessageFont).toBe("")
    expect(defaultSettings.appearance.userMessageFontWeight).toBe(400)
  })

  test("user message font falls back to the shared message stack when unset", () => {
    expect(messageFontFamily(defaultSettings.appearance.userMessageFont, defaultSettings.appearance.userMessageFontWeight)).toBe(
      "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
    )
  })

  test("user message font builds a weighted stack when set", () => {
    expect(messageFontFamily("Inter", 600)).toBe(
      '"Inter SemiBold", "Inter Semi-Bold", "Inter DemiBold", "Inter Semibold", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    )
  })

  test("empty border and background colors emit no override", () => {
    expect(fontColor(defaultSettings.appearance.messageBorderColorLight, defaultSettings.appearance.messageBorderColorDark)).toBe("")
    expect(fontColor(defaultSettings.appearance.messageBackgroundLight, defaultSettings.appearance.messageBackgroundDark)).toBe("")
    expect(
      fontColor(defaultSettings.appearance.userMessageTextColorLight, defaultSettings.appearance.userMessageTextColorDark),
    ).toBe("")
  })

  test("border and background colors resolve per color scheme", () => {
    expect(fontColor("#ff0000", "#00ff00")).toBe("light-dark(#ff0000, #00ff00)")
  })

  test("user message text color is decoupled from the message font color", () => {
    expect(fontColor("#123456", "")).toBe("#123456")
    expect(fontColor(defaultSettings.appearance.messageFontColorLight, defaultSettings.appearance.messageFontColorDark)).toBe(
      "",
    )
    expect(defaultSettings.appearance.messageFontColorLight).toBe("")
    expect(defaultSettings.appearance.userMessageTextColorLight).toBe("")
    expect(fontColor("#123456", defaultSettings.appearance.messageFontColorDark)).toBe("#123456")
  })
})
