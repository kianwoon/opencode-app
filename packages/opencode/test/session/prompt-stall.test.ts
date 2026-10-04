import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { turnAdvancesWork, nextStall } from "@/session/prompt"

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

  // Regression (ses_f06df872, 2026-10-02): the same step persisted 3x because
  // two consecutive turns carrying an IDENTICAL batch rode the slow ladder and
  // only tripped the wrap-up several generations later.
  test("consecutive turns with an identical non-empty batch escalate at the first repeat", () => {
    const seen = new Set<string>()
    const batch = [bash("git status --short")]
    // T1 advances work, so there is no previous no-progress turn to match and
    // the escalation cannot fire on the first stall.
    const t1 = nextStall(seen, { repeatCount: 0, fingerprint: "" }, batch)
    expect(t1.repeatCount).toBe(0)
    expect(t1.identical).toBe(false)
    expect(t1.fingerprint).toBe("")
    // T2 is the first no-progress turn: its batch is new as a FINGERPRINT, so
    // it only establishes the baseline.
    const t2 = nextStall(seen, { repeatCount: t1.repeatCount, fingerprint: t1.fingerprint }, batch)
    expect(t2.repeatCount).toBe(1)
    expect(t2.identical).toBe(false)
    // T3 repeats T2's exact batch at repeatCount 2 — far below WARN=3, yet the
    // escalation already fires, so no third identical generation is burned.
    const t3 = nextStall(seen, { repeatCount: t2.repeatCount, fingerprint: t2.fingerprint }, batch)
    expect(t3.repeatCount).toBe(2)
    expect(t3.identical).toBe(true)
  })

  test("an alternating cycle and pure-text turns never take the fast lane", () => {
    const seen = new Set<string>()
    let state = { repeatCount: 0, fingerprint: "" }
    // Seed both batches as work so the A,B,A,B cycle below is genuinely stalled.
    for (const parts of [[bash("git status --short")], [bash("git log --oneline -5")]] as SessionV1.Part[][])
      state = { ...state, ...nextStall(seen, state, parts) }
    const first = nextStall(seen, state, [bash("git status --short")])
    expect(first.identical).toBe(false)
    const second = nextStall(seen, { repeatCount: first.repeatCount, fingerprint: first.fingerprint }, [
      bash("git log --oneline -5"),
    ])
    expect(second.identical).toBe(false)
    const third = nextStall(seen, { repeatCount: second.repeatCount, fingerprint: second.fingerprint }, [
      bash("git status --short"),
    ])
    expect(third.identical).toBe(false)
    expect(third.repeatCount).toBe(3)
    // A turn with no real tool call is transparent to the ladder: it neither
    // accumulates nor resets the count, and the fingerprint is untouched.
    const text = [{ type: "text", text: "still thinking" }] as unknown as SessionV1.Part
    const t1 = nextStall(seen, { repeatCount: 2, fingerprint: "seeded" }, [text])
    expect(t1.repeatCount).toBe(2)
    expect(t1.fingerprint).toBe("seeded")
    expect(t1.identical).toBe(false)
    // Transparency does not break tool-ladder accumulation: repeat, text,
    // repeat still reaches 2 stalls.
    const repeated = [bash("git status --short")]
    const before = nextStall(seen, { repeatCount: 0, fingerprint: "" }, repeated)
    const mid = nextStall(seen, { ...before }, [text])
    const after = nextStall(seen, { repeatCount: mid.repeatCount, fingerprint: mid.fingerprint }, repeated)
    expect(mid.repeatCount).toBe(before.repeatCount)
    expect(after.repeatCount).toBe(2)
  })

  test("a bookkeeping-only turn is transparent to the ladder", () => {
    const seen = new Set<string>()
    const out = nextStall(seen, { repeatCount: 4, fingerprint: "seeded" }, [todowrite()])
    expect(out.repeatCount).toBe(4)
    expect(out.fingerprint).toBe("seeded")
    expect(out.identical).toBe(false)
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
