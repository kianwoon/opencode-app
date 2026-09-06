import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

/**
 * Task Effort Router — a self-adjusting reasoning-effort governor.
 *
 * Philosophy: don't predict task difficulty upfront. Assess signals from
 * exactly three sources — message shape (fences, line/word counts, frame
 * shape), real tool behavior (which tools actually executed), and config
 * files (effort-router.json thresholds/risk list/agent name, opencode.json
 * brain.model) — on each new user message and provider turn, at zero LLM
 * cost, and let the model escalate further via the `request_effort` tool
 * when the work proves harder than expected. No lexical matching anywhere:
 * zero regex literals, zero keyword lists.
 * - `experimental.chat.system.transform` appends short discovery lines so the
 *   model knows the tool exists and when to use it, plus a verification
 *   caution line for sessions that used mutating tools.
 * - `Hooks.tool` registers a `request_effort` tool the model calls to escalate.
 *   Escalation is monotonic (never decreases), capped a couple of rungs above
 *   the baseline, and rate-limited per task.
 *
 * Key principle: effort ≠ risk. This plugin never touches permissions.
 */

const LADDER = ["minimal", "low", "medium", "high"] as const
type Effort = (typeof LADDER)[number]

/**
 * Router config mirroring effort-router.json. Every threshold, list and
 * identity string the router uses lives here — nothing is hardcoded.
 */
type RouterConfig = {
  minimalWords: number
  mediumWords: number
  mediumLines: number
  stackFrames: number
  fenceWords: number
  riskyTools: string[]
  brainAgent: string
  budgetBands: { low: number; medium: number }
}

const DEFAULTS: RouterConfig = {
  minimalWords: 12,
  mediumWords: 60,
  mediumLines: 60,
  stackFrames: 3,
  fenceWords: 40,
  riskyTools: ["edit", "write", "patch", "bash"],
  brainAgent: "brain",
  budgetBands: { low: 8000, medium: 20000 },
}

/** Shape-check a loaded value so malformed configs fail open, never throw. */
function isConfig(value: unknown): value is RouterConfig {
  if (!value || typeof value !== "object") return false
  const cfg = value as Record<string, unknown>
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v)
  const bands = cfg.budgetBands as Record<string, unknown> | undefined
  return (
    num(cfg.minimalWords) &&
    num(cfg.mediumWords) &&
    num(cfg.mediumLines) &&
    num(cfg.stackFrames) &&
    num(cfg.fenceWords) &&
    Array.isArray(cfg.riskyTools) &&
    cfg.riskyTools.every((t) => typeof t === "string") &&
    typeof cfg.brainAgent === "string" &&
    !!bands &&
    num(bands.low) &&
    num(bands.medium)
  )
}

/** Known wire values that exceed the top of our ladder; treated as `high`. */
const SUPER_TIERS = new Set(["xhigh", "max"])

type State = {
  /** Run the model escalated to. `undefined` until the first escalation. */
  escalated: Effort | undefined
  /** Task-boundary rung from the structural profile. Floors the ladder. */
  baseline: Effort | undefined
  /** Escalations granted for the current task (baseline does not count). */
  escalations: number
  /** True when the session has actually run a mutating tool. */
  risky: boolean
  /** Provider turns seen for the current task (chat.params call count). */
  turns: number
  /** Whether a skip was already logged for the current task. */
  skipLogged: boolean
  /** Last assessed message fingerprint, for chat.message double-fire dedup. */
  lastMessage?: { text: string; ts: number }
}

/**
 * Best-effort JSONL observability so firings can be counted directly instead
 * of inferred from token distributions. One line per decision:
 * `{ts, event, sessionID, ...}`. Never throws — logging must not break the
 * request pipeline, and a missing/unwritable XDG dir degrades to silence.
 * Node built-ins load via dynamic import (desktop-sidecar safe).
 *
 * Rotation: when the file crosses MAX_LOG_BYTES it is truncated from the
 * front (newest lines kept) so long-running installs stay bounded. Checked
 * at most once per rotation interval of appends.
 */
const dataRoot = () => process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`

const MAX_LOG_BYTES = 4 * 1024 * 1024
const ROTATION_CHECK_EVERY = 500

let appendsSinceCheck = 0

async function rotateIfNeeded(fs: typeof import("node:fs/promises"), file: string) {
  appendsSinceCheck += 1
  if (appendsSinceCheck < ROTATION_CHECK_EVERY) return
  appendsSinceCheck = 0
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat || stat.size < MAX_LOG_BYTES) return
  const raw = await fs.readFile(file, "utf8").catch(() => "")
  const lines = raw.split("\n").filter(Boolean)
  // Keep roughly the newest half; drop partial first line risk by keeping
  // whole lines only.
  const keep = lines.slice(Math.floor(lines.length / 2))
  if (keep.length === lines.length) return
  await fs.writeFile(file, keep.join("\n") + "\n")
}

function log(event: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: Date.now(), event, ...fields }) + "\n"
  void (async () => {
    try {
      const { appendFile, mkdir } = await import("node:fs/promises")
      const dir = `${dataRoot()}/opencode`
      const file = `${dir}/effort-router.jsonl`
      await mkdir(dir, { recursive: true })
      await appendFile(file, line)
      await rotateIfNeeded(await import("node:fs/promises"), file)
    } catch {
      // Observability is best-effort by design.
    }
  })()
}

/**
 * Max words for a no-signal structural prompt to still count as minimal:
 * DEFAULTS.minimalWords (kept for readability; the live value is config).
 */

/**
 * Word count without regex: plain-text separator splits only. Chained on
 * space/newline/tab/carriage-return so mixed-whitespace prose still counts.
 */
function countWords(text: string): number {
  return text
    .split(" ")
    .flatMap((chunk) => chunk.split("\n"))
    .flatMap((chunk) => chunk.split("\t"))
    .flatMap((chunk) => chunk.split("\r"))
    .filter((chunk) => chunk.length > 0).length
}

/** Digit check by char scan — no regex. */
function hasDigit(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i)
    if (code >= 48 && code <= 57) return true
  }
  return false
}

/**
 * Frame-line shape, language-agnostic and keyword-free: a location separator
 * (/ or \) plus at least one digit somewhere in the line. Matches JS "at"
 * frames, Python 'File "/app/main.py", line 42', Rust, Go, etc. — anything
 * with a path and a position. Never inspects the words themselves.
 */
function isFrameLine(line: string): boolean {
  return (line.includes("/") || line.includes("\\")) && hasDigit(line)
}

/**
 * Structural profile of a task from its text. Cheap on purpose — the exact
 * words are never inspected; only shape is: frame-shaped lines, code fences,
 * line count, and total length. Everything else is left to the escalation
 * path (`request_effort`).
 */
function assess(text: string | undefined, cfg: RouterConfig = DEFAULTS): { baseline: Effort | undefined; risky: boolean } {
  // Empty or whitespace-only text (attachments-only messages, blank fires)
  // carries no signal: no opinion rather than a minimal baseline.
  if (!text || text.trim().length === 0) return { baseline: undefined, risky: false }
  const words = countWords(text)
  const lines = text.split("\n")
  // Stack-trace shape: >= cfg.stackFrames lines with a path separator and a
  // digit — language-agnostic, no "at " keyword.
  const frames = lines.filter(isFrameLine).length
  if (frames >= cfg.stackFrames) return { baseline: "medium", risky: false }
  // Pasted code (an opened and closed fence) plus a real explanation.
  const fences = text.split("```").length - 1
  if (fences >= 2 && words > cfg.fenceWords) return { baseline: "medium", risky: false }
  if (lines.length > cfg.mediumLines) return { baseline: "medium", risky: false }
  // Length-only complexity proxy: long prose correlates with multi-part work.
  if (words > cfg.mediumWords) return { baseline: "medium", risky: false }
  // Short imperative prompts with zero structural signal are the most
  // common task shape. Start lean: escalation recovers the rare hard ones.
  if (words <= cfg.minimalWords) return { baseline: "minimal", risky: false }
  // No opinion — the escalation path handles the rest.
  return { baseline: undefined, risky: false }
}

/**
 * Risk from behavior, never words: the config's riskyTools list (exact,
 * case-insensitive equality on the executed tool name) decides what marks a
 * session risky. No substring matching, no regex.
 */
function noteToolUse(entry: State, toolName: string, riskyTools: readonly string[] = DEFAULTS.riskyTools): boolean {
  const lower = toolName.toLowerCase()
  const risky = riskyTools.some((name) => name.toLowerCase() === lower)
  if (risky) entry.risky = true
  return risky
}

/**
 * effort-router.json loader: mtime-gated refresh at most once per refresh
 * interval, failing open to last-known (initially DEFAULTS). Malformed JSON
 * or wrong-typed fields keep the last-known config and never throw.
 */
const CONFIG_REFRESH_MS = 60_000

const configCache: { config: RouterConfig; mtimeMs: number; checkedAt: number } = {
  config: DEFAULTS,
  mtimeMs: -1,
  checkedAt: 0,
}

async function loadRouterConfig(): Promise<RouterConfig> {
  const now = Date.now()
  if (now - configCache.checkedAt < CONFIG_REFRESH_MS) return configCache.config
  configCache.checkedAt = now
  try {
    const fs = await import("node:fs/promises")
    const dir = process.env.OPENCODE_CONFIG_DIR ?? `${process.env.HOME}/.config/opencode`
    const file = `${dir}/effort-router.json`
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat) return configCache.config
    if (stat.mtimeMs !== configCache.mtimeMs) {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"))
      if (isConfig(parsed)) {
        configCache.config = parsed
        configCache.mtimeMs = stat.mtimeMs
      }
    }
    return configCache.config
  } catch {
    return configCache.config
  }
}

/**
 * Brain identity from config, never from model-id substrings. Reads the
 * `brain.model` field (lowercased) from opencode.json, cached and refreshed
 * at most once per refresh interval via mtime. Any failure fails open to the
 * last-known value (initially undefined → no brain floor).
 */
const BRAIN_MODEL_REFRESH_MS = 60_000

const brainModelCache: { model: string | undefined; mtimeMs: number; checkedAt: number } = {
  model: undefined,
  mtimeMs: -1,
  checkedAt: 0,
}

async function loadBrainModel(): Promise<string | undefined> {
  const now = Date.now()
  if (now - brainModelCache.checkedAt < BRAIN_MODEL_REFRESH_MS) return brainModelCache.model
  brainModelCache.checkedAt = now
  try {
    const fs = await import("node:fs/promises")
    const dir = process.env.OPENCODE_CONFIG_DIR ?? `${process.env.HOME}/.config/opencode`
    const file = `${dir}/opencode.json`
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat) return brainModelCache.model
    if (stat.mtimeMs !== brainModelCache.mtimeMs) {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { brain?: { model?: unknown } }
      brainModelCache.model = typeof parsed.brain?.model === "string" ? parsed.brain.model.toLowerCase() : undefined
      brainModelCache.mtimeMs = stat.mtimeMs
    }
    return brainModelCache.model
  } catch {
    return brainModelCache.model
  }
}

/**
 * Exact structural match between a "providerID/modelID" pair and the
 * configured brain model. True on exact equality, or when the model part
 * after the first "/" matches (covers short-form config values).
 */
function isBrainModel(combinedID: string, configured: string | undefined): boolean {
  if (!configured) return false
  if (combinedID === configured) return true
  const modelPart = combinedID.slice(combinedID.indexOf("/") + 1)
  // Nested provider paths ("openrouter/meta/model") need a second strip to
  // align with short-form config values; missing separators compare whole.
  return modelPart === configured || modelPart.slice(modelPart.indexOf("/") + 1) === configured.slice(configured.indexOf("/") + 1)
}

const MAX_ESCALATIONS_PER_TASK = 2

/** Session state. Effort moves upward only; a new user message re-assesses it. */
const state = new Map<string, State>()

/** Bounded session map: long-lived processes must not grow it without limit. */
const MAX_SESSIONS = 1_000

/** Window in which an identical chat.message fire is treated as a duplicate. */
const DEDUP_WINDOW_MS = 2_000

function trackSession(sessionID: string) {
  state.delete(sessionID)
  state.set(sessionID, {
    escalated: undefined,
    baseline: undefined,
    escalations: 0,
    risky: false,
    turns: 0,
    skipLogged: false,
  })
  if (state.size > MAX_SESSIONS) {
    // Map preserves insertion order — evict the oldest session.
    const oldest = state.keys().next().value
    if (oldest !== undefined) state.delete(oldest)
  }
}

function rank(effort: Effort): number {
  return LADDER.indexOf(effort)
}

export { DEFAULTS, assess, effective, isBrainAgent, isBrainModel, noteToolUse, normalize, pinnedEffort, variantFor }

/**
 * Exact agent-name identity from config: equality against cfg.brainAgent,
 * never a keyword literal.
 */
function isBrainAgent(agent: string | undefined, cfg: RouterConfig = DEFAULTS): boolean {
  return agent === cfg.brainAgent
}

function normalize(value: unknown): Effort | undefined {
  if (typeof value !== "string") return undefined
  const lower = value.toLowerCase()
  if (lower === "none" || lower === "off") return "minimal"
  if (SUPER_TIERS.has(lower)) return "high"
  return LADDER.find((tier) => tier === lower)
}

/**
 * The plugin-facing `Model` type omits `variants`, but the runtime object
 * passed to hooks is the internal provider model which carries them. Access
 * defensively so the plugin degrades gracefully if the shape ever changes.
 */
function variantsOf(model: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!model || typeof model !== "object") return undefined
  const variants = (model as { variants?: unknown }).variants
  if (!variants || typeof variants !== "object") return undefined
  return variants as Record<string, Record<string, unknown>>
}

/**
 * Best-effort detection of the effort already present in the effective
 * request options (user selection, agent config, or model defaults). Used
 * only to guarantee we never LOWER a user-pinned effort.
 */
function pinnedEffort(options: Record<string, unknown>, cfg: RouterConfig = DEFAULTS): Effort | undefined {
  const direct = normalize(options.reasoningEffort)
  if (direct) return direct
  const budget = options.thinkingBudget ?? options.thinkingTokens
  if (typeof budget !== "number") return undefined
  if (budget <= 0) return "minimal"
  if (budget < cfg.budgetBands.low) return "low"
  if (budget < cfg.budgetBands.medium) return "medium"
  return "high"
}

/**
 * The effective rung is the higher of the assessed baseline and the model's
 * escalation. `undefined` means the governor has no opinion for this task
 * (nothing assessed, nothing escalated) and the request options must pass
 * through untouched.
 */
function effective(entry: State): Effort | undefined {
  if (entry.escalated && rank(entry.escalated) >= rank(entry.baseline ?? "low")) return entry.escalated
  return entry.baseline
}

function escalate(sessionID: string, requested: Effort): { granted: Effort; changed: boolean; note: string } {
  const entry = state.get(sessionID) ?? {
    escalated: undefined,
    baseline: undefined,
    escalations: 0,
    risky: false,
    turns: 0,
    skipLogged: false,
  }
  const baseline = entry.baseline ?? "low"
  const current = entry.escalated && rank(entry.escalated) >= rank(baseline) ? entry.escalated : baseline

  if (rank(requested) <= rank(current)) {
    state.set(sessionID, entry)
    log("escalate", { sessionID, granted: current, changed: false, requested })
    return { granted: current, changed: false, note: `already at ${current} or above` }
  }
  if (entry.escalations >= MAX_ESCALATIONS_PER_TASK) {
    state.set(sessionID, entry)
    log("escalate", { sessionID, granted: current, changed: false, requested, reason: "budget-exhausted" })
    return {
      granted: current,
      changed: false,
      note: `escalation budget exhausted (${MAX_ESCALATIONS_PER_TASK} per task)`,
    }
  }

  entry.escalated = requested
  entry.escalations += 1
  state.set(sessionID, entry)
  log("escalate", { sessionID, granted: requested, changed: true, requested })
  return { granted: requested, changed: true, note: `reasoning effort raised to ${requested}` }
}

/**
 * Resolve the wire-level variant options for a tier on this model. Models
 * disagree about which tiers exist (GLM ships low/high/max, MiniMax none/
 * thinking, others the full ladder), so an exact hit is preferred and the
 * request otherwise falls back to the nearest rung the model actually ships:
 * baselines resolve DOWN (a cheap task should never pay more than its tier),
 * and when the model ships nothing at or below the tier, to its cheapest
 * available tier — expressing "run cheap" beats dropping the opinion and
 * letting the provider default decide. Escalations resolve UP only: an
 * escalation must genuinely deepen reasoning or it is a lie to the model.
 * Resolving down below the pinned effort is still prevented by the caller.
 */
function variantFor(model: unknown, tier: Effort, direction: "down" | "up") {
  const variants = variantsOf(model)
  if (!variants) return undefined
  const exact = variants[tier]
  if (exact) return exact
  const shipped = LADDER.filter((candidate) => variants[candidate]).map((candidate) => ({ candidate, rank: rank(candidate) }))
  if (shipped.length === 0) return undefined
  const start = rank(tier)
  const inDirection = shipped
    .filter(({ rank: r }) => (direction === "down" ? r <= start : r >= start))
    .sort((a, b) => (direction === "down" ? b.rank - a.rank : a.rank - b.rank))
  const nearest = inDirection[0]
  if (nearest) return variants[nearest.candidate]
  if (direction === "down") {
    const cheapest = shipped.sort((a, b) => a.rank - b.rank)[0]
    return variants[cheapest.candidate]
  }
  return undefined
}

export const TaskEffortRouterPlugin: Plugin = async (_input) => {
  return {
    "chat.message": async (input, output) => {
      // New user message = new task boundary: re-assess and reset effort.
      const text = output.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
      const now = Date.now()
      // Some flows fire chat.message twice for one user message (observed:
      // 26 of 122 real assessments were exact duplicates). Re-assessing is
      // harmless but doubles work and pollutes the log — dedupe identical
      // text within a short window.
      const previous = state.get(input.sessionID)
      const duplicate =
        text.length > 0 &&
        previous?.lastMessage !== undefined &&
        previous.lastMessage.text === text &&
        now - previous.lastMessage.ts <= DEDUP_WINDOW_MS
      if (duplicate) return

      const cfg = await loadRouterConfig()
      const profile = assess(text, cfg)
      trackSession(input.sessionID)
      state.set(input.sessionID, {
        escalated: undefined,
        baseline: profile.baseline,
        escalations: 0,
        risky: profile.risky,
        turns: 0,
        skipLogged: false,
        lastMessage: { text, ts: now },
      })
      log("assess", {
        sessionID: input.sessionID,
        baseline: profile.baseline,
        risky: profile.risky,
        words: text ? countWords(text) : 0,
      })
    },

    "chat.params": async (input, output) => {
      // Leave non-reasoning models (and thus most small-model calls) alone.
      if (input.model.capabilities.reasoning === false) return
      const entry = state.get(input.sessionID)
      if (!entry) return
      entry.turns += 1
      // Log skip outcomes once per task, not once per provider turn: a task
      // that runs 300 turns would otherwise write 300 identical lines.
      const logSkip = (fields: Record<string, unknown>) => {
        if (!entry.skipLogged) {
          entry.skipLogged = true
          log("skip", { sessionID: input.sessionID, ...fields })
        }
      }
      // The effective rung is the higher of the assessed baseline and the
      // model's escalation. `undefined` means the governor has no opinion
      // for this task and the request options must pass through untouched.
      const tier = effective(entry)
      const cfg = await loadRouterConfig()
      // Brain identity: exact agent-name match (config-driven), then the
      // config-driven model identity (exact provider/model equality,
      // short-form model part).
      const combined = `${input.model.providerID ?? ""}/${input.model.id ?? ""}`.toLowerCase()
      const brain = isBrainAgent(input.agent, cfg) || isBrainModel(combined, await loadBrainModel())
      const pinned = pinnedEffort(output.options, cfg)
      // Brain floor/default applies ONLY when there is no explicit effort
      // signal in the request options (no reasoningEffort/thinkingBudget).
      // A pin is indistinguishable from a provider default, so it is always
      // respected as-is — the brain default must never override it; upward
      // correction still works afterwards via request_effort escalation.
      let floorTier = tier
      if (brain && pinned === undefined) {
        floorTier = tier === undefined ? "medium" : (rank(tier) < rank("low") ? "low" : tier)
      }
      const clamped = floorTier
      if (!clamped) {
        logSkip({ reason: "no-opinion" })
        return
      }
      // The pin is a FLOOR, not a ceiling: the user's selected effort sets the
      // minimum, but the governor must still be able to raise above it when a
      // task assesses complex or the model escalates. Never lower a pin;
      // always raise past one.
      if (pinned && rank(pinned) >= rank(clamped)) {
        logSkip({ reason: "pinned", tier: clamped, pinned })
        return
      }

      // Baselines resolve to the cheapest tier at or below the assessed rung;
      // escalations to the deepest tier at or above it. Skips only when the
      // model ships no usable tier in that direction at all.
      // When the assessed tier sits ABOVE the user's pin, resolve UP instead:
      // the pin is a floor, and a task judged more complex than the pin must
      // not collapse back down onto it (e.g. medium assessed on a pin of low
      // resolves to high on models that ship low/high/max).
      const fromEscalation = entry.escalated !== undefined && rank(entry.escalated) >= rank(entry.baseline ?? "low")
      const abovePin = pinned !== undefined && rank(clamped) > rank(pinned)
      const variant = variantFor(input.model, clamped, fromEscalation || abovePin ? "up" : "down")
      if (!variant) {
        logSkip({ reason: "no-variant", tier: clamped })
        return
      }
      // The tier's thinking params win over whatever variant the user had
      // selected; everything else in `output.options` is preserved.
      output.options = { ...output.options, ...variant }
      log("apply", {
        sessionID: input.sessionID,
        turn: entry.turns,
        tier: clamped,
        resolved: fromEscalation || abovePin ? "up" : "down",
        escalated: entry.escalated,
        baseline: entry.baseline,
        options: variant,
      })
    },

    // Risk from behavior, not words: actually running a mutating tool (per
    // the config's riskyTools list) marks the session's current task risky.
    "tool.execute.after": async (input) => {
      const cfg = await loadRouterConfig()
      const existing = state.get(input.sessionID)
      if (existing) {
        noteToolUse(existing, input.tool, cfg.riskyTools)
        return
      }
      // Tool fired before any chat.message assessment — create the minimal
      // entry so the risk flag has somewhere to land.
      trackSession(input.sessionID)
      const created = state.get(input.sessionID)
      if (created) noteToolUse(created, input.tool, cfg.riskyTools)
    },

    "experimental.chat.system.transform": async (input, output) => {
      const variants = variantsOf(input.model)
      if (!variants || Object.keys(variants).length === 0) return
      output.system.push(
        [
          "Reasoning effort governor:",
          "- Start lean. Solve with your current reasoning effort first.",
          "- If the task is clearly harder than expected (deep architecture changes, gnarly debugging), call `request_effort` with a short reason to raise your reasoning effort.",
          "- Effort never decreases during a task and is capped; do not call it reflexively.",
        ].join("\n"),
      )
      const entry = input.sessionID ? state.get(input.sessionID) : undefined
      if (entry?.risky) {
        output.system.push(
          "Task risk notice: this task touches a risk-sensitive domain (auth, credentials, schema/data, payments, production). Verify the blast radius before destructive steps and double-check edge cases before finishing.",
        )
      }
    },

    tool: {
      request_effort: tool({
        description:
          "Request higher reasoning effort for this task. Call ONLY when the work is clearly harder than expected and needs deeper reasoning. Effort is monotonic (never decreases) and capped per task.",
        args: {
          level: tool.schema.enum(["medium", "high"]).optional().describe("Target effort level. Defaults to high."),
          reason: tool.schema.string().describe("One short sentence: why deeper reasoning is needed."),
        },
        execute: async (args, ctx) => {
          const result = escalate(ctx.sessionID, args.level ?? "high")
          // Plugin SDK tools return the output string; there is no separate title.
          const status = result.changed ? `effort: ${result.granted}` : `effort: ${result.granted} (unchanged)`
          return result.changed
            ? `${status}. ${result.note}. Reason: ${args.reason}. Apply deeper reasoning from this point onward.`
            : `${status}. ${result.note}. Reason: ${args.reason}. Continue at the current effort.`
        },
      }),
    },
  }
}

// Default-export the PluginModule shape (server()) so the loader takes the v1
// path. Without it, the legacy fallback treats every exported function in this
// module (DEFAULTS, assess, ...) as a plugin instance and throws.
export default {
  id: "task-effort-router",
  server: TaskEffortRouterPlugin,
}
