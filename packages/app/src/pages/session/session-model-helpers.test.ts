import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { resetSessionModel, restorePromptModel, syncPromptModel, syncSessionModel } from "./session-model-helpers"

const message = (input?: { agent?: string; model?: UserMessage["model"] }) =>
  ({
    id: "msg",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: input?.agent ?? "build",
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
  }) as UserMessage

describe("syncSessionModel", () => {
  test("restores the last message through session state", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    )

    expect(calls).toEqual([
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    ])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})

describe("syncPromptModel", () => {
  test("stores the effective session model in prompt state", () => {
    const calls: unknown[] = []

    syncPromptModel(
      {
        model: {
          current: () => ({ id: "claude-sonnet-4", provider: { id: "anthropic" } }),
          set() {},
          variant: { current: () => "high", set() {} },
        },
      },
      {
        model: {
          current: () => undefined,
          set: (model) => calls.push(model),
        },
      },
    )

    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }])
  })

  test("does not rewrite an unchanged prompt model", () => {
    const calls: unknown[] = []
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }

    syncPromptModel(
      {
        model: {
          current: () => ({ id: model.modelID, provider: { id: model.providerID } }),
          set() {},
          variant: { current: () => model.variant, set() {} },
        },
      },
      {
        model: {
          current: () => model,
          set: (value) => calls.push(value),
        },
      },
    )

    expect(calls).toEqual([])
  })
})

describe("restorePromptModel", () => {
  test("restores the persisted prompt model when no session model is set", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => undefined,
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "anthropic", modelID: "claude", variant: "high" }),
          set() {},
        },
      },
    )

    expect(restored).toBe(true)
    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude" }, "high"])
  })

  test("does not clobber a session model that is already set with a stale prompt model", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => ({ id: "muse-spark-1.3-contributor", provider: { id: "opencode-go" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash", variant: null }),
          set() {},
        },
      },
    )

    expect(restored).toBe(true)
    expect(calls).toEqual([])
  })

  test("does nothing without a persisted prompt model", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => undefined,
          set() {},
        },
      },
    )

    expect(restored).toBe(false)
    expect(calls).toEqual([])
  })
})
