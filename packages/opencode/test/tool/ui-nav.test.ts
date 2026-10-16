import { describe, expect, test } from "bun:test"
import { buildArgs, verdictFromRun } from "@/tool/ui-nav"

describe("ui-nav — argv and verdict passthrough", () => {
  test("builds the exact argv for a read verb", () => {
    expect(buildArgs({ verb: "sel", app: "System Settings", label: "General" })).toEqual([
      "sel",
      "System Settings",
      "General",
    ])
  })

  test("appends the press match index, then the window scope", () => {
    expect(
      buildArgs({ verb: "press", app: "System Settings", label: "Wallpaper", index: 1, window: "Settings" }),
    ).toEqual(["press", "System Settings", "Wallpaper", "1", "--window", "Settings"])
  })

  test("passes the sensor's JSON verdict through verbatim plus a summary", () => {
    const line = '{"effect":"confirmed","label":"General","selected":true}'
    const result = verdictFromRun(0, line, "")
    expect(result.output.startsWith(line)).toBe(true)
    expect(result.title).toBe("ui_nav: confirmed")
  })

  test("a non-zero exit is a typed error naming the exit", () => {
    const result = verdictFromRun(1, "", "usage: axnav")
    expect(JSON.parse(result.output)).toMatchObject({ effect: "error", kind: "nonzero_exit" })
  })

  test("empty stdout is a typed error, never a silent empty result", () => {
    const result = verdictFromRun(0, "", "")
    expect(JSON.parse(result.output)).toMatchObject({ effect: "error", kind: "empty_stdout" })
  })

  test("non-JSON stdout is a typed error carrying what came back", () => {
    const result = verdictFromRun(0, "not json", "")
    expect(JSON.parse(result.output)).toMatchObject({ effect: "error", kind: "non_json", raw: "not json" })
  })
})
