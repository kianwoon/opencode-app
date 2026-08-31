import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { SessionReminders } from "../../src/session/reminders"
import { Session } from "../../src/session/session"
import { Todo } from "../../src/session/todo"

const sessionID = SessionID.make("session")

// Fresh message per call: SessionReminders.apply mutates the parts array.
const userMessage = (): SessionV1.WithParts => ({
  info: {
    id: MessageID.make("msg_user"),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  } as unknown as SessionV1.User,
  parts: [],
})

const sessionInfo = { id: sessionID } as Session.Info

const layers = (rulePaths: string[], todos: Todo.Info[] = []) =>
  Layer.mergeAll(
    Layer.succeed(
      Instruction.Service,
      Instruction.Service.of({
        clear: () => Effect.void,
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

const run = (rulePaths: string[], todos: Todo.Info[] = []) =>
  SessionReminders.apply({ messages: [userMessage()], agent: { name: "build" } as never, session: sessionInfo }).pipe(
    Effect.provide(layers(rulePaths, todos)),
  )

const reminderTexts = (msgs: SessionV1.WithParts[]) =>
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
})
