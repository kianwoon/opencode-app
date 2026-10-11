import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * compaction-fuel — relevance-guided compaction.
 *
 * Compacted content is fuel for the next window, so summarization must be
 * relevance-guided, not blind: before the host compacts, older user→assistant
 * turns are scored for how load-bearing they are for the LATEST request, and
 * the keepers inject PRESERVE directives into the compaction prompt so their
 * specifics (decisions, file paths, commands, outcomes) survive verbatim.
 *
 * Config lives at ~/.config/opencode/compaction-fuel.json and is OFF by
 * default. Fail-open everywhere: a missing key, unknown provider, timeout,
 * malformed response, or empty history leaves the compaction prompt untouched.
 */

type FuelConfig = {
  enabled: boolean
  model: string
  threshold: number
  floor: number
  maxKeeps: number
  maxTurns: number
  tailSkip: number
  digestChars: number
  timeoutMs: number
}

const DEFAULTS: FuelConfig = {
  enabled: false,
  model: "openrouter/perplexity/pplx-decider-v1.1-27b",
  threshold: 0.6,
  floor: 0.3,
  maxKeeps: 5,
  maxTurns: 12,
  tailSkip: 2,
  digestChars: 700,
  timeoutMs: 8_000,
}

/** Coerce a loaded value so a malformed config fails open to code defaults. */
function resolveFuelConfig(raw: unknown): FuelConfig {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const band = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
  const count = (value: unknown, fallback: number, max = Number.POSITIVE_INFINITY) =>
    Math.min(typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback, max)
  const d = DEFAULTS
  return {
    enabled: r.enabled === true,
    model: typeof r.model === "string" && r.model.length > 0 ? r.model : d.model,
    threshold: band(r.threshold, d.threshold),
    floor: band(r.floor, d.floor),
    maxKeeps: count(r.maxKeeps, d.maxKeeps, 20),
    maxTurns: count(r.maxTurns, d.maxTurns, 48),
    tailSkip: count(r.tailSkip, d.tailSkip),
    digestChars: count(r.digestChars, d.digestChars, 4_000),
    timeoutMs: count(r.timeoutMs, d.timeoutMs, 30_000),
  }
}

// ---------------------------------------------------------------------------
// Transport — copied from jev-effort.ts (plugin-lib stays zero-dependency). A
// `provider/model-id` spec resolves to its own endpoint, so a `typesafe/*` spec
// never goes to openrouter.ai. Unknown providers return undefined → fail-open.
// ---------------------------------------------------------------------------
const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")

const ENDPOINTS: Readonly<Record<string, string>> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/alpha/decisions",
}

const KEY_ENV: Readonly<Record<string, string>> = { typesafe: "TYPESAFE_API_KEY", openrouter: "OPENROUTER_API_KEY" }

type Transport = { provider: string; id: string; endpoint: string }

const transportOf = (spec: string): Transport | undefined => {
  const raw = spec.trim()
  const slash = raw.indexOf("/")
  if (slash <= 0) return undefined
  const provider = raw.slice(0, slash)
  const id = raw.slice(slash + 1)
  if (!id) return undefined
  const endpoint = ENDPOINTS[provider]
  if (!endpoint) return undefined
  return { provider, id, endpoint }
}

/** Key from the auth.json namespace, then the provider's env var; never logged. */
const keyFor = (provider: string): string | undefined => {
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<string, { key?: string }>
    const k = auth[provider]?.key
    if (typeof k === "string" && k.length > 0) return k
  } catch {
    // fall through to env
  }
  const name = KEY_ENV[provider]
  const env = name ? process.env[name] : undefined
  return typeof env === "string" && env.length > 0 ? env : undefined
}

// ---------------------------------------------------------------------------
// Pure fold — no fetch/Effect/clock, so tests drive the real function.
// ---------------------------------------------------------------------------

/** A `score` question's criteria MUST be an ordered string array; the record
 * label→description form a `choice` uses is rejected with HTTP 422 here. */
const SCORE_CRITERIA = [
  "Irrelevant to the latest request",
  "Background: contextually useful",
  "Load-bearing: the latest work depends on its specifics",
] as const

type FuelTurn = { readonly id: string; readonly user: string; readonly assistant: string }
type FuelKeepOpts = { threshold: number; floor: number; maxKeeps: number }

const DIGEST_HEAD_CHARS = 160

const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max))

/** Read the finite `probabilities[key]` of a score row; undefined when absent. */
const probability = (row: unknown, key: string): number | undefined => {
  if (!row || typeof row !== "object") return undefined
  const probabilities = (row as Record<string, unknown>).probabilities
  if (!probabilities || typeof probabilities !== "object") return undefined
  const value = (probabilities as Record<string, unknown>)[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const loadDirective = (digestHead: string): string =>
  `[compaction-fuel] The latest work depends on this earlier exchange (user asked: "${digestHead}"): preserve its key decisions, file paths, commands, and outcomes VERBATIM in your summary.`

const backgroundDirective = (digestHead: string): string =>
  `[compaction-fuel] This earlier exchange is contextually useful (user asked: "${digestHead}"): weave its gist into the summary without losing concrete specifics.`

/**
 * Invariant: ONLY a measured score row whose `probabilities["2"]` (load-bearing)
 * or `probabilities["1"]` (background) clears max(threshold, floor) earns a
 * directive, and the two tiers together never exceed maxKeeps. Load-bearing is
 * ranked first by its probability; background only fills the slots left over.
 * Answers keyed by ids absent from `turns` are ignored — we index by turn, never
 * by answer.
 */
export function fuelKeeps(
  answers: Record<string, unknown>,
  turns: readonly FuelTurn[],
  opts: FuelKeepOpts,
): { loadBearing: string[]; background: string[] } {
  const gate = Math.max(opts.threshold, opts.floor)
  const rows = turns.map((turn) => ({
    id: turn.id,
    digestHead: clip(turn.user, DIGEST_HEAD_CHARS),
    load: probability(answers[`turn:${turn.id}`], "2"),
    background: probability(answers[`turn:${turn.id}`], "1"),
  }))
  const loadBearing = rows
    .filter((row) => row.load !== undefined && row.load >= gate)
    .sort((a, b) => (b.load ?? 0) - (a.load ?? 0))
    .slice(0, opts.maxKeeps)
  const kept = new Set(loadBearing.map((row) => row.id))
  const background = rows
    .filter((row) => !kept.has(row.id) && row.background !== undefined && row.background >= gate)
    .sort((a, b) => (b.background ?? 0) - (a.background ?? 0))
    .slice(0, Math.max(0, opts.maxKeeps - loadBearing.length))
  return {
    loadBearing: loadBearing.map((row) => loadDirective(row.digestHead)),
    background: background.map((row) => backgroundDirective(row.digestHead)),
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
type SessionMessage = { info: { id: string; role: string }; parts: ReadonlyArray<Part> }

const firstText = (parts: ReadonlyArray<Part>): string => {
  const part = parts.find((p) => p.type === "text")
  return part?.type === "text" ? part.text : ""
}

/** Consecutive user→assistant pairs, mirroring turns() in compaction.ts. */
const buildTurns = (messages: readonly SessionMessage[], digestChars: number): FuelTurn[] => {
  const visible = messages.filter((message) => !message.parts.some((part) => part.type === "compaction"))
  const turns: FuelTurn[] = []
  let pending: { id: string; user: string } | undefined
  for (const message of visible) {
    if (message.info.role === "user") {
      pending = { id: message.info.id, user: clip(firstText(message.parts), digestChars) }
      continue
    }
    if (!pending) continue
    turns.push({ id: pending.id, user: pending.user, assistant: clip(firstText(message.parts), digestChars) })
    pending = undefined
  }
  return turns
}

const REQUEST_CHARS = 2_000

const latestRequest = (messages: readonly SessionMessage[]): string => {
  const lastUser = [...messages].reverse().find((message) => message.info.role === "user")
  return lastUser ? clip(firstText(lastUser.parts), REQUEST_CHARS) : ""
}

async function loadFuelConfig(): Promise<FuelConfig> {
  const fs = await import("node:fs/promises")
  const dir = process.env.OPENCODE_CONFIG_DIR ?? `${process.env.HOME}/.config/opencode`
  const parsed: unknown = JSON.parse(await fs.readFile(`${dir}/compaction-fuel.json`, "utf8"))
  return resolveFuelConfig(parsed)
}

async function injectFuel(
  ctx: PluginInput,
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
): Promise<void> {
  const cfg = await loadFuelConfig()
  if (!cfg.enabled) return
  // `limit` returns the NEWEST N messages (tail), not the first N: the handler
  // (httpapi/handlers/session.ts:123-129) calls MessageV2.page, which orders
  // desc(time_created) before .limit + reverses to chronological order
  // (session/message-v2.ts:463,484). So a bounded fetch still keeps recent turns.
  const data =
    (
      await ctx.client.session.messages({
        path: { id: input.sessionID },
        query: { limit: cfg.maxTurns * 2 + cfg.tailSkip * 2 + 2 },
      })
    ).data ?? []
  const turns = buildTurns(data, cfg.digestChars)
  if (turns.length === 0) return
  const eligible = turns.slice(0, Math.max(0, turns.length - cfg.tailSkip)).slice(-cfg.maxTurns)
  if (eligible.length === 0) return
  const transport = transportOf(cfg.model)
  const key = transport ? keyFor(transport.provider) : undefined
  if (!transport || !key) return
  const questions = Object.fromEntries(
    eligible.map((turn) => [
      `turn:${turn.id}`,
      { type: "score", instructions: "How load-bearing is this earlier exchange for the latest request?", criteria: SCORE_CRITERIA },
    ]),
  )
  const res = await fetch(transport.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: transport.id,
      state: JSON.stringify({
        request: latestRequest(data),
        turns: eligible.map((turn) => ({ id: turn.id, user: turn.user, assistant: turn.assistant })),
      }),
      questions,
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  if (!res.ok) return
  const envelope = (await res.json()) as { model?: unknown; answers?: unknown }
  if (typeof envelope.model !== "string" || envelope.model.length === 0) return
  const answers =
    envelope.answers && typeof envelope.answers === "object" ? (envelope.answers as Record<string, unknown>) : {}
  const { loadBearing, background } = fuelKeeps(answers, eligible, {
    threshold: cfg.threshold,
    floor: cfg.floor,
    maxKeeps: cfg.maxKeeps,
  })
  const directives = [...loadBearing, ...background]
  output.context.push(...directives)
  console.log(JSON.stringify({ event: "compaction-fuel", scored: eligible.length, kept: directives.length, injected: directives.length }))
}

export const CompactionFuelPlugin: Plugin = async (ctx) => ({
  "experimental.session.compacting": async (input, output) => {
    await injectFuel(ctx, input, output).catch(() => {
      // Deliberate catch at the plugin hook boundary: a throw here would abort
      // the host's compaction path, so any failure must leave output untouched.
    })
  },
})

// Default-export the PluginModule shape so the loader takes the v1 path; a bare
// function default would make the legacy scan treat every exported fn as a plugin.
export default {
  id: "compaction-fuel",
  server: CompactionFuelPlugin,
}
