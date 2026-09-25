import { describe, expect, test } from "bun:test"
import { foldJevLabel, jevLabel, LABEL_OPTIONS } from "../../src/jev/label"

const labelAnswer = (choice: string, strength: number, noul: number) => ({
  choice,
  probabilities: { thrive: 0, stall: 0, bloat: 0, drift: 0, [choice]: strength },
  noul,
})

describe("foldJevLabel", () => {
  test("labels a measured valid choice at or above the threshold", () => {
    const answer = labelAnswer("thrive", 0.91, 0.88)
    const result = foldJevLabel(answer, LABEL_OPTIONS, 0.7)
    expect(result).toEqual({
      labeled: true,
      label: "thrive",
      measured: true,
      noul: 0.88,
      strength: 0.91,
      probabilities: answer.probabilities,
      options: LABEL_OPTIONS,
    })
  })

  test("keeps the measured label exposed below the threshold", () => {
    const result = foldJevLabel(labelAnswer("stall", 0.84, 0.42), LABEL_OPTIONS, 0.7)
    expect(result.labeled).toBe(false)
    expect(result.label).toBe("stall")
    expect(result.measured).toBe(true)
    expect(result.noul).toBe(0.42)
  })

  test("rejects a measured choice outside the supplied options", () => {
    const result = foldJevLabel(labelAnswer("focus", 0.93, 0.95), LABEL_OPTIONS, 0.7)
    expect(result.measured).toBe(true)
    expect(result.label).toBeNull()
    expect(result.labeled).toBe(false)
    expect(result.noul).toBe(0.95)
    expect(result.probabilities).toEqual({})
  })

  test("fails open on a malformed answer", () => {
    const result = foldJevLabel({ choice: "thrive" }, LABEL_OPTIONS, 0.7)
    expect(result.measured).toBe(false)
    expect(result.labeled).toBe(false)
    expect(result.label).toBeNull()
    expect(result.noul).toBeNull()
    expect(result.probabilities).toEqual({})
  })

  test("echoes the supplied options", () => {
    const options = ["thrive", "drift"] as const
    const result = foldJevLabel(undefined, options, 0.7)
    expect(result.options).toEqual(options)
  })

  test("uses a custom threshold for the labeled verdict", () => {
    const answer = labelAnswer("bloat", 0.82, 0.6)
    expect(foldJevLabel(answer, LABEL_OPTIONS, 0.7).labeled).toBe(false)
    expect(foldJevLabel(answer, LABEL_OPTIONS, 0.5).labeled).toBe(true)
  })
})

describe("jevLabel transport", () => {
  test("retries a flaky endpoint and folds the label", async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits++
        return hits < 2
          ? new Response("boom", { status: 500 })
          : Response.json({
              answers: {
                label: { choice: "thrive", probabilities: { thrive: 0.9, stall: 0.04, bloat: 0.03, drift: 0.03 } },
                noul: { noul: 0.85 },
              },
            })
      },
    })
    try {
      const result = await jevLabel({
        key: "test-key",
        snapshot: "tokens=12000 cost=0.42 prompts=8 duration=12m activity=steady progress=healthy",
        objective: "ship the parser",
        transport: { endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, id: "jev-latest" },
      })
      expect(result.labeled).toBe(true)
      expect(result.label).toBe("thrive")
      expect(hits).toBe(2)
    } finally {
      server.stop(true)
    }
  })

  test("requests a separate noul row alongside the label choice", async () => {
    const requests: unknown[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push(await request.json())
        return Response.json({
          answers: {
            label: { choice: "thrive", probabilities: { thrive: 0.9, stall: 0.04, bloat: 0.03, drift: 0.03 } },
            noul: { noul: 0.85 },
          },
        })
      },
    })
    try {
      const result = await jevLabel({
        key: "test-key",
        snapshot: "tokens=12000 cost=0.42 prompts=8 duration=12m activity=steady progress=healthy",
        transport: { endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, id: "jev-latest" },
      })
      const body = requests[0] as { questions?: Record<string, unknown> }
      expect(body.questions?.["noul"]).toEqual({ type: "noul", instructions: expect.any(String) })
      expect(result.measured).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("fails open unlabeled on a persistently failing endpoint", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) })
    try {
      const result = await jevLabel({
        key: "test-key",
        snapshot: "tokens=12000 cost=0.42 prompts=8 duration=12m activity=idle progress=none",
        transport: { endpoint: `http://127.0.0.1:${server.port}/v1/systemone`, id: "jev-latest" },
      })
      expect(result.labeled).toBe(false)
      expect(result.measured).toBe(false)
      expect(result.label).toBeNull()
    } finally {
      server.stop(true)
    }
  })
})
