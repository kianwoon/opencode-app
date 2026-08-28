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

/** Simple-task signals: mechanical one-liners that never need deep reasoning. */
const SIMPLE_HINTS = ["typo", "rename", "comment", "spell", "docs", "format"]

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
  const simpleHits = SIMPLE_HINTS.filter((hint) => lower.includes(hint)).length
  const complex = complexHits >= 2 || (complexHits >= 1 && words > 40) || (complexHits >= 1 && risky)
  const simple = simpleHits >= 1 && complexHits === 0 && !risky && words <= 12
  if (complex && risky) return { baseline: "high", risky }
  if (complex) return { baseline: "medium", risky }
  if (simple) return { baseline: "minimal", risky }
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
    return { granted: current, changed: false, note: `already at ${current} or above` }
  }
  if (entry.escalations >= MAX_ESCALATIONS_PER_TASK) {
    state.set(sessionID, entry)
    return {
      granted: current,
      changed: false,
      note: `escalation budget exhausted (${MAX_ESCALATIONS_PER_TASK} per task)`,
    }
  }

  entry.escalated = requested
  entry.escalations += 1
  state.set(sessionID, entry)
  return { granted: requested, changed: true, note: `reasoning effort raised to ${requested}` }
}

export const TaskEffortRouterPlugin = (async () => {
  return {
    "chat.message": async (input, output) => {
      // New user message = new task boundary: re-assess and reset effort.
      const text = output.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
      const profile = assess(text)
      trackSession(input.sessionID)
      state.set(input.sessionID, { escalated: undefined, baseline: profile.baseline, escalations: 0, risky: profile.risky })
    },

    "chat.params": async (input, output) => {
      // Leave non-reasoning models (and thus most small-model calls) alone.
      if (input.model.capabilities.reasoning === false) return
      const entry = state.get(input.sessionID)
      if (!entry) return
      const tier = effective(entry)
      // No assessment and no escalation: the governor has no opinion —
      // the request options pass through untouched (model defaults win).
      if (!tier) return

      // Only raise: if the effective options already pin an effort at or above
      // the tier (user selection / agent config), leave them alone.
      if (rank(pinnedEffort(output.options) ?? "minimal") >= rank(tier)) return

      const variant = variantsOf(input.model)?.[tier]
      if (!variant) {
        // Model doesn't ship this tier — skip rather than guess provider params.
        return
      }
      // The tier's thinking params win over whatever variant the user had
      // selected; everything else in `output.options` is preserved.
      output.options = { ...output.options, ...variant }
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
          level: tool.schema
            .enum(["medium", "high"])
            .optional()
            .describe("Target effort level. Defaults to high."),
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
