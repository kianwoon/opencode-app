import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { JobRecord } from "@opencode-ai/core/job-record"
import { Database } from "@opencode-ai/core/database/database"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer } from "effect"

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

/**
 * Keeps the legacy service instance-scoped while sharing the core registry
 * engine, and adds a durable record slice: every lifecycle transition is
 * persisted best-effort (never breaks live work), list/get merge live entries
 * with recorded ones, and stale "running" rows from a previous process are
 * swept to cancelled at construction.
 */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const withDb = JobRecord.provided(database)
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const jobs = yield* CoreBackgroundJob.make
        // Startup sweep: rows still "running" belong to a dead process.
        yield* withDb.sweepStale().pipe(Effect.ignore)
        return jobs
      }),
    )

    const record = (info: Parameters<(typeof JobRecord.ops)["record"]>[0]) => withDb.record(info).pipe(Effect.ignore, Effect.asVoid)

    const asRecord = (info: CoreBackgroundJob.Info): Parameters<(typeof JobRecord.ops)["record"]>[0] => ({
      id: info.id,
      type: info.type,
      title: info.title,
      status: info.status,
      started_at: info.started_at,
      completed_at: info.completed_at,
      output: info.output,
      error: info.error,
      metadata: info.metadata,
    })

    return CoreBackgroundJob.Service.of({
      list: () =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            const live = yield* jobs.list()
            const recorded = yield* withDb.list()
            const liveIds = new Set(live.map((job) => job.id))
            // Live entries win; recorded-only entries fill the history.
            return [...live, ...recorded.filter((job) => !liveIds.has(job.id))]
          }),
        ),
      get: (id) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            const live = yield* jobs.get(id)
            if (live) return live
            return yield* withDb.get(id)
          }),
        ),
      start: (input) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            const info = yield* jobs.start(input)
            yield* record(asRecord(info))
            return info
          }),
        ),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            const result = yield* jobs.wait(input)
            // wait() observes the final lifecycle state — persist it here so
            // jobs that finish on their own fiber are recorded without the
            // caller having to promote/cancel them.
            if (result.info && result.info.status !== "running") yield* record(asRecord(result.info))
            return result
          }),
        ),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            const info = yield* jobs.promote(id)
            if (info) yield* record(asRecord(info))
            return info
          }),
        ),
      cancel: (id) =>
        InstanceState.useEffect(state, (jobs) =>
          Effect.gen(function* () {
            const info = yield* jobs.cancel(id)
            if (info) yield* record(asRecord(info))
            return info
          }),
        ),
    })
  }),
)

export const node = LayerNode.make({
  service: CoreBackgroundJob.Service,
  layer,
  deps: [Database.node],
})

export * as BackgroundJob from "./job"
