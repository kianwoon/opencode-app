import * as InstanceState from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Plugin } from "@/plugin"
import { FileSystem } from "@opencode/core/filesystem"
import { Pty } from "@opencode/core/pty"
import { PtyProtocol } from "@opencode/core/pty/protocol"
import { PtyID } from "@/compat/pty-schema"
import { PtyTicket } from "@opencode/core/pty/ticket"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode/core/location-services"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { ShellSelect } from "@opencode/core/shell/select"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "@opencode/server/cors"
import {
  PTY_CONNECT_TICKET_QUERY,
  PTY_CONNECT_TOKEN_HEADER,
  PTY_CONNECT_TOKEN_HEADER_VALUE,
} from "@/server/shared/pty-ticket"
import { Effect, Layer, Option, Queue, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Socket from "effect/socket/Socket"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import { CursorQuery, PtyConnectApi } from "../groups/pty"
import { WebSocketTracker } from "../websocket-tracker"
import { runPtySocket } from "@opencode/server/handlers/pty-socket"

function validOrigin(request: HttpServerRequest.HttpServerRequest, opts: CorsOptions | undefined) {
  return isAllowedRequestOrigin(request.headers.origin, request.headers.host, opts)
}

const locationServiceMapLayer = buildLocationServiceMap()

const ticketScope = Effect.gen(function* () {
  const instance = yield* InstanceRef
  const workspaceID = yield* WorkspaceRef
  return { directory: instance?.directory, workspaceID }
})

// Legacy surface compatibility: before exited-session retention, sessions vanished the moment
// their process exited. These routes preserve that observable behavior — exited sessions are
// invisible here — while the canonical /api/pty surface exposes them until removal.
export const ptyHandlers = HttpApiBuilder.group(InstanceHttpApi, "pty", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const plugin = yield* Plugin.Service
    const locations = yield* LocationServiceMap.Service
    const unregister = registerDisposer((directory) =>
      Effect.runPromise(locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unregister))

    const pty = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
        Effect.catchIf(
          (error): error is FileSystem.DirectoryNotFoundError => error instanceof FileSystem.DirectoryNotFoundError,
          (error) =>
            Effect.fail(new ApiError.InvalidRequestError({ message: `Directory not found: ${error.directory}` })),
        ),
      )
    })

    const shells = Effect.fn("PtyHttpApi.shells")(function* () {
      return yield* pty(ShellSelect.Service.use((service) => service.list?.() ?? Effect.succeed([])))
    })

    const list = Effect.fn("PtyHttpApi.list")(function* () {
      const sessions = yield* pty(Pty.Service.use((service) => service.list()))
      return sessions.filter((info) => info.status === "running")
    })

    const create = Effect.fn("PtyHttpApi.create")(function* (ctx: { payload: typeof Pty.CreateInput.Type }) {
      const cwd = ctx.payload.cwd || (yield* InstanceState.context).directory
      const shell = yield* plugin.trigger("shell.env", { cwd }, { env: {} as Record<string, string> })
      return yield* pty(
        Pty.Service.use((service) =>
          service.create({
            ...ctx.payload,
            args: ctx.payload.args ? [...ctx.payload.args] : undefined,
            cwd,
            env: { ...ctx.payload.env, ...shell.env },
          }),
        ),
      )
    })

    const get = Effect.fn("PtyHttpApi.get")(function* (ctx: { params: { ptyID: PtyID } }) {
      return yield* pty(Pty.Service.use((service) => service.get(ctx.params.ptyID))).pipe(
        Effect.catchTag(
          "Pty.NotFoundError",
          (error) =>
            new ApiError.PtyNotFoundError({
              ptyID: error.ptyID,
              message: `PTY session not found: ${error.ptyID}`,
            }),
        ),
        Effect.flatMap((info) =>
          info.status === "running"
            ? Effect.succeed(info)
            : new ApiError.PtyNotFoundError({
                ptyID: ctx.params.ptyID,
                message: `PTY session not found: ${ctx.params.ptyID}`,
              }),
        ),
      )
    })

    const update = Effect.fn("PtyHttpApi.update")(function* (ctx: {
      params: { ptyID: PtyID }
      payload: typeof Pty.UpdateInput.Type
    }) {
      yield* get(ctx)
      return yield* pty(
        Pty.Service.use((service) =>
          service.update(ctx.params.ptyID, {
            ...ctx.payload,
            size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
          }),
        ),
      ).pipe(
        Effect.catchTag(
          "Pty.NotFoundError",
          (error) =>
            new ApiError.PtyNotFoundError({
              ptyID: error.ptyID,
              message: `PTY session not found: ${error.ptyID}`,
            }),
        ),
      )
    })

    const remove = Effect.fn("PtyHttpApi.remove")(function* (ctx: { params: { ptyID: PtyID } }) {
      yield* get(ctx)
      yield* pty(Pty.Service.use((service) => service.remove(ctx.params.ptyID))).pipe(
        Effect.catchTag(
          "Pty.NotFoundError",
          (error) =>
            new ApiError.PtyNotFoundError({
              ptyID: error.ptyID,
              message: `PTY session not found: ${error.ptyID}`,
            }),
        ),
      )
      return true
    })

    const connectToken = Effect.fn("PtyHttpApi.connectToken")(function* (ctx: { params: { ptyID: PtyID } }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE || !validOrigin(request, cors))
        return yield* new ApiError.PtyForbiddenError({ message: "Invalid PTY connect token request" })
      yield* get(ctx)
      return yield* tickets.issue({ ptyID: ctx.params.ptyID, ...(yield* ticketScope) })
    })

    return handlers
      .handle("shells", shells)
      .handle("list", list)
      .handle("create", create)
      .handle("get", get)
      .handle("update", update)
      .handle("remove", remove)
      .handle("connectToken", connectToken)
  }),
).pipe(Layer.provide(locationServiceMapLayer))

export const ptyConnectHandlers = HttpApiBuilder.group(PtyConnectApi, "pty-connect", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const locations = yield* LocationServiceMap.Service
    const unregister = registerDisposer((directory) =>
      Effect.runPromise(locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unregister))

    return handlers.handleRaw(
      "connect",
      Effect.fn("PtyHttpApi.connect")(function* (ctx: {
        params: { ptyID: PtyID }
        request: HttpServerRequest.HttpServerRequest
      }) {
        if (!validOrigin(ctx.request, cors)) return HttpServerResponse.empty({ status: 403 })

        const ticket = new URL(ctx.request.url, "http://localhost").searchParams.get(PTY_CONNECT_TICKET_QUERY)
        if (ticket && !(yield* tickets.consume({ ticket, ptyID: ctx.params.ptyID, ...(yield* ticketScope) })))
          return HttpServerResponse.empty({ status: 403 })

        const directory = (yield* InstanceState.context).directory
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))
        const exists = yield* Pty.Service.use((service) => service.get(ctx.params.ptyID)).pipe(
          Effect.provide(location),
          Effect.map((info) => info.status === "running"),
          Effect.catchTags({
            "Pty.NotFoundError": () => Effect.succeed(false),
            "FileSystem.DirectoryNotFoundError": () => Effect.succeed(false),
          }),
        )
        if (!exists) return HttpServerResponse.empty({ status: 404 })

        const query = Schema.decodeUnknownOption(CursorQuery)(yield* HttpServerRequest.ParsedSearchParams)
        if (Option.isNone(query)) return HttpServerResponse.empty({ status: 400 })
        const parsedCursor = query.value.cursor === undefined ? undefined : Number(query.value.cursor)
        const cursor =
          parsedCursor !== undefined && Number.isSafeInteger(parsedCursor) && parsedCursor >= -1
            ? parsedCursor
            : undefined
        const socket = yield* Effect.orDie(ctx.request.upgrade)
        const writer = yield* socket.writer
        const registered = yield* WebSocketTracker.register(
          writer.write(WebSocketTracker.SERVER_CLOSING_EVENT()).pipe(Effect.ignore),
        )
        if (!registered) return HttpServerResponse.empty()

        // Outbound frames flow through one queue drained by a single writer so replay, live
        // output, and the close frame keep their order.
        const outbox = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>()
        const attachment = yield* Pty.Service.use((service) =>
          service.attach(ctx.params.ptyID, {
            cursor,
            onData: (chunk) => Queue.offerUnsafe(outbox, chunk),
            onEnd: () => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000)),
          }),
        ).pipe(
          Effect.provide(location),
          Effect.catchTags({
            "Pty.NotFoundError": () =>
              Effect.sync(() => {
                Queue.offerUnsafe(outbox, new Socket.CloseEvent(4404, "session not found"))
              }),
            "Pty.ExitedError": () =>
              Effect.sync(() => {
                Queue.offerUnsafe(outbox, new Socket.CloseEvent(4404, "session not found"))
              }),
            "FileSystem.DirectoryNotFoundError": () =>
              Effect.sync(() => {
                Queue.offerUnsafe(outbox, new Socket.CloseEvent(4404, "session not found"))
              }),
          }),
        )
        if (attachment) {
          for (const chunk of PtyProtocol.chunks(attachment.replay)) Queue.offerUnsafe(outbox, chunk)
          Queue.offerUnsafe(outbox, PtyProtocol.metaFrame(attachment.cursor))
          attachment.activate()
        }

        yield* runPtySocket({
          socket,
          outbox,
          onMessage: (message) =>
            Effect.sync(() => {
              if (!attachment) return
              const decoded = PtyProtocol.decodeInput(message)
              if (decoded !== undefined) attachment.write(decoded)
            }),
          detach: () => attachment?.detach(),
        })
        return HttpServerResponse.empty()
      }),
    )
  }),
).pipe(Layer.provide(locationServiceMapLayer))
