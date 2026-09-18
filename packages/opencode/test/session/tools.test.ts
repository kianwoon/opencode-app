import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools, TOOL_EXECUTION_TIMEOUT_MS } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer, Schema, Cause, Duration, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
  limit: { context: 200_000, output: 32_000 },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
  dedup: () => Effect.void,
} satisfies Truncate.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
  Layer.succeed(Config.Service, TestConfig.make()),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed([
          {
            id: "timing",
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ metadata: { output: "first" } })
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
          {
            id: "hang",
            description: "never settles",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: () => Effect.never,
          } satisfies Tool.Def,
        ]),
    }),
  ),
)

const it = testEffect(layer)

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      mcpConfig: {},
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

it.effect("a tool whose execute never settles fails with the timeout error", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "hang",
      callID,
      state: { status: "running", input: {}, time: { start: 1 } },
    }
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          state.state = update(state).state
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      mcpConfig: {},
    })
    const execute = tools.hang.execute
    if (!execute) throw new Error("hang tool is missing execute")

    const outcome = yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    ).pipe(Effect.forkScoped)

    // The execute never settles; advancing the clock trips the execution ceiling.
    yield* TestClock.adjust(Duration.millis(TOOL_EXECUTION_TIMEOUT_MS))
    const exit = yield* Fiber.await(outcome)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.prettyErrors(exit.cause).join(" ")).toContain("timed out after 10 minutes")
    }
  }),
)

// Secret Broker Critical: a tool that throws must still route its error text
// through `tool.execute.after` so secrets in error messages are redacted, and
// the ORIGINAL error must still propagate (identity preserved).
const throwingRegistry = ToolRegistry.Service.of({
  ids: () => Effect.succeed(["boom"]),
  all: () => Effect.succeed([]),
  named: () => Effect.die("unused"),
  tools: () =>
    Effect.succeed([
      {
        id: "boom",
        description: "throws with a secret in the message",
        parameters: Schema.Struct({}),
        jsonSchema: { type: "object", properties: {} },
        execute: () => Effect.die(new Error("boom leaked sk-abcdefgh")),
      } satisfies Tool.Def,
    ]),
})

const redactingPlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (name, _input, output) => {
    if (name === "tool.execute.after" && isRecordLike(output) && typeof output.output === "string") {
      output.output = output.output.replaceAll("sk-abcdefgh", "secret://project/API_KEY")
    }
    return Effect.succeed(output)
  },
} satisfies Plugin.Interface)

function isRecordLike(value: unknown): value is { output?: unknown; title?: unknown } {
  return typeof value === "object" && value !== null
}

const errorPathLayer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, redactingPlugin),
  Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
  Layer.succeed(Config.Service, TestConfig.make()),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(ToolRegistry.Service, throwingRegistry),
)

const itErrorPath = testEffect(errorPathLayer)

itErrorPath.effect("redacts a thrown tool error and preserves the original error", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "boom",
      callID,
      state: { status: "running", input: {}, time: { start: 1 } },
    }
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID: string, update: (part: SessionV1.ToolPart) => SessionV1.ToolPart) =>
        Effect.sync(() => {
          state.state = update(state).state
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      mcpConfig: {},
    })
    const execute = tools.boom.execute
    if (!execute) throw new Error("boom tool is missing execute")

    // Capture the rejection value rather than letting Effect wrap it, so the
    // test asserts on the exact error message the model would receive.
    const failure = yield* Effect.promise(() =>
      execute({}, { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )

    expect(failure).toBeDefined()
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).not.toContain("sk-abcdefgh")
    expect(message).toContain("secret://project/API_KEY")
  }),
)

// Secret Broker: the MCP resource tool branches throw raw error text that must
// also be routed through `tool.execute.after` (redaction) before it reaches the
// model. Each branch is exercised with a canary secret in the thrown message.
const resourceCapableClient = { getServerCapabilities: () => ({ resources: {} }) } as never

function mcpLayer(overrides: Partial<MCP.Interface>) {
  return Layer.succeed(MCP.Service, MCP.Service.of({ ...fakeMcp(), ...overrides } as MCP.Interface))
}

function mcpErrorPathLayer(overrides: Partial<MCP.Interface>) {
  return Layer.mergeAll(
    Layer.succeed(Plugin.Service, redactingPlugin),
    Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
    Layer.succeed(Config.Service, TestConfig.make()),
    Layer.succeed(Permission.Service, fakePermission),
    mcpLayer(overrides),
    Layer.succeed(Truncate.Service, fakeTruncate),
    RuntimeFlags.layer(),
    Layer.succeed(ToolRegistry.Service, throwingRegistry),
  )
}

function mcpProcessor() {
  const state: SessionV1.ToolPart = {
    id: partID,
    sessionID,
    messageID,
    type: "tool",
    tool: "mcp",
    callID,
    state: { status: "running", input: {}, time: { start: 1 } },
  }
  return {
    message: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      agent: "build",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    } satisfies SessionV1.Assistant,
    updateToolCall: () => Effect.succeed(state),
    completeToolCall: () => Effect.void,
  } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
}

function mcpToolInput(name: string, overrides: Partial<MCP.Interface>) {
  return Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: mcpProcessor(),
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      mcpConfig: {},
    })
    const execute = tools[name]?.execute
    if (!execute) throw new Error(`${name} tool is missing execute`)
    return (args: Record<string, unknown>) =>
      Effect.promise(() =>
        execute(args, { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      )
  }).pipe(Effect.provide(mcpErrorPathLayer(overrides)))
}

function expectRedacted(failure: unknown) {
  expect(failure).toBeDefined()
  const message = failure instanceof Error ? failure.message : String(failure)
  expect(message).not.toContain("sk-abcdefgh")
  expect(message).toContain("secret://project/API_KEY")
}

it.effect("redacts a thrown list_mcp_resources error", () =>
  Effect.gen(function* () {
    const run = yield* mcpToolInput("list_mcp_resources", {
      clients: () => Effect.succeed({ srv: resourceCapableClient }),
      resources: () => Effect.die(new Error("list failed sk-abcdefgh")),
    })
    expectRedacted(yield* run({ server: "srv" }))
  }),
)

it.effect("redacts a thrown list_mcp_resource_templates error", () =>
  Effect.gen(function* () {
    const run = yield* mcpToolInput("list_mcp_resource_templates", {
      clients: () => Effect.succeed({ srv: resourceCapableClient }),
      resourceTemplates: () => Effect.die(new Error("templates failed sk-abcdefgh")),
    })
    expectRedacted(yield* run({ server: "srv" }))
  }),
)

it.effect("redacts a thrown read_mcp_resource error", () =>
  Effect.gen(function* () {
    const run = yield* mcpToolInput("read_mcp_resource", {
      clients: () => Effect.succeed({ srv: resourceCapableClient }),
      readResource: () => Effect.die(new Error("read failed sk-abcdefgh")),
    })
    expectRedacted(yield* run({ server: "srv", uri: "file:///x" }))
  }),
)

it.effect("surfaces snapshot_id and element tokens from structuredContent", () => {
  const mcpTool: MCP.McpTool = {
    def: { name: "snapshot", description: "cua", inputSchema: { type: "object", properties: {} } } as never,
    client: {
      callTool: async () => ({
        content: [{ type: "text", text: "62KB of accessibility text".repeat(50) }],
        structuredContent: {
          snapshot_id: "snap-123",
          elements: [
            { element_index: 7, element_token: "tok-abc", role: "button", label: "Submit" },
            { element_index: 8, element_token: "tok-def", role: "textfield", label: "Query" },
          ],
        },
      }),
    } as never,
  }
  return Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: mcpProcessor(),
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
      mcpConfig: {},
    })
    const execute = tools.mcp_srv_snapshot?.execute
    if (!execute) throw new Error("mcp_srv_snapshot tool is missing execute")
    const output = (yield* Effect.promise(() =>
      execute({}, { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] }),
    )) as { output: string }
    expect(output.output).toContain("[mcp-structured snapshot_id=snap-123]")
    expect(output.output).toContain("[7] token=tok-abc button Submit")
    expect(output.output).toContain("[8] token=tok-def textfield Query")
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Plugin.Service, fakePlugin),
        Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
        Layer.succeed(Config.Service, TestConfig.make()),
        Layer.succeed(Permission.Service, fakePermission),
        mcpLayer({ tools: () => Effect.succeed({ mcp_srv_snapshot: mcpTool }) }),
        Layer.succeed(Truncate.Service, fakeTruncate),
        RuntimeFlags.layer(),
        Layer.succeed(ToolRegistry.Service, throwingRegistry),
      ),
    ),
  )
})

it.effect("redacts a thrown MCP tool error (inline deferral branch)", () =>
  Effect.gen(function* () {
    const mcpTool: MCP.McpTool = {
      def: { name: "boom", description: "boom", inputSchema: { type: "object", properties: {} } } as never,
      client: {
        callTool: async () => {
          throw new Error("inline mcp failed sk-abcdefgh")
        },
      } as never,
    }
    const execute = yield* mcpToolInput("mcp_srv_boom", {
      clients: () => Effect.succeed({ srv: { getServerCapabilities: () => ({}) } as never }),
      tools: () => Effect.succeed({ mcp_srv_boom: mcpTool }),
    })
    expectRedacted(yield* execute({}))
  }),
)
