import { describe, expect, test } from "bun:test"
import { foldJevAccept, jevAccept } from "../../src/jev/accept"

const acceptRow = (strength: number) => ({ choice: "accept", probabilities: { accept: strength } })
const refireRow = (strength: number) => ({ choice: "refire", probabilities: { refire: strength } })

describe("foldJevAccept", () => {
  test("accepts on measured noul pass + measured accept choice", () => {
    const d = foldJevAccept({ gate_ok: { noul: 0.95 }, verdict: acceptRow(0.9) }, 0.7)
    expect(d.accept).toBe(true)
    expect(d.measured).toBe(true)
    expect(d.noul).toBe(0.95)
    expect(d.choice).toBe("accept")
  })

  test("noul below threshold rejects (prefilter) even with a passing choice", () => {
    const d = foldJevAccept({ gate_ok: { noul: 0.3 }, verdict: acceptRow(0.95) }, 0.7)
    expect(d.accept).toBe(false)
    expect(d.measured).toBe(true)
  })

  test("measured refire choice rejects despite a passing noul", () => {
    const d = foldJevAccept({ gate_ok: { noul: 0.95 }, verdict: refireRow(0.9) }, 0.7)
    expect(d.accept).toBe(false)
    expect(d.measured).toBe(true)
    expect(d.choice).toBe("refire")
  })

  test("choice-only verdict decides when the noul row is absent", () => {
    const d = foldJevAccept({ verdict: acceptRow(0.9) }, 0.7)
    expect(d.accept).toBe(true)
    expect(d.measured).toBe(true)
    expect(d.noul).toBeUndefined()
  })

  test("noul-only pass accepts, noul-only miss rejects", () => {
    expect(foldJevAccept({ gate_ok: { noul: 0.9 } }, 0.7).accept).toBe(true)
    expect(foldJevAccept({ gate_ok: { noul: 0.5 } }, 0.7).accept).toBe(false)
  })

  test("fails open (measured:false) when both rows are unmeasured", () => {
    const d = foldJevAccept({ gate_ok: { noul: "high" }, verdict: { choice: "accept" } }, 0.7)
    expect(d.accept).toBe(false)
    expect(d.measured).toBe(false)
  })
})

describe("jevAccept transport", () => {
  test("retries a flaky endpoint (SDK parity) and folds the verdict", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++
        return hits < 2
          ? new Response("boom", { status: 500 })
          : Response.json({
              answers: { gate_ok: { noul: 0.95 }, verdict: { choice: "accept", probabilities: { accept: 0.9 } } },
            })
      },
    })
    try {
      const d = await jevAccept({
        key: "test-key",
        gate: "all tests pass",
        result: "3/3 green, typecheck clean",
        transport: { endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, id: "jev-latest" },
      })
      expect(d.accept).toBe(true)
      expect(d.measured).toBe(true)
      expect(hits).toBe(2)
    } finally {
      server.stop(true)
    }
  })

  test("fails open measured:false on a persistently failing endpoint", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) })
    try {
      const d = await jevAccept({
        key: "test-key",
        gate: "g",
        result: "r",
        transport: { endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, id: "jev-latest" },
      })
      expect(d.measured).toBe(false)
      expect(d.accept).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})
