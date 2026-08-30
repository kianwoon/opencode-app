import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

const session = (id: string): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title: id,
  version: "1",
  parentID: undefined,
  time: { created: 1, updated: 1 },
})

function setup(sessions: Record<string, Session>) {
  const client = {
    session: {
      get: async (input: unknown) => {
        const id = (input as { sessionID: string }).sessionID
        return { data: sessions[id] }
      },
      messages: async () => ({ data: [] }),
      diff: async () => ({ data: [] }),
      todo: async () => ({ data: [] }),
    },
  } as unknown as OpencodeClient
  return { store: createServerSession(client) }
}

const base = { created: 2, location: { directory: "/repo" } }

const stepStarted = (assistantMessageID: string) => ({
  ...base,
  id: `evt_step_${assistantMessageID}`,
  type: "session.step.started",
  data: { sessionID: "ses_1", assistantMessageID, agent: "build", model: { id: "model", providerID: "provider" } },
})

const textDelta = (assistantMessageID: string, ordinal: number, delta: string) => ({
  ...base,
  id: `evt_text_delta_${delta}`,
  type: "session.text.delta",
  data: { sessionID: "ses_1", assistantMessageID, ordinal, delta },
})

const toolInputDelta = (assistantMessageID: string, callID: string, delta: string) => ({
  ...base,
  id: `evt_tool_delta_${callID}_${delta}`,
  type: "session.tool.input.delta",
  data: { sessionID: "ses_1", assistantMessageID, callID, delta },
})

describe("server session v2 delta fast path", () => {
  test("streams text deltas into fold state and legacy part in place", () => {
    const ctx = setup({ ses_1: session("ses_1") })
    ctx.store.remember(session("ses_1"))
    ctx.store.set("session_message", "ses_1", [{ id: "msg_user", type: "user", text: "hello", time: { created: 1 } }])
    const apply = (input: object) => ctx.store.applyV2(input as OpenCodeEvent)

    apply(stepStarted("msg_a"))
    apply({
      ...base,
      id: "evt_text_start",
      type: "session.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 },
    })
    // First visible fragment falls back to the full path (normalize drops empty text parts).
    apply(textDelta("msg_a", 0, "wor"))

    const foldBefore = ctx.store.data.session_message.ses_1!
    const partListBefore = ctx.store.data.part.msg_a!
    const partBefore = partListBefore[0]!
    const userBefore = foldBefore[0]!
    const assistantBefore = foldBefore[1]!

    apply(textDelta("msg_a", 0, "ld"))

    expect(ctx.store.data.session_message.ses_1![1]).toMatchObject({
      id: "msg_a",
      type: "assistant",
      content: [{ type: "text", text: "world" }],
    })
    expect(ctx.store.data.part.msg_a![0]).toMatchObject({ type: "text", text: "world" })
    // No structural churn: array and untouched object identities are stable,
    // and only the streamed part's text changed.
    expect(ctx.store.data.session_message.ses_1).toBe(foldBefore)
    expect(ctx.store.data.session_message.ses_1![0]).toBe(userBefore)
    expect(ctx.store.data.session_message.ses_1![1]).toBe(assistantBefore)
    expect(ctx.store.data.part.msg_a).toBe(partListBefore)
    expect(ctx.store.data.part.msg_a![0]).toBe(partBefore)
  })

  test("streams tool input deltas as pending state with raw input", () => {
    const ctx = setup({ ses_1: session("ses_1") })
    ctx.store.remember(session("ses_1"))
    ctx.store.set("session_message", "ses_1", [{ id: "msg_user", type: "user", text: "hello", time: { created: 1 } }])
    const apply = (input: object) => ctx.store.applyV2(input as OpenCodeEvent)

    apply(stepStarted("msg_a"))
    apply({
      ...base,
      id: "evt_tool_start",
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", callID: "call_1", name: "bash" },
    })
    // The tool part exists from input.started (no empty-text filtering), so
    // even the first delta takes the fast path.
    apply(toolInputDelta("msg_a", "call_1", '{"comm'))

    expect(ctx.store.data.part.msg_a![0]).toMatchObject({
      type: "tool",
      callID: "call_1",
      state: { status: "pending", raw: '{"comm' },
    })

    apply(toolInputDelta("msg_a", "call_1", 'and":"ls"}'))

    expect(ctx.store.data.part.msg_a![0]).toMatchObject({
      state: { status: "pending", raw: '{"command":"ls"}', input: { command: "ls" } },
    })
    expect(ctx.store.data.session_message.ses_1![1]).toMatchObject({
      type: "assistant",
      content: [{ type: "tool", id: "call_1", state: { status: "streaming", input: '{"command":"ls"}' } }],
    })
  })

  test("falls back to the full path for unknown targets and stays consistent", () => {
    const ctx = setup({ ses_1: session("ses_1") })
    ctx.store.remember(session("ses_1"))
    ctx.store.set("session_message", "ses_1", [{ id: "msg_user", type: "user", text: "hello", time: { created: 1 } }])
    const apply = (input: object) => ctx.store.applyV2(input as OpenCodeEvent)

    // Delta for an assistant that was never seen: reducer ignores it; nothing crashes.
    apply(textDelta("msg_missing", 0, "ignored"))
    expect(ctx.store.data.session_message.ses_1!.length).toBe(1)
    expect(ctx.store.data.part.msg_missing).toBeUndefined()

    // Structural event then delta: the index rebuild picks up new content.
    apply(stepStarted("msg_a"))
    apply({
      ...base,
      id: "evt_reasoning_start",
      type: "session.reasoning.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 },
    })
    apply({
      ...base,
      id: "evt_reasoning_delta_seed",
      type: "session.reasoning.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "think" },
    })
    expect(ctx.store.data.part.msg_a![0]).toMatchObject({ type: "reasoning", text: "think" })

    apply({
      ...base,
      id: "evt_reasoning_delta_more",
      type: "session.reasoning.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "ing" },
    })
    expect(ctx.store.data.part.msg_a![0]).toMatchObject({ type: "reasoning", text: "thinking" })
    expect(ctx.store.data.session_message.ses_1![1]).toMatchObject({
      content: [{ type: "reasoning", text: "thinking" }],
    })
  })

  test("structural events after fast-path deltas rebuild the index and stay correct", () => {
    const ctx = setup({ ses_1: session("ses_1") })
    ctx.store.remember(session("ses_1"))
    ctx.store.set("session_message", "ses_1", [{ id: "msg_user", type: "user", text: "hello", time: { created: 1 } }])
    const apply = (input: object) => ctx.store.applyV2(input as OpenCodeEvent)

    apply(stepStarted("msg_a"))
    apply({
      ...base,
      id: "evt_text_start",
      type: "session.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 },
    })
    apply(textDelta("msg_a", 0, "hello"))
    apply(textDelta("msg_a", 0, " world"))

    // Structural: tool input starts mid-turn; positions change.
    apply({
      ...base,
      id: "evt_tool_start",
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", callID: "call_9", name: "edit" },
    })
    apply(toolInputDelta("msg_a", "call_9", '{"path":"a.ts"}'))

    expect(ctx.store.data.part.msg_a!.map((part) => [part.type, part.id])).toEqual([
      ["tool", "call_9"],
      ["text", "msg_a:text:0"],
    ])
    expect(ctx.store.data.part.msg_a![0]).toMatchObject({
      state: { status: "pending", raw: '{"path":"a.ts"}', input: { path: "a.ts", filePath: "a.ts" } },
    })

    // Text delta after the structural change still lands on the right item.
    apply({
      ...base,
      id: "evt_text_start2",
      type: "session.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 1 },
    })
    apply(textDelta("msg_a", 1, "after"))
    expect(ctx.store.data.part.msg_a!.map((part) => [part.type, part.id, (part as { text?: string }).text])).toEqual([
      ["tool", "call_9", undefined],
      ["text", "msg_a:text:0", "hello world"],
      ["text", "msg_a:text:1", "after"],
    ])
  })
})
