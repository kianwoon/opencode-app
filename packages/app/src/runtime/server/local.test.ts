import { describe, expect, test } from "bun:test"
import { resolveAgentState } from "./local"
import { resolveSessionModel } from "./local"
import type { ModelKey } from "./local"

const glm: ModelKey = { providerID: "opencode-go", modelID: "glm-5.3-flash" }
const deepseek: ModelKey = { providerID: "opencode-go", modelID: "deepseek-v4-flash" }

const alwaysValid = () => true

describe("resolveSessionModel", () => {
  test("restore-recorded session model wins when explicit is unset (later restore cannot unpin a pick)", () => {
    // session.restore writes { agent, model, variant } without an `explicit`
    // flag; a session model recorded from the last message must stay
    // authoritative over the agent-configured model.
    expect(
      resolveSessionModel({ agent: "brain", model: deepseek, variant: null }, glm, undefined, alwaysValid)?.modelID,
    ).toBe("deepseek-v4-flash")
  })

  test("promote-via-snapshot preserves the picked model (no explicit flag in snapshot)", () => {
    // snapshot() returns { agent, model, variant } without `explicit`; after a
    // pick the recorded model must not revert to the agent-configured one.
    expect(
      resolveSessionModel({ agent: "brain", model: deepseek, variant: null }, glm, undefined, alwaysValid)?.modelID,
    ).toBe("deepseek-v4-flash")
  })

  test("an explicit user pick wins over the agent-configured model", () => {
    expect(
      resolveSessionModel({ agent: "brain", model: deepseek, variant: null, explicit: true }, glm, undefined, alwaysValid)
        ?.modelID,
    ).toBe("deepseek-v4-flash")
  })

  test("an agent switch (explicit false) adopts the agent-configured model", () => {
    expect(
      resolveSessionModel({ agent: "build", model: glm, variant: null, explicit: false }, glm, undefined, alwaysValid)
        ?.modelID,
    ).toBe("glm-5.3-flash")
    expect(
      resolveSessionModel({ agent: "build", model: deepseek, variant: null, explicit: false }, glm, undefined, alwaysValid)
        ?.modelID,
    ).toBe("glm-5.3-flash")
  })

  test("falls back to the agent model when the recorded model is not valid", () => {
    const valid = (model: ModelKey) => model.modelID === "glm-5.3-flash"
    expect(resolveSessionModel({ agent: "brain", model: deepseek, variant: null }, glm, undefined, valid)?.modelID).toBe(
      "glm-5.3-flash",
    )
  })
})

describe("resolveAgentState", () => {
  test("(a) re-selecting the SAME agent preserves an explicit model pick", () => {
    const state = { agent: "brain", model: deepseek, variant: "high", explicit: true } as const
    const next = resolveAgentState(state, "brain", { name: "brain", model: glm })
    expect(next.model).toEqual(deepseek)
    expect(next.variant).toBe("high")
    expect(next.explicit).toBe(true)
  })

  test("(a) same-agent re-click with no pick still adopts the agent model", () => {
    const state = { agent: "brain", model: deepseek, variant: null, explicit: false } as const
    const next = resolveAgentState(state, "brain", { name: "brain", model: glm })
    expect(next.model).toEqual(glm)
    expect(next.explicit).toBe(false)
  })

  test("(b) selecting a DIFFERENT agent adopts its configured model", () => {
    const state = { agent: "brain", model: deepseek, variant: null, explicit: true } as const
    const next = resolveAgentState(state, "brain", { name: "build", model: glm })
    expect(next.model).toEqual(glm)
    expect(next.explicit).toBe(false)
  })
})