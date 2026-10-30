import { LayerNode } from "@opencode/core/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { SessionPartTable, SessionTable } from "@opencode/core/session/sql"
import { ORPHAN_ERROR } from "@opencode/core/session/projector"
import { SessionV1 } from "@opencode/schema/v1/session"
import { Session } from "./session"
import { SessionRunState } from "./run-state"
import { Config } from "@/config/config"
import { MessageID, PartID, type SessionID } from "./schema"
import type { MessageID as MessageIDType, PartID as PartIDType } from "./schema"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Scope } from "effect"

// A subagent that stops emitting durable activity (session row updates) is
// indistinguishable from one whose owning turn died, because the only signal
// that would notice lives inside the turn that can die. This sweep watches the
// child session's durable `time_updated` heartbeat instead, from a process
// fiber that survives the turn.
export const SWEEP_INTERVAL_MS = 60_000
export const DEFAULT_STALE_TIMEOUT_MS = 15 * 60 * 1_000

export interface SweepResult {
  scanned: number
  finalized: number
  escalated: number
}

export interface SweepOptions {
  now?: number
  timeoutMs?: number
  /** Include parts a previous process already marked ORPHAN_ERROR. */
  boot?: boolean
}

export interface Interface {
  readonly sweep: (input?: SweepOptions) => Effect.Effect<SweepResult>
  readonly reconcile: (input?: SweepOptions) => Effect.Effect<SweepResult>
  /** Boot reconciliation once per process, then start the periodic loop. */
  readonly boot: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/StaleSubagentTask") {}

type Candidate = {
  id: PartIDType
  message_id: MessageIDType
  session_id: SessionID
  data: Record<string, unknown>
  time_created: number
}

type StoredState = Record<string, unknown>

const stateOf = (data: Record<string, unknown> | null): StoredState =>
  typeof data?.state === "object" && data.state !== null ? (data.state as StoredState) : {}

const metadataOf = (state: StoredState): Record<string, unknown> =>
  typeof state.metadata === "object" && state.metadata !== null ? (state.metadata as Record<string, unknown>) : {}

const asPart = (row: Candidate): SessionV1.ToolPart =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as SessionV1.ToolPart

const asSessionID = (value: unknown): SessionID | undefined =>
  typeof value === "string" && value.length > 0 ? (value as SessionID) : undefined

// `input.task_id` is model-supplied. Adopt it only when it has the session-id
// shape, so an arbitrary string is ignored instead of probed as a session row.
const asTaskID = (value: unknown): SessionID | undefined =>
  typeof value === "string" && value.startsWith("ses_") ? (value as SessionID) : undefined

const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)

const childOf = (state: StoredState): SessionID | undefined => {
  const metadata = metadataOf(state)
  const input = typeof state.input === "object" && state.input !== null ? (state.input as Record<string, unknown>) : {}
  return (
    asSessionID(metadata.childSessionId) ??
    asSessionID(metadata.sessionId) ??
    asSessionID(metadata.jobId) ??
    asSessionID(metadata.taskSessionId) ??
    // Durable pointer for the reuse/resume path: the task part records the
    // requested task_id in its input, and it survives when the metadata write
    // loses the race with an abort (the live part carried only
    // `{ interrupted: true }`).
    asTaskID(input.task_id)
  )
}

const descriptionOf = (state: StoredState, metadata: Record<string, unknown>): string => {
  const input = typeof state.input === "object" && state.input !== null ? (state.input as Record<string, unknown>) : {}
  const description = input.description ?? metadata.title
  return typeof description === "string" && description.length > 0 ? description : "task"
}

type ChildRow = {
  parent_id: string | null
  time_updated: number
  model: { id: string; providerID: string; variant?: string } | null
}

const modelOf = (
  metadata: Record<string, unknown>,
  parent: Session.Info | undefined,
  child: ChildRow | undefined,
): SessionV1.User["model"] | undefined => {
  const raw =
    typeof metadata.model === "object" && metadata.model !== null ? (metadata.model as Record<string, unknown>) : {}
  if (typeof raw.providerID === "string" && typeof raw.modelID === "string")
    return {
      providerID: raw.providerID as SessionV1.User["model"]["providerID"],
      modelID: raw.modelID as SessionV1.User["model"]["modelID"],
      variant: typeof raw.variant === "string" ? raw.variant : undefined,
    }
  if (parent?.model)
    return {
      providerID: parent.model.providerID,
      modelID: parent.model.id,
      variant: parent.model.variant,
    }
  if (child?.model)
    return {
      providerID: child.model.providerID as SessionV1.User["model"]["providerID"],
      modelID: child.model.id as SessionV1.User["model"]["modelID"],
      variant: child.model.variant,
    }
  return undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope

    // Process-global guard: the sweep and the boot reconciliation must run once
    // per process, never once per instance (a second instance sharing the DB
    // would otherwise scan the first instance's live work).
    let booted = false
    let started = false

    const injectFailure = (input: {
      parentID: SessionID
      description: string
      reason: string
      metadata: Record<string, unknown>
      child: ChildRow | undefined
      now: number
    }) =>
      Effect.gen(function* () {
        const parent = yield* sessions.get(input.parentID).pipe(Effect.option)
        const info = parent._tag === "Some" ? parent.value : undefined
        const model = modelOf(input.metadata, info, input.child)
        if (!model) {
          yield* Effect.logWarning("stale subagent escalation skipped: no model", {
            sessionID: input.parentID,
            description: input.description,
          })
          return false
        }
        // Same durable delivery contract as the live runSubagentTask failure
        // path (57d0f3d33d): a user message plus synthetic text part, so a dead
        // parent turn sees it on its next resume instead of losing the failure.
        const message: SessionV1.User = {
          id: MessageID.ascending(),
          sessionID: input.parentID,
          role: "user",
          time: { created: input.now },
          agent: info?.agent ?? "build",
          model,
        }
        yield* sessions.updateMessage(message)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: message.id,
          sessionID: input.parentID,
          type: "text",
          text: `Subagent task "${input.description}" failed: ${input.reason}. Decide: retry the task, do the work yourself, or report the failure — do not silently continue.`,
          synthetic: true,
        } satisfies SessionV1.TextPart)
        return true
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("stale subagent escalation failed", {
            sessionID: input.parentID,
            cause,
          }).pipe(Effect.as(false)),
        ),
      )

    const reconcile = Effect.fn("StaleSubagentTask.reconcile")(function* (input?: SweepOptions) {
      const now = input?.now ?? Date.now()
      const cfg = yield* config.get().pipe(Effect.option)
      const timeoutMs =
        input?.timeoutMs ??
        (cfg._tag === "Some" ? cfg.value.subagent_stale_timeout_ms : undefined) ??
        DEFAULT_STALE_TIMEOUT_MS
      const condition = input?.boot
        ? sql`(json_extract(${SessionPartTable.data}, '$.state.status') IN ('pending','running') OR (json_extract(${SessionPartTable.data}, '$.state.status') = 'error' AND json_extract(${SessionPartTable.data}, '$.state.error') = ${ORPHAN_ERROR} AND json_extract(${SessionPartTable.data}, '$.state.metadata.staleEscalated') IS NULL))`
        : sql`json_extract(${SessionPartTable.data}, '$.state.status') IN ('pending','running')`
      const rows = yield* db
        .select({
          id: SessionPartTable.id,
          message_id: SessionPartTable.message_id,
          session_id: SessionPartTable.session_id,
          data: SessionPartTable.data,
          time_created: SessionPartTable.time_created,
        })
        .from(SessionPartTable)
        .where(
          and(
            sql`json_extract(${SessionPartTable.data}, '$.type') = 'tool'`,
            sql`json_extract(${SessionPartTable.data}, '$.tool') = 'task'`,
            condition,
          ),
        )
        .all()
        .pipe(Effect.orDie)

      let finalized = 0
      let escalated = 0
      // One WARN per unlinked part per sweep window: the sweep runs every
      // minute, so an unlinked-but-live part must not spam the log forever.
      const warnedUnlinked = new Set<PartIDType>()

      for (const row of rows as Candidate[]) {
        const state = stateOf(row.data)
        const metadata = metadataOf(state)
        const status = state.status
        const childID = childOf(state)

        if (status === "pending" || status === "running") {
          const child: ChildRow | undefined = childID
            ? yield* db
                .select({
                  parent_id: SessionTable.parent_id,
                  time_updated: SessionTable.time_updated,
                  model: SessionTable.model,
                })
                .from(SessionTable)
                .where(and(eq(SessionTable.id, childID), eq(SessionTable.parent_id, row.session_id)))
                .get()
                .pipe(Effect.orDie)
            : undefined

          // Fail open: a subagent is declared stale ONLY on positive evidence
          // of child-session silence. Without a resolved child row there is no
          // heartbeat to prove silence (the part's own start time is not a
          // heartbeat), so skip — never finalize on missing linkage.
          // A model-supplied pointer (input.task_id) can name any session; only
          // a child this same session owns is a valid heartbeat. Probe scoped by
          // parent_id, and belt-and-braces on the returned row: a mismatch is
          // unlinked, never silently treated as a live child.
          if (!child || child.parent_id !== row.session_id) {
            if (!warnedUnlinked.has(row.id)) {
              warnedUnlinked.add(row.id)
              yield* Effect.logWarning("stale subagent sweep skipped part without a linked child session", {
                partID: row.id,
                sessionID: row.session_id,
              })
            }
            continue
          }
          // Never fire on a child with recent durable activity.
          if (now - child.time_updated <= timeoutMs) continue
          const start = asNumber((state.time as Record<string, unknown> | undefined)?.start) ?? row.time_created
          const quiet = now - child.time_updated
          if (quiet <= timeoutMs) continue

          const reason = `subagent stale: no activity for ${Math.floor(quiet / 1_000)}s`
          const nextData = {
            ...row.data,
            state: {
              status: "error",
              input: state.input ?? {},
              error: reason,
              metadata: { ...metadata, staleEscalated: true },
              time: { start, end: now },
            },
          }
          // Compare-and-set: if the owning turn settled the part between the
          // scan and now, leave its terminal state alone.
          const claimed = yield* db
            .update(SessionPartTable)
            .set({ data: nextData as unknown as typeof SessionPartTable.$inferInsert.data })
            .where(
              and(
                eq(SessionPartTable.id, row.id),
                sql`json_extract(${SessionPartTable.data}, '$.state.status') IN ('pending','running')`,
              ),
            )
            .returning({ id: SessionPartTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!claimed) continue
          yield* sessions.updatePart(asPart({ ...row, data: nextData })).pipe(Effect.ignore)
          finalized++
          // Finalizing the part must also stop the orphan: otherwise the child
          // keeps streaming (and burning tokens) with no owner. Reuse the
          // existing session-abort path; a failure here must not abort the sweep.
          if (childID)
            yield* runState.cancel(childID).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("stale subagent child abort failed", { sessionID: childID, cause }),
              ),
            )
          if (
            yield* injectFailure({
              parentID: row.session_id,
              description: descriptionOf(state, metadata),
              reason,
              metadata,
              child,
              now,
            })
          )
            escalated++
          continue
        }

        // A prior process already finalized this part at its boot sweep. Deliver
        // the failure message the boot sweep never sent, once.
        if (status === "error" && state.error === ORPHAN_ERROR) {
          const nextData = {
            ...row.data,
            state: { ...state, metadata: { ...metadata, staleEscalated: true } },
          }
          const claimed = yield* db
            .update(SessionPartTable)
            .set({ data: nextData as unknown as typeof SessionPartTable.$inferInsert.data })
            .where(
              and(
                eq(SessionPartTable.id, row.id),
                sql`json_extract(${SessionPartTable.data}, '$.state.status') = 'error'`,
                sql`json_extract(${SessionPartTable.data}, '$.state.error') = ${ORPHAN_ERROR}`,
                sql`json_extract(${SessionPartTable.data}, '$.state.metadata.staleEscalated') IS NULL`,
              ),
            )
            .returning({ id: SessionPartTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!claimed) continue
          yield* sessions.updatePart(asPart({ ...row, data: nextData })).pipe(Effect.ignore)
          finalized++
          if (
            yield* injectFailure({
              parentID: row.session_id,
              description: descriptionOf(state, metadata),
              reason: ORPHAN_ERROR,
              metadata,
              child: undefined,
              now,
            })
          )
            escalated++
        }
      }

      if (finalized > 0 || escalated > 0)
        yield* Effect.logInfo("stale subagent sweep", { scanned: rows.length, finalized, escalated })
      return { scanned: rows.length, finalized, escalated }
    })

    const start = Effect.suspend(() => {
      if (started) return Effect.void
      started = true
      const loop = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(SWEEP_INTERVAL_MS)
          yield* reconcile().pipe(
            Effect.catchCause((cause) => Effect.logWarning("stale subagent sweep failed", { cause })),
            Effect.asVoid,
          )
        }
      })
      return Effect.forkIn(loop, scope).pipe(Effect.asVoid)
    })

    const boot = Effect.suspend(() => {
      if (booted) return Effect.void
      booted = true
      return reconcile({ boot: true }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("stale subagent boot reconciliation failed", { cause })),
        Effect.andThen(start),
      )
    })

    return Service.of({ sweep: reconcile, reconcile, boot })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Session.node, SessionRunState.node, Config.node],
})

export * as StaleSubagentTask from "./stale-task"
