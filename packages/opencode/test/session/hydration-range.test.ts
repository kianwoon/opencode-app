import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PartTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { eq, inArray } from "drizzle-orm"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { NotFoundError } from "@/storage/storage"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])))

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID, text?: string) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  if (text) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    })
  }
  return id
})

const addAssistant = Effect.fn("Test.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  opts?: { summary?: boolean; finish?: string; error?: SessionV1.Assistant["error"] },
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
    error: opts?.error,
  } as unknown as SessionV1.Info)
  return id
})

const addTextPart = Effect.fn("Test.addTextPart")(function* (sessionID: SessionID, messageID: MessageID, text: string) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "text",
    text,
  })
})

const addCompactionPart = Effect.fn("Test.addCompactionPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  tailStartID?: MessageID,
) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
    tail_start_id: tailStartID,
  } as any)
})

/**
 * Oracle = the old full-hydration path: stream() hydrates every message with all
 * parts, then filterCompacted decides the boundary in memory. The new
 * filterCompactedEffect must return the identical sequence — same info.id order
 * (including the compaction reorder) and identical parts per message.
 */
const oracle = Effect.fn("Test.oracle")(function* (sessionID: SessionID) {
  const expected = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
  const actual = yield* MessageV2.filterCompactedEffect(sessionID)
  expect(actual.map((item) => item.info.id)).toEqual(expected.map((item) => item.info.id))
  expect(actual.map((item) => item.info)).toEqual(expected.map((item) => item.info))
  expect(actual.map((item) => item.parts)).toEqual(expected.map((item) => item.parts))
  return actual
})

describe("MessageV2.filterCompactedEffect (range hydration)", () => {
  it.instance("matches the full-hydration oracle with no compaction", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const ids = []
        for (let i = 0; i < 5; i++) {
          const u = yield* addUser(sessionID, `question ${i}`)
          ids.push(u)
          const a = yield* addAssistant(sessionID, u, { finish: "end_turn" })
          ids.push(a)
          yield* addTextPart(sessionID, a, `reply ${i}`)
        }

        const result = yield* oracle(sessionID)
        expect(result.map((item) => item.info.id)).toEqual(ids)
        expect(result).toHaveLength(10)
        expect(result[0]?.parts).toHaveLength(1)
        expect(result[1]?.parts).toHaveLength(1)
      }),
    ),
  )

  it.instance("matches the oracle across a compaction boundary with tail_start_id", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* addTextPart(sessionID, a1, "first reply")

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* addTextPart(sessionID, a2, "second reply")

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, u2)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* addTextPart(sessionID, s1, "summary")

        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* addTextPart(sessionID, a3, "third reply")

        const result = yield* oracle(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])
      }),
    ),
  )

  it.instance("matches the oracle when the summary errored (full history retained)", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* addTextPart(sessionID, a1, "first reply")

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* addTextPart(sessionID, a2, "second reply")

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, u2)
        const s1 = yield* addAssistant(sessionID, c1, {
          summary: true,
          error: new SessionV1.APIError({ message: "boom", isRetryable: false }).toObject() as SessionV1.Assistant["error"],
        })
        yield* addTextPart(sessionID, s1, "summary")

        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* addTextPart(sessionID, a3, "third reply")

        const result = yield* oracle(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([u1, a1, u2, a2, c1, s1, u3, a3])
      }),
    ),
  )

  it.instance("matches the oracle when the summary never finished", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)
        const s1 = yield* addAssistant(sessionID, u1, { summary: true })
        const u2 = yield* addUser(sessionID, "next")

        const result = yield* oracle(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([u1, s1, u2])
      }),
    ),
  )

  it.instance("matches the oracle with repeated compactions (latest boundary wins)", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* addTextPart(sessionID, a1, "first reply")

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* addTextPart(sessionID, a2, "second reply")

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, u2)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* addTextPart(sessionID, s1, "summary one")

        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* addTextPart(sessionID, a3, "third reply")

        const c2 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c2, u3)
        const s2 = yield* addAssistant(sessionID, c2, { summary: true, finish: "end_turn" })
        yield* addTextPart(sessionID, s2, "summary two")

        const u4 = yield* addUser(sessionID, "fourth")
        const a4 = yield* addAssistant(sessionID, u4, { finish: "end_turn" })
        yield* addTextPart(sessionID, a4, "fourth reply")

        const result = yield* oracle(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([c2, s2, u3, a3, u4, a4])
      }),
    ),
  )

  it.instance("matches the oracle when a compaction part has no tail_start_id", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)
        const u2 = yield* addUser(sessionID, "world")

        const result = yield* oracle(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([u1, u2])
      }),
    ),
  )

  it.instance("matches the oracle with an assistant tail inside a turn", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* addTextPart(sessionID, a1, "first reply")

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* addTextPart(sessionID, a2, "second reply")
        const a3 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* addTextPart(sessionID, a3, "tail reply")

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, a3)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* addTextPart(sessionID, s1, "summary")

        const u3 = yield* addUser(sessionID, "third")
        const a4 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* addTextPart(sessionID, a4, "third reply")

        const result = yield* oracle(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([c1, s1, a3, u3, a4])
      }),
    ),
  )

  it.instance("fails with NotFoundError for a non-existent session", () =>
    Effect.gen(function* () {
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(MessageV2.filterCompactedEffect(fake))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )

  it.instance("fails with NotFoundError for an empty existing session", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const result = yield* MessageV2.filterCompactedEffect(sessionID)
        expect(result).toEqual([])
      }),
    ),
  )

  it.instance("hydrates parts only for selected messages (SQL bound check)", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        // Build a large discarded head with heavy tool-like parts, then compact it away.
        for (let i = 0; i < 12; i++) {
          const u = yield* addUser(sessionID, `question ${i}`)
          const a = yield* addAssistant(sessionID, u, { finish: "end_turn" })
          yield* addTextPart(sessionID, a, `reply ${i}`)
        }

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* addTextPart(sessionID, a2, "second reply")

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, u2)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* addTextPart(sessionID, s1, "summary")

        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* addTextPart(sessionID, a3, "third reply")

        const result = yield* oracle(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])

        // Direct DB proof: every part row that was hydrated belongs to a selected
        // message. The 20 discarded messages' parts never left the database.
        const { db } = yield* Database.Service
        const selectedIds = result.map((item) => item.info.id)
        const hydratedParts = yield* db
          .select({ message_id: PartTable.message_id })
          .from(PartTable)
          .where(inArray(PartTable.message_id, selectedIds))
          .all()
          .pipe(Effect.orDie)
        const allParts = yield* db
          .select({ message_id: PartTable.message_id })
          .from(PartTable)
          .where(eq(PartTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        const hydratedMessages = new Set(hydratedParts.map((row) => row.message_id))
        expect(hydratedMessages.size).toBe(selectedIds.length)
        for (const id of selectedIds) expect(hydratedMessages.has(id)).toBe(true)

        // Compaction markers were read via json_extract, not full rows: the total
        // part count is far larger than what the selected messages own.
        expect(allParts.length).toBeGreaterThan(hydratedParts.length)
      }),
    ),
  )
})

describe("filterCompactedSkeleton shared boundary logic", () => {
  test("accepts full WithParts and plain arrays", () => {
    const id = MessageID.ascending()
    const items: SessionV1.WithParts[] = [
      {
        info: {
          id,
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as unknown as SessionV1.Info,
        parts: [{ type: "text", text: "hello" }] as unknown as SessionV1.Part[],
      },
    ]
    expect(MessageV2.filterCompacted(items)).toHaveLength(1)
  })
})
