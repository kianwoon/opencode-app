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
 *
 * INVARIANT OWNED: every click is attempted through the element's declared
 * action first and a frame-derived pixel click second, and the outcome is stated
 * as a screen-signature delta.
 * LIVE FAILURE AS ONE INSTANCE: AXPress on an AXRow is unsupported (-25206; the
 * wallpaper swatch was the same class) — the declared action (AXSelect→pick) is
 * used, or the pixel rung lands the click anyway.
 * UNSEEN CASE COVERED: a custom control that exposes neither AXPress nor a
 * declared action — its frame still yields a pixel rung.
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

/** How an actuation was carried out: a click rung, or a typed text entry. */
export type ActuationMode = ActuationRung["mode"] | "type"

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
