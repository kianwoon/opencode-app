import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent } from "@opencode-ai/llm"
import { RepetitionGuard } from "@/session/llm/repetition-guard"
import { MessageError } from "@/session/message-error"

const delta = (text: string) => LLMEvent.textDelta({ id: "block-1", text })

describe("session.llm.repetition-guard.detectRepetition", () => {
  test("returns undefined for normal text", () => {
    expect(
      RepetitionGuard.detectRepetition(
        "I will commit the changes. Let me check the diff first. The changes look good.",
      ),
    ).toBeUndefined()
  })

  test("returns undefined for short text", () => {
    expect(RepetitionGuard.detectRepetition("ok.")).toBeUndefined()
  })

  test("detects a degenerate repetition loop", () => {
    expect(RepetitionGuard.detectRepetition("Let me commit. Let me commit. Let me commit.")).toBe("Let me commit.")
  })

  test("detects repetition across more than one sentence", () => {
    expect(RepetitionGuard.detectRepetition("I need to finish. Let me commit. Let me commit. Let me commit.")).toBe(
      "Let me commit.",
    )
  })

  test("does not trigger for short repeated fragments", () => {
    expect(RepetitionGuard.detectRepetition("ok. ok. ok.")).toBeUndefined()
  })

  test("does not trigger when the same sentence appears non-consecutively", () => {
    expect(
      RepetitionGuard.detectRepetition("Let me commit. First check the diff. Let me commit. Then run tests."),
    ).toBeUndefined()
  })

  test("detects repetition with a custom threshold", () => {
    expect(
      RepetitionGuard.detectRepetition("commit. commit. commit. commit.", { minRepeats: 4, minSentenceLength: 3 }),
    ).toBe("commit.")
  })

  test("does not trigger below the custom threshold", () => {
    expect(
      RepetitionGuard.detectRepetition("commit. commit. commit.", { minRepeats: 4, minSentenceLength: 3 }),
    ).toBeUndefined()
  })
})

describe("session.llm.repetition-guard.Guard", () => {
  test("accumulates deltas and detects repetition as it arrives", () => {
    const guard = new RepetitionGuard.Guard()
    expect(guard.update("Let me commit. ")).toBeUndefined()
    expect(guard.update("Let me commit. ")).toBeUndefined()
    expect(guard.update("Let me commit.")).toBe("Let me commit.")
  })

  test("does not trigger on a finished reply that ends with repetition", () => {
    const guard = new RepetitionGuard.Guard()
    expect(guard.update("Done. All tests pass.")).toBeUndefined()
    expect(guard.update(" The commit is complete.")).toBeUndefined()
  })

  test("continues to signal the loop after detection (stream is aborted on first trigger)", () => {
    const guard = new RepetitionGuard.Guard()
    expect(guard.update("Let me commit. ")).toBeUndefined()
    expect(guard.update("Let me commit. ")).toBeUndefined()
    expect(guard.update("Let me commit.")).toBe("Let me commit.")
    // The stream is aborted on first trigger; the guard stays hot so a lagging
    // consumer never sees the loop as healthy again.
    expect(guard.update(" Moving on to the tests now.")).toBe("Let me commit.")
  })
})

describe("session.llm.repetition-guard.guardStream", () => {
  test("passes through non-degenerate events", async () => {
    const events: LLMEvent[] = [
      delta("Hello there. "),
      delta("How can I help you today?"),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    ]
    const stream: Stream.Stream<LLMEvent, never> = Stream.fromIterable(events)
    const collected = await Effect.runPromise(RepetitionGuard.guardStream(stream).pipe(Stream.runCollect))
    expect(collected.length).toBe(3)
  })

  test("fails the stream with RepetitionLoopError on a degenerate loop", async () => {
    const events: LLMEvent[] = [
      delta("Let me commit. "),
      delta("Let me commit. "),
      delta("Let me commit. "),
      delta("Let me commit. "),
    ]
    const stream: Stream.Stream<LLMEvent, never> = Stream.fromIterable(events)
    const exit = await Effect.runPromise(RepetitionGuard.guardStream(stream).pipe(Stream.runCollect).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(MessageError.RepetitionLoopError.isInstance(error)).toBe(true)
    }
  })
})
