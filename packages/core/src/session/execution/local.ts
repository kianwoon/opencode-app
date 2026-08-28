import { Cause, Effect, FiberSet, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })
    // Scoped fork runner: timer fibers die with the layer scope.
    const forkTimer = yield* FiberSet.makeRuntime<never, void, never>()

    // Followup timers: one fiber per scheduled wake, keyed by session. An
    // earlier deadline replaces the pending timer; a later one is ignored.
    // Timers are prompt-only — `session_input.deliver_at` is the durable
    // source of truth, and any wake re-checks due inputs before promoting.
    const timers = new Map<SessionSchema.ID, number>()
    const schedule = (sessionID: SessionSchema.ID, deliverAt: number) =>
      Effect.sync(() => {
        const pending = timers.get(sessionID)
        if (pending !== undefined && pending <= deliverAt) return
        timers.set(sessionID, deliverAt)
        forkTimer(
          Effect.gen(function* () {
            yield* Effect.sleep(Math.max(0, deliverAt - Date.now()))
            if (timers.get(sessionID) !== deliverAt) return
            timers.delete(sessionID)
            yield* coordinator.wake(sessionID)
          }),
        )
      }).pipe(Effect.asVoid)

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
      schedule,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
