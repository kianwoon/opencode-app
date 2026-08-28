import { describe, expect, test } from "bun:test"
import { verificationGate } from "../../src/session/verification"

const edit = (filePath?: string, status = "completed") => ({
  tool: "edit",
  state: { status, ...(filePath ? { input: { filePath } } : {}) },
})

describe("verification gate", () => {
  test("no mutation — never review", () => {
    const verdict = verificationGate({
      prompt: "delete the production database",
      tools: [{ tool: "read", state: { status: "completed" } }],
    })
    expect(verdict.review).toBe(false)
  })

  test("failed mutation alone does not trigger review", () => {
    const verdict = verificationGate({ prompt: "fix the bug", tools: [edit("/tmp/a.ts", "error")] })
    expect(verdict.review).toBe(false)
    expect(verdict.reason).toBe("no files were modified")
  })

  test("risk-sensitive path triggers review", () => {
    const verdict = verificationGate({
      prompt: "update the module",
      tools: [edit("/repo/src/auth/login.ts")],
    })
    expect(verdict.review).toBe(true)
    expect(verdict.reason).toContain('matched "auth"')
  })

  test("destructive prompt triggers review even on benign paths", () => {
    const verdict = verificationGate({
      prompt: "delete the unused helpers",
      tools: [edit("/repo/src/util.ts")],
    })
    expect(verdict.review).toBe(true)
    expect(verdict.reason).toContain("destructive")
  })

  test("breadth signals with many files trigger review", () => {
    const tools = Array.from({ length: 6 }, (_, i) => edit(`/repo/src/f${i}.ts`))
    const verdict = verificationGate({ prompt: "refactor the provider module", tools })
    expect(verdict.review).toBe(true)
    expect(verdict.reason).toContain("broad refactor")
  })

  test("routine single-file edit does not trigger review", () => {
    const verdict = verificationGate({ prompt: "add a log line", tools: [edit("/repo/src/app.ts")] })
    expect(verdict.review).toBe(false)
    expect(verdict.reason).toBe("routine mutation")
  })

  test("aborted mutations do not count as mutations", () => {
    const verdict = verificationGate({
      prompt: "delete everything",
      tools: [{ tool: "edit", state: { status: "aborted" } }],
    })
    expect(verdict.review).toBe(false)
  })
})
