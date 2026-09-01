import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

/**
 * Task Effort Router — a self-adjusting reasoning-effort governor with a
 * heuristic task-profile assessor.
 *
 * Philosophy: don't predict task difficulty upfront. Assess cheap signals on
 * each new user message (task boundary), pre-escalate only when the heuristic
 * profile is clearly complex or risky, and let the model escalate further via
 * the `request_effort` tool when the work proves harder than expected.
 *
 * Mechanics (all public plugin API, no core changes):
 * - `chat.message` assesses the task text (keyword heuristics, zero LLM cost)
 *   and resets effort to the assessed baseline.
 * - `chat.params` enforces the current tier by merging the matching model
 *   variant's options (reasoningEffort / thinkingBudget / provider-native
 *   thinking config) into the request. Works on both AI SDK and native runtimes
 *   because both consume `prepared.params.options`.
 * - `experimental.chat.system.transform` appends short discovery lines so the
 *   model knows the tool exists and when to use it, plus a verification
 *   caution line for risky tasks.
 * - `Hooks.tool` registers a `request_effort` tool the model calls to escalate.
 *   Escalation is monotonic (never decreases), capped a couple of rungs above
 *   the baseline, and rate-limited per task.
 *
 * Key principle: effort ≠ risk. This plugin never touches permissions.
 */

const LADDER = ["minimal", "low", "medium", "high"] as const
type Effort = (typeof LADDER)[number]

/** Known wire values that exceed the top of our ladder; treated as `high`. */
const SUPER_TIERS = new Set(["xhigh", "max"])

type State = {
  /** Run the model escalated to. `undefined` until the first escalation. */
  escalated: Effort | undefined
  /** Task-boundary rung from the heuristic profile. Floors the ladder. */
  baseline: Effort | undefined
  /** Escalations granted for the current task (baseline does not count). */
  escalations: number
  /** True when the task text matched a risk-sensitive domain. */
  risky: boolean
}

/** Heuristic complexity hints: architecture-scale or investigation-shaped work. */
const COMPLEX_HINTS = [
  "architect",
  "refactor",
  "migrate",
  "migration",
  "redesign",
  "rewrite",
  "codebase",
  "across the repo",
  "performance",
  "optimize",
  "investigate",
  "race condition",
  "concurrency",
  "distributed",
  "debug",
]

/** Heuristic risk hints: domains where mistakes are expensive or irreversible. */
const RISKY_HINTS = [
  "auth",
  "password",
  "credential",
  "secret",
  "permission",
  "payment",
  "billing",
  "migration",
  "schema",
  "database",
  "delete",
  "production",
  "deploy",
  "release",
  "security",
  "encrypt",
]

/**
 * Best-effort JSONL observability so firings can be counted directly instead
 * of inferred from token distributions. One line per decision:
 * `{ts, event, sessionID, ...}`. Never throws — logging must not break the
 * request pipeline, and a missing/unwritable XDG dir degrades to silence.
 * Node built-ins load via dynamic import (desktop-sidecar safe).
 */
const dataRoot = () => process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`

function log(event: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: Date.now(), event, ...fields }) + "\n"
  void (async () => {
    try {
      const { appendFile, mkdir } = await import("node:fs/promises")
      const dir = `${dataRoot()}/opencode`
      await mkdir(dir, { recursive: true })
      await appendFile(`${dir}/effort-router.jsonl`, line)
    } catch {
      // Observability is best-effort by design.
    }
  })()
}

/**
 * Heuristic profile of a task from its text. Cheap on purpose — the exact
 * words matter less than the shape: risky domains gate the rung floor,
 * complexity hints plus length gate pre-escalation.
 */
function assess(text: string | undefined): { baseline: Effort | undefined; risky: boolean } {
  if (!text) return { baseline: undefined, risky: false }
  const lower = text.toLowerCase()
  const words = lower.split(/\s+/).filter(Boolean).length
  const risky = RISKY_HINTS.some((hint) => lower.includes(hint))
  const complexHits = COMPLEX_HINTS.filter((hint) => lower.includes(hint)).length
  const complex = complexHits >= 2 || (complexHits >= 1 && words > 40) || (complexHits >= 1 && risky)
  if (complex && risky) return { baseline: "high", risky }
  if (complex) return { baseline: "medium", risky }
  // Short imperative prompts with zero signal ("run tests", "commit this",
  // "let's enhance it") are the most common task shape and were previously
  // left at the provider default. Start lean: the escalation path recovers
  // the rare hard ones.
  if (!risky && words <= 10) return { baseline: "minimal", risky }
  return { baseline: undefined, risky }
}

const MAX_ESCALATIONS_PER_TASK = 2

/** Session state. Effort moves upward only; a new user message re-assesses it. */
const state = new Map<string, State>()

/** Bounded session map: long-lived processes must not grow it without limit. */
const MAX_SESSIONS = 1_000

function trackSession(sessionID: string) {
  state.delete(sessionID)
  state.set(sessionID, { escalated: undefined, baseline: undefined, escalations: 0, risky: false })
  if (state.size > MAX_SESSIONS) {
    // Map preserves insertion order — evict the oldest session.
    const oldest = state.keys().next().value
    if (oldest !== undefined) state.delete(oldest)
  }
}

function rank(effort: Effort): number {
  return LADDER.indexOf(effort)
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
function pinnedEffort(options: Record<string, unknown>): Effort | undefined {
  const direct = normalize(options.reasoningEffort)
  if (direct) return direct
  const budget = options.thinkingBudget ?? options.thinkingTokens
  if (typeof budget !== "number") return undefined
  if (budget <= 0) return "minimal"
  if (budget < 8000) return "low"
  if (budget < 20000) return "medium"
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
  const entry = state.get(sessionID) ?? { escalated: undefined, baseline: undefined, escalations: 0, risky: false }
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

export const TaskEffortRouterPlugin = (async () => {
  return {
    "chat.message": async (input, output) => {
      // New user message = new task boundary: re-assess and reset effort.
      const text = output.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
      const profile = assess(text)
      trackSession(input.sessionID)
      log("assess", {
        sessionID: input.sessionID,
        baseline: profile.baseline,
        risky: profile.risky,
        words: text ? text.trim().split(/\s+/).filter(Boolean).length : 0,
      })
      state.set(input.sessionID, {
        escalated: undefined,
        baseline: profile.baseline,
        escalations: 0,
        risky: profile.risky,
      })
    },

    "chat.params": async (input, output) => {
      // Leave non-reasoning models (and thus most small-model calls) alone.
      if (input.model.capabilities.reasoning === false) return
      const entry = state.get(input.sessionID)
      if (!entry) return
      // The effective rung is the higher of the assessed baseline and the
      // model's escalation. `undefined` means the governor has no opinion
      // for this task and the request options must pass through untouched.
      const tier = effective(entry)
      if (!tier) {
        log("skip", { sessionID: input.sessionID, reason: "no-opinion" })
        return
      }

      // Only raise: if the effective options already pin an effort at or above
      // the tier (user selection / agent config), leave them alone. Unpinned
      // options have no opinion, so even a `minimal` baseline may apply.
      const pinned = pinnedEffort(output.options)
      if (pinned && rank(pinned) >= rank(tier)) {
        log("skip", { sessionID: input.sessionID, reason: "pinned", tier, pinned })
        return
      }

      // Baselines resolve to the cheapest tier at or below the assessed rung;
      // escalations to the deepest tier at or above it. Skips only when the
      // model ships no usable tier in that direction at all.
      const fromEscalation = entry.escalated !== undefined && rank(entry.escalated) >= rank(entry.baseline ?? "low")
      const variant = variantFor(input.model, tier, fromEscalation ? "up" : "down")
      if (!variant) {
        log("skip", { sessionID: input.sessionID, reason: "no-variant", tier })
        return
      }
      // The tier's thinking params win over whatever variant the user had
      // selected; everything else in `output.options` is preserved.
      output.options = { ...output.options, ...variant }
      log("apply", {
        sessionID: input.sessionID,
        tier,
        resolved: fromEscalation ? "up" : "down",
        escalated: entry.escalated,
        baseline: entry.baseline,
        options: variant,
      })
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
          return {
            title: result.changed ? `effort: ${result.granted}` : `effort: ${result.granted} (unchanged)`,
            output: result.changed
              ? `${result.note}. Reason: ${args.reason}. Apply deeper reasoning from this point onward.`
              : `${result.note}. Reason: ${args.reason}. Continue at the current effort.`,
          }
        },
      }),
    },
  }
}) satisfies Plugin
