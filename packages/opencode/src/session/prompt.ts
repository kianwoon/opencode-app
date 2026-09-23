import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { validateWorkflow, readySteps, propagateFailure, isComplete, workflowErrorMessage } from "./workflow/dag"
import { verificationGate } from "./verification"
import { assess } from "./effort"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema, type ModelMessage } from "ai"
import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { redactErrorText } from "../plugin/secret-broker"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Fiber, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { SessionStableHeadTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { node as SessionTodoNode, Service as TodoService } from "./todo"
import { SessionTools } from "./tools"
import { LLMEvent } from "@opencode-ai/llm"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
// Safety wall for runaway agentic loops. Agents without an explicit `steps`
// config previously ran unbounded (`Infinity`), so a model that keeps ending
// turns with tool calls could loop for hours burning millions of tokens.
const DEFAULT_MAX_STEPS = 1000
// Subagents share the session loop with the main agent, so an unbounded step
// budget for a subagent amplifies into the same runaway-token failure mode the
// DEFAULT_MAX_STEPS wall guards against. Cap subagents at 100 unless their
// explicit `steps` config is lower; the primary agent keeps the full budget.
const SUBAGENT_MAX_STEPS = 100
// Re-entry cap: `runLoop` is re-entered fresh (step=0) whenever a finished run
// is re-driven — e.g. a subagent↔parent wake ping-pong. Each fresh entry
// silently restarts the loop, so a pathological wake cycle burns tokens with
// no failure ever surfacing. Past 3 wake re-drives within 60s per session, stop
// re-driving and surface a user-visible error instead of silently restarting.
// User-initiated prompts (`source: "prompt"`) bypass the cap by resetting the
// window — only automatic wake re-drives accumulate. Entries are pruned when
// their window expires (swept opportunistically once the map grows), so the
// map never grows unbounded. NOTE: entries must NOT be deleted on session
// idle — every re-drive passes through idle, so an idle hook would reset the
// count each cycle and nullify the cap.
// The per-iteration `!finished` grace backstop below is intentionally kept.
const REENTRY_LIMIT = 3
const REENTRY_WINDOW_MS = 60_000
const reentries = new Map<SessionID, { count: number; windowStart: number }>()
// The map only needs recent sessions; once it grows past this many entries,
// drop entries whose window has expired to bound memory on long-lived servers.
const REENTRY_PRUNE_MIN = 128
// Workflow re-dispatch bound, keyed by workflow PART id (not session): the
// loop re-collects a workflow part on every drain until an assistant message
// with a non-null `finish` exists after it (MessageV2.latest's consumption
// boundary). A workflow that repeatedly settles without a terminal assistant
// message — every step failing on the first turn, as when steps delegate via
// `task` while `subagent_depth` is 1 — is re-run forever: 5,419 identical step
// executions over ~4 minutes in one session, with every assistant message left
// `finish: null`. Past this many attempts the step hard-fails, the summary is
// written, and the workflow part is marked terminal so it is never re-collected.
export const MAX_STEP_ATTEMPTS_PER_WORKFLOW = 3
const workflowAttempts = new Map<string, number>()
// Bounded like `reentries`, but keyed by part id and therefore with no expiry
// clock: sweep the least-recently-bumped entries once the map grows past the
// cap, so a long-lived server that admits many workflows cannot leak memory.
// A part id is unique per admission, so an evicted entry can only mean a
// workflow that has not been re-collected in a very long time — it restarts
// its count instead of being permanently refused.
export const WORKFLOW_ATTEMPTS_PRUNE_MIN = 512

/**
 * Increment the re-dispatch counter for a workflow part, pruning the map when
 * it grows. Re-insertion on every bump keeps Map insertion order as recency
 * order, so eviction drops the coldest entries first.
 * @internal Exported for testing
 */
export function bumpWorkflowAttempts(id: string) {
  const attempts = (workflowAttempts.get(id) ?? 0) + 1
  workflowAttempts.delete(id)
  workflowAttempts.set(id, attempts)
  if (workflowAttempts.size > WORKFLOW_ATTEMPTS_PRUNE_MIN) {
    for (const key of workflowAttempts.keys()) {
      if (workflowAttempts.size <= WORKFLOW_ATTEMPTS_PRUNE_MIN) break
      // Never evict the entry being bumped: it is the one under test.
      if (key === id) continue
      workflowAttempts.delete(key)
    }
  }
  return attempts
}
// Wall-clock backstop for a single drain: a drain that makes no
// user-visible progress for 45 minutes is failed, not slow. The ceiling is
// checked between steps (never mid-stream) so healthy long single steps are
// never killed — expiry publishes Session.Event.Error, exits the loop via
// lastAssistant, and lets the runner settle to idle so a later prompt
// re-drives fresh.
export const DRAIN_WALL_CEILING_MS = 45 * 60_000
export const DRAIN_WALL_CEILING_MESSAGE =
  "Session drain exceeded 45 minutes without completing; stopped to keep the app responsive. Send a new prompt to continue."
/** @internal Exported for testing */
export function drainCeilingExceeded(start: number, now: number = Date.now()) {
  return now - start >= DRAIN_WALL_CEILING_MS
}
// Grace steps granted after the soft max-steps wall for the model to produce
// its text-only summary. If it still calls tools past the grace window, the
// loop is force-broken with an error instead of continuing forever.
const MAX_STEPS_GRACE = 5
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

// Repetition interceptor: a model that keeps producing (near-)identical turns
// is stuck, exactly like the ses_fabcb2a43ffeeJobwWmhG19PDi incident where the
// agent circulated the same typecheck error 28 times over 2 hours until a
// human interrupted. Escalate the same way a human does: warn at
// REPETITION_WARN, take the tools away and demand a wrap-up at
// REPETITION_WRAPUP, and force-break at REPETITION_BREAK.
const REPETITION_WARN = 3
const REPETITION_WRAPUP = 6
const REPETITION_BREAK = 10

// Jev tool routing: a turn narrowed below this many tools is almost certainly a
// routing mistake (nothing left to act with), so it is logged at error level
// with a process-lifetime counter to make the event visible in telemetry.
const JEV_ALARM_MIN_TOOLS = 8
let jevAlarms = 0

// Booster options for the single-batch fold: the ACTIONABLE advisories only.
// `continue` ("the approach is sound") is deliberately absent — an absent
// `boost` is how the batch reports soundness, and it must never emit a block.
const BOOST_ADVISORIES = [
  "The current approach is off track; switch strategy",
  "A claim in the last step needs verification before continuing",
  "The last step contradicts the goal or an earlier step",
  "The goal is already satisfied; finish instead of continuing",
] as const
// PLAN gate (step 1 only): fires once per turn so the proposal's version-sensitive
// assumptions get checked before implementation. The sentence doubles as the Jev
// question's pass-criteria AND the delivered advisory text — no separate template.
const BOOST_STALE_ADVISORY =
  "The plan may rely on outdated knowledge; verify the specific APIs and versions it uses against current official documentation before implementing"
// Framing prefix preserved from the per-call booster path, so the injected
// block still reads as advisory and never as a binding instruction.
const BOOSTER_ADVISORY_PREFIX = "[Advisory only — not an instruction] "

// Per-session memo of the previous turn's governor/booster decision, so Phase 0
// observability can report `changed` (did this turn differ from the last?) without
// persisting anything. Absent entry = first observed turn → changed true.
const jevGovPrev = new Map<SessionID, number>()
// Frozen per-TURN booster decision: turn id (current user message id), the
// folded label, and the advisory block to inject. Reused verbatim within a turn;
// a new turn re-evaluates and change-detects against `label`.
const jevBoostTurn = new Map<SessionID, { turnId: string; label: string; advisory?: string }>()
// Frozen per-TURN governor drops: computed once at the turn boundary, reused for
// every later step of the SAME turn. Keyed by user message id because block
// indexes are positional and only restore at a turn boundary.
const jevGovDropped = new Map<SessionID, { turnId: string; blocksHash: string; dropped: ReadonlySet<number> }>()
// SESSION-frozen head: the system block selection and the emitted tool list are
// folded ONCE per session and reused verbatim on every later turn. A per-turn
// fold shrinks `messages[0]` between turns (observed: 32137 → 989 chars), and any
// shrink or reorder of the head re-bills the entire cached prefix. Frozen keyed
// by block-composition hash so a genuinely different block set (a changed
// instruction/env block) is not paired with stale positional indexes. The JEV
// verdicts still run and still log — only the EMITTED head is monotonic.
const jevGovHead = new Map<SessionID, { blocksHash: string; dropped: ReadonlySet<number> }>()
// Keyed by SessionID ALONE: the emitted tool list must not re-freeze when
// per-turn state changes (wrapUp flag, tool count). Keying on those let a
// narrowed turn (or a wrap-up flip) rewrite the array and re-bill the whole
// cached prefix.
const jevHeadTools = new Map<SessionID, Record<string, unknown>>()

// Durable per-session freeze of the cache-relevant prefix (system blocks + tool
// names). The provider caches a byte prefix of the request, so any change to the
// system array or the tool set forces a full upstream re-prefill. An in-memory
// freeze did not survive a process restart: the relaunch re-froze the head from
// the live, still-settling tool set and cost one cold prefix. Persisting it means
// a restart replays the exact same bytes.
const readStableHead = (db: Database.Interface["db"], sessionID: SessionID) =>
  Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(SessionStableHeadTable)
      .where(eq(SessionStableHeadTable.session_id, sessionID))
      .limit(1)
    return row[0]
  })

const writeStableHead = (db: Database.Interface["db"], sessionID: SessionID, system: string[], tools: string[]) =>
  db
    .insert(SessionStableHeadTable)
    .values({ session_id: sessionID, system, tools, time_created: Date.now() })
    .onConflictDoNothing()

function freezeHead<T extends Record<string, unknown>>(
  sessionID: SessionID,
  current: T,
  persisted: { system: string[]; tools: string[] } | undefined,
): T {
  const frozen = jevHeadTools.get(sessionID)
  if (frozen) return frozen as T
  const names = persisted
    ? Object.keys(current).filter((name) => persisted.tools.includes(name))
    : Object.keys(current)
  const keep = names.length > 0 ? names : Object.keys(current)
  // Insertion order IS the emitted order, so sort by name once here: the same
  // session can otherwise resolve tools in a different order between turns.
  const sorted = Object.fromEntries(keep.toSorted().map((name) => [name, current[name]]))
  jevHeadTools.set(sessionID, sorted)
  capMemo(jevHeadTools)
  return sorted as T
}

// Module-global session-keyed memos never get an explicit session-end hook, so
// cap them: oldest-inserted entry is evicted past 50 sessions. Only observability
// and sticky-drop memory are affected; a re-appearing session just starts fresh.
const JEV_MEMO_CAP = 50
function capMemo<T>(map: Map<SessionID, T>) {
  for (const key of map.keys()) {
    if (map.size <= JEV_MEMO_CAP) break
    map.delete(key)
  }
}

// Frozen per session so mid-session local edits (AGENTS.md / instruction files)
// cannot rewrite the cached prefix bytes. The provider caches a byte prefix of
// the request: any change to the system array forces a full upstream re-prefill
// even when prompt_cache_key is unchanged. Later turns reuse the session's first
// system array verbatim; edits apply to the NEXT session.
const jevSystemPrefix = new Map<SessionID, string[]>()

function freezeSystem(
  sessionID: SessionID,
  current: string[],
  persisted: { system: string[]; tools: string[] } | undefined,
): string[] {
  const frozen = jevSystemPrefix.get(sessionID)
  if (frozen) return frozen
  const value = persisted?.system ?? current
  jevSystemPrefix.set(sessionID, value)
  capMemo(jevSystemPrefix)
  return value
}

// Fingerprint one completed assistant turn from its persisted parts: text
// content, every tool name+input, and the finish reason. Identical turns
// produce identical fingerprints; reordered tool calls still match.
function turnFingerprint(parts: SessionV1.Part[], finish?: string) {
  const items: string[] = []
  for (const part of parts) {
    if (part.type === "text") items.push(`text:${part.text}`)
    else if (part.type === "tool") items.push(`tool:${part.tool}:${JSON.stringify(part.state.input ?? null)}`)
    else if (part.type === "reasoning") items.push(`reason:${part.text}`)
  }
  items.push(`finish:${finish ?? ""}`)
  return items.sort().join("\n")
}

// Global Jev tool-routing: narrows the turn tool list via the Jev decision
// model. The transport + verdict algebra live in the shared, zero-dependency
// `@/jev/client` module (copyable into plugins that cannot import the runtime);
// this re-export keeps the historical import path used by tests stable.
export { jevFoldTools, jevKeepTools, jevVerdict, jevDecide, jevBelowFloor, jevGaugeKeep, jevAsk } from "@/jev/client"
import { jevBelowFloor, jevBatch, jevTransport, jevModelFor, resolveJevModel, resolveJevSurface } from "@/jev/client"
import { jevKey } from "@/jev/controller"
import { boosterPush, applyDrops } from "@/jev/gate"
import { JEV_DEFAULT_THRESHOLD, JEV_DEFAULT_TIMEOUT_MS } from "@/jev/client"

function jevPromptText(parts: readonly unknown[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => {
      if (typeof p !== "object" || p === null) return false
      const r = p as Record<string, unknown>
      return r["type"] === "text" && typeof r["text"] === "string"
    })
    .map((p) => p.text)
    .join("\n")
}

/**
 * Auth namespace for a governor/booster model spec: the `provider` prefix of
 * `provider/model-id`, or `typesafe` (the SystemOne default) when absent.
 */
function governorProvider(model?: string, defaultModel?: string): string {
  return jevModelFor(model, defaultModel).split("/")[0] || "typesafe"
}

/**
 * Cheap deterministic task fingerprint from the latest user message text. Two
 * turns sharing this hash are the SAME task (sticky drop set applies); a change
 * is the task boundary that resets it. Not cryptographic — collision only
 * widens a task, which at worst keeps a section the governor already keeps.
 */
function governorTaskHash(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${text.length}:${h >>> 0}`
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const { db } = database
    const todos = yield* TodoService
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    /**
     * Run one subagent task (a `subtask` part or a workflow step) through the
     * task tool. Owns the assistant message + tool part bookkeeping so the
     * part always settles — running parts are finalized on every early-exit
     * path (unknown agent, execution failure, interruption), never orphaned.
     *
     * Returns a discriminated result so callers can report the real failure
     * reason: `ok` carries the task output; `failed` carries the error
     * message that was also persisted on the tool part.
     */
    type SubagentResult = { ok: true; output: string } | { ok: false; reason: string }
    const runSubagentTask = Effect.fn("SessionPrompt.runSubagentTask")(function* (input: {
      task: Pick<SessionV1.SubtaskPart, "prompt" | "description" | "agent" | "model" | "command">
      fallbackModel: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
      /** Extra metadata stamped on the running task part (workflow step context). */
      partMetadata?: Record<string, unknown>
    }) {
      const { task, fallbackModel, lastUser, sessionID, session, msgs, partMetadata } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()

      const taskModel = task.model
        ? yield* getModel(task.model.providerID, task.model.modelID, sessionID)
        : fallbackModel
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          metadata: partMetadata,
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }

      /** Settle the part as an error and close the assistant message. */
      const failPart = Effect.fnUntraced(function* (message: string) {
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        yield* sessions.updateMessage(assistantMessage)
        if (part.state.status === "running" || part.state.status === "pending") {
          const running = part.state.status === "running" ? part.state : undefined
          yield* sessions.updatePart({
            ...part,
            state: {
              status: "error",
              error: message,
              time: {
                start: running ? running.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: running?.metadata,
              input: part.state.input,
            },
          } satisfies SessionV1.ToolPart)
        }
      })

      // Unknown agents settle the part as an error (never an orphaned
      // "running" part) and surface as a session error event. The settled
      // assistant message also creates the task-consumption boundary the
      // loop relies on, so the enclosing task is not re-dispatched.
      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        yield* failPart(error.message)
        throw error
      }

      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              // Workflow step context survives task-tool metadata updates.
              const merged = { ...partMetadata, ...val.metadata }
              const state =
                part.state.status === "pending" || part.state.status === "running"
                  ? { ...part.state, ...val, metadata: merged }
                  : part.state
              part = yield* sessions.updatePart({ ...part, type: "tool", state } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            const failure = defect instanceof Error ? defect : new Error(String(defect))
            error = failure
            // Secret Broker: route the failure text through `tool.execute.after`
            // (redaction) before it is embedded in the part/session error, so a
            // secret in a subagent failure never reaches the model.
            return redactErrorText({
              plugin,
              tool: TaskTool.id,
              sessionID,
              callID: part.id,
              args: taskArgs,
              text: failure.message,
            }).pipe(
              Effect.tap((text) => Effect.sync(() => void (failure.message = text))),
              Effect.flatMap(() =>
                Effect.logError("subagent task execution failed", {
                  error: failure,
                  agent: task.agent,
                  description: task.description,
                }),
              ),
            )
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              yield* failPart("Cancelled")
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      // `result` is undefined on the failure path (catchCause above recovers
      // the fiber with `void`), yet hooks still receive the output object and
      // write `output.metadata` / `output.title`. Passing undefined made every
      // plugin throw "Cannot read properties of undefined (reading 'metadata')",
      // which REPLACED the real task failure — a depth-limit rejection surfaced
      // in the workflow summary as that TypeError. Hand hooks a well-formed
      // empty result so the true error survives.
      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result ?? { title: "", output: "", metadata: {} },
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: { ...partMetadata, ...result.metadata },
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        const reason = error ? `Tool execution failed: ${error.message}` : "Tool execution failed"
        yield* failPart(reason)
        return { ok: false, reason }
      }
      if (!result.output) {
        const reason = error ? `Tool execution failed: ${error.message}` : "Task produced no output"
        yield* failPart(reason)
        return { ok: false, reason }
      }
      return { ok: true, output: result.output }
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      // The part is settled either way inside runSubagentTask; hard failures
      // (unknown agent) throw, soft ones are already persisted on the part.
      yield* runSubagentTask({ task, fallbackModel: model, lastUser, sessionID, session, msgs })

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    /**
     * Extract the payload text from a task tool result. The task tool wraps
     * its final text as <task id=... state=...>...<task_result>text</task_result>
     * </task>; downstream step prompts want the inner text, not the envelope
     * (and not the child session id noise it carries).
     */
    const taskResultPayload = (output: string) => {
      const start = output.indexOf("<task_result>")
      if (start === -1) return output
      const end = output.lastIndexOf("</task_result>")
      if (end === -1 || end < start) return output
      return output.slice(start + "<task_result>".length, end).trim()
    }

    /** Per-upstream cap on injected result text; keeps fan-in prompts bounded. */
    const UPSTREAM_RESULT_MAX_CHARS = 20_000

    /** Build a step's prompt with upstream results injected for dataflow. */
    const workflowStepPrompt = (step: SessionV1.WorkflowStep, results: Map<string, string>) => {
      const upstream = step.dependsOn
        .map((dep) => results.get(dep))
        .filter((output): output is string => output !== undefined)
      if (upstream.length === 0) return step.prompt
      return [
        step.prompt,
        "",
        "Results from upstream workflow steps:",
        ...upstream.map((output) => {
          const payload = taskResultPayload(output)
          const clipped =
            payload.length > UPSTREAM_RESULT_MAX_CHARS
              ? payload.slice(0, UPSTREAM_RESULT_MAX_CHARS) + "\n...[truncated]..."
              : payload
          return `<upstream-result>\n${clipped}\n</upstream-result>`
        }),
      ].join("\n")
    }

    /**
     * Execute a workflow (DAG of subagent steps). Event-driven scheduling: a
     * step starts the moment its dependencies settle (no batch barriers), up
     * to the concurrency cap. A failed step marks its transitive dependents
     * skipped; failures carry their reason into the final summary so the
     * orchestrating model can react. The final step statuses are rendered as
     * a synthetic text part.
     */
    const handleWorkflow = Effect.fn("SessionPrompt.handleWorkflow")(function* (input: {
      task: SessionV1.WorkflowPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input

      // Settle a terminal assistant message AFTER the workflow part: a message
      // with a non-null `finish` is the task-consumption boundary in
      // MessageV2.latest, so a dead/rejected workflow cannot be re-collected
      // and re-dispatched on every later drain. Without this the loop re-runs
      // the same workflow part forever (5,419 re-runs, every assistant message
      // left `finish: null`).
      const settleTerminal = (text: string) =>
        Effect.gen(function* () {
          const terminal: SessionV1.Assistant = {
            id: MessageID.ascending(),
            sessionID,
            parentID: lastUser.id,
            mode: lastUser.agent,
            agent: lastUser.agent,
            cost: 0,
            path: { cwd: (yield* InstanceState.context).directory, root: (yield* InstanceState.context).worktree },
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
            role: "assistant",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
          }
          yield* sessions.updateMessage(terminal)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: terminal.id,
            sessionID,
            type: "text",
            text,
            synthetic: true,
          } satisfies SessionV1.TextPart)
        })

      // Same admission as the workflow tool: the direct API path
      // (PromptInput with a workflow part) must not bypass graph-shape,
      // step-count, or agent-name enforcement.
      const knownAgents = new Set((yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name))
      const dag = validateWorkflow(task.steps, knownAgents)
      if ("_tag" in dag) {
        const error = new NamedError.Unknown({ message: workflowErrorMessage(task.title, dag) })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        // Settle before throwing so the rejected WorkflowPart cannot be
        // re-collected and re-dispatched on every later prompt (which would
        // poison the session — the next user message would never reach the
        // model).
        yield* settleTerminal(error.message)
        throw error
      }

      const cfg = yield* config.get()
      const concurrency = Math.max(1, cfg.experimental?.workflow_concurrency ?? 4)

      // Re-dispatch bound. The loop re-collects this same workflow part on
      // every drain until a terminal assistant message exists after it, so a
      // workflow that settles without one is re-run indefinitely. Count
      // attempts on the PART (the durable identity): past the limit, hard-fail
      // every step, write the summary, and settle terminally so the part is
      // consumed. `record()` on the bounded path keeps the invariant that a
      // step is never left neither completed nor failed.
      const attempts = bumpWorkflowAttempts(task.id)
      if (attempts > MAX_STEP_ATTEMPTS_PER_WORKFLOW) {
        const terminalError = new NamedError.Unknown({
          message:
            `Workflow "${task.title}" stopped after ${MAX_STEP_ATTEMPTS_PER_WORKFLOW} attempts: it keeps settling ` +
            `without completing (every step failed). Likely cause: a step delegates via the task tool while ` +
            `"subagent_depth" is 1 — workflow steps must do their own work, not nest subagents. ` +
            `Fix the step definition or raise subagent_depth, then re-run.`,
        })
        yield* events.publish(Session.Event.Error, { sessionID, error: terminalError.toObject() })
        yield* Effect.logWarning("workflow re-dispatch cap hit", {
          "session.id": sessionID,
          workflow: task.title,
          attempts,
        })
        yield* settleTerminal(terminalError.message)
        return
      }

      const completed = new Set<string>()
      const skipped = new Set<string>()
      const failed = new Set<string>()
      const settled = new Set<string>() // completed ∪ failed, for readiness
      const outputs = new Map<string, string>()
      const failureReasons = new Map<string, string>()
      // Steps started but not yet settled, and their fibers. Fibers remove
      // their id from `inflight` on every exit path; the scheduler prunes
      // `running` by inflight membership. Failure is a scheduling outcome
      // recorded in state, so step fibers never fail.
      const inflight = new Set<string>()
      const running = new Map<string, Fiber.Fiber<void>>()

      /** Record a step outcome (sync, atomic). Idempotent: the first outcome wins. */
      const record = (stepId: string, result: SubagentResult) => {
        if (settled.has(stepId)) return
        settled.add(stepId)
        if (result.ok) {
          completed.add(stepId)
          outputs.set(stepId, result.output)
          return
        }
        failed.add(stepId)
        failureReasons.set(stepId, result.reason)
        for (const id of propagateFailure(dag, stepId)) skipped.add(id)
      }

      const runStep = Effect.fnUntraced(function* (step: (typeof dag.steps)[number]) {
        const exit = yield* Effect.exit(
          runSubagentTask({
            task: {
              prompt: workflowStepPrompt(step, outputs),
              description: step.description,
              agent: step.agent,
              model: step.model,
              command: step.command,
            },
            fallbackModel: model,
            lastUser,
            sessionID,
            session,
            msgs,
            // Step context on the task part so UIs and telemetry can
            // correlate steps with their owning workflow and graph edge.
            partMetadata: { workflow: { title: task.title, stepId: step.id, dependsOn: [...step.dependsOn] } },
          }),
        )
        // `exit.value`'s literal discriminator widens through Effect.fn's
        // inferred generator type; reassert the declared union.
        if (Exit.isSuccess(exit)) return record(step.id, exit.value as SubagentResult)
        // Hard failures (unknown agent, defects) settle the step as failed
        // too — scheduling outcome, never a fiber failure.
        const defect = Cause.squash(exit.cause)
        // NamedError messages live on `.data.message`; plain Errors on `.message`.
        const data = defect as { data?: { message?: string } }
        record(step.id, {
          ok: false,
          reason: defect instanceof Error ? (data.data?.message ?? defect.message) : String(defect),
        })
      })

      // Event-driven frontier: start newly-ready steps the moment capacity
      // frees up, then wait on live fibers. No batch barrier — a slow sibling
      // never delays an unrelated dependent.
      while (!isComplete(dag.steps, settled, skipped)) {
        const startable = readySteps(dag.steps, settled, skipped)
          .filter((step) => !inflight.has(step.id))
          .slice(0, concurrency - inflight.size)
        if (startable.length > 0) {
          for (const step of startable) {
            inflight.add(step.id)
            const fiber = yield* runStep(step).pipe(
              // On any exit (including interruption) release capacity; a step
              // interrupted before recording settles as failed so the
              // scheduler can always make progress.
              Effect.ensuring(
                Effect.sync(() => {
                  inflight.delete(step.id)
                  if (!settled.has(step.id)) record(step.id, { ok: false, reason: "Cancelled" })
                }),
              ),
              // Step fibers are children of the workflow/loop fiber, not
              // daemons in the instance scope. Forking into `scope` detaches
              // them from cancellation: cancelling the session interrupts the
              // loop fiber but leaves already-started steps running to
              // completion, burning turns and mutating the tree. As children,
              // they inherit the loop's interrupt, which cascades into the
              // task tool's own onInterrupt (aborting the child session).
              Effect.forkChild,
            )
            running.set(step.id, fiber)
          }
          continue
        }

        if (inflight.size === 0) {
          // Nothing running, nothing startable, work left: deadlock.
          const message = `Workflow "${task.title}" cannot make progress (deadlock)`
          const error = new NamedError.Unknown({ message })
          yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
          throw error
        }

        // Wait for any live step to settle. Racing the `Fiber.await` effects
        // only interrupts these ephemeral awaiters — the underlying step
        // fibers run in the prompt scope and are unaffected.
        yield* Effect.raceAll([...running.values()].map((fiber) => Fiber.await(fiber)))
        for (const [id] of running) {
          if (!inflight.has(id)) running.delete(id)
        }
      }

      // Statuses in declaration order keep the summary deterministic.
      const statusLine = (id: string) => {
        if (completed.has(id)) return `- ${id}: completed`
        if (failed.has(id)) {
          const reason = failureReasons.get(id)
          return `- ${id}: failed${reason ? ` (${reason})` : ""}`
        }
        return `- ${id}: skipped`
      }
      const summary = [`Workflow "${task.title}" finished.`, ...dag.steps.map((s) => statusLine(s.id))].join("\n")
      const summaryMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryMsg.id,
        sessionID,
        type: "text",
        text: summary,
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    /**
     * Automatic verification gate: after a task finishes, run one reviewer
     * subagent pass over the session's changes when the risk gate fires.
     * The reviewer's summary is injected as a synthetic user message so the
     * model can react to findings; a marker part records that the pass
     * already ran so the loop tail never re-triggers it for the same task.
     * Flag-gated: OPENCODE_EXPERIMENTAL_VERIFICATION (default off).
     */
    const reviewPass = Effect.fn("SessionPrompt.reviewPass")(function* (input: {
      lastUser: SessionV1.User
      model: Provider.Model
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
      reason: string
    }) {
      const { lastUser, model, sessionID, session, msgs, reason } = input
      const prompt = [
        "Automatic verification pass. Review the changes made in this session for:",
        "correctness, regressions, edge cases, error handling, and security issues.",
        "Gate reason: " + reason + ".",
        "Report critical issues, important issues, and recommended fixes concisely.",
      ].join(" ")
      const result = yield* Effect.exit(
        runSubagentTask({
          task: {
            prompt,
            description: "Verification review",
            agent: "reviewer",
            model: undefined,
            command: undefined,
          },
          fallbackModel: model,
          lastUser,
          sessionID,
          session,
          msgs,
        }),
      )
      const summary = Exit.isSuccess(result)
        ? (result.value.output ?? "Reviewer pass completed with no output.")
        : "Reviewer pass failed to run."
      const markerMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(markerMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: markerMsg.id,
        sessionID,
        type: "text",
        text: summary,
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        if (part.type === "workflow") {
          // The workflow part carries a DAG of steps; deep-mutate so it fits
          // the stored Part type (schema DeepMutable semantics).
          return [
            {
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
              steps: part.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] })),
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: 8 }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      return yield* loop({ sessionID: input.sessionID, source: "prompt" })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const runLoop: (sessionID: SessionID, source: "prompt" | "wake") => Effect.Effect<SessionV1.WithParts> = Effect.fn(
      "SessionPrompt.run",
    )(
      function* (sessionID, source) {
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
        let repeatKey: string | undefined
        let repeatCount = 0
        let forceWrapUp = false
        // Jev routing decision cache: a single slot keyed by the current user
        // message id (the turn boundary). A new user message changes the key,
        // so the narrowed tool set is recomputed for a new turn and reused for
        // every LLM step within one turn. `computed` memoizes a fail-open
        // outcome (no key, no decision) so later steps skip the provider
        // lookup/HTTP call too. `keep: null` = fail open (full list).
        // Intentionally runLoop-scoped, not lifted to session scope: it is
        // recomputed on wake, which is acceptable — a wake is a fresh decision.
        const jevTurn: {
          key: string
          computed: boolean
          keep: Set<string> | null
          names: Set<string>
          // Threshold actually used for this turn's decision, so every log line
          // reports the number the fold ran with instead of a re-derived guess.
          threshold: number
          // Resolved model spec for this turn's decision (e.g. `openrouter/...`),
          // so log lines attribute a routing change to its source model.
          spec: string
          // Single-batch fold for this turn (tools + governor + booster). Undefined
          // until computed, or when the batch path is disabled / fails open.
          batch: Awaited<ReturnType<typeof jevBatch>> | undefined
        } = { key: "", computed: false, keep: null, names: new Set(), threshold: JEV_DEFAULT_THRESHOLD, spec: "", batch: undefined }
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        // Re-entry cap (module-level state, survives within the process).
        // Counts only wake-sourced FRESH entries (step=0); a user-initiated
        // prompt resets the window so legitimate rapid prompting never hits
        // the cap. Wake re-drives (e.g. a subagent↔parent ping-pong) still
        // accumulate and surface a visible error past the limit.
        if (step === 0) {
          const now = Date.now()
          const entry = reentries.get(sessionID)
          if (source === "prompt") {
            reentries.set(sessionID, { count: 0, windowStart: now })
          } else if (entry && now - entry.windowStart < REENTRY_WINDOW_MS) {
            entry.count++
            if (entry.count >= REENTRY_LIMIT) {
              const error = new NamedError.Unknown({
                message: "loop re-entry cap hit, reporting to user",
              })
              yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
              yield* Effect.logWarning("loop re-entry cap hit", { "session.id": sessionID, reentries: entry.count })
              return yield* lastAssistant(sessionID)
            }
          } else {
            reentries.set(sessionID, { count: 1, windowStart: now })
          }
          // Opportunistic prune: drop expired windows once the map grows.
          if (reentries.size > REENTRY_PRUNE_MIN) {
            for (const [id, e] of reentries) {
              if (now - e.windowStart >= REENTRY_WINDOW_MS) reentries.delete(id)
            }
          }
        }

        const drainStart = Date.now()
        const findLastAssistant = lastAssistant
        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          if (drainCeilingExceeded(drainStart)) {
            const error = new NamedError.Unknown({ message: DRAIN_WALL_CEILING_MESSAGE })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            yield* status.set(sessionID, { type: "idle" })
            yield* Effect.logWarning("drain wall ceiling exceeded", { "session.id": sessionID })
            return yield* findLastAssistant(sessionID)
          }
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.orDie,
            Effect.provideService(Database.Service, database),
          )

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          if (
            lastAssistant?.finish &&
            !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastAssistant.parentID === lastUser.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })

            // Effort controller phase 0 outcome: what the task actually cost,
            // paired with the effort_assessment log at task start.
            if (flags.experimentalEffortLog) {
              const taskTools = msgs
                .filter((m) => m.info.role === "assistant" && m.info.time.created >= lastUser.time.created)
                .flatMap((m) => m.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool"))
              yield* Effect.logInfo("effort_outcome", {
                "session.id": sessionID,
                tools: taskTools.length,
                steps: step,
                total_tokens: lastFinished?.tokens.input ?? 0,
                output_tokens: lastFinished?.tokens.output ?? 0,
              })
            }

            // Automatic verification gate: risk-gated single reviewer pass
            // per task. Runs before the session goes idle so findings land
            // in the same turn; the injected summary ends the loop again
            // (the reviewer's subtask part is consumed by its own reply).
            if (flags.experimentalVerification && !session.parentID) {
              const lastUserMsg = msgs.findLast((m) => m.info.role === "user" && m.info.id === lastUser.id)
              const taskTools = msgs
                .filter((m) => m.info.role === "assistant" && m.info.time.created >= lastUser.time.created)
                .flatMap((m) => m.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool"))
              const verdict = verificationGate({
                prompt: (lastUserMsg?.parts ?? [])
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join(" "),
                tools: taskTools.map((part) => ({ tool: part.tool, state: part.state })),
              })
              const reviewerAgent = yield* agents.get("reviewer")
              if (verdict.review && reviewerAgent && !reviewerAgent.hidden) {
                const turnModel = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
                yield* Effect.logInfo("verification gate triggered reviewer pass", {
                  "session.id": sessionID,
                  reason: verdict.reason,
                  tools: taskTools.length,
                })
                yield* reviewPass({
                  lastUser,
                  model: turnModel,
                  sessionID,
                  session,
                  msgs,
                  reason: verdict.reason,
                })
              }
            }
            break
          }

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          // Effort controller phase 0: log the predicted tier at task start.
          // Paired with the effort_outcome log at task tail, this is the data
          // collection for tuning future budget enforcement — no behavior change.
          if (step === 1 && flags.experimentalEffortLog) {
            const promptText = msgs
              .filter((m) => m.info.role === "user" && m.info.id === lastUser.id)
              .flatMap((m) => m.parts.filter((part): part is SessionV1.TextPart => part.type === "text"))
              .map((part) => part.text)
              .join(" ")
            const signal = assess(promptText)
            yield* Effect.logInfo("effort_assessment", {
              "session.id": sessionID,
              tier: signal.tier,
              reasons: signal.reasons,
              prompt_chars: promptText.length,
            })
          }

          const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "workflow") {
            yield* handleWorkflow({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
          ) {
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps =
            agent.mode === "subagent" || agent.mode === "all"
              ? // Subagents (mode "subagent") and agents invoked as subagents
                // (mode "all" reached through the task tool, i.e. running in a
                // session with a parentID) share the session loop with the main
                // agent, so the same runaway-token cap applies. Explicit `steps`
                // config is honored only when it is lower than the cap.
                Math.min(agent.steps ?? SUBAGENT_MAX_STEPS, SUBAGENT_MAX_STEPS)
              : (agent.steps ?? DEFAULT_MAX_STEPS)
          if (
            (agent.mode === "subagent" || agent.mode === "all") &&
            (agent.steps ?? SUBAGENT_MAX_STEPS) > SUBAGENT_MAX_STEPS
          ) {
            yield* Effect.logWarning("subagent steps clamped", {
              "session.id": sessionID,
              agent: agent.name,
              mode: agent.mode,
              configured: agent.steps,
              clampedTo: SUBAGENT_MAX_STEPS,
            })
          }
          const isLastStep = step >= maxSteps
          const isPastGrace = step >= maxSteps + MAX_STEPS_GRACE
          msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
            Effect.provideService(TodoService, todos),
            Effect.provideService(Instruction.Service, instruction),
          )

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps = yield* ops()
            const cfg = yield* config.get()

            const tools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
              mcpConfig: (cfg.mcp ?? {}) as Record<string, unknown>,
              jevEnabled: resolveJevSurface(cfg.jev, cfg.jevDefault?.model, {
                threshold: JEV_DEFAULT_THRESHOLD,
                timeoutMs: JEV_DEFAULT_TIMEOUT_MS,
              }).enabled,
            }).pipe(
              Effect.provideService(Plugin.Service, plugin),
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(MCP.Service, mcp),
              Effect.provideService(Truncate.Service, truncate),
              Effect.provideService(RuntimeFlags.Service, flags),
              Effect.provideService(Agent.Service, agents),
              Effect.provideService(Config.Service, config),
            )

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            const format = lastUser.format ?? { type: "text" as const }

            // Soft wall: once the step budget is exhausted — or the model is
            // repeating itself — physically strip tools for this turn so the
            // injected MAX_STEPS_PROMPT is true: the model's only move is to
            // emit its final text summary, which exits the loop through the
            // normal finish path and salvages the session (summary recorded,
            // todos intact). Keep the structured output tool when the user
            // requested a json_schema response, since that call IS the final
            // answer.
            const wrapUp = isLastStep || forceWrapUp
            let turnTools = tools
            // JEV-gated tool list, hoisted out of the `if (keep)` block below so
            // the freezeHead call site can see it. Set ONLY when a verdict was
            // actually applied (the `else` branch below); left undefined on every
            // fail-open path (no verdict, below-floor, empty narrowing) and on
            // wrap-up turns, where turnTools is the collapsed mask and must never
            // become the session head.
            let gatedHead: typeof tools | undefined
            if (wrapUp) {
              const keep =
                format.type === "json_schema"
                  ? (name: string) => name === "StructuredOutput"
                  : (name: string) => name === "invalid"
              turnTools = Object.fromEntries(Object.entries(tools).filter(([name]) => keep(name)))
              if (format.type === "json_schema" && !turnTools["StructuredOutput"]) {
                turnTools["StructuredOutput"] = tools["StructuredOutput"]
              }
            }

            // System block assembly is hoisted ABOVE the Jev routing fold so the
            // SINGLE batch POST can carry the governor block candidates and the
            // booster options it would otherwise need separate calls for. The
            // values are turn-constant; `ruleAnchor` is still placed LAST in the
            // `system` array below — its POSITION there is what the anchor needs.
            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const [skills, env, instructions, mcpInstructions, workflowGuidance, rulePaths, modelMsgs] =
              yield* Effect.all([
                sys.skills(agent),
                sys.environment(model),
                // A transient FS error while reading instruction files must not kill
                // the prompt loop; degrade to whatever loaded and keep going.
                instruction.system().pipe(
                  Effect.catch((error) =>
                    Effect.logError("failed to load instruction files", { error }).pipe(Effect.as([] as string[])),
                  ),
                ),
                sys.mcp(agent, session.permission),
                sys.workflow(agent),
                instruction.systemPaths().pipe(
                  // Set order is FS-discovery order; rules anchor rides the wire, so sort.
                  Effect.map((paths) => Array.from(paths).toSorted()),
                  Effect.catch(() => Effect.succeed([] as string[])),
                ),
                MessageV2.toModelMessagesEffect(msgs, model),
              ])
            const ruleAnchor = yield* sys.rules(rulePaths)
            // Context governor candidates: the NON-binding context blocks. The
            // rule anchor is never a candidate — it is binding and must stay last.
            // Positional ids (`b${i}`) are what the batch scores and what the
            // governor's drop-set is derived from.
            const govBlocks = [
              ...env,
              ...(mcpInstructions ? [mcpInstructions] : []),
              ...(skills ? [skills] : []),
              ...(workflowGuidance ? [workflowGuidance] : []),
            ]

            // Global Jev tool-routing (OFF = current behavior, full tool
            // list). Fail-open: missing key, timeout, error, or parse miss
            // keeps the full list. Never drops StructuredOutput on
            // json_schema turns. The decision is computed ONCE per user turn
            // (cached in jevTurn under the current user message id) and reused
            // across every LLM step: a 20-step turn makes one HTTP call, not
            // 20. Later steps intersect the cached set with the current
            // turnTools, so wrapUp/json_schema masking is still respected;
            // tools that surface after the decision (e.g. find_tools
            // promotions) were never evaluated, so they fail open and stay.
            //
            // Config owner: `opencode.json` (the UI-editable file) owns tool
            // routing. `context-optimizer.json`'s `jev` block is IGNORED here —
            // that plugin's own config must not become a second source of truth
            // for `enabled`/`threshold`/`timeoutMs`; the threshold read below is
            // `cfg.jev.threshold` from opencode.json alone (else the shared
            // JEV_DEFAULT_THRESHOLD). Do not migrate this key.
            const jev = resolveJevSurface(cfg.jev, cfg.jevDefault?.model, {
              threshold: JEV_DEFAULT_THRESHOLD,
              timeoutMs: JEV_DEFAULT_TIMEOUT_MS,
            })
            const jevEnabled = jev.enabled
            // Hoisted ABOVE the JEV fold (and above the freezeHead call site) so
            // the routing telemetry can tell a first-turn freeze from a later
            // verdict the session-frozen head swallows. 12-space scope: a
            // declaration inside the `if` below would be invisible at the
            // freezeHead/`system` sites further down.
            const persistedHead = yield* readStableHead(db, sessionID).pipe(Effect.orDie)
            if (jevEnabled && !wrapUp) {
              const names = Object.keys(turnTools)
              if (jevTurn.key !== lastUser.id) {
                jevTurn.key = lastUser.id
                jevTurn.computed = false
                jevTurn.keep = null
                jevTurn.names = new Set()
                jevTurn.threshold = JEV_DEFAULT_THRESHOLD
              }
              if (!jevTurn.computed && names.length > 0) {
                jevTurn.computed = true
                // Provider-aware: the model spec's prefix selects the transport,
                // so the key must come from the same provider namespace. Absent
                // spec defaults to the SystemOne (typesafe) path.
                const { spec: jevSpec, fallback: jevFallback } = resolveJevModel(jevModelFor(jev.model), jevKey)
                const jevTransportResolved = jevTransport(jevSpec)
                // Key from the SAME provider namespace as the transport: the
                // typesafe and openrouter decision endpoints take different
                // credentials. auth.json namespace first, then the env var.
                // A missing/unknown provider fails open (skip routing).
                const resolvedJevKey = jevTransportResolved ? jevKey(jevTransportResolved.provider) : undefined
                // Default-provider gotcha: a default/typesafe spec with no
                // typesafe key but a present OpenRouter key falls back to the
                // OpenRouter decisions endpoint instead of silently disabling
                // routing. One diagnostic line, matching the skip-reason form.
                if (jevFallback && step === 1) {
                  yield* Effect.logInfo("jev.tool-routing provider-fallback", {
                    "session.id": sessionID,
                    reason: "no-typesafe-key",
                    provider: "openrouter",
                    threshold: jevTurn.threshold,
                  })
                }
                if (resolvedJevKey && jevTransportResolved) {
                  // One default for every reader: config wins, else the shared
                  // constant (never a second literal that can drift).
                  const threshold = jev.threshold
                  const timeoutMs = jev.timeoutMs
                  jevTurn.threshold = threshold
                  jevTurn.spec = jevSpec
                  const govBatchOn = resolveJevSurface(cfg.governor, cfg.jevDefault?.model, {
                    threshold: JEV_DEFAULT_THRESHOLD,
                    timeoutMs: JEV_DEFAULT_TIMEOUT_MS,
                  }).enabled
                  const boostBatchOn = resolveJevSurface(cfg.brainBooster, cfg.jevDefault?.model, {
                    threshold: JEV_DEFAULT_THRESHOLD,
                    timeoutMs: JEV_DEFAULT_TIMEOUT_MS,
                  }).enabled
                  const batchTools = jevEnabled ? names : []
                  // The governor scores the NON-binding context blocks that were
                  // assembled above; positional ids map back to `govBlocks` for
                  // the drop-set derivation below.
                  const batchGovBlocks = govBatchOn
                    ? govBlocks.map((text, i) => ({ id: `b${i}`, text }))
                    : []
                  const batchBoostOptions = boostBatchOn ? (step === 1 ? [...BOOST_ADVISORIES, BOOST_STALE_ADVISORY] : [...BOOST_ADVISORIES]) : []
                  const anySubset =
                    (batchTools.length > 0 && jevEnabled) ||
                    (batchGovBlocks.length > 0 && govBatchOn) ||
                    (batchBoostOptions.length > 0 && boostBatchOn)
                  if (anySubset) {
                    jevTurn.batch = yield* Effect.promise(() =>
                      jevBatch({
                        key: resolvedJevKey,
                        state: jevPromptText(lastUserMsg?.parts ?? []),
                        tools: batchTools,
                        govBlocks: batchGovBlocks,
                        boostOptions: batchBoostOptions,
                        threshold,
                        timeoutMs,
                        model: jevSpec,
                      }),
                    )
                  } else {
                    jevTurn.batch = undefined
                  }
                  // Tool routing reads the FROZEN batch fold (undefined ⇒ fail
                  // open to the full list, exactly as an abstained decision did).
                  jevTurn.keep = jevTurn.batch ? jevTurn.batch.toolKeep : null
                  jevTurn.names = new Set(names)
                  if (!jevTurn.keep) {
                    // Abstained / batch unavailable: no keep-set to apply, so the
                    // full list stands. `tools_after` is the count the turn runs.
                    yield* Effect.logInfo("jev.tool-routing fallback", {
                      "session.id": sessionID,
                      reason: "no-decision",
                      abstained: true,
                      threshold,
                      tools: names.length,
                      tools_after: names.length,
                    })
                  }
                } else if (step === 1) {
                  yield* Effect.logInfo("jev.tool-routing skipped", {
                    "session.id": sessionID,
                    reason: jevTransportResolved ? "no-key" : "unknown-provider",
                    provider: jevTransportResolved?.provider,
                    threshold: jevTurn.threshold,
                  })
                }
              } else if (step === 1 && names.length === 0) {
                yield* Effect.logInfo("jev.tool-routing skipped", {
                  "session.id": sessionID,
                  reason: "no-tools",
                  threshold: jevTurn.threshold,
                  tools_after: Object.keys(turnTools).length,
                })
              }
              const keep = jevTurn.keep
              if (keep) {
                // Never-evaluated names (surfaced after the decision) stay in
                // the list — masking only removes what Jev explicitly skipped.
                const narrowed = Object.fromEntries(
                  Object.entries(turnTools).filter(([name]) => !jevTurn.names.has(name) || keep.has(name)),
                )
                if (format.type === "json_schema" && tools["StructuredOutput"]) {
                  narrowed["StructuredOutput"] = tools["StructuredOutput"]
                }
                const after = Object.keys(narrowed).length
                // EMITTED head is frozen: the JEV verdict must NOT rewrite the
                // `tools[]` array, because dropping or reordering tools between
                // turns invalidates the whole cached prefix (observed: 35 → 22
                // tools across turns). The decision is still applied to `turnTools`
                // for behavior/telemetry, then the session-frozen full list wins.
                // Floor guard: a confident skip-all can fold a 35-tool turn down
                // to a handful (observed: `ses_f4545cf6`, 35 → 2 at 0.7), and the
                // decision is CACHED for the whole turn, so applying it leaves the
                // model unable to act with no later recovery. Refuse the narrowing
                // (keep-all) and keep the ALARM counter for telemetry/grep.
                // `tools_after` reports the refused decision's count; `tools_kept`
                // is what the turn really runs with.
                if (jevBelowFloor(after, JEV_ALARM_MIN_TOOLS)) {
                  if (step === 1) {
                    jevAlarms++
                    yield* Effect.logError("jev.tool-routing ALARM tools_after below floor", {
                      "session.id": sessionID,
                      step,
                      reason: "tools-after-below-floor",
                      threshold: jevTurn.threshold,
                      tools_before: names.length,
                      tools_after: after,
                      floor: JEV_ALARM_MIN_TOOLS,
                      alarms: jevAlarms,
                      tools_kept: names.length,
                    })
                  }
                } else if (after === 0) {
                  // Empty fold: the decision pruned every routable tool and the
                  // turn carried no exempt tool to anchor on. Apply nothing —
                  // keep the full list and report the distinct tools_after: 0
                  // signal the alarm/grep looks for (jevBelowFloor deliberately
                  // leaves this case to the caller).
                  yield* Effect.logInfo("jev.tool-routing fallback", {
                    "session.id": sessionID,
                    step,
                    reason: "empty-narrowing",
                    threshold: jevTurn.threshold,
                    tools: names.length,
                    tools_after: 0,
                    tools_kept: names.length,
                  })
                } else {
                  turnTools = narrowed
                  gatedHead = narrowed
                  // The verdict reaches the request ONLY on the first freeze;
                  // later turns are swallowed by the first-call-wins freezeHead
                  // memo / persisted.tools filter, so "applied" is honest only
                  // when the stable head is still unset.
                  yield* Effect.logInfo(
                    persistedHead ? "jev.tool-routing frozen-ignored" : "jev.tool-routing applied",
                    persistedHead
                      ? {
                          "session.id": sessionID,
                          step,
                          reason: "frozen-ignored",
                          model: jevTurn.spec,
                          threshold: jevTurn.threshold,
                          tools_before: names.length,
                          verdict_tools: after,
                        }
                      : {
                          "session.id": sessionID,
                          step,
                          reason: "applied",
                          model: jevTurn.spec,
                          threshold: jevTurn.threshold,
                          tools_before: names.length,
                          // Never blank: the applied list meets the floor by construct.
                          tools_after: after,
                          removed: names.length - after,
                        },
                  )
                }
              }
            } else if (!jevEnabled && step === 1) {
              yield* Effect.logInfo("jev.tool-routing skipped", {
                "session.id": sessionID,
                reason: "disabled",
                threshold: JEV_DEFAULT_THRESHOLD,
                tools_after: Object.keys(turnTools).length,
              })
            }

            // Context governor: drop-only relevance gate over the NON-binding
            // context blocks (assembled above). Fail-open keeps every block.
            //
            // Explicit-enable only: an ABSENT `governor` block means OFF for
            // every agent. The brain-only default made the governor rewrite
            // content per turn, breaking the cached prefix. This is the one
            // canonical enablement source; the plugin-side governor path is
            // retired (disabled-by-default).
            const gov = resolveJevSurface(cfg.governor, cfg.jevDefault?.model, {
              threshold: JEV_DEFAULT_THRESHOLD,
              timeoutMs: JEV_DEFAULT_TIMEOUT_MS,
            })
            const govKey = gov.enabled ? jevKey(governorProvider(gov.model)) : undefined
            const govTaskHash = governorTaskHash(jevPromptText(lastUserMsg?.parts ?? []))
            // Block composition identity: indexes are positional into a per-turn
            // rebuilt array, so a changed composition would drop the wrong
            // section. Hash the blocks and recompute when it shifts.
            const govBlocksHash = governorTaskHash(govBlocks.join("\u0000"))
            const govPrevTask = jevGovDropped.get(sessionID)
            // JEV decisions are FROZEN per TURN: later steps of the same user
            // turn reuse the memo verbatim, so the system prefix stays
            // byte-identical across the turn's steps. A verdict flip is deferred
            // to the next turn boundary.
            const govReuse =
              govKey !== undefined &&
              govPrevTask !== undefined &&
              govPrevTask.turnId === lastUser.id &&
              govPrevTask.blocksHash === govBlocksHash
            const govFrozen = jevGovHead.get(sessionID)
            let govDroppedSet: ReadonlySet<number>
            let govStickySize = 0
            if (!govKey) {
              // Fail-open: disabled / no key → nothing dropped, never fold.
              govDroppedSet = new Set<number>()
            } else if (govFrozen && govFrozen.blocksHash === govBlocksHash) {
              // SESSION-frozen head: the emitted block list must not shrink
              // between turns (prefix cache is append-only). The verdict is still
              // computed and logged below; only the emission stays verbatim.
              govDroppedSet = govFrozen.dropped
              govStickySize = govFrozen.dropped.size
            } else if (govReuse) {
              // Same turn: reuse the frozen decision, do NOT call governorKeep.
              govDroppedSet = govPrevTask!.dropped
              govStickySize = govPrevTask!.dropped.size
            } else {
              // Turn boundary: reuse the FROZEN single-batch fold — the governor
              // scores were carried on the one batch POST. `batch.govKeep` is a
              // keep-set of block ids, so the dropped INDEXES are the candidates
              // whose id is absent from it. No batch (disabled / failed open) ⇒
              // keep every block.
              const govKeep = jevTurn.batch?.govKeep
              if (govKeep) {
                const dropped = new Set<number>()
                govBlocks.forEach((_, i) => {
                  if (!govKeep.has(`b${i}`)) dropped.add(i)
                })
                govDroppedSet = dropped
              } else {
                govDroppedSet = new Set<number>()
              }
              govStickySize = govDroppedSet.size
              jevGovDropped.set(sessionID, {
                turnId: lastUser.id,
                blocksHash: govBlocksHash,
                dropped: govDroppedSet,
              })
              capMemo(jevGovDropped)
              if (!jevGovHead.has(sessionID)) {
                jevGovHead.set(sessionID, { blocksHash: govBlocksHash, dropped: govDroppedSet })
                capMemo(jevGovHead)
              }
            }
            const gatedBlocks = applyDrops(govBlocks, govDroppedSet)
            const govDropped = govDroppedSet.size
            // `changed` = this turn's drop-set differs from the previous turn's.
            // Minimal per-session memo of the dropped count; absent entry (first
            // observed turn) reports changed=true.
            const govChanged = govKey ? jevGovPrev.get(sessionID) !== govDropped : false
            if (govKey) {
              jevGovPrev.set(sessionID, govDropped)
              capMemo(jevGovPrev)
            }
            // A restore only happens at a task boundary (new user turn). Log it
            // distinctly so a sticky-drop regression is observable in telemetry.
            const govRestored = govPrevTask && govPrevTask.turnId !== lastUser.id && govPrevTask.dropped.size > 0
            if (govRestored) {
              yield* Effect.logInfo("jev.governor restored", {
                "session.id": sessionID,
                step,
                restored: govPrevTask.dropped.size,
                taskHash: govTaskHash,
              })
            }
            if (govKey && govDropped > 0) {
              yield* Effect.logInfo("jev.governor dropped", {
                "session.id": sessionID,
                step,
                before: govBlocks.length,
                after: gatedBlocks.length,
                changed: govChanged,
                sticky: govStickySize,
                threshold: gov.threshold,
              })
            }
            // Brain booster: computed ONCE at the turn boundary and reused
            // verbatim for the remaining steps, then injected as a constant system
            // block — never as a part of the last user message, which is the
            // cache-pin breakpoint (ProviderTransform.applyCaching). Fail-open
            // emits nothing.
            const boost = resolveJevSurface(cfg.brainBooster, cfg.jevDefault?.model, {
              threshold: JEV_DEFAULT_THRESHOLD,
              timeoutMs: JEV_DEFAULT_TIMEOUT_MS,
            })
            const boostKey = boost.enabled ? jevKey(governorProvider(boost.model)) : undefined
            const boostPrevTurn = jevBoostTurn.get(sessionID)
            let advisory: string | undefined
            if (boostKey) {
              if (boostPrevTurn && boostPrevTurn.turnId === lastUser.id) {
                // Same turn: reuse the frozen advisory; no boosterVerdict call.
                advisory = boostPrevTurn.advisory
              } else {
                // Advisory from the FROZEN single-batch fold: `batch.boost` is the
                // highest-strength actionable option that cleared the gate, or
                // undefined for sound/no-decision. Undefined ⇒ emit nothing.
                const label = jevTurn.batch?.boost ?? "none"
                const verdict = {
                  label,
                  emitted: jevTurn.batch?.boost !== undefined,
                  text: jevTurn.batch?.boost ? `${BOOSTER_ADVISORY_PREFIX}${jevTurn.batch.boost}.` : undefined,
                }
                // Change-detect across turns: a repeated label pushes no block.
                const push = boosterPush(boostPrevTurn?.label, verdict)
                advisory = push.advisory
                jevBoostTurn.set(sessionID, { turnId: lastUser.id, label, advisory })
                capMemo(jevBoostTurn)
                yield* Effect.logInfo("jev.booster verdict", {
                  "session.id": sessionID,
                  step,
                  verdict: label,
                  changed: push.changed,
                  emitted: advisory !== undefined,
                })
              }
            }
            // Per-turn tool preference rides the TAIL like the booster advisory: the emitted
            // tool list is frozen after the first turn, so guidance (not removal) is the
            // honest per-turn channel.
            // Filtered to real tool names: the batch fold can emit garbage entries (observed live: "invalid") that must never reach the advisory text.
            // "invalid" itself IS a registered catch-all tool (tool/registry.ts:216) that llm.ts:347
            // already excludes from activeTools — it is never a preference either.
            const keepReal = jevTurn.keep ? [...jevTurn.keep].filter((n) => jevTurn.names.has(n) && n !== "invalid") : []
            const routingAdvisory =
              jevEnabled && keepReal.length > 0
                ? `${BOOSTER_ADVISORY_PREFIX}For this step, prefer these tools: ${keepReal.slice(0, 8).join(", ")}${keepReal.length > 8 ? ", and others" : ""}.`
                : undefined
            const environmentDate = yield* sys.environmentDate()
            const system = freezeSystem(sessionID, [
              ...gatedBlocks,
              // The frozen advisory must NOT ride the system prefix: `system[0]`
              // is the cached head (`messages[0]`), so any advisory text there
              // makes the head turn-variable and kills prefix-cache reads. It is
              // appended to the trailing user message instead (below), where a
              // change only invalidates the tail.
              ...(ruleAnchor ? [ruleAnchor] : []),
              // Volatile date goes AFTER the stable anchors so a day rollover
              // only re-misses the short trailing tail, keeping the long stable
              // prefix byte-identical across turns for implicit prefix caching.
              environmentDate,
            ], persistedHead)
            if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
            // Prefix-cache invariant: the head (system blocks + sorted tool list)
            // is APPEND-ONLY across a session. Freeze once so every later turn
            // emits byte-identical head bytes. The JEV verdict becomes the
            // session's INITIAL head (gatedHead is undefined on every fail-open
            // path, so the full list is frozen exactly as before); once frozen,
            // no later turn may rewrite it — a per-turn fold would re-bill the
            // whole cached prefix.
            const headTools = freezeHead(sessionID, gatedHead ?? tools, persistedHead)
            // Probe: one line per step with a short digest of the cache-relevant
            // head (joined system string + sorted tool names). Always on; the log
            // write is best-effort and must never break the turn.
            try {
              const head = [...system, Object.keys(headTools).toSorted().join(",")].join("\n")
              const digestMsgs = JSON.stringify(modelMsgs)
              appendFileSync(
                path.join(os.homedir(), ".local/share/opencode/head-hash.log"),
                `${new Date().toISOString()} step=${step} turn=${lastUser.id} head=${createHash("sha256").update(head).digest("hex").slice(0, 12)} tools=${Object.keys(headTools).length} msgs=${createHash("sha256").update(digestMsgs).digest("hex").slice(0, 12)} msgcount=${modelMsgs.length} syslen=${system.join("\n").length}\n`,
              )
            } catch {}
            try {
              if (!persistedHead) {
                yield* writeStableHead(db, sessionID, system, Object.keys(headTools)).pipe(Effect.catch(() => Effect.void))
              }
            } catch {}
            // Advisory rides the TAIL, not the cached head: append it as a
            // trailing text part of the last user message so head bytes stay
            // stable across turns and prefix-cache reads survive.
            const advisoryText = [advisory, routingAdvisory].filter(Boolean).join("\n")
            const lastUserIdx = advisoryText
              ? modelMsgs.findLastIndex((m) => m.role === "user")
              : -1
            const outboundMsgs: ModelMessage[] =
              advisoryText && lastUserIdx >= 0
                ? modelMsgs.map((m, i): ModelMessage => {
                    if (i !== lastUserIdx) return m
                    const content = Array.isArray(m.content)
                      ? [...m.content, { type: "text" as const, text: advisoryText }]
                      : [{ type: "text" as const, text: m.content }, { type: "text" as const, text: advisoryText }]
                    return { ...m, content } as ModelMessage
                  })
                : modelMsgs
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [
                ...outboundMsgs,
                ...(wrapUp
                  ? [
                      {
                        role: "assistant" as const,
                        content: forceWrapUp
                          ? `${MAX_STEPS_PROMPT}\n\nAdditionally, you have produced the same response ${repeatCount} times in a row. Your tool access has been removed. Produce your final answer now as plain text.`
                          : MAX_STEPS_PROMPT,
                      },
                    ]
                  : []),
                // Instructions ride a trailing block, NOT the system prefix: the provider
                // caches a byte prefix of the request, so instruction-file content in the
                // system array means any AGENTS.md edit re-bills the whole cached prefix.
                // Regenerated identically every turn, after all history, so history bytes
                // stay stable and only this tail block can move.
                ...(instructions.length > 0
                  ? [
                      {
                        role: "user" as const,
                        content: [{ type: "text" as const, text: instructions.join("\n") }],
                      },
                    ]
                  : []),
              ],
              tools: headTools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }

            // Repetition interceptor: fingerprint the turn that just
            // completed and count consecutive identical turns. A model
            // repeating the exact same work is stuck — escalate like a human
            // would: warn it, then take its tools away, then force-break.
            const fingerprint = turnFingerprint(
              yield* MessageV2.parts(handle.message.id).pipe(Effect.provideService(Database.Service, database)),
              handle.message.finish,
            )
            if (fingerprint === repeatKey) repeatCount++
            else {
              repeatKey = fingerprint
              repeatCount = 1
            }
            if (repeatCount >= REPETITION_BREAK) {
              handle.message.error = new SessionV1.MaxStepsError({
                message: `Agent "${agent.name}" repeated the same response ${repeatCount} times without making progress. The run was stopped automatically. Re-run with a more specific prompt, or increase the agent's "steps" config if the repetition is expected.`,
                steps: step,
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
              yield* Effect.logWarning("loop force-break after repeated identical turns", {
                "session.id": sessionID,
                step,
                repeatCount,
              })
              return "break" as const
            }
            if (repeatCount >= REPETITION_WRAPUP) {
              forceWrapUp = true
              yield* Effect.logWarning("loop repeating identical turns, forcing wrap-up", {
                "session.id": sessionID,
                step,
                repeatCount,
              })
            } else if (repeatCount === REPETITION_WARN) {
              // Visible nudge in the transcript AND a steer to the model on
              // its next turn — the automated version of a human typing "you
              // keep repeating the same thing".
              const warnPart: SessionV1.TextPart = {
                id: PartID.ascending(),
                sessionID,
                messageID: handle.message.id,
                type: "text",
                text: `You have now produced the identical response ${repeatCount} times in a row (same tool calls and arguments). You are stuck in a loop. Stop repeating: either change your approach substantially, or produce your final answer and stop calling tools.`,
                time: { start: Date.now() },
              }
              yield* sessions.updatePart(warnPart)
              yield* sessions.updateMessage(handle.message)
              yield* Effect.logWarning("loop repeating identical turns, warning agent", {
                "session.id": sessionID,
                step,
                repeatCount,
              })
            }

            // Backstop: the model was told at the soft wall to stop calling
            // tools and summarize, and its tools were physically removed, but
            // it still has not produced a final response after the grace
            // window. Force-break so the loop can never run unbounded
            // (see ses_fabcb2a43ffeeJobwWmhG19PDi: 531 steps / 2 hours before
            // a manual cancel). This is the last resort after salvage failed;
            // a normal finish still exits via the regular path above.
            if (isPastGrace && !finished) {
              handle.message.error = new SessionV1.MaxStepsError({
                message: `Agent "${agent.name}" reached the maximum of ${maxSteps} steps${
                  MAX_STEPS_GRACE > 0 ? ` (+${MAX_STEPS_GRACE} grace steps)` : ""
                } without producing a final response. The run was stopped automatically. Increase the agent's "steps" config to allow longer runs.`,
                steps: maxSteps,
              }).toObject()
              yield* sessions.updateMessage(handle.message)
              yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
              yield* Effect.logWarning("loop force-break at max steps", {
                "session.id": sessionID,
                step,
                maxSteps,
              })
              return "break" as const
            }

            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") break
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(
        input.sessionID,
        lastAssistant(input.sessionID),
        runLoop(input.sessionID, input.source ?? "wake"),
      )
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
      SessionV1.WorkflowPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
  // "prompt" = user-initiated (bypasses the wake re-entry cap by resetting it);
  // "prompt()" passes it explicitly. Unset/"wake" = automatic re-drive
  // (counted toward the cap) — the HTTP loop path is a re-drive, not a fresh
  // user prompt, so a bare decoded `{ sessionID }` payload keeps counting.
  source: Schema.optional(Schema.Literals(["prompt", "wake"])),
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    SessionTodoNode,
  ],
})

export * as SessionPrompt from "./prompt"
