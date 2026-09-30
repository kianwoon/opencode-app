import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { turnAdvancesWork } from "@/session/prompt"

const bash = (command: string): SessionV1.Part =>
  ({
    type: "tool",
    tool: "bash",
    state: { status: "completed", input: { command } },
  }) as unknown as SessionV1.Part

const todowrite = (): SessionV1.Part =>
  ({
    type: "tool",
    tool: "todowrite",
    state: { status: "completed", input: { todos: [] } },
  }) as unknown as SessionV1.Part

// The four-call block that recurs at T1, T7 and T12 in the live session.
const FOUR = [
  bash("git status --short"),
  bash("git log --oneline -5"),
  bash("ls packages/desktop/dist/mac-arm64"),
  bash("ps aux | grep -i opencode"),
]

const SEQUENCE: SessionV1.Part[][] = [
  FOUR, // T1 new work
  [bash("ls packages/desktop/dist"), bash("ls packages/desktop/dist/mac-arm64")], // T2 new work
  [todowrite()], // T3 bookkeeping only
  [todowrite()], // T4
  [bash("git status --short")], // T5
  [bash("git status --short")], // T6
  FOUR, // T7 every call already seen
  [todowrite()], // T8
  [todowrite()], // T9
  [todowrite()], // T10
  [todowrite()], // T11
  FOUR, // T12
  [bash("ls packages/desktop/dist"), bash("ls packages/desktop/dist/OpenCode.app/Contents/Resources")], // T13 new
  [bash("git status --short")], // T14
  [bash("git status --short")], // T15
  [todowrite()], // T16
]

describe("turnAdvancesWork", () => {
  test("an alternating cycle accumulates stalls and a novel call resets them", () => {
    const seen = new Set<string>()
    const stalls: number[] = []
    for (const parts of SEQUENCE) stalls.push(turnAdvancesWork(seen, parts) ? 0 : stalls.at(-1)! + 1)
    expect(stalls[4]).toBe(3)
    expect(stalls[7]).toBe(6)
    expect(stalls[11]).toBe(10)
    expect(stalls[12]).toBe(0)
    expect(stalls[15]).toBe(3)
  })

  test("todo churn never counts as work and key order does not change a signature", () => {
    const seen = new Set<string>()
    expect(turnAdvancesWork(seen, [todowrite(), todowrite(), todowrite()])).toBe(false)
    const a = {
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "ls", timeout: 10 } },
    } as unknown as SessionV1.Part
    const b = {
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { timeout: 10, command: "ls" } },
    } as unknown as SessionV1.Part
    expect(turnAdvancesWork(seen, [a])).toBe(true)
    expect(turnAdvancesWork(seen, [b])).toBe(false)
  })
})
