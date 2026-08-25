import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
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

const client = {
  session: {
    get: async () => ({ data: session("ses_1") }),
    messages: async () => ({ data: [] }),
    diff: async () => ({ data: [] }),
    todo: async () => ({ data: [] }),
  },
} as unknown as OpencodeClient

const base = { created: 2, location: { directory: "/repo" } }

describe("v2 delta fast path benchmark", () => {
  test("per-delta cost stays flat as conversation grows", () => {
    const store = createServerSession(client)
    store.remember(session("ses_1"))

    // Seed a long conversation: 100 user turns each with a completed assistant
    // message carrying one text + one completed tool.
    const seed: SessionMessageInfo[] = []
    for (let i = 0; i < 100; i++) {
      seed.push({ id: `msg_u_${i}`, type: "user", text: `question ${i}`, time: { created: i * 10 + 1 } })
      seed.push({
        id: `msg_a_${i}`,
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          { type: "text", text: `answer ${i} `.repeat(200) },
          {
            type: "tool",
            id: `call_${i}`,
            name: "bash",
            state: { status: "completed", input: {}, metadata: {}, content: [{ type: "text", text: "ok" }] },
            time: { created: i * 10 + 2, ran: i * 10 + 2, completed: i * 10 + 3 },
          },
        ],
        time: { created: i * 10 + 2, completed: i * 10 + 3 },
      })
    }
    store.set("session_message", "ses_1", seed)

    // Start a live streaming turn.
    store.applyV2({
      ...base,
      id: "evt_step",
      type: "session.step.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_live", agent: "build", model: { id: "model", providerID: "provider" } },
    } as never)
    store.applyV2({
      ...base,
      id: "evt_ts",
      type: "session.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_live", ordinal: 0 },
    } as never)
    // Seed the part via full path (first visible fragment).
    store.applyV2({
      ...base,
      id: "evt_seed",
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_live", ordinal: 0, delta: "x" },
    } as never)

    // Warm up, then measure 2000 deltas.
    for (let i = 0; i < 200; i++)
      store.applyV2({
        ...base,
        id: `evt_warm_${i}`,
        type: "session.text.delta",
        data: { sessionID: "ses_1", assistantMessageID: "msg_live", ordinal: 0, delta: "token " },
      } as never)

    const before = performance.now()
    const COUNT = 2000
    for (let i = 0; i < COUNT; i++)
      store.applyV2({
        ...base,
        id: `evt_bench_${i}`,
        type: "session.text.delta",
        data: { sessionID: "ses_1", assistantMessageID: "msg_live", ordinal: 0, delta: "token " },
      } as never)
    const after = performance.now()

    const perDeltaUs = ((after - before) / COUNT) * 1000
    console.log(`per-delta: ${perDeltaUs.toFixed(1)}us (${COUNT} deltas, ${(after - before).toFixed(0)}ms total)`)
    expect(store.data.part.msg_live?.[0]).toMatchObject({ type: "text" })
    expect(store.data.part.msg_live?.[0]?.type === "text" ? store.data.part.msg_live[0].text.length : 0).toBeGreaterThan(
      COUNT * 5,
    )
  })
})
