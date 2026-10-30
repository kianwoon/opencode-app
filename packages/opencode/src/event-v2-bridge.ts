// Opencode publish boundary for core events. Attach routed instance location
// so direct consumers can isolate directory/workspace streams. Publishing
// through Bus (not the legacy EventV2 store) keeps Bus projectors — notably
// SessionProjector — running on every event the fork emits.
import { LayerNode } from "@opencode/util/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { Bus } from "@opencode/core/bus"
import { EventV2 } from "@opencode/core/event"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Context, Effect, Layer } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@opencode/EventV2Bridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Bus is the canonical store: it commits durable rows and runs registered
    // projectors in the same transaction. EventV2 remains the read/compat
    // surface for callers that need its legacy stream helpers.
    const bus = yield* Bus.Service
    const events = yield* EventV2.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* bus.publish(definition, data, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* bus.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* bus.publish(definition, data, {
          ...options,
          location: Location.Ref.make({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
          }),
        })
      })

    const unsubscribe = yield* bus.listen((event) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: Bus.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              data: event.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ...bus, all: events.all, durable: events.durable, replayAll: events.replayAll, publish })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Bus.node, EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
