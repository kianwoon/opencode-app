/**
 * EYES organ — observation + world model for the ui_run loop.
 *
 * CONTRACT: eyes are the loop's only source of truth about the screen.
 *   1. LOSSLESS enumeration — `buildCandidates` must represent the whole
 *      goal-relevant region of the observed screen. The bound is
 *      CONTENT-ADAPTIVE (`frontierBound`): a real screen (System Settings: 159
 *      controls) is enumerated in full; only a pathologically long list is
 *      sampled, and then the truncation is marked. A hard 60-cap silently hid
 *      every control past position 60 — that is the defect this bound removes.
 *   2. STABLE IDENTITY — node identity (`screenSignature`) is a structural
 *      signature of role+label, never of the ephemeral snapshot/token that
 *      churned it. Eye-to-hand identity follows the same rule: `resolveTarget`
 *      re-resolves a chosen label against FRESH elements by role+label, so a
 *      target whose element_token churned is acted on instead of dropped as
 *      "not-in-fresh-candidates".
 *   3. TOLERANT VOCABULARY — decode the NAMES the driver actually ships. The
 *      live probe ships the element token as `token`, not `element_token`; the
 *      decoder aliases known variants and defaults only fields the driver
 *      genuinely omits. A key-NAME change must never read as an unusable
 *      payload: `decodeObservation` returns null only when the payload is truly
 *      undecodable, never because a key is aliased.
 *
 * INVARIANT OWNED: the world model (`NavMap.frontier`) contains every
 * goal-relevant control the screen holds, a decision keyed to a (role,label)
 * survives a token/snapshot change, and the decoder accepts the driver's aliased
 * wire vocabulary rather than one hard-coded spelling.
 * LIVE FAILURE AS ONE INSTANCE: "controls truncated from 159 to 60" on System
 * Settings, and every valid choice lost as "target-not-in-fresh-candidates"
 * when tokens churned.
 * UNSEEN CASE COVERED: a 500-row list whose goal target is the final row — the
 * adaptive bound enumerates it (500 < FRONTIER_HARD_MAX), and a re-observation
 * that reassigns tokens still resolves the row by its role+label.
 *
 * The controller (DECIDER) is handed this organ's output; it never reads the
 * driver itself.
 */

import { Effect, Option, Schema } from "effect"
import { LABEL_MAX, sampleWithinCap, type NavMap } from "../jev/controller"

export const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max))

/** AXStaticText/AXImage carry no actions, so offering them as click targets emits blind clicks. */
export const NON_INTERACTIVE = new Set(["AXStaticText", "AXImage"])

/** Axis-aligned frame as the driver reports it (either key name is tolerated). */
const Rect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})

/** Element fields shared by the canonical and wire shapes. */
const elementFields = {
  element_index: Schema.optional(Schema.Int),
  role: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  /** The element's DECLARED AX actions (e.g. ["AXPress"], ["AXSelect"]); the hand maps these. */
  actions: Schema.optional(Schema.Array(Schema.String)),
  /** Screen-space frame; the hand's pixel fallback clicks its centre. */
  frame: Schema.optional(Rect),
  bounds: Schema.optional(Rect),
} as const

/** The canonical element the rest of the organ speaks: the token is `element_token`. */
export const Element = Schema.Struct({
  ...elementFields,
  element_token: Schema.optional(Schema.String),
})
export type Element = Schema.Schema.Type<typeof Element>

/**
 * GENERAL RULE — parse the vocabulary the driver actually ships, not one
 * hard-coded spelling. The live `get_window_state` probe keys the token as
 * `token` (not `element_token`); the wire schema accepts BOTH, so a key alias
 * decodes rather than reading as unusable. `enabled`/`frame`/`bounds`/`actions`
 * are the driver's own names where present and default when the driver omits
 * them (the probe ships only `token`/`role`/`label`). Unseen variant it covers:
 * a driver that emits the frame under either `frame` or `bounds`.
 */
const WireElement = Schema.Struct({
  ...elementFields,
  element_token: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
})
type WireElement = Schema.Schema.Type<typeof WireElement>

/** Fold the wire element onto the canonical shape, aliasing `token` -> `element_token`. */
function normalizeElement(wire: WireElement): Element {
  const { token, ...rest } = wire
  return { ...rest, element_token: rest.element_token ?? token }
}

const Observation = Schema.Struct({
  snapshot_id: Schema.String,
  /**
   * `tree_format:"elements"` (the format this loop requests) delivers the array.
   * The driver's default `tree_format:"markdown"` omits it and ships a
   * `tree_markdown` string instead; a missing array defaults to empty so the
   * loop proceeds on zero candidates rather than stopping — parse the format
   * asked for, tolerate the ones it is not.
   */
  elements: Schema.Array(Element).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
})
export type Observation = Schema.Schema.Type<typeof Observation>

const WireObservation = Schema.Struct({
  snapshot_id: Schema.String,
  elements: Schema.Array(WireElement).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
})

/**
 * Decode a `cua-driver_get_window_state` `structuredContent`. The wire shape is
 * decoded first (tolerating aliased keys), then normalized to the canonical
 * element. A missing or truly-undecodable payload is never guessed from the text
 * channel: it returns `null` and the run stops, because a target invented from
 * prose would be a blind click.
 */
export function decodeObservation(input: unknown): Observation | null {
  const decoded = Schema.decodeUnknownOption(WireObservation)(input)
  if (Option.isNone(decoded)) return null
  return { snapshot_id: decoded.value.snapshot_id, elements: decoded.value.elements.map(normalizeElement) }
}

/** The elements the loop may enumerate: token + role present, interactive, enabled. */
export function usableElements(elements: readonly Element[]): Element[] {
  return elements.filter(
    (element) =>
      element.element_token !== undefined &&
      element.role !== undefined &&
      !NON_INTERACTIVE.has(element.role) &&
      element.enabled !== false,
  )
}

/**
 * GENERAL RULE — the frontier bound is CONTENT-ADAPTIVE, not a fixed 60. A fixed
 * cap below a real screen's control count is lossy: it hides the goal-relevant
 * region of a dense pane (System Settings: 159 controls) behind a "truncated to
 * 60" marker even though every control is on screen. The bound grows with the
 * screen up to a hard ceiling; only beyond the ceiling is the range SAMPLED
 * (never prefix-truncated) and the truncation marked. Unseen case it covers: a
 * 500-row list, still enumerated in full because 500 < FRONTIER_HARD_MAX.
 */
export const FRONTIER_HARD_MAX = 600

export function frontierBound(usable: number): number {
  return Math.min(usable, FRONTIER_HARD_MAX)
}

/**
 * Turn observed elements into the label set the controller chooses from.
 * Labels are the round-trip handle: `foldController` returns exactly the clipped
 * string it was offered, so `byLabel` maps a decision back to a live token, and
 * `resolveTarget` maps it back by role+label when the token churned.
 */
export function buildCandidates(elements: readonly Element[]): {
  labels: string[]
  byLabel: Map<string, Element>
  elements: Element[]
  truncated: string | undefined
} {
  const usable = usableElements(elements)
  const bound = frontierBound(usable.length)
  const entries = sampleWithinCap(usable, bound).map((element, i) => ({
    element,
    label: clip(`c${i + 1} ${element.role} ${element.label ?? ""}`.trim(), LABEL_MAX),
  }))
  return {
    labels: entries.map((entry) => entry.label),
    byLabel: new Map(entries.map((entry) => [entry.label, entry.element])),
    elements: usable,
    truncated:
      usable.length > bound
        ? `controls truncated from ${usable.length} to ${bound}; the bound is content-adaptive and samples the whole range so no region is hidden`
        : undefined,
  }
}

/** Split a built label back into its `cN`-stripped role and label parts. */
export function parseTargetLabel(target: string): { role: string | undefined; label: string | undefined } {
  const body = target.replace(/^c\d+\s+/, "")
  const sp = body.indexOf(" ")
  if (sp < 0) return { role: body || undefined, label: undefined }
  return { role: body.slice(0, sp), label: body.slice(sp + 1) }
}

/**
 * GENERAL RULE — eye-to-hand identity is (role,label), never the churned token.
 * A chosen target is offered as a built label; if the fresh observation's label
 * set no longer contains that exact string (an element inserted/removed ahead of
 * it renumbers the `cN` prefix), the target is re-resolved against the fresh
 * elements by role+label rather than dropped. Unseen case it covers: a list that
 * gains a row, shifting every downstream `cN`, where the goal control itself is
 * unchanged.
 */
export function resolveTarget(target: string, elements: readonly Element[]): Element | undefined {
  const { role, label } = parseTargetLabel(target)
  if (role === undefined) return undefined
  return usableElements(elements).find(
    (element) =>
      element.role === role &&
      (label === undefined || (element.label ?? "") === label || (element.label ?? "").startsWith(label)),
  )
}

/**
 * GENERAL RULE — node identity is a STABLE signature of what the screen IS, not
 * of the observation that captured it. The driver invalidates `snapshot_id` on
 * every fresh read, so keying nodes on it makes each observation look like a new
 * screen: `advanceMap` then never dedups and `path` records observations, not
 * visits. The signature is the ordered role+label of every observed element;
 * ephemeral fields (snapshot_id, element_token, element_index, enabled, frame,
 * actions) are deliberately excluded. The same screen therefore yields the same
 * node across successive observations whose snapshot ids change.
 */
export function screenSignature(elements: readonly Element[]): string {
  const shape = elements.map((element) => `${element.role ?? ""}\u0000${element.label ?? ""}`).join("\u0001")
  let h = 5381
  for (let i = 0; i < shape.length; i++) h = ((h << 5) + h + shape.charCodeAt(i)) | 0
  return `n${(h >>> 0).toString(36)}`
}

/**
 * Update the navigation map from THIS iteration's fresh observation. Code owns
 * the map: `current` becomes the STABLE screen node (see `screenSignature`), the
 * `frontier` the code-enumerated next-level option set at that node, and `path`
 * gains the node only when it differs from the last visited one, so a
 * backtracking revisit is recorded rather than erased. `start` is pinned on the
 * first observation.
 */
export function advanceMap(
  goal: string,
  previous: NavMap | undefined,
  elements: readonly Element[],
  frontier: readonly string[],
): NavMap {
  const node = screenSignature(elements)
  const start = previous?.start ?? node
  const path = previous && previous.current === node ? previous.path : [...(previous?.path ?? []), node]
  return { goal, start, current: node, frontier, path }
}
