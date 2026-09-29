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
      "Effective tool permissions — generated from config; the config-derived lower bound, not a ceiling: runtime session approvals (approved) may additionally allow. See Permission.evaluate (ruleset + approved) for the verdict on any call.",
      "Dead and duplicate layers are resolved away; where entries still overlap, the LAST matching rule wins.",
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
  expect(lines.at(-1)).toBe("... 10 more rules omitted (most-recent tail dropped)")
})

test("fmtPermissions keeps both allows when the later rule is narrower", () => {
  const manifest = fmtPermissions([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "echo *", action: "allow" },
  ])
  const lines: string[] = manifest?.split("\n") ?? []
  // 2 lines after the header pair: the broad allow is NOT dead, because the
  // later "echo *" glob does not match the literal pattern "*" (findLast can
  // still select the broad allow for any non-echo command).
  expect(lines.slice(2)).toEqual([`- bash "*": allow`, `- bash "echo *": allow`])
  expect(manifest).toContain(`- bash "echo *": allow`)
})
