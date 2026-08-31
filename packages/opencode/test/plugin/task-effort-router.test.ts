import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { TaskEffortRouterPlugin } from "../../../../.opencode/plugin-lib/task-effort-router"

const hooks = (await (TaskEffortRouterPlugin as (input: unknown) => Promise<Hooks>)({
  project: { id: "test" },
})) as Hooks

function text(result: unknown): string {
  return typeof result === "string" ? result : (result as { output: string }).output
}

function model(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "test-model",
    providerID: "test",
    api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
    },
    ...overrides,
  }
}

const chatParamsInput = (overrides: Record<string, unknown> = {}) => ({
  sessionID: "ses_test",
  agent: "build",
  model: model(),
  provider: { source: "api" as const, info: {}, options: {} },
  message: {
    id: "msg_1",
    sessionID: "ses_test",
    role: "user" as const,
    time: { created: 0 },
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
  },
  ...overrides,
})

async function requestEffort(sessionID: string, args: { level?: "medium" | "high"; reason: string }) {
  const def = hooks.tool?.request_effort
  if (!def) throw new Error("request_effort tool is not registered")
  return text(
    await def.execute(args as never, {
      sessionID,
      messageID: "msg_1",
      agent: "build",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }),
  )
}

/** Reset per-session governor state between tests. */
async function resetState(sessionID = "ses_test") {
  await hooks["chat.message"]?.({ sessionID }, { message: {} as never, parts: [] })
}

describe("task effort router", () => {
  test("chat.params is a no-op before any escalation", async () => {
    await resetState()
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: { reasoningEffort: "low" },
    }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "low" })
  })

  test("chat.params is a no-op when chat.message was never called", async () => {
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: { reasoningEffort: "low" },
    }
    await hooks["chat.params"]?.({ ...chatParamsInput(), sessionID: "ses_never" } as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "low" })
  })

  test("escalating merges the requested tier's variant options", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "medium", reason: "architecture change needs deeper analysis" })
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: { reasoningEffort: "low" },
    }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "medium" })
  })

  test("escalation is monotonic and capped per task", async () => {
    await resetState()
    const first = await requestEffort("ses_test", { level: "medium", reason: "harder than expected" })
    expect(first).toContain("raised to medium")
    const second = await requestEffort("ses_test", { level: "high", reason: "still stuck" })
    expect(second).toContain("raised to high")
    const third = await requestEffort("ses_test", { level: "high", reason: "one more" })
    expect(third).toContain("already at high")
    expect(third).not.toContain("raised to")
  })

  test("chat.message resets effort to baseline on a new task", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "high", reason: "deep debugging" })
    await resetState()
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({})
  })

  test("assesses complex tasks to a medium baseline", async () => {
    await hooks["chat.message"]?.(
      { sessionID: "ses_test" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            id: "p1",
            sessionID: "ses_test",
            messageID: "msg_1",
            text: "Refactor the provider module and redesign the session loop across the codebase",
          },
        ] as never,
      },
    )
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "medium" })
  })

  test("assesses complex + risky tasks to a high baseline and pushes a risk notice", async () => {
    await hooks["chat.message"]?.(
      { sessionID: "ses_test" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            id: "p1",
            sessionID: "ses_test",
            messageID: "msg_1",
            text: "Migrate the auth database schema and redesign the permission model",
          },
        ] as never,
      },
    )
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "high" })

    const system = { system: ["base"] }
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_test", model: model() } as never,
      system as never,
    )
    expect(system.system[2]).toContain("Task risk notice")
  })

  test("minimal baseline applies the model's cheapest shipped tier", async () => {
    await hooks["chat.message"]?.(
      { sessionID: "ses_test" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            id: "p1",
            sessionID: "ses_test",
            messageID: "msg_1",
            text: "fix typo in comment",
          },
        ] as never,
      },
    )
    // The model ships low/medium/high and has no `minimal` tier. The governor
    // still expresses its "run cheap" opinion by applying the cheapest tier
    // the model does ship, instead of deferring to the provider default.
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "low" })
  })

  test("request_effort above an assessed baseline still escalates", async () => {
    await hooks["chat.message"]?.(
      { sessionID: "ses_test" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            id: "p1",
            sessionID: "ses_test",
            messageID: "msg_1",
            text: "Refactor the provider module and redesign the session loop across the codebase",
          },
        ] as never,
      },
    )
    const first = await requestEffort("ses_test", { level: "high", reason: "bigger than it looked" })
    expect(first).toContain("raised to high")

    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "high" })
  })

  test("never lowers a user-pinned higher effort", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "medium", reason: "escalate" })
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: { reasoningEffort: "high" },
    }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "high" })
  })

  test("detects user-pinned effort expressed as a thinking budget", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "medium", reason: "escalate" })
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: { thinkingBudget: 32000 },
    }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ thinkingBudget: 32000 })
  })

  test("skips models that do not ship the requested tier", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "high", reason: "escalate" })
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: { reasoningEffort: "low" },
    }
    await hooks["chat.params"]?.(
      chatParamsInput({ model: model({ variants: { low: { reasoningEffort: "low" } } }) }) as never,
      output as never,
    )
    expect(output.options).toEqual({ reasoningEffort: "low" })
  })

  test("glm-shaped model (low/high/max): simple baseline applies the cheapest shipped tier", async () => {
    await hooks["chat.message"]?.(
      { sessionID: "ses_test" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            id: "p1",
            sessionID: "ses_test",
            messageID: "msg_1",
            text: "fix typo in comment",
          },
        ] as never,
      },
    )
    const glm = model({
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      },
    })
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput({ model: glm }) as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "low" })
  })

  test("glm-shaped model (low/high/max): medium escalation resolves up to high", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "medium", reason: "harder than expected" })
    const glm = model({
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      },
    })
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput({ model: glm }) as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "high" })
  })

  test("minimal baseline never lowers a user-pinned effort on a glm-shaped model", async () => {
    await hooks["chat.message"]?.(
      { sessionID: "ses_test" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            id: "p1",
            sessionID: "ses_test",
            messageID: "msg_1",
            text: "fix typo in comment",
          },
        ] as never,
      },
    )
    const glm = model({
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      },
    })
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: { reasoningEffort: "high" } }
    await hooks["chat.params"]?.(chatParamsInput({ model: glm }) as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "high" })
  })

  test("skips non-reasoning models", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "high", reason: "escalate" })
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: { foo: "bar" } }
    const base = model()
    const caps = { ...(base.capabilities as Record<string, unknown>), reasoning: false }
    await hooks["chat.params"]?.(chatParamsInput({ model: model({ capabilities: caps }) }) as never, output as never)
    expect(output.options).toEqual({ foo: "bar" })
  })

  test("treats super tiers (xhigh/max) as high when pinning is detected", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "medium", reason: "escalate" })
    const output = {
      temperature: 0.7,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined,
      options: { reasoningEffort: "xhigh" },
    }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "xhigh" })
  })

  test("system transform advertises the governor only for models with variants", async () => {
    await resetState()
    const withVariants = { system: ["base prompt"] }
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_test", model: model() } as never,
      withVariants as never,
    )
    expect(withVariants.system.length).toBe(2)
    expect(withVariants.system[1]).toContain("request_effort")

    const withoutVariants = { system: ["base prompt"] }
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_test", model: model({ variants: undefined }) } as never,
      withoutVariants as never,
    )
    expect(withoutVariants.system).toEqual(["base prompt"])
  })

  test("requesting the same or lower level is a no-op", async () => {
    await resetState()
    await requestEffort("ses_test", { level: "high", reason: "jump straight up" })
    const again = await requestEffort("ses_test", { level: "medium", reason: "regress request" })
    expect(again).toContain("already at high")
  })
})
