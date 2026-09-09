import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createRefreshQueue", () => {
  test("clears queued directories by normalized key", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")
    queue.clear("C:/tmp/demo")

    await tick()

    expect(calls).toEqual([])
    queue.dispose()
  })

  test("passes the original directory to bootstrapInstance", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")

    await tick()

    expect(calls).toEqual(["C:\\tmp\\demo"])
    queue.dispose()
  })

  test("hung directory does not starve other directories", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        if (directory === "slow") return new Promise<void>(() => {})
        calls.push(directory)
      },
      timeoutMs: 20,
    })

    queue.push("slow")
    queue.push("fast")

    await tick()
    await tick()
    await tick()
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(calls).toEqual(["fast"])
    queue.dispose()
  })

  test("hung root bootstrap does not stall the queue", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: () => new Promise<void>(() => {}),
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
      timeoutMs: 20,
    })

    queue.refresh()
    queue.push("fast")

    await tick()
    await tick()
    await tick()
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(calls).toEqual(["fast"])
    queue.dispose()
  })
})
