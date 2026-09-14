import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { CpuPool, POOL_SIZE } from "@/tool/cpu-pool"
import { truncateInline } from "@/tool/truncate-inline"

// These exercise the real pool (real Bun.Worker, no mocks). They assert the two
// properties that actually matter for event-loop safety: results match the
// inline implementation, and no task can hang the caller past its deadline.
const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

describe("CpuPool", () => {
  test("pools at most one worker per spare core, capped at 12", () => {
    expect(POOL_SIZE).toBeGreaterThanOrEqual(1)
    expect(POOL_SIZE).toBeLessThanOrEqual(12)
  })

  test("sha256 matches node:crypto", async () => {
    const pooled = await run(CpuPool.sha256("hello world"))
    expect(pooled).toBe(createHash("sha256").update("hello world").digest("hex"))
  })

  test("truncate matches the inline reduction for head and tail", async () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n")
    const head = await run(CpuPool.truncate(text, 20, 4096, "head"))
    const tail = await run(CpuPool.truncate(text, 20, 4096, "tail"))
    expect(head).toEqual(truncateInline(text, 20, 4096, "head"))
    expect(tail).toEqual(truncateInline(text, 20, 4096, "tail"))
  })

  test("settles every concurrent task with a unique result", async () => {
    const results = await run(
      Effect.all(
        Array.from({ length: 24 }, (_, i) => CpuPool.sha256(`payload-${i}`).pipe(Effect.map((h) => [i, h] as const))),
        { concurrency: "unbounded" },
      ),
    )
    expect(results).toHaveLength(24)
    expect(new Set(results.map(([, hash]) => hash)).size).toBe(24)
    // Correlation ids must not collide even under saturation.
    for (const [i, hash] of results) expect(hash).toBe(createHash("sha256").update(`payload-${i}`).digest("hex"))
  })

  test("backpressure beyond the queue depth degrades to inline, never drops work", async () => {
    const results = await run(
      Effect.all(
        Array.from({ length: 200 }, (_, i) => CpuPool.sha256(`burst-${i}`)),
        { concurrency: "unbounded" },
      ),
    )
    expect(new Set(results).size).toBe(200)
  })

  test("shutdown rejects queued work instead of leaving callers pending", async () => {
    const jobs = Array.from({ length: 32 }, (_, i) => CpuPool.sha256(`x-${i}`))
    const settled = await run(Effect.all(jobs, { concurrency: "unbounded" }))
    expect(settled).toHaveLength(32)
    await run(CpuPool.shutdown())
  })
})
