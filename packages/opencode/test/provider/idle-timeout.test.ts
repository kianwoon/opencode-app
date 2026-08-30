import { describe, expect, test } from "bun:test"
import { DEFAULT_IDLE_TIMEOUT, resolveIdleTimeouts } from "@/provider/provider"

describe("resolveIdleTimeouts", () => {
  test("defaults both phases to DEFAULT_IDLE_TIMEOUT when nothing is configured", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({})
    expect(chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(headerMs).toBe(DEFAULT_IDLE_TIMEOUT)
  })

  test("timeout: false disables both phases entirely", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ timeout: false })
    expect(chunkMs).toBeUndefined()
    expect(headerMs).toBeUndefined()
  })

  test("chunkTimeout: false disables only the chunk-gap guard", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ chunkTimeout: false })
    expect(chunkMs).toBeUndefined()
    expect(headerMs).toBe(DEFAULT_IDLE_TIMEOUT)
  })

  test("headerTimeout: false disables only the headers guard", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ headerTimeout: false })
    expect(chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(headerMs).toBeUndefined()
  })

  test("explicit timeout applies to both phases", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ timeout: 60_000 })
    expect(chunkMs).toBe(60_000)
    expect(headerMs).toBe(60_000)
  })

  test("explicit phase timeouts win over timeout for their phase", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({
      timeout: 60_000,
      chunkTimeout: 10_000,
      headerTimeout: 20_000,
    })
    expect(chunkMs).toBe(10_000)
    expect(headerMs).toBe(20_000)
  })

  test("string timeout is coerced", () => {
    const { chunkMs, headerMs } = resolveIdleTimeouts({ timeout: "45000" })
    expect(chunkMs).toBe(45_000)
    expect(headerMs).toBe(45_000)
  })

  test("non-positive and empty string timeouts fall through to the default", () => {
    expect(resolveIdleTimeouts({ timeout: 0 }).chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(resolveIdleTimeouts({ timeout: -1 }).chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(resolveIdleTimeouts({ timeout: "" }).chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
    expect(resolveIdleTimeouts({ timeout: "abc" }).chunkMs).toBe(DEFAULT_IDLE_TIMEOUT)
  })
})
