// baseline-guard:dump new test — no prior artifact; pins the settings→tools model flow.
import { describe, expect, test } from "bun:test"
import { Document, Info } from "@opencode/schema/config"
import { jevToolCall } from "../src/jev/tool-model"
import { toAskInput } from "../src/tool/jev-ask"
import { toAcceptInput } from "../src/tool/jev-accept"
import { toRankInput } from "../src/tool/jev-rank"
import { toLabelInput } from "../src/tool/jev-label"
import { toControllerInput } from "../src/tool/jev-decide"

const CONFIGURED = "openrouter/perplexity/pplx-decider-flash-v1.2"

const entries = (info: Record<string, unknown>) => [
  new Document({ type: "document", info: new Info(info as never) }),
]

/** Records the provider namespace each key read asks for. */
const keyFor = (asked: string[]) => (provider: string) => {
  asked.push(provider)
  return `${provider}-key`
}

describe("jevToolCall — the five tools read the model the user set", () => {
  test("configured openrouter spec becomes the outgoing wire model, with an openrouter key", () => {
    const asked: string[] = []
    const call = jevToolCall(entries({ jev: { model: CONFIGURED } }), keyFor(asked))

    // `body.model` on every decisions request is `transport.id`.
    expect(call.transport?.id).toBe("perplexity/pplx-decider-flash-v1.2")
    expect(call.transport?.endpoint).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(call.model).toBe(CONFIGURED)
    // Credential namespace follows the transport, never a fixed typesafe key.
    expect(call.key).toBe("openrouter-key")
    expect(asked).toEqual(["openrouter"])
  })

  test("unset config preserves the typesafe/jev-latest fallback", () => {
    const asked: string[] = []
    const call = jevToolCall([], keyFor(asked))

    expect(call.model).toBe("typesafe/jev-latest")
    expect(call.transport?.endpoint).toBe("https://api.typesafe.ai/v1/systemone")
    expect(call.transport?.id).toBe("jev-latest")
    // resolveJevModel probes the default provider first, then the transport key read.
    expect(new Set(asked)).toEqual(new Set(["typesafe"]))
  })

  test("jevDefault supplies the model when the jev block omits one, and jev.model wins over it", () => {
    const shared = jevToolCall(entries({ jevDefault: { model: CONFIGURED } }), () => "k")
    expect(shared.model).toBe(CONFIGURED)
    expect(shared.transport?.id).toBe("perplexity/pplx-decider-flash-v1.2")

    const winning = jevToolCall(
      entries({ jev: { model: "typesafe/jev-latest" }, jevDefault: { model: CONFIGURED } }),
      () => "k",
    )
    expect(winning.model).toBe("typesafe/jev-latest")
    expect(winning.transport?.endpoint).toBe("https://api.typesafe.ai/v1/systemone")
  })
})

describe("tool call sites pass the configured model into the request chain", () => {
  const call = jevToolCall(entries({ jev: { model: CONFIGURED } }), () => "k")

  test("jev_ask", () => {
    const input = toAskInput(
      { goal: "g", questions: [{ id: "q", type: "noul", instructions: "i" }] } as never,
      "k",
      call.transport,
      call.model,
    )
    expect(input.model).toBe(CONFIGURED)
    expect(input.transport?.id).toBe("perplexity/pplx-decider-flash-v1.2")
  })

  test("jev_accept", () => {
    expect(toAcceptInput({ gate: "g", result: "r" } as never, "k", call.model).model).toBe(CONFIGURED)
  })

  test("jev_rank", () => {
    expect(toRankInput({ question: "q", candidates: ["a"] } as never, "k", call.model).model).toBe(CONFIGURED)
  })

  test("jev_label", () => {
    expect(toLabelInput({ snapshot: "s" } as never, "k", call.model).model).toBe(CONFIGURED)
  })

  test("jev_decide", () => {
    expect(toControllerInput({ goal: "g", controls: [] } as never, "k", call.model).model).toBe(CONFIGURED)
  })
})
