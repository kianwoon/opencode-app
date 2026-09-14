import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Option, Schema, Scope, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { InstanceState } from "@/effect/instance-state"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

export const id = "task"
export const TASK_TOOL_ID = id
const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

// Bounds the foreground parent join so one never-settling child (dead drain
// fiber, silent provider, stuck tool dispatch) can't park the session forever.
// Background tasks stay unbounded; the user polls those intentionally.
export const FOREGROUND_SUBAGENT_TIMEOUT_MS = 30 * 60_000

// Child-process isolation for foreground subagents (default ON), but only when
// a SAFE child binary is resolvable. Read synchronously at call time (not module
// load) so tests and the CLI can toggle it per process. Enabled unless opted out
// via `OPENCODE_SUBAGENT_ISOLATE=0` (also "false"/"off", case-insensitive).
// A missing binary disables isolation rather than spawning a wrong one: the
// desktop app runs its own server baked into app.asar and never loads the
// PATH/`~/.opencode/bin` CLI, which may be stale AND points at a different
// channel DB (`opencode-main.db`) than the app (`opencode.db`) — so a PATH
// child cannot see the parent's session and silently produces no output.
export function isolatedEnabled() {
  const value = process.env["OPENCODE_SUBAGENT_ISOLATE"]?.trim().toLowerCase()
  if (value === "0" || value === "false" || value === "off") return false
  return isolationBinary() !== undefined
}

// Resolves the child binary to the SAME build as the running process, or
// undefined when no trustworthy binary exists. The compiled launcher sets
// OPENCODE_BIN_PATH; a running compiled binary is its own execPath. A dev/`bun`
// runtime (execPath is `bun`) has no safe child, and we deliberately do NOT fall
// back to the PATH-installed CLI: that CLI can be a different version/channel and
// would run against a different database, so the resumed session would not exist.
function isolationBinary() {
  const configured = process.env["OPENCODE_BIN_PATH"]?.trim()
  if (configured) return configured
  return process.execPath.includes("opencode") ? process.execPath : undefined
}

// `opencode run --format json` emits one JSON object per line; assistant text
// parts carry the model's user-visible output. This mirrors runTask's contract:
// the LAST text part's text is the result. Non-JSON lines (banners, warnings)
// and non-text events are ignored. Schema.UnknownFromJsonString keeps the parse
// total — a malformed line decodes to None rather than throwing.
function isolatedText(stdout: string) {
  let last = ""
  for (const line of stdout.split("\n")) {
    const event = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line))
    if (!event || typeof event !== "object") continue
    const record = event as Record<string, unknown>
    if (record.type !== "text") continue
    const part = record.part as Record<string, unknown> | undefined
    if (typeof part?.text === "string") last = part.text
  }
  return last
}

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    // Bound here so `execute` stays requirement-free; only used by the
    // OPENCODE_SUBAGENT_ISOLATE child-process path.
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: next.model ? undefined : variant,
          agent: next.name,
          parts,
        })
        if (result.info.role === "assistant" && result.info.error) {
          // A user-initiated cancel surfaces as MessageAbortedError (or the
          // stream-level AbortError text). Report it as cancelled, not as a
          // failure — the subagent did nothing wrong.
          if (SessionV1.AbortedError.isInstance(result.info.error)) {
            return yield* Effect.fail(new Error(`Subagent cancelled (task_id: ${nextSession.id})`))
          }
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          if (/^The operation was aborted$/i.test(message)) {
            return yield* Effect.fail(new Error(`Subagent cancelled (task_id: ${nextSession.id})`))
          }
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${message}`))
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          if (/^The operation was aborted$|^Cancelled$/i.test(failed.state.error ?? "")) {
            return yield* Effect.fail(new Error(`Subagent cancelled (task_id: ${nextSession.id})`))
          }
          return yield* Effect.fail(new Error(`Subagent failed (task_id: ${nextSession.id}): ${failed.state.error}`))
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      // Isolated transport (OPENCODE_SUBAGENT_ISOLATE=1, foreground only): the
      // subagent runs in a fresh child process instead of a fiber sharing this
      // event loop. IPC/secret boundary: only the child session id, the prompt
      // text, the model id and the persisted permission ruleset (already written
      // onto nextSession via deriveSubagentSessionPermission) cross. The child is
      // spawned with extendEnv:true, so it inherits the parent process env and
      // reads its own credentials from the same store — no API keys or secrets
      // are passed as arguments, on stdin, or in any payload. Background subagents
      // stay in-fiber: their lifecycle is already managed by BackgroundJob.
      // Returns None on any spawn/IO failure so the caller falls back to runTask.
      const runIsolated = Effect.gen(function* () {
        const binary = isolationBinary()
        if (!binary) return Option.none<string>()
        const directory = (yield* InstanceState.context).directory
        const cmd = ChildProcess.make(
          binary,
          [
            "run",
            "--session",
            nextSession.id,
            "--format",
            "json",
            // --model matches runTask's explicit model; --agent is intentionally
            // omitted because `opencode run` rejects subagent names and would
            // fall back to a primary agent. Resuming the session reuses its
            // persisted agent (the subagent) and permission ruleset instead.
            "--model",
            `${model.providerID}/${model.modelID}`,
            ...(variant ? ["--variant", variant] : []),
            params.prompt,
          ],
          {
            cwd: directory,
            extendEnv: true,
            // Pin the child to the parent's database. A same-build CLI compiled
            // for another channel opens `opencode-<channel>.db` by default, so
            // without this the resumed session would not exist in the child.
            env: { OPENCODE_DB: Database.path() },
            stdin: "ignore",
            forceKillAfter: "3 seconds",
          },
        )
        const handle = yield* spawner.spawn(cmd)
        // Child stdout is the JSON event stream we parse; stderr is forwarded to
        // the parent log so child failures stay diagnosable without leaking back
        // into the tool result.
        yield* Effect.forkScoped(
          Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) => Effect.sync(() => process.stderr.write(chunk))),
        )
        const chunks: string[] = []
        yield* Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk)
          }),
        )
        // A non-zero child exit (or a signal death) means the child never
        // produced a usable result: treat it as isolation unavailable and let
        // the caller fall back in-fiber, instead of parsing partial output.
        const exited = yield* Effect.exit(handle.exitCode)
        if (Exit.isFailure(exited)) return Option.none<string>()
        if (exited.value !== 0) return Option.none<string>()
        // Empty text is never a valid subagent result. Without this guard a
        // failed child (e.g. session not found in a different channel DB) yields
        // an empty string that the caller reports as a successful completion.
        const text = isolatedText(chunks.join(""))
        return text.trim().length === 0 ? Option.none<string>() : Option.some(text)
      }).pipe(
        Effect.scoped,
        // Only spawn/stream failures fall back to the in-fiber path; the caller
        // treats None as "isolation unavailable". A timeout is a real failure and
        // is raised below, not converted to a fallback (which would silently run
        // another 30 minutes in-process).
        Effect.catch(() => Effect.succeed(Option.none<string>())),
        Effect.timeoutOrElse({
          duration: FOREGROUND_SUBAGENT_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new Error(
                `Isolated subagent timed out after 30 minutes (task_id: ${nextSession.id}). The child process was killed; retry the task.`,
              ),
            ),
        }),
      )

      if (!runInBackground && isolatedEnabled()) {
        const attempt = yield* runIsolated
        if (Option.isSome(attempt)) {
          return {
            title: params.description,
            metadata,
            output: renderOutput({ sessionID: nextSession.id, state: "completed", text: attempt.value }),
          }
        }
      }

      if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            ).pipe(
              Effect.timeoutOption(FOREGROUND_SUBAGENT_TIMEOUT_MS),
              Effect.flatMap((option) =>
                option._tag === "Some"
                  ? Effect.succeed(option.value)
                  : Effect.fail(
                      new Error(
                        `Subagent timed out after 30 minutes without settling (task_id: ${nextSession.id}). The child session may still be running; check its session or retry.`,
                      ),
                    ),
              ),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            // Timeout-failure must also cancel the orphan (parent already settled as error; child would otherwise run unbounded).
            if (Exit.hasInterrupts(exit) || Exit.isFailure(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
