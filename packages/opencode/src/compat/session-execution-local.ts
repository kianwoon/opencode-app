import { Cause, Effect, Exit, Layer } from "effect"
import { EventV2 } from "@opencode/core/event"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { SessionExecution } from "@opencode/core/session/execution"
import { toSessionError } from "@opencode/core/session/to-session-error"

// Core settles interruption through the coordinator's `reason`, so local marker
// errors are only needed when a drain fails after being told to stop.
class UserInterruptedError extends Error {}

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: "user" | "shutdown" | "superseded") {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  const failure = Cause.squash(exit.cause)
  if (failure instanceof UserInterruptedError) return { type: "interrupted" as const, reason: "user" as const }
  return { type: "failed" as const, error: toSessionError(failure) }
}

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs({ sessionID }),
              ),
        ),
        Effect.asVoid,
      )
    const drain = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      force: boolean,
      continuation?: SessionRunner.Continuation,
      promotable: SessionInbox.Promotable = "input",
      stepped = false,
    ): Effect.fn.Return<void, SessionRunner.RunError> {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      const result = yield* SessionRunner.Service.use((runner) =>
        runner.drain({ sessionID, force, continuation, promotable, stepped }),
      ).pipe(
        Effect.provide(locations.get(session.location)),
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )
      return yield* SessionRunner.DrainResult.$match(result, {
        Complete: () => Effect.void,
        Moved: (result) => drain(sessionID, false, result.continuation, promotable, result.stepped),
        Reloaded: (result) => drain(sessionID, result.force, result.continuation, promotable, result.stepped),
      })
    })
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      SessionRunner.RunError,
      "user" | "shutdown" | "superseded"
    >({
      started: (sessionID) => reportLifecycle(sessionID, events.publish(SessionEvent.Execution.Started, { sessionID })),
      drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
      // One terminal observation per busy period, covering every coalesced drain.
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = terminal(exit, reason)
            if (outcome.type === "succeeded") {
              yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
              return
            }
            if (outcome.type === "interrupted") {
              yield* events.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: outcome.reason })
              return
            }
            yield* events.publish(SessionEvent.Execution.Failed, {
              sessionID,
              error: outcome.error,
            })
          }),
        ),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      interrupt: (sessionID) => coordinator.interrupt(sessionID, "user"),
      resume: coordinator.run,
      wake: coordinator.wake,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, EventV2.node],
})

export * as SessionExecutionLocal from "./session-execution-local"
