import { describe, expect, test } from "bun:test"
import { jevFetchRetry } from "../../src/jev/client"

const payload = () =>
  Response.json({ answers: { q1: { choice: "use", probabilities: { use: 0.9 } } } })

const init = () => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })

describe("jevFetchRetry — SDK-parity automatic retries", () => {
  test("retries 5xx then succeeds (3 attempts)", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++
        return hits < 3 ? new Response("boom", { status: 500 }) : payload()
      },
    })
    try {
      const res = await jevFetchRetry(`http://127.0.0.1:${server.port}/v1/systemone`, 2_000, init())
      expect(res?.ok).toBe(true)
      expect(hits).toBe(3)
    } finally {
      server.stop(true)
    }
  })

  test("returns undefined after exhausting retries on persistent 500", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++
        return new Response("boom", { status: 500 })
      },
    })
    try {
      const res = await jevFetchRetry(`http://127.0.0.1:${server.port}/v1/systemone`, 2_000, init())
      expect(res).toBeUndefined()
      expect(hits).toBe(3)
    } finally {
      server.stop(true)
    }
  })

  test("does not retry a deterministic 4xx", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++
        return new Response("nope", { status: 400 })
      },
    })
    try {
      const res = await jevFetchRetry(`http://127.0.0.1:${server.port}/v1/systemone`, 2_000, init())
      expect(res?.ok).toBe(false)
      expect(hits).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})
