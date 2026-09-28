import { describe, expect, test } from "bun:test"
import { foldJevRank, jevRank } from "../../src/jev/rank"

const scoreRow = (raw: number, max: number) => ({
  score: raw,
  legend: Object.fromEntries(Array.from({ length: max + 1 }, (_, i) => [`${i}`, `L${i}`])),
})

describe("foldJevRank", () => {
  test("normalizes by each row's own legend before ordering", () => {
    const d = foldJevRank({ "cand:0": scoreRow(3, 4), "cand:1": scoreRow(2, 2) }, ["a", "b"], 0.5)
    expect(d.ranked).toBe(true)
    expect(d.order).toEqual(["b", "a"])
    expect(d.ranks[0]).toEqual({ candidate: "b", rank: 1, score: 1 })
  })

  test("below-threshold rows fall to the unranked tail, never dropped", () => {
    const d = foldJevRank(
      { "cand:0": scoreRow(4, 4), "cand:1": scoreRow(1, 4), "cand:2": scoreRow(3, 4) },
      ["a", "b", "c"],
      0.5,
    )
    expect(d.ranked).toBe(true)
    expect(d.order).toEqual(["a", "c", "b"])
    expect(d.ranks.map((r) => r.candidate)).toEqual(["a", "c"])
  })

  test("ties keep input order", () => {
    const d = foldJevRank({ "cand:0": scoreRow(2, 2), "cand:1": scoreRow(2, 2) }, ["a", "b"], 0.5)
    expect(d.order).toEqual(["a", "b"])
  })

  test("fails open (ranked:false) when no row is measurable", () => {
    const d = foldJevRank({ "cand:0": { choice: "x" } }, ["a", "b"], 0.5)
    expect(d.ranked).toBe(false)
    expect(d.order).toEqual(["a", "b"])
    expect(d.ranks).toEqual([])
  })

  test("fewer than 2 candidates is unranked", () => {
    const d = foldJevRank({ "cand:0": scoreRow(2, 2) }, ["a"], 0.5)
    expect(d.ranked).toBe(false)
  })

  test("all rows below threshold is unranked, order intact", () => {
    const d = foldJevRank({ "cand:0": scoreRow(1, 4), "cand:1": scoreRow(1, 4) }, ["a", "b"], 0.5)
    expect(d.ranked).toBe(false)
    expect(d.order).toEqual(["a", "b"])
  })

  test("duplicate candidate ids keep both entries; the unscored twin survives the tail", () => {
    const d = foldJevRank({ "cand:0": scoreRow(3, 4), "cand:1": scoreRow(1, 4) }, ["a", "a"], 0.5)
    expect(d.ranked).toBe(true)
    expect(d.order.length).toBe(2)
    expect(d.order).toEqual(["a", "a"])
    expect(d.ranks.length).toBe(1)
  })
})

describe("jevRank transport", () => {
  test("retries a flaky endpoint (SDK parity) and folds the ranking", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++
        return hits < 2
          ? new Response("boom", { status: 500 })
          : Response.json({ answers: { "cand:0": scoreRow(1, 2), "cand:1": scoreRow(2, 2) } })
      },
    })
    try {
      const d = await jevRank({
        key: "test-key",
        question: "where is the transport client?",
        candidates: ["src/one.ts", "src/two.ts"],
        transport: { endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, id: "jev-latest" },
      })
      expect(d.ranked).toBe(true)
      expect(d.order).toEqual(["src/two.ts", "src/one.ts"])
      expect(hits).toBe(2)
    } finally {
      server.stop(true)
    }
  })

  test("fails open ranked:false on a persistently failing endpoint", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) })
    try {
      const d = await jevRank({
        key: "test-key",
        question: "q",
        candidates: ["a.ts", "b.ts"],
        transport: { endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, id: "jev-latest" },
      })
      expect(d.ranked).toBe(false)
      expect(d.order).toEqual(["a.ts", "b.ts"])
    } finally {
      server.stop(true)
    }
  })
})
