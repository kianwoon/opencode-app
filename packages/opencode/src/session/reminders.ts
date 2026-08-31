import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Instruction } from "./instruction"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { Todo } from "./todo"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const todos = yield* Todo.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // Keep the todo list alive across turns: without re-injection the list drops
  // out of the model's attention a few turns after it is written and stays
  // stale forever (observed: 5-item list untouched through 177 subsequent
  // turns). The reminder is a synthetic part, so it never persists as user
  // content and never reaches the transcript.
  const items = yield* todos.get(input.session.id)

  // Per-turn rule adherence: the binding-rules anchor lives at the end of the
  // system prompt, but attention decays as a long conversation accumulates, so
  // re-assert obedience at the user-turn position every turn. Synthetic part,
  // never persisted. No-op when no instruction files are in effect.
  const ruleCount = yield* (yield* Instruction.Service)
    .systemPaths()
    .pipe(
      Effect.map((paths) => paths.size),
      Effect.catch(() => Effect.succeed(0)),
    )
  if (ruleCount > 0) {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: [
        "<system-reminder>",
        "Rule adherence check: the instruction files in this session are BINDING. Re-check your plan and output against every stated rule before acting; honor style, testing, permission, safety, and scope constraints with no exceptions. If you cannot satisfy a rule, say so explicitly instead of silently deviating.",
        "</system-reminder>",
      ].join("\n"),
      synthetic: true,
    })
  }

  if (items.some((item) => item.status !== "completed")) {
    const list = items
      .map((item) => {
        const mark = item.status === "in_progress" ? "▸" : item.status === "completed" ? "✓" : " "
        return `${mark} ${item.content}${item.status === "in_progress" ? " (in progress)" : ""}`
      })
      .join("\n")
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: [
        "<system-reminder>",
        "The current todo list for this session is below. Keep it current: mark items completed as soon as they are done, set the active item in_progress, and clear or extend the list when the plan changes. Use the todowrite tool to update it.",
        "<todo-list>",
        list,
        "</todo-list>",
        "</system-reminder>",
      ].join("\n"),
      synthetic: true,
    })
  }

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
