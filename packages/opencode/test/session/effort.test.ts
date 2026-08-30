import { describe, expect, test } from "bun:test"
import { assess } from "../../src/session/effort"

describe("Effort.assess", () => {
  test("routine VCS operations classify as light", () => {
    expect(assess("commit and push these changes").tier).toBe("light")
    expect(assess("git status").tier).toBe("light")
    expect(assess("fix a typo in the readme").tier).toBe("light")
    expect(assess("run the test suite").tier).toBe("light")
  })

  test("exploration and design prompts classify as deep", () => {
    expect(assess("investigate why the session hangs").tier).toBe("deep")
    expect(assess("refactor the authentication architecture").tier).toBe("deep")
    expect(assess("why does the stream stall on long responses?").tier).toBe("deep")
    expect(assess("debug the race condition in the scheduler").tier).toBe("deep")
  })

  test("breadth signals push toward deep", () => {
    expect(assess("rename the config keys across all files").tier).toBe("deep")
  })

  test("light signal offset by breadth lands on standard", () => {
    expect(assess("commit the changes across the repo").tier).toBe("standard")
    expect(assess("commit the changes across the codebase").tier).toBe("deep")
  })

  test("no signals default to standard", () => {
    const signal = assess("update the version number")
    expect(signal.tier).toBe("standard")
    expect(signal.reasons).toEqual(["no signals"])
  })

  test("reasons are explainable", () => {
    const signal = assess("commit and push")
    expect(signal.reasons.length).toBeGreaterThan(0)
    expect(signal.reasons[0]).toContain("light signal")
  })

  test("case-insensitive", () => {
    expect(assess("REFACTOR the module").tier).toBe("deep")
  })
})
