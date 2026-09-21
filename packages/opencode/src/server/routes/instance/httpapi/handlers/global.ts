import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Option, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GateConfigUpdateInput, GlobalUpgradeInput } from "../groups/global"

/**
 * Resolved effort-router config, mirroring the plugin's coercion so the panel
 * shows what the router will actually use. Deliberately returns no key material.
 */
const DEFAULT_JEV = { enabled: false, model: "typesafe/jev-1.13", threshold: 0.5 }
const DEFAULT_GUARDRAIL = { enabled: false, model: "typesafe/jev-1.13", denyBelow: 0.3, abstainBelow: 0.7 }
const DEFAULT_RISKY_TOOLS = ["edit", "write", "patch", "bash"]

const DEFAULT_VERDICT_LIMIT = 20
const MAX_VERDICT_LIMIT = 100
// Per-line budget for the bounded tail read; real records are well under this.
const VERDICT_BYTES_PER_LINE = 512

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}

const band = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback

// Mirrors the plugin's `DEFAULTS` in `.opencode/plugin-lib/context-gate.ts`
// (scoping/summarize on, triage off) so an absent file reports what the gate
// would actually do rather than a false "disabled".
const GATE_DEFAULTS = { scopingEnabled: true, summarizeEnabled: true, triageEnabled: false }

function resolveGateConfig(raw: unknown) {
  const root = record(raw)
  return {
    scopingEnabled: typeof root.scopingEnabled === "boolean" ? root.scopingEnabled : GATE_DEFAULTS.scopingEnabled,
    summarizeEnabled: typeof root.summarizeEnabled === "boolean" ? root.summarizeEnabled : GATE_DEFAULTS.summarizeEnabled,
    triageEnabled: typeof root.triageEnabled === "boolean" ? root.triageEnabled : GATE_DEFAULTS.triageEnabled,
  }
}

const text = (value: unknown, fallback: string) =>
  typeof value === "string" && value.length > 0 ? value : fallback

function resolveEffortRouterConfig(raw: unknown) {
  const root = record(raw)
  const jev = record(root.jev)
  const guardrail = record(root.guardrail)
  const riskyTools = Array.isArray(root.riskyTools) ? root.riskyTools.filter((t) => typeof t === "string") : []
  return {
    jev: {
      enabled: jev.enabled === true,
      model: text(jev.model, DEFAULT_JEV.model),
      threshold: band(jev.threshold, DEFAULT_JEV.threshold),
    },
    guardrail: {
      enabled: guardrail.enabled === true,
      model: text(guardrail.model, DEFAULT_GUARDRAIL.model),
      denyBelow: band(guardrail.denyBelow, DEFAULT_GUARDRAIL.denyBelow),
      abstainBelow: band(guardrail.abstainBelow, DEFAULT_GUARDRAIL.abstainBelow),
    },
    riskyTools: riskyTools.length > 0 ? riskyTools : DEFAULT_RISKY_TOOLS,
  }
}

export function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const fs = yield* FSUtil.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    // The router plugin (`.opencode/plugin-lib/task-effort-router.ts`) is not a
    // server dependency — its lib is repo-local and Bun-plugin shaped — so the
    // route re-reads the same on-disk file and re-applies its coercion. Absent
    // or malformed config fails open to the plugin's DEFAULTS, never an error.
    const effortRouter = Effect.fn("GlobalHttpApi.effortRouter")(function* () {
      const file = `${Global.Path.config}/effort-router.json`
      const raw = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      if (!raw) return resolveEffortRouterConfig(undefined)
      return resolveEffortRouterConfig(
        Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw)),
      )
    })

    // Read-only, bounded tail: stat for the size, seek to a window of
    // `limit * VERDICT_BYTES_PER_LINE` bytes from the end, never the whole file.
    const jevVerdicts = Effect.fn("GlobalHttpApi.jevVerdicts")(function* (ctx: {
      query: { limit?: number }
    }) {
      const limit = Math.min(ctx.query.limit ?? DEFAULT_VERDICT_LIMIT, MAX_VERDICT_LIMIT)
      if (limit === 0) return []
      const file = `${Global.Path.data}/effort-router.jsonl`
      const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))
      if (!info) return []
      const tailBytes = Math.min(Number(info.size), limit * VERDICT_BYTES_PER_LINE)
      const chunk = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(file, { flag: "r" })
          yield* handle.seek(Number(info.size) - tailBytes, "start")
          return Option.getOrElse(yield* handle.readAlloc(tailBytes), () => new Uint8Array())
        }),
      ).pipe(Effect.orElseSucceed(() => new Uint8Array()))
      const lines = new TextDecoder().decode(chunk).split("\n").filter((line) => line.length > 0)
      // A seek into the middle of a line leaves a partial first entry: drop it.
      const whole = Number(info.size) > tailBytes ? lines.slice(1) : lines
      return whole.slice(-limit).flatMap((line) => {
        const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(line))
        if (!parsed || typeof parsed !== "object") return []
        return [parsed as Record<string, unknown>]
      }).reverse()
    })

    // Same repo-local-plugin reasoning as `effortRouter` below: re-read the
    // on-disk file and re-apply the plugin's coercion. Absent/malformed fails
    // open to the plugin DEFAULTS, never an error.
    const gateConfigPath = `${Global.Path.config}/context-gate.json`

    const gateConfig = Effect.fn("GlobalHttpApi.gateConfig")(function* () {
      const raw = yield* fs.readFileStringSafe(gateConfigPath).pipe(Effect.orElseSucceed(() => undefined))
      if (!raw) return resolveGateConfig(undefined)
      return resolveGateConfig(Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw)))
    })

    // Only `triageEnabled` is writable here; every other on-disk key is
    // preserved verbatim. The current file is backed up before a write so a bad
    // toggle is recoverable without git.
    const gateConfigUpdate = Effect.fn("GlobalHttpApi.gateConfigUpdate")(function* (ctx: {
      payload: typeof GateConfigUpdateInput.Type
    }) {
      if (ctx.payload.triageEnabled === undefined) return yield* new HttpApiError.BadRequest({})
      const raw = yield* fs.readFileStringSafe(gateConfigPath).pipe(Effect.orElseSucceed(() => undefined))
      const parsed = raw
        ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw))
        : undefined
      const existing = record(parsed)
      const current = resolveGateConfig(existing)
      if (ctx.payload.triageEnabled === current.triageEnabled) return current
      if (raw)
        yield* fs
          .writeWithDirs(
            `${Global.Path.config}/.cache-fix-backup-20260921-212521/context-gate.json.pre-toggle-${Date.now()}`,
            raw,
          )
          .pipe(Effect.orElseSucceed(() => undefined))
      const next = { ...existing, triageEnabled: ctx.payload.triageEnabled }
      yield* fs
        .writeWithDirs(gateConfigPath, `${JSON.stringify(next, null, 2)}\n`)
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return resolveGateConfig(next)
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      // Drop the cached global config so a subsequent read re-parses the on-disk
      // config (the cache is TTL-infinity, so it would otherwise never refresh).
      yield* config.invalidate()
      yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("effortRouter", effortRouter)
      .handle("jevVerdicts", jevVerdicts)
      .handle("gateConfig", gateConfig)
      .handle("gateConfigUpdate", gateConfigUpdate)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
