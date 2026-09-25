import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Git } from "../../src/git"

describe("Git.memo", () => {
  test("reuses one fetch for repeated keys inside the TTL", async () => {
    const spawns = { count: 0 }
    const load = Git.memo<number>(1000)
    const fetch = () => Effect.sync(() => ++spawns.count)
    const first = await Effect.runPromise(load("/repo", fetch))
    const second = await Effect.runPromise(load("/repo", fetch))
    expect(spawns.count).toBe(1)
    expect(second).toBe(first)
  })

  test("refetches once the TTL has elapsed", async () => {
    const clock = { at: 0 }
    const spawns = { count: 0 }
    const load = Git.memo<number>(1500, () => clock.at)
    const fetch = () => Effect.sync(() => ++spawns.count)
    await Effect.runPromise(load("/repo", fetch))
    clock.at += 1600
    const second = await Effect.runPromise(load("/repo", fetch))
    expect(spawns.count).toBe(2)
    expect(second).toBe(2)
  })

  test("keys fetch independently", async () => {
    const spawns = { count: 0 }
    const load = Git.memo<number>(1000)
    const fetch = () => Effect.sync(() => ++spawns.count)
    await Effect.runPromise(load("/repo-a", fetch))
    await Effect.runPromise(load("/repo-b", fetch))
    await Effect.runPromise(load("/repo-a", fetch))
    expect(spawns.count).toBe(2)
  })
})
