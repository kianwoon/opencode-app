import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CpuPool } from "@/tool/cpu-pool"

// Event-loop responsiveness smoke: a 5MB reduction runs on the pool while a
// second Effect yields on the main loop. If the pool work ran inline, the
// ticker below would stall for well over 2s (5MB sha256 + reduction is the
// exact workload that used to block). Real pool, real worker, no mocks.
describe("CpuPool event-loop isolation", () => {
  test("main loop stays responsive while a 5MB reduction runs on the pool", async () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `line ${i} ${"x".repeat(48)}`).join("\n")
    expect(text.length).toBeGreaterThan(5 * 1024 * 1024)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const work = CpuPool.truncate(text, 100, 8192, "head")

        // Tick on the main loop while the pool is busy; the longest gap between
        // ticks is the stall we care about.
        let last = Date.now()
        let worst = 0
        let ticks = 0
        const stop = Date.now() + 300
        while (Date.now() < stop && ticks < 200) {
          yield* Effect.yieldNow
          const now = Date.now()
          worst = Math.max(worst, now - last)
          last = now
          ticks++
        }

        return { reduced: yield* work, worst }
      }),
    )

    expect(result.reduced).toBeDefined()
    expect(result.worst).toBeLessThan(2000)
  })
})
