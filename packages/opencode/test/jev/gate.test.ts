import { afterEach, describe, expect, test } from "bun:test"
import { boosterAdvisory } from "@/jev/gate"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const answers = (row: unknown) =>
  (async () => new Response(JSON.stringify({ answers: { advice: row } }), { status: 200 })) as unknown as typeof fetch

describe("boosterAdvisory — require a MEASURED probabilities[choice]", () => {
  test("emits when the measured strength clears the threshold", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "verify", probabilities: { verify: 0.9, continue: 0.1 } })
    const text = await boosterAdvisory({ key: "k", state: "s", config: { enabled: true } })
    expect(text).toContain("verification")
  })

  test("emits NOTHING when probabilities[choice] is absent (no fabricated strength=1)", async () => {
    // The Critical-2 regression: `confidence` is confidence in the LABEL, not a
    // score. A confident `switch` label with no probability map must not emit.
    globalThis.fetch = answers({ type: "choice", choice: "switch", confidence: 0.99 })
    const text = await boosterAdvisory({ key: "k", state: "s", config: { enabled: true } })
    expect(text).toBeUndefined()
  })

  test("emits nothing for `continue` and sub-threshold rows", async () => {
    globalThis.fetch = answers({ type: "choice", choice: "continue", probabilities: { continue: 0.99 } })
    expect(await boosterAdvisory({ key: "k", state: "s", config: { enabled: true } })).toBeUndefined()
    globalThis.fetch = answers({ type: "choice", choice: "switch", probabilities: { switch: 0.2 } })
    expect(await boosterAdvisory({ key: "k", state: "s", config: { enabled: true } })).toBeUndefined()
  })
})
