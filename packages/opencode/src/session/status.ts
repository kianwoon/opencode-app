import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(function* () {
        // Bun's garbage collector fires on allocation/timer thresholds and can
        // land mid-turn, stealing CPU exactly when a session is streaming.
        // Collect deliberately once the whole process quiesces instead: when
        // the last busy session goes idle (debounced so rapid status flapping
        // doesn't thrash), run a non-blocking full collection. Bun-only — the
        // Node sidecar's V8 GC already schedules itself around mutator activity.
        // Remove when Bun ships an idle-driven GC controller natively
        // (https://github.com/oven-sh/bun/pull/36638).
        let timer: ReturnType<typeof setTimeout> | undefined
        yield* Effect.addFinalizer(() =>
          timer === undefined ? Effect.void : Effect.sync(() => clearTimeout(timer)),
        )
        const onIdle = (idle: boolean) => {
          if (typeof Bun === "undefined") return
          if (timer !== undefined) clearTimeout(timer)
          if (!idle) return
          timer = setTimeout(() => {
            timer = undefined
            Bun.gc(false)
          }, 5_000)
          timer.unref?.()
        }
        return { busy: new Map<SessionID, Info>(), onIdle }
      }),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.busy.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map((yield* InstanceState.get(state)).busy)
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.busy.delete(sessionID)
        data.onIdle(data.busy.size === 0)
        return
      }
      data.busy.set(sessionID, status)
      data.onIdle(false)
    })

    return Service.of({ get, list, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
