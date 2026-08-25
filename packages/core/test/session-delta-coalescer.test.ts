import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createDeltaCoalescer, DELTA_COALESCE_MAX_AGE_MS } from "@opencode-ai/core/session/delta-coalescer"

const harness = (options?: { now?: () => number; maxAgeMs?: number; maxParts?: number }) => {
  const published: Array<{ key: string; fragment: string }> = []
  const coalescer = createDeltaCoalescer<string>({
    publish: (key, fragment) =>
      Effect.sync(() => {
        published.push({ key, fragment })
      }),
    ...options,
  })
  return { published, coalescer }
}

describe("delta coalescer", () => {
  test("buffers same-key fragments and publishes one merged delta on flush", async () => {
    const { published, coalescer } = harness()
    await Effect.runPromise(coalescer.append("a", "he"))
    await Effect.runPromise(coalescer.append("a", "ll"))
    await Effect.runPromise(coalescer.append("a", "o"))
    expect(published).toEqual([])
    await Effect.runPromise(coalescer.flush)
    expect(published).toEqual([{ key: "a", fragment: "hello" }])
  })

  test("keeps distinct stream targets separate and flushes in insertion order", async () => {
    const { published, coalescer } = harness()
    await Effect.runPromise(coalescer.append("text|1", "a"))
    await Effect.runPromise(coalescer.append("reasoning|1", "b"))
    await Effect.runPromise(coalescer.append("text|1", "c"))
    await Effect.runPromise(coalescer.flush)
    expect(published).toEqual([
      { key: "text|1", fragment: "ac" },
      { key: "reasoning|1", fragment: "b" },
    ])
  })

  test("flushes by age from the first buffered fragment", async () => {
    let clock = 1_000
    const { published, coalescer } = harness({ now: () => clock })
    await Effect.runPromise(coalescer.append("a", "one"))
    clock += 5
    await Effect.runPromise(coalescer.append("a", "two"))
    expect(published).toEqual([])
    clock += DELTA_COALESCE_MAX_AGE_MS
    await Effect.runPromise(coalescer.append("b", "three"))
    expect(published).toEqual([{ key: "a", fragment: "onetwo" }])
    expect((await Effect.runPromise(coalescer.flush), published.at(-1))).toEqual({ key: "b", fragment: "three" })
  })

  test("flushes pending deltas ahead of a guarded publish", async () => {
    const { published, coalescer } = harness()
    await Effect.runPromise(coalescer.append("a", "frag"))
    const order: string[] = []
    await Effect.runPromise(
      coalescer.publishGuarded(() =>
        Effect.sync(() => {
          order.push("boundary")
        }),
      ),
    )
    expect(published).toEqual([{ key: "a", fragment: "frag" }])
    expect(order).toEqual(["boundary"])
  })

  test("bounds memory by part count", async () => {
    const { published, coalescer } = harness({ maxParts: 3 })
    await Effect.runPromise(coalescer.append("a", "1"))
    await Effect.runPromise(coalescer.append("b", "2"))
    await Effect.runPromise(coalescer.append("c", "3"))
    expect(published).toEqual([
      { key: "a", fragment: "1" },
      { key: "b", fragment: "2" },
      { key: "c", fragment: "3" },
    ])
    await Effect.runPromise(coalescer.append("d", "4"))
    await Effect.runPromise(coalescer.flush)
    expect(published.at(-1)).toEqual({ key: "d", fragment: "4" })
  })

  test("flush is idempotent when empty", async () => {
    const { published, coalescer } = harness()
    await Effect.runPromise(coalescer.flush)
    expect(published).toEqual([])
  })
})
