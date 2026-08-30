import { describe, expect, test } from "bun:test"
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

const base = { created: 1, location: { directory: "/repo" } }

const seedEvents = (id: string) => [
  {
    ...base,
    id: `a_${id}`,
    type: "session.input.admitted" as const,
    data: {
      sessionID: "ses_1",
      inputID: id,
      input: { type: "user" as const, delivery: "steer" as const, data: { text: "hi" } },
    },
  },
  { ...base, id: `p_${id}`, type: "session.input.promoted" as const, data: { sessionID: "ses_1", inputID: id } },
  {
    ...base,
    id: `s_${id}`,
    type: "session.step.started" as const,
    data: { sessionID: "ses_1", assistantMessageID: id, agent: "build", model: { id: "m", providerID: "p" } },
  },
  {
    ...base,
    id: `ts_${id}`,
    type: "session.text.started" as const,
    data: { sessionID: "ses_1", assistantMessageID: id, ordinal: 0 },
  },
  {
    ...base,
    id: `td_${id}`,
    type: "session.text.delta" as const,
    data: { sessionID: "ses_1", assistantMessageID: id, ordinal: 0, delta: "x" },
  },
  {
    ...base,
    id: `te_${id}`,
    type: "session.text.ended" as const,
    data: { sessionID: "ses_1", assistantMessageID: id, ordinal: 0, text: "x" },
  },
  {
    ...base,
    id: `sd_${id}`,
    type: "session.step.ended" as const,
    data: {
      sessionID: "ses_1",
      assistantMessageID: id,
      finish: "stop" as const,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  },
]

const buildLiveEvents = (id: string) => [
  {
    ...base,
    id: `lts_${id}`,
    type: "session.text.started" as const,
    data: { sessionID: "ses_1", assistantMessageID: id, ordinal: 0 },
  },
  {
    ...base,
    id: `lte_${id}`,
    type: "session.text.ended" as const,
    data: { sessionID: "ses_1", assistantMessageID: id, ordinal: 0, text: "answer" },
  },
  {
    ...base,
    id: `lts_${id}_1`,
    type: "session.tool.input.started" as const,
    data: { sessionID: "ses_1", assistantMessageID: id, callID: "c1", name: "bash" },
  },
  {
    ...base,
    id: `ltc_${id}`,
    type: "session.tool.called" as const,
    data: { sessionID: "ses_1", assistantMessageID: id, callID: "c1", input: {}, executed: true },
  },
  {
    ...base,
    id: `ltsx_${id}`,
    type: "session.tool.success" as const,
    data: {
      sessionID: "ses_1",
      assistantMessageID: id,
      callID: "c1",
      metadata: {},
      content: [{ type: "text" as const, text: "ok" }],
      executed: true,
    },
  },
  {
    ...base,
    id: `lse_${id}`,
    type: "session.step.ended" as const,
    data: {
      sessionID: "ses_1",
      assistantMessageID: id,
      finish: "stop" as const,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  },
]

describe("applyV2 end-to-end cost across a realistic turn", () => {
  for (const PRIOR_TURNS of [50, 200, 500, 1000]) {
    test(`one text+tool turn, with ${PRIOR_TURNS} prior user/assistant turns`, () => {
      const client = {
        session: {
          get: async () => ({ data: session("ses_1") }),
          messages: async () => ({ data: [] }),
          diff: async () => ({ data: [] }),
          todo: async () => ({ data: [] }),
        },
      } as unknown as OpencodeClient
      const store = createServerSession(client)
      store.remember(session("ses_1"))

      for (let i = 0; i < PRIOR_TURNS; i++) for (const e of seedEvents(`a_${i}`)) store.applyV2(e as never)

      // Warm up applyV2
      for (const e of buildLiveEvents("a_warm")) store.applyV2(e as never)

      const before = performance.now()
      const COUNT = 30
      for (let i = 0; i < COUNT; i++) {
        for (const e of buildLiveEvents(`a_live_${i}`)) store.applyV2(e as never)
      }
      const after = performance.now()

      const liveEvents = buildLiveEvents("a_live_0")
      const perEventUs = ((after - before) / (COUNT * liveEvents.length)) * 1000
      console.log(
        `applyV2 per non-delta event @ ${PRIOR_TURNS} prior turns: ${perEventUs.toFixed(2)}us (${COUNT} turns x ${liveEvents.length} events = ${(after - before).toFixed(1)}ms, ${
          store.data.session_message.ses_1?.length ?? 0
        } messages)`,
      )

      const lastAssistant = [...(store.data.session_message.ses_1 ?? [])].reverse().find((m) => m.type === "assistant")
      expect(lastAssistant?.content?.length).toBeGreaterThan(0)
    })
  }
})
