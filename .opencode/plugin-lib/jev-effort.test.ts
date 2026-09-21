import { describe, expect, test } from "bun:test"
import { jevTransport, resolveJevEffortConfig, DEFAULT_JEV_EFFORT } from "./jev-effort.ts"

describe("jevTransport", () => {
  test("typesafe/jev-1.13 -> SystemOne + wire id jev-latest", () => {
    expect(jevTransport("typesafe/jev-1.13")).toEqual({
      provider: "typesafe",
      id: "jev-latest",
      endpoint: "https://api.typesafe.ai/v1/systemone",
    })
  })

  test("typesafe/jev-1.13.0 stays, jev-latest stays", () => {
    expect(jevTransport("typesafe/jev-1.13.0")?.id).toBe("jev-1.13.0")
    expect(jevTransport("typesafe/jev-latest")?.id).toBe("jev-latest")
    expect(jevTransport("typesafe/unknown-thing")?.id).toBe("jev-latest")
  })

  test("openrouter/x -> decisions URL, id verbatim", () => {
    expect(jevTransport("openrouter/meta/llama")).toEqual({
      provider: "openrouter",
      id: "meta/llama",
      endpoint: "https://openrouter.ai/api/alpha/decisions",
    })
  })

  test("unknown provider -> undefined (fail-open)", () => {
    expect(jevTransport("acme/foo")).toBeUndefined()
    expect(jevTransport("noslash")).toBeUndefined()
    expect(jevTransport("typesafe/")).toBeUndefined()
  })

  test("a typesafe spec never resolves to openrouter.ai", () => {
    expect(jevTransport("typesafe/jev-1.13")?.endpoint).not.toContain("openrouter")
  })
})

describe("resolveJevEffortConfig", () => {
  test("malformed -> defaults", () => {
    expect(resolveJevEffortConfig(undefined)).toEqual(DEFAULT_JEV_EFFORT)
  })

  test("explicit model preserved", () => {
    expect(resolveJevEffortConfig({ enabled: true, model: "openrouter/x", threshold: 0.7 }).model).toBe("openrouter/x")
  })
})
