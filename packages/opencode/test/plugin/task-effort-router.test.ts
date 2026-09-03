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

  test("a pin is a floor: complex task raises above a pinned low on glm-shaped models", async () => {
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
    // GLM ships low/high/max (no medium). Assessed medium + pinned low must
    // resolve UP to high, not collapse back down onto the pin.
    const glm = model({
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      },
    })
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: { reasoningEffort: "low" } }
    await hooks["chat.params"]?.(chatParamsInput({ model: glm }) as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "high" })
  })

  test("a pin is a floor: simple task never lowers a pinned low", async () => {
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
            text: "let's enhance it",
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
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: { reasoningEffort: "low" } }
    await hooks["chat.params"]?.(chatParamsInput({ model: glm }) as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "low" })
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

  test("short imperative prompts get a minimal baseline without any keyword", async () => {
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
            text: "let's enhance it",
          },
        ] as never,
      },
    )
    // No simple/complex/risky keyword fired, but the prompt is a ≤10-word
    // imperative with zero signal — start lean instead of deferring.
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "low" })
  })

  test("longer prompts without hints still defer to the provider default", async () => {
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
            text: "Please take a careful look at how the session loop currently schedules its work and summarize the control flow for me with a detailed explanation of each stage",
          },
        ] as never,
      },
    )
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput() as never, output as never)
    expect(output.options).toEqual({})
  })

  test("assess decisions are logged to the JSONL observability file", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "effort-log-"))
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir

    try {
      await hooks["chat.message"]?.(
        { sessionID: "ses_log" },
        {
          message: {} as never,
          parts: [
            {
              type: "text",
              id: "p1",
              sessionID: "ses_log",
              messageID: "msg_1",
              text: "fix typo in comment",
            },
          ] as never,
        },
      )
      const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
      await hooks["chat.params"]?.(
        chatParamsInput({ sessionID: "ses_log" }) as never,
        output as never,
      )
      // The append is fire-and-forget; poll the file into existence.
      const logPath = join(dir, "opencode", "effort-router.jsonl")
      let lines: string[] = []
      for (let i = 0; i < 50 && lines.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        const file = Bun.file(logPath)
        if (!(await file.exists())) continue
        lines = (await file.text()).trim().split("\n")
      }
      const assess = lines.map((line) => JSON.parse(line)).find((e) => e.event === "assess")
      expect(assess).toMatchObject({ sessionID: "ses_log", baseline: "minimal", risky: false })
      const apply = lines.map((line) => JSON.parse(line)).find((e) => e.event === "apply")
      expect(apply).toMatchObject({ sessionID: "ses_log", tier: "minimal", resolved: "down" })
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previous
    }
  })

  test("duplicate chat.message fires are deduped within the window", async () => {
    await resetState()
    const fire = () =>
      hooks["chat.message"]?.(
        { sessionID: "ses_dupe" },
        {
          message: {} as never,
          parts: [
            {
              type: "text",
              id: "p1",
              sessionID: "ses_dupe",
              messageID: "msg_1",
              text: "Refactor the provider module and redesign the session loop across the codebase",
            },
          ] as never,
        },
      )
    await fire()
    await fire()
    // The second identical fire must not reset governor state: escalation
    // granted before the duplicate still applies afterwards.
    const first = await requestEffort("ses_dupe", { level: "high", reason: "hard task" })
    await fire()
    expect(first).toContain("raised to high")
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput({ sessionID: "ses_dupe" }) as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "high" })
  })

  test("a genuinely new message after the dedup window re-assesses", async () => {
    await hooks["chat.message"]?.(
      { sessionID: "ses_new" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            id: "p1",
            sessionID: "ses_new",
            messageID: "msg_1",
            text: "fix typo in comment",
          },
        ] as never,
      },
    )
    // Different text = a new task boundary even within the window.
    await hooks["chat.message"]?.(
      { sessionID: "ses_new" },
      {
        message: {} as never,
        parts: [
          {
            type: "text",
            id: "p2",
            sessionID: "ses_new",
            messageID: "msg_2",
            text: "Refactor the provider module and redesign the session loop across the codebase",
          },
        ] as never,
      },
    )
    const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
    await hooks["chat.params"]?.(chatParamsInput({ sessionID: "ses_new" }) as never, output as never)
    expect(output.options).toEqual({ reasoningEffort: "medium" })
  })

  test("skip is logged once per task, not once per provider turn", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "effort-log-"))
    const previous = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir

    try {
      await hooks["chat.message"]?.(
        { sessionID: "ses_amp" },
        { message: {} as never, parts: [] as never },
      )
      const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
      // Three provider turns for the same task: only one skip line expected.
      for (let i = 0; i < 3; i++) {
        await hooks["chat.params"]?.(chatParamsInput({ sessionID: "ses_amp" }) as never, output as never)
      }
      const logPath = join(dir, "opencode", "effort-router.jsonl")
      let lines: string[] = []
      for (let i = 0; i < 50 && lines.length < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        const file = Bun.file(logPath)
        if (!(await file.exists())) continue
        lines = (await file.text()).trim().split("\n")
      }
      const skips = lines.map((line) => JSON.parse(line)).filter((e) => e.event === "skip")
      expect(skips).toHaveLength(1)
      expect(skips[0]).toMatchObject({ sessionID: "ses_amp", reason: "no-opinion" })
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previous
    }
  })

  test("empty and whitespace-only messages get no opinion", async () => {
    for (const text of ["", "   "]) {
      await hooks["chat.message"]?.(
        { sessionID: "ses_empty" },
        {
          message: {} as never,
          parts: [{ type: "text", id: "p1", sessionID: "ses_empty", messageID: "msg_1", text }] as never,
        },
      )
      const output = { temperature: 0.7, topP: 1, topK: 0, maxOutputTokens: undefined, options: {} }
      await hooks["chat.params"]?.(chatParamsInput({ sessionID: "ses_empty" }) as never, output as never)
      expect(output.options).toEqual({})
    }
  })
})
