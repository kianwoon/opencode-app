/**
 * HANDS organ — actuation for the ui_run loop.
 *
 * CONTRACT:
 *   1. MULTI-MODAL — an actuation is never a single blind AXPress. The hand
 *      first maps the element's DECLARED action (`declaredAction`: the observed
 *      `actions[]`, else a role default) and, when that rung fails, falls back
 *      to a foreground PIXEL click at the element's frame centre.
 *   2. CHANGE EVIDENCE — an actuation never returns a bare success boolean. The
 *      hand folds the before/after screen signature into `ActuationEvidence`, so
 *      the loop reports WHAT changed, not merely that a call returned ok.
 *   3. AFFIRMATIVE CLICK DELIVERY — a click is DELIVERED only when the WORLD
 *      changed: the screen signature, the target's own state
 *      (`selected`/`enabled`/`value`/`label`), or focus moving ONTO the target.
 *      Driver success codes are never evidence. After rung 1, absent delivery
 *      escalates to rung 2; after rung 2, absent delivery returns
 *      `worked:false` with BOTH rungs' evidence — an affirmative failure.
 *
 * INVARIANT OWNED: a click's outcome is measured in OBSERVABLE WORLD STATE
 * across multiple signals, never in the driver's success codes; an unprovable
 * click is reported as failed rather than silently absorbed.
 * hardcode-guard:allow the named live incidents are instances of the invariant, cited to ground it
 * LIVE FAILURE AS ONE INSTANCE: the SILENT NO-OP CLASS — a click the driver
 * reports as ok that changed nothing: AXPress on an AXRow is unsupported
 * (-25206), the wallpaper swatch absorbs the click, and the driver still returns
 * success. All are one class: a bare success code with no world-state change.
 * UNSEEN CASE COVERED: a custom control that exposes neither AXPress nor a
 * declared action — its frame still yields a pixel rung; if the pixel rung also
 * changes nothing, the click is reported failed (never absorbed as success).
 */

import type { Element } from "./ui-eyes"

/** The driver's `cua-driver_click` `action` enumeration (cua-driver v0.28.2). */
export type ClickAction = "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open"

/** AX action name -> driver click action. `AXSelect` has no exact driver verb; its nearest is `pick`. */
const AX_CLICK: Readonly<Record<string, ClickAction>> = {
  AXPress: "press",
  AXShowMenu: "show_menu",
  AXPick: "pick",
  AXConfirm: "confirm",
  AXCancel: "cancel",
  AXOpen: "open",
  AXSelect: "pick",
}

/** Role default when the element declares no usable action. Rows select, buttons press. */
const ROLE_CLICK: Readonly<Record<string, ClickAction>> = {
  AXRow: "pick",
  AXOutlineRow: "pick",
  AXTableRow: "pick",
  AXMenuItem: "press",
  AXButton: "press",
  AXPopUpButton: "press",
  AXMenuButton: "press",
  AXCheckBox: "press",
  AXRadioButton: "press",
  AXLink: "press",
  AXDisclosureTriangle: "press",
}

/**
 * The element's DECLARED action, resolved from its `actions[]` first (the
 * authoritative source), then from a role default. `undefined` means the hand
 * has no declared verb and falls straight to a plain element click / pixel rung.
 */
export function declaredAction(element: Element): ClickAction | undefined {
  const fromDeclared = (element.actions ?? [])
    .map((name) => AX_CLICK[name])
    .find((action): action is ClickAction => action !== undefined)
  if (fromDeclared) return fromDeclared
  return element.role ? ROLE_CLICK[element.role] : undefined
}

/** Centre of the element's frame (either key name), or undefined when unknown. */
export function elementCenter(element: Element): { x: number; y: number } | undefined {
  const rect = element.frame ?? element.bounds
  if (!rect) return undefined
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
}

export interface WindowRef {
  readonly pid: number
  readonly window_id: number
}

export interface ActuationRung {
  readonly mode: "declared" | "pixel"
  /** Telemetry handle: the declared verb, or `pixel(x,y)`. */
  readonly label: string
  /** Full `cua-driver_click` args for this rung. */
  readonly args: Record<string, unknown>
}

/**
 * The ordered actuation plan for one click: declared action first, pixel frame
 * click second. A rung is tried only when its predecessor fails. A pixel rung is
 * emitted only when the frame is known; when no declared action exists the first
 * rung is a plain element click (the pre-existing behaviour).
 */
export function actuationPlan(element: Element, window: WindowRef): readonly ActuationRung[] {
  const base = { pid: window.pid, window_id: window.window_id, element_token: element.element_token }
  const declared = declaredAction(element)
  const rungs: ActuationRung[] = [
    declared
      ? { mode: "declared", label: declared, args: { ...base, action: declared } }
      : { mode: "declared", label: "click", args: base },
  ]
  const center = elementCenter(element)
  if (center)
    rungs.push({
      mode: "pixel",
      label: `pixel(${center.x},${center.y})`,
      args: {
        pid: window.pid,
        window_id: window.window_id,
        x: center.x,
        y: center.y,
        delivery_mode: "foreground",
      },
    })
  return rungs
}

/**
 * How an actuation was carried out: a click rung, a key press, a typed text
 * entry, a scroll, or a read (no actuation — the observation IS the result).
 */
export type ActuationMode = ActuationRung["mode"] | "type" | "key" | "scroll" | "read"

/**
 * Args for the driver's key-press verb (`cua-driver_press_key`): a fixed key plus
 * optional modifiers, scoped to the focused element when one is known. It obeys
 * the same evidence contract as a click — the loop folds its before/after screen
 * signature via `changeEvidence("key", before, after)`. The foreground remedy for
 * `same_pid_keyboard_ambiguity` is applied by the caller, exactly as for type.
 */
export function keyPress(
  key: string,
  window: WindowRef,
  modifiers: readonly string[] = [],
  element?: Element,
): Record<string, unknown> {
  return {
    pid: window.pid,
    window_id: window.window_id,
    ...(element?.element_token ? { element_token: element.element_token } : {}),
    key,
    ...(modifiers.length > 0 ? { modifiers: [...modifiers] } : {}),
  }
}

export interface ActuationEvidence {
  readonly mode: ActuationMode
  /** Screen signature the action ran at. */
  readonly before: string
  /** Screen signature observed after the action. */
  readonly after: string
  readonly changed: boolean
}

/** Fold a before/after screen signature into the hand's change evidence. */
export const changeEvidence = (mode: ActuationMode, before: string, after: string): ActuationEvidence => ({
  mode,
  before,
  after,
  changed: before !== after,
})

/**
 * The MULTI-SIGNAL world state a click's delivery is judged against. Not the
 * driver's ok code: (1) the whole-screen stable signature, (2) the target's own
 * state, (3) the focused element's identity when the wire exposes one. Delivery
 * is ANY signal changing — a click that changes NONE is not delivered.
 */
export interface ClickSignals {
  /** Stable whole-screen node signature (`screenSignature`). */
  readonly screen: string
  /** The target's own observable state (`targetState`). */
  readonly target: string
  /** The focused element's identity, when the wire exposes it; absent otherwise. */
  readonly focus?: string
}

/** The identity used to test whether focus moved ONTO the target. */
export const focusIdentity = (element: Element): string => `${element.role ?? ""}\u0000${element.label ?? ""}`

/**
 * Fold an element's OWN state into a stable token (delivery signal 2). `selected`
 * and `value` are the driver's fields; `enabled`/`label` are always present on
 * the decoded element. A change in any of them is a delivered click.
 */
export const targetState = (element: Element): string =>
  [
    element.role ?? "",
    element.label ?? "",
    element.enabled === undefined ? "" : element.enabled ? "1" : "0",
    element.selected === undefined ? "" : element.selected ? "1" : "0",
    element.value ?? "",
  ].join("\u0000")

/**
 * The identity of the focused element in a fresh observation, or undefined when
 * the wire exposes none. A click that FOCUSES its target delivers even when the
 * screen signature is unchanged (the focus signal moved).
 */
export function focusedIdentity(elements: readonly Element[]): string | undefined {
  const focused = elements.find((element) => element.focused === true)
  return focused ? focusIdentity(focused) : undefined
}

/**
 * Find the SAME element (role+label identity, never the churned token) in a fresh
 * observation so its own state can be re-read; falls back to the known element.
 */
export function relocate(element: Element, elements: readonly Element[]): Element {
  return elements.find((e) => e.role === element.role && (e.label ?? "") === (element.label ?? "")) ?? element
}

/**
 * Capture the click signals for one observation: the screen signature, the
 * target's own state (relocated into THIS observation), and the focused element
 * when the wire exposes it.
 */
export function clickSignals(screen: string, element: Element, elements: readonly Element[]): ClickSignals {
  const focus = focusedIdentity(elements)
  return {
    screen,
    target: targetState(relocate(element, elements)),
    ...(focus !== undefined ? { focus } : {}),
  }
}

/** Which signal established delivery. */
export type ClickDeliveryReason = "screen" | "target-state" | "focus"

/**
 * Evaluate delivery on OBSERVABLE world state: a click is delivered when the
 * screen signature changed, the target's own state changed, or focus moved ONTO
 * the target. Driver success codes are deliberately absent from this decision.
 */
export function deliveryReasons(before: ClickSignals, after: ClickSignals, target: Element): ClickDeliveryReason[] {
  const reasons: ClickDeliveryReason[] = []
  if (before.screen !== after.screen) reasons.push("screen")
  if (before.target !== after.target) reasons.push("target-state")
  if (after.focus !== undefined && after.focus === focusIdentity(target) && before.focus !== after.focus)
    reasons.push("focus")
  return reasons
}

/** One rung's attempt, judged on world state (never the driver's ok code). */
export interface ClickAttemptEvidence {
  readonly mode: ActuationRung["mode"]
  readonly label: string
  readonly before: ClickSignals
  readonly after: ClickSignals
  readonly delivered: boolean
  readonly reasons: readonly ClickDeliveryReason[]
  /** The driver's own answer, for diagnostics only — never part of the verdict. */
  readonly error?: string
}

/** Build one rung's evidence from its before/after signals. */
export function clickAttempt(
  rung: ActuationRung,
  before: ClickSignals,
  after: ClickSignals,
  target: Element,
  error?: string,
): ClickAttemptEvidence {
  const reasons = deliveryReasons(before, after, target)
  return {
    mode: rung.mode,
    label: rung.label,
    before,
    after,
    delivered: reasons.length > 0,
    reasons,
    ...(error !== undefined ? { error } : {}),
  }
}

/** The whole click's affirmative verdict over its rung attempts. */
export interface ClickOutcome {
  readonly worked: boolean
  /** The rung that delivered, or the last rung tried when none did. */
  readonly mode: ActuationRung["mode"]
  readonly attempts: readonly ClickAttemptEvidence[]
}

/**
 * AFFIRMATIVE VERDICT: `worked` is true only when SOME rung showed a world-state
 * change. When every rung changed nothing, `worked:false` carries BOTH rungs'
 * evidence — a failure stated from observation, never from a driver code.
 */
export function clickVerdict(attempts: readonly ClickAttemptEvidence[]): ClickOutcome {
  const delivered = attempts.find((attempt) => attempt.delivered)
  const last = attempts[attempts.length - 1]
  return { worked: delivered !== undefined, mode: (delivered ?? last)?.mode ?? "declared", attempts }
}
