import path from "path"
import { SessionV1 } from "@opencode/schema/v1/session"
import { WithParts } from "@/compat/schema/session-v1"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode/util/fs-util"
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

/**
 * Per-session drift memo for the rule-adherence anchor. The value is the
 * identity of the compaction markers visible in the session's projected history
 * at the last anchor ("" = none). The anchor is re-asserted only when this
 * identity changes — the session's FIRST turn, or a resumed/compacted session
 * whose visible context no longer carries the anchor. Ordinary consecutive
 * turns keep the same identity and are skipped. Capped to bound memory; an
 * eviction only costs a harmless extra re-anchor.
 */
const RULE_ANCHOR_MAX = 200
const ruleAnchors = new Map<string, string>()

/**
 * Drift signal: the concatenated `id`s of every `type: "compaction"` part in
 * the projected history. `MessageV2.filterCompacted` retains the compaction
 * marker on its user message, so its presence (and id) is observable in the
 * transform input; a new marker means the visible context was reset.
 */
const compactionSignal = (messages: WithParts[]): string =>
  messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "compaction" ? [part.id] : []))
    .join(",")

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: WithParts[]
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

  // Drift-triggered rule adherence: the binding-rules anchor lives at the end
  // of the system prompt, but attention decays as a long conversation
  // accumulates. Re-assert obedience only when the session re-exposes drift —
  // its FIRST turn, or a resumed/compacted session whose visible context no
  // longer carries the anchor. Ordinary consecutive turns are skipped.
  // Synthetic part, never persisted. No-op when no instruction files are in
  // effect.
  const ruleCount = yield* (yield* Instruction.Service)
    .systemPaths()
    .pipe(
      Effect.map((paths) => paths.size),
      Effect.catch(() => Effect.succeed(0)),
    )
  if (ruleCount > 0) {
    const signal = compactionSignal(input.messages)
    // Fail-open: a memo fault falls through to anchoring, never suppresses it.
    let anchored = false
    try {
      anchored = ruleAnchors.get(input.session.id) === signal
    } catch {
      anchored = false
    }
    if (!anchored) {
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
      try {
        ruleAnchors.set(input.session.id, signal)
        if (ruleAnchors.size > RULE_ANCHOR_MAX) {
          const oldest = ruleAnchors.keys().next().value
          if (oldest !== undefined) ruleAnchors.delete(oldest)
        }
      } catch {
        // Memo is best-effort; the reminder is already appended.
      }
    }
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
        "The current todo list for this session is below. Update it at phase boundaries only: when a phase completes, mark its items completed in one update and keep the active phase's first item in_progress. Never update per step. Use the todowrite tool to update it.",
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
