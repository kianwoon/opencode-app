import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Effect, Option, Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

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
    summarizeEnabled:
      typeof root.summarizeEnabled === "boolean" ? root.summarizeEnabled : GATE_DEFAULTS.summarizeEnabled,
    triageEnabled: typeof root.triageEnabled === "boolean" ? root.triageEnabled : GATE_DEFAULTS.triageEnabled,
  }
}

const text = (value: unknown, fallback: string) => (typeof value === "string" && value.length > 0 ? value : fallback)

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

const parseJson = (raw: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(raw))

export const OrchestrationHandler = HttpApiBuilder.group(Api, "server.orchestration", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service

    const effortRouterPath = `${global.config}/effort-router.json`
    const verdictsPath = `${global.data}/effort-router.jsonl`
    const gateConfigPath = `${global.config}/context-gate.json`

    // The router plugin (`.opencode/plugin-lib/task-effort-router.ts`) is not a
    // server dependency — its lib is repo-local and Bun-plugin shaped — so the
    // route re-reads the same on-disk file and re-applies its coercion. Absent
    // or malformed config fails open to the plugin's DEFAULTS, never an error.
    const effortRouter = Effect.fn("OrchestrationHttpApi.effortRouter")(function* () {
      const raw = yield* fs.readFileStringSafe(effortRouterPath).pipe(Effect.orElseSucceed(() => undefined))
      if (!raw) return resolveEffortRouterConfig(undefined)
      return resolveEffortRouterConfig(parseJson(raw))
    })

    // Read-only, bounded tail: stat for the size, seek to a window of
    // `limit * VERDICT_BYTES_PER_LINE` bytes from the end, never the whole file.
    const jevVerdicts = Effect.fn("OrchestrationHttpApi.jevVerdicts")(function* (ctx: { query: { limit?: number } }) {
      const limit = Math.min(ctx.query.limit ?? DEFAULT_VERDICT_LIMIT, MAX_VERDICT_LIMIT)
      if (limit === 0) return []
      const info = yield* fs.stat(verdictsPath).pipe(Effect.orElseSucceed(() => undefined))
      if (!info) return []
      const tailBytes = Math.min(Number(info.size), limit * VERDICT_BYTES_PER_LINE)
      const chunk = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(verdictsPath, { flag: "r" })
          yield* handle.seek(info.size - BigInt(tailBytes), "start")
          return Option.getOrElse(yield* handle.readAlloc(tailBytes), () => new Uint8Array())
        }),
      ).pipe(Effect.orElseSucceed(() => new Uint8Array()))
      const lines = new TextDecoder()
        .decode(chunk)
        .split("\n")
        .filter((line) => line.length > 0)
      // A seek into the middle of a line leaves a partial first entry: drop it.
      const whole = Number(info.size) > tailBytes ? lines.slice(1) : lines
      return whole
        .slice(-limit)
        .flatMap((line) => {
          const parsed = parseJson(line)
          if (!parsed || typeof parsed !== "object") return []
          return [parsed as Record<string, unknown>]
        })
        .reverse()
    })

    // Same repo-local-plugin reasoning as `effortRouter` above: re-read the
    // on-disk file and re-apply the plugin's coercion. Absent/malformed fails
    // open to the plugin DEFAULTS, never an error.
    const gateConfig = Effect.fn("OrchestrationHttpApi.gateConfig")(function* () {
      const raw = yield* fs.readFileStringSafe(gateConfigPath).pipe(Effect.orElseSucceed(() => undefined))
      if (!raw) return resolveGateConfig(undefined)
      return resolveGateConfig(parseJson(raw))
    })

    // Only `triageEnabled` is writable here; every other on-disk key is
    // preserved verbatim. The current file is backed up before a write so a bad
    // toggle is recoverable without git.
    const gateConfigUpdate = Effect.fn("OrchestrationHttpApi.gateConfigUpdate")(function* (ctx: {
      payload: { triageEnabled?: boolean }
    }) {
      if (ctx.payload.triageEnabled === undefined)
        return yield* new InvalidRequestError({ message: "triageEnabled is required", field: "triageEnabled" })
      const raw = yield* fs.readFileStringSafe(gateConfigPath).pipe(Effect.orElseSucceed(() => undefined))
      const existing = record(raw ? parseJson(raw) : undefined)
      const current = resolveGateConfig(existing)
      if (ctx.payload.triageEnabled === current.triageEnabled) return current
      if (raw)
        yield* fs
          .writeWithDirs(
            `${global.config}/.cache-fix-backup-20260921-212521/context-gate.json.pre-toggle-${Date.now()}`,
            raw,
          )
          .pipe(Effect.orElseSucceed(() => undefined))
      const next = { ...existing, triageEnabled: ctx.payload.triageEnabled }
      yield* fs.writeWithDirs(gateConfigPath, `${JSON.stringify(next, null, 2)}\n`).pipe(
        Effect.mapError(
          (cause) => new InvalidRequestError({ message: `Failed to write context-gate.json: ${cause.message}` }),
        ),
      )
      return resolveGateConfig(next)
    })

    return handlers
      .handle("orchestration.effortRouter", effortRouter)
      .handle("orchestration.jevVerdicts", jevVerdicts)
      .handle("orchestration.gateConfig", gateConfig)
      .handle("orchestration.gateConfigUpdate", gateConfigUpdate)
  }),
)
