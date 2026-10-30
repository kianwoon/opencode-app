import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode/schema/v1/session"
import { WithParts } from "@/compat/schema/session-v1"
import { FSUtil } from "@opencode/util/fs-util"
import { Provider } from "@opencode/core/provider"
import { Model } from "@opencode/core/model"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { SessionReminders } from "../../src/session/reminders"
import { Session } from "../../src/session/session"
import { Todo } from "../../src/session/todo"

// Unique session per run: the drift memo is session-scoped and module-level, so
// a shared id would let one test's anchor suppress the next test's reminder.
let sessionSeq = 0
const freshSessionID = () => SessionID.make(`session-${++sessionSeq}`)

// Fresh message per call: SessionReminders.apply mutates the parts array.
const userMessage = (sessionID: SessionID): WithParts => ({
  info: {
    id: MessageID.make("msg_user"),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test") },
  } as unknown as SessionV1.User,
  parts: [],
})

// A prior compaction marker in the projected history: the drift signal that
// re-anchors the rule reminder after a context reset.
const compactionMessage = (sessionID: SessionID): WithParts => ({
  info: {
    id: MessageID.make(`msg_compact_${sessionID}`),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: Provider.ID.make("test"), modelID: Model.ID.make("test") },
  } as unknown as SessionV1.User,
  parts: [
    {
      id: PartID.make(`prt_compact_${sessionID}`),
      messageID: MessageID.make(`msg_compact_${sessionID}`),
      sessionID,
      type: "compaction",
      auto: false,
    } as unknown as SessionV1.CompactionPart,
  ],
})

const sessionInfo = (sessionID: SessionID) => ({ id: sessionID }) as Session.Info

const layers = (rulePaths: string[], todos: Todo.Info[] = []) =>
  Layer.mergeAll(
    Layer.succeed(
      Instruction.Service,
      Instruction.Service.of({
        clear: () => Effect.void,
        staticBlock: () => Effect.succeed(undefined),
        systemPaths: () => Effect.succeed(new Set(rulePaths)),
        system: () => Effect.succeed([]),
        find: () => Effect.succeed(undefined),
        resolve: () => Effect.succeed([]),
      }),
    ),
    RuntimeFlags.layer({ experimentalPlanMode: false }),
    Layer.succeed(
      FSUtil.Service,
      FSUtil.Service.of({
        existsSafe: () => Effect.succeed(false),
        ensureDir: () => Effect.void,
      } as unknown as FSUtil.Interface),
    ),
    Layer.mock(Session.Service, {
      updatePart: <T>(part: T) => Effect.succeed(part),
    }),
    Layer.succeed(Todo.Service, Todo.Service.of({ update: () => Effect.void, get: () => Effect.succeed(todos) })),
  )

const run = (
  rulePaths: string[],
  todos: Todo.Info[] = [],
  sessionID: SessionID = freshSessionID(),
  prior: WithParts[] = [],
) =>
  SessionReminders.apply({
    messages: [...prior, userMessage(sessionID)],
    agent: { name: "build" } as never,
    session: sessionInfo(sessionID),
  }).pipe(Effect.provide(layers(rulePaths, todos)))

const reminderTexts = (msgs: WithParts[]) =>
  msgs
    .flatMap((msg) => msg.parts)
    .filter((part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true)
    .map((part) => part.text)

describe("session.reminders", () => {
  test("injects a synthetic rule adherence reminder when instruction files are in effect", async () => {
    const msgs = await Effect.runPromise(
      run(["/proj/AGENTS.md", "/home/.config/opencode/AGENTS.md"]).pipe(Effect.tapError(Effect.die)),
    )
    const texts = reminderTexts(msgs)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("Rule adherence check")
    expect(texts[0]).toContain("BINDING")
    expect(texts[0]).toContain("<system-reminder>")
  })

  test("no rule reminder when no instruction files are in effect", async () => {
    const msgs = await Effect.runPromise(run([]))
    expect(reminderTexts(msgs)).toHaveLength(0)
  })

  test("rule reminder fires alongside the todo reminder", async () => {
    const todos: Todo.Info[] = [{ content: "task", status: "pending", priority: "high" }]
    const msgs = await Effect.runPromise(run(["/proj/AGENTS.md"], todos))
    const texts = reminderTexts(msgs)
    expect(texts.some((text) => text.includes("Rule adherence check"))).toBe(true)
    expect(texts.some((text) => text.includes("<todo-list>"))).toBe(true)
  })

  test("an ordinary second turn in the same session does not re-anchor", async () => {
    const sessionID = freshSessionID()
    const first = await Effect.runPromise(run(["/proj/AGENTS.md"], [], sessionID))
    expect(reminderTexts(first).some((text) => text.includes("Rule adherence check"))).toBe(true)
    const second = await Effect.runPromise(run(["/proj/AGENTS.md"], [], sessionID))
    expect(reminderTexts(second).some((text) => text.includes("Rule adherence check"))).toBe(false)
  })

  test("a compaction marker re-anchors the rule reminder", async () => {
    const sessionID = freshSessionID()
    await Effect.runPromise(run(["/proj/AGENTS.md"], [], sessionID))
    const afterCompaction = await Effect.runPromise(
      run(["/proj/AGENTS.md"], [], sessionID, [compactionMessage(sessionID)]),
    )
    expect(reminderTexts(afterCompaction).some((text) => text.includes("Rule adherence check"))).toBe(true)
  })
})
