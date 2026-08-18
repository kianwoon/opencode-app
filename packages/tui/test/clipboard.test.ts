import { expect, test } from "bun:test"
import { copyCommand, imageToolMissing } from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

test("reports missing image clipboard tools only on bare Linux", () => {
  expect(imageToolMissing("linux", false, () => false)).toBeTrue()
  expect(imageToolMissing("linux", false, (name) => name === "wl-paste")).toBeFalse()
  expect(imageToolMissing("linux", false, (name) => name === "xclip")).toBeFalse()
  expect(imageToolMissing("linux", true, () => false)).toBeFalse()
  expect(imageToolMissing("darwin", false, () => false)).toBeFalse()
  expect(imageToolMissing("win32", false, () => false)).toBeFalse()
})
