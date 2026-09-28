import { expect, test } from "bun:test"
import { fmtPermissions } from "@/session/system"

test("fmtPermissions returns undefined for an empty ruleset", () => {
  expect(fmtPermissions([])).toBeUndefined()
})

test("fmtPermissions renders the effective ruleset in evaluation order", () => {
  const manifest = fmtPermissions([
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "echo *", action: "allow" },
    { permission: "bash", pattern: "*>*", action: "deny" },
  ])
  expect(manifest).toBe(
    [
      "Effective tool permissions — generated from config; the single source of truth for what you may do.",
      "The LAST matching rule wins; list order is semantic.",
      `- bash "*": deny`,
      `- bash "echo *": allow`,
      `- bash "*>*": deny`,
    ].join("\n"),
  )
})

test("fmtPermissions caps the rule list and reports the remainder", () => {
  const ruleset = Array.from({ length: 70 }, (_, index) => ({
    permission: "bash",
    pattern: `cmd ${index} *`,
    action: "allow" as const,
  }))
  const lines: string[] = fmtPermissions(ruleset)?.split("\n") ?? []
  expect(lines.filter((line) => line.startsWith("- ")).length).toBe(60)
  expect(lines.at(-1)).toBe("... 10 more rules omitted")
})
