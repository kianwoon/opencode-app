/**
 * HANDS organ — actuation for the ui_run loop.
 *
 * CONTRACT:
 *   1. MULTI-MODAL — an actuation is never a single blind AXPress, and it never
 *      stops at the first modality. The hand first maps the element's DECLARED
 *      action (`declaredAction`: the observed `actions[]`, else a role default);
 *      when that rung delivers nothing it escalates to the SAME element re-issued
 *      FOREGROUND as a real input event (`escalateRung`); and only then to a
 *      foreground PIXEL click at the element's frame centre.
 *   2. CHANGE EVIDENCE — an actuation never returns a bare success boolean. The
 *      hand folds the before/after screen signature into `ActuationEvidence`, so
 *      the loop reports WHAT changed, not merely that a call returned ok.
 *   3. AFFIRMATIVE CLICK DELIVERY — a click is DELIVERED only when the WORLD
 *      changed: the screen signature, the target's own state
 *      (`selected`/`enabled`/`value`/`label`), or focus moving ONTO the target.
 *      Driver success codes are never evidence. Each rung is reached only when
 *      EVERY earlier rung delivered nothing, and every attempt is recorded; when
 *      the last permitted rung delivers nothing the click returns `worked:false`
 *      with all attempts' evidence — an affirmative failure.
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

/** The driver's `cua-driver_click` `action` enumeration (cua-driver v0.28.2) plus the element-declared scroll verbs. */
export type ClickAction =
  | "press"
  | "show_menu"
  | "pick"
  | "confirm"
  | "cancel"
  | "open"
  | "scroll_to_visible"
  | "scroll_to_top"
  | "scroll_to_bottom"
  | "scroll_to_left"
  | "scroll_to_right"

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

/**
 * SCROLL ACTION VOCABULARY — the element-DECLARED actions that REVEAL content
 * rather than actuate it. They are deliberately NOT in `AX_CLICK`/`declaredActions`
 * (a reveal is not a click), but they are the sanctioned route to bring an
 * off-screen element into view: macOS exposes scrollability as ACTIONS, not roles,
 * so an element carrying no scroll-area role still declares these.
 * hardcode-guard:allow the AX action names are the driver's own vocabulary under test
 */
const AX_SCROLL: Readonly<Record<string, ClickAction>> = {
  AXScrollToVisible: "scroll_to_visible",
  AXScrollToTop: "scroll_to_top",
  AXScrollToBottom: "scroll_to_bottom",
  AXScrollToLeft: "scroll_to_left",
  AXScrollToRight: "scroll_to_right",
}

/** The AX action names that express scrollability on an element (scrollability by ACTION, not role). */
export const SCROLL_ACTION_NAMES: ReadonlySet<string> = new Set(Object.keys(AX_SCROLL))

/** The directional scroll verb that reveals an element overflowing on each axis. */
const SCROLL_BY_DIRECTION: Readonly<Record<"up" | "down" | "left" | "right", ClickAction>> = {
  up: "scroll_to_top",
  down: "scroll_to_bottom",
  left: "scroll_to_left",
  right: "scroll_to_right",
}

/** Whether the element declares any scroll action — SCROLLABILITY BY ACTION, not role. */
export function hasScrollActions(element: Element): boolean {
  return (element.actions ?? []).some((name) => SCROLL_ACTION_NAMES.has(name))
}

/** The element's declared scroll actions, in declaration order, mapped to driver verbs. */
export function declaredScrollActions(element: Element): readonly ClickAction[] {
  return (element.actions ?? [])
    .filter((name) => SCROLL_ACTION_NAMES.has(name))
    .map((name) => AX_SCROLL[name])
    .filter((action): action is ClickAction => action !== undefined)
}

/**
 * The sanctioned scroll action to reveal this element overflowing on `direction`:
 * the content-agnostic `scroll_to_visible` when declared, else the directional
 * verb. `undefined` when the element declares no scroll action of its own.
 */
export function scrollActionFor(element: Element, direction: "up" | "down" | "left" | "right"): ClickAction | undefined {
  const declared = declaredScrollActions(element)
  if (declared.includes("scroll_to_visible")) return "scroll_to_visible"
  const directional = SCROLL_BY_DIRECTION[direction]
  return declared.includes(directional) ? directional : declared[0]
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
 * CLICK-INTENT PRIORITY — the AX verbs that can actuate an element, most decisive
 * first. Press-like verbs outrank the weaker pick/show-menu family, so an element
 * declaring both is walked press-first.
 */
const CLICK_INTENT_AX = ["AXPress", "AXConfirm", "AXOpen", "AXSelect", "AXPick"] as const
/** The activating subset: verbs that state-change or navigate (never a bare pick). */
const ACTIVATING_AX = ["AXPress", "AXConfirm", "AXOpen", "AXSelect"] as const

/**
 * The element's DECLARED actions ranked in click-intent priority order: the
 * press-like verbs first (AXPress, AXConfirm, AXOpen, AXSelect, AXPick), then any
 * other mapped verb in the element's own order, deduped (AXSelect/AXPick both map
 * to `pick`). Falls back to the role default when no usable action is declared.
 *
 * INVARIANT OWNED: an element is actuated by ANY of its declared actions, so the
 * declared rung WALKS this ordered list (skipping any the driver reports
 * unsupported) instead of committing to one verb.
 * hardcode-guard:allow the named live error is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: the wallpaper row's declared rung issued ONE verb
 * (AXPick), the driver rejected it (`AXUIElementPerformAction(AXPick) returned
 * -25206`) and the rung ended though other declared actions remained untried.
 * UNSEEN CASE COVERED: any control declaring several verbs (a cell that both picks
 * and opens) is walked by the same ordering until one delivers.
 */
export function declaredActions(element: Element): readonly ClickAction[] {
  const names = element.actions ?? []
  const ranked = [
    ...CLICK_INTENT_AX.filter((known) => names.some((name) => name === known)),
    ...names.filter((name) => !CLICK_INTENT_AX.some((known) => known === name) && AX_CLICK[name] !== undefined),
  ]
  const actions = ranked.map((name) => AX_CLICK[name]).filter((action): action is ClickAction => action !== undefined)
  const unique = [...new Set(actions)]
  if (unique.length > 0) return unique
  const roleAction = element.role !== undefined ? ROLE_CLICK[element.role] : undefined
  return roleAction !== undefined ? [roleAction] : []
}

/**
 * The element's FIRST declared action (the top of `declaredActions`), or
 * `undefined` when the hand has no declared verb and falls straight to a plain
 * element click / pixel rung.
 */
export function declaredAction(element: Element): ClickAction | undefined {
  return declaredActions(element)[0]
}

/**
 * Whether the element ACTIVATES via a declared click action (AXPress, AXConfirm,
 * AXOpen, AXSelect) — the verbs that state-change or navigate. A pick-only or
 * show-menu-only element is actuable but NOT activating, so it is not preferred as
 * a click target when an activating candidate exists.
 */
export function clickActivating(element: Element): boolean {
  const names = element.actions ?? []
  if (names.some((name) => ACTIVATING_AX.some((known) => known === name))) return true
  if (names.length > 0) return false
  const roleAction = element.role !== undefined ? ROLE_CLICK[element.role] : undefined
  return roleAction !== undefined && roleAction !== "pick"
}

/**
 * The driver's live refusal when an element does not support a requested AX action.
 * The rung records it and walks on while an untried declared action remains.
 */
export const UNSUPPORTED_ACTION = "-25206"

export function isUnsupportedAction(error: string | undefined): boolean {
  return error !== undefined && error.includes(UNSUPPORTED_ACTION)
}

/** Centre of the element's frame (either key name), or undefined when unknown. */
export function elementCenter(element: Element): { x: number; y: number } | undefined {
  const rect = element.frame ?? element.bounds
  if (!rect) return undefined
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
}

/** An axis-aligned frame in screen space (the driver's canonical `{x,y,width,height}`). */
export interface Frame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The element's frame (either key name), or undefined when unknown. */
export const frameOf = (element: Element): Frame | undefined => element.frame ?? element.bounds

/** A small margin so a control hugging an edge is treated as needing a reveal. */
export const VISIBILITY_MARGIN = 4

/**
 * The containing window's VISIBLE bounds, from the freshest observation: the frame
 * of the observed `AXWindow` node (the largest such node, when several nest). This
 * is the sensor's field of view — an element may be in the AX tree yet sit BELOW
 * the pane's visible area, and only the window frame exposes that. `undefined`
 * when no window node was observed (the caller then cannot prove invisibility).
 */
export function windowBounds(elements: readonly Element[]): Frame | undefined {
  const windows = elements.filter((element) => element.role === "AXWindow" && frameOf(element) !== undefined)
  const area = (element: Element): number => {
    const frame = frameOf(element)
    return frame === undefined ? -1 : frame.width * frame.height
  }
  const best = windows.sort((a, b) => area(b) - area(a))[0]
  return best === undefined ? undefined : frameOf(best)
}

/**
 * VISIBILITY PREDICATE — whether a frame lies INSIDE the visible bounds eroded by
 * `margin`, so a control whose edge is cut off reads as not-yet-visible.
 */
export function withinBounds(frame: Frame, bounds: Frame, margin = VISIBILITY_MARGIN): boolean {
  return (
    frame.x >= bounds.x + margin &&
    frame.y >= bounds.y + margin &&
    frame.x + frame.width <= bounds.x + bounds.width - margin &&
    frame.y + frame.height <= bounds.y + bounds.height - margin
  )
}

/** The edge a frame overflows its bounds on (the axis of the greatest overflow). */
export function scrollDirection(frame: Frame, bounds: Frame): "up" | "down" | "left" | "right" {
  const below = frame.y + frame.height - (bounds.y + bounds.height)
  const above = bounds.y - frame.y
  const right = frame.x + frame.width - (bounds.x + bounds.width)
  const left = bounds.x - frame.x
  const most = Math.max(below, above, right, left)
  if (most === below) return "down"
  if (most === above) return "up"
  if (most === right) return "right"
  return "left"
}

/** The driver's per-line scroll distance assumed when sizing a reveal scroll. */
export const REVEAL_LINE = 20
/** A reveal scroll never exceeds this many lines in one step (bounded, re-observed). */
export const REVEAL_SCROLL_MAX = 10
/** How much taller a reveal tries to grow the window when no scroller exists. */
export const REVEAL_GROW_PX = 300

// ── GEOMETRY-AUTHORITATIVE VISIBILITY ───────────────────────────────────────
/**
 * The role vocabulary whose frame CLIPS its descendants — a scroll area/list/
 * table bounds what is on screen inside it. Used to find the nearest container a
 * targeted reveal scrolls, and to clip an element's visible rect.
 */
export const SCROLL_CONTAINER_ROLES = new Set([
  "AXScrollArea",
  "AXScrollView",
  "AXWebArea",
  "AXWebView",
  "AXList",
  "AXOutline",
  "AXTable",
  "AXTree",
])

const intersectFrame = (a: Frame, b: Frame): Frame => {
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), width: right - Math.max(a.x, b.x), height: bottom - Math.max(a.y, b.y) }
}

const isEmptyFrame = (frame: Frame): boolean => frame.width <= 0 || frame.height <= 0

const enclosesFrame = (outer: Frame, inner: Frame): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

/**
 * The element's ANCESTOR CHAIN, nearest-first. Containment comes from the wire's
 * `parent_index` chain where available; otherwise (a tree that omits indices) from
 * FRAME CONTAINMENT — every observed element whose frame holds this one, innermost
 * (smallest area) first. This is the clip chain a visible rect is intersected with.
 */
export function ancestorChain(element: Element, elements: readonly Element[]): readonly Element[] {
  const byIndex = new Map<number, Element>()
  for (const candidate of elements)
    if (candidate.element_index !== undefined) byIndex.set(candidate.element_index, candidate)
  const chain: Element[] = []
  let current = element.parent_index === undefined ? undefined : byIndex.get(element.parent_index)
  for (let depth = 0; current !== undefined && depth < 64; depth++) {
    chain.push(current)
    current = current.parent_index === undefined ? undefined : byIndex.get(current.parent_index)
  }
  if (chain.length > 0) return chain
  const rect = frameOf(element)
  if (rect === undefined) return chain
  return elements
    .filter((candidate) => {
      const frame = candidate === element ? undefined : frameOf(candidate)
      return frame !== undefined && enclosesFrame(frame, rect)
    })
    .sort((a, b) => {
      const ra = frameOf(a)!
      const rb = frameOf(b)!
      return ra.width * ra.height - rb.width * rb.height
    })
}

/**
 * The element's VISIBLE rect: its frame intersected with every ancestor clip rect
 * up to the window. `undefined` when the element carries no frame; an EMPTY rect
 * (zero width/height) means it is entirely clipped away.
 */
export function visibleRectOf(element: Element, elements: readonly Element[]): Frame | undefined {
  const rect = frameOf(element)
  if (rect === undefined) return undefined
  return ancestorChain(element, elements).reduce<Frame>((visible, ancestor) => {
    const clip = frameOf(ancestor)
    return clip === undefined ? visible : intersectFrame(visible, clip)
  }, rect)
}

/** How much of the element's frame is actually on screen. */
export type VisibilityState = "visible" | "partial" | "off-screen"

/** The scroll that would bring an off-screen element inside its nearest container. */
export interface ScrollIntoView {
  readonly direction: "up" | "down" | "left" | "right"
  readonly px: number
  readonly lines: number
}

export interface Visibility {
  readonly state: VisibilityState
  /** The visible rect (frame ∩ ancestor clips); absent only when the frame is unknown. */
  readonly visibleRect?: Frame
  /** The nearest scrollable ancestor whose content bounds the element. */
  readonly container?: Element
  /** The container's own visible rect — the viewport a reveal scroll must move. */
  readonly bounds?: Frame
  /** The delta (within `container`) that would bring the element into view. */
  readonly scroll?: ScrollIntoView
}

const VISIBILITY_TOL = 1

/**
 * Whether an element is a scroll CONTAINER: it carries a scroll ROLE (`SCROLL_CONTAINER_ROLES`)
 * OR declares a scroll ACTION (`hasScrollActions`). Role lists alone are
 * insufficient — macOS exposes scrollability as actions, so a group with no
 * scroll-area role but with `AXScrollToTop`/`AXScrollToBottom` scrolls its content.
 */
export function isScrollableContainer(element: Element): boolean {
  return SCROLL_CONTAINER_ROLES.has(element.role ?? "") || hasScrollActions(element)
}

/** The nearest scroll container in the ancestor chain (by role OR declared action), or undefined. */
export function scrollContainerOf(element: Element, elements: readonly Element[]): Element | undefined {
  return ancestorChain(element, elements).find((ancestor) => isScrollableContainer(ancestor))
}

/**
 * REVEAL VIA THE ELEMENT'S OWN SANCTIONED ACTION — the target, or its nearest
 * ancestor, that DECLARES a scroll action, plus the verb to invoke on it. This
 * precedes any computed scroll delta or window resize: the element's own
 * `AXScrollToVisible`/`AXScrollToTop`/`AXScrollToBottom` is the app's sanctioned
 * reveal, invoked through the driver's per-element action mechanism.
 * hardcode-guard:allow the named live incident is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: the wallpaper colour swatch declares
 * `AXScrollToVisible` (no scroll-area wraps its pane), so the sanctioned action is
 * the reveal route that a computed scroll delta never had.
 * UNSEEN CASE COVERED: an off-screen row whose scroller ancestor declares
 * `AXScrollToBottom` reveals through that ancestor's own action just the same.
 */
export function sanctionedScroll(
  element: Element,
  elements: readonly Element[],
  direction: "up" | "down" | "left" | "right",
): { readonly element: Element; readonly action: ClickAction } | undefined {
  for (const candidate of [element, ...ancestorChain(element, elements)]) {
    const action = scrollActionFor(candidate, direction)
    if (action !== undefined) return { element: candidate, action }
  }
  return undefined
}

/**
 * The scroll that would bring `element` inside `bounds` (its container's viewport).
 * Direction is the axis of greatest overflow; `px` is the overflow on that axis.
 */
function scrollIntoView(element: Element, elements: readonly Element[]): Pick<Visibility, "container" | "bounds" | "scroll"> {
  const container = scrollContainerOf(element, elements)
  const frame = frameOf(element)
  if (container === undefined || frame === undefined) return {}
  const bounds = visibleRectOf(container, elements)
  if (bounds === undefined || isEmptyFrame(bounds)) return { container }
  const direction = scrollDirection(frame, bounds)
  const px =
    direction === "down"
      ? frame.y + frame.height - (bounds.y + bounds.height)
      : direction === "up"
        ? bounds.y - frame.y
        : direction === "right"
          ? frame.x + frame.width - (bounds.x + bounds.width)
          : bounds.x - frame.x
  return { container, bounds, scroll: { direction, px, lines: Math.max(1, Math.ceil(px / REVEAL_LINE)) } }
}

/**
 * GEOMETRY-AUTHORITATIVE VISIBILITY — classify an element visible / partial /
 * off-screen from the TREE's own geometry (its frame clipped by every ancestor),
 * never from whether a click "worked". An element whose frame lies below its
 * scroll container's viewport is `off-screen` and carries the scroll delta that
 * would reveal it; an element fully inside every clip is `visible`.
 *
 * INVARIANT OWNED: the accessibility tree's own geometry decides what is on
 * screen; a scroll delta is computed within the NEAREST scrollable container.
 * hardcode-guard:allow the named live failure is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: the wallpaper pane's black swatch frame lay BELOW
 * its scroll container's viewport (the Colors row under the fold) yet the flat
 * window-bounds check called it visible, so the reveal never ran.
 * UNSEEN CASE COVERED: a nested chain of clip containers (a scroll area inside a
 * dialog inside a window) clips the element at every level, and a horizontally
 * overflowing table yields a right-scroll delta — both with no loop change.
 */
export function visibilityOf(element: Element, elements: readonly Element[]): Visibility {
  const rect = frameOf(element)
  if (rect === undefined) return { state: "visible" }
  const visible = visibleRectOf(element, elements)
  const state: VisibilityState =
    visible === undefined || isEmptyFrame(visible)
      ? "off-screen"
      : visible.width < rect.width - VISIBILITY_TOL || visible.height < rect.height - VISIBILITY_TOL
        ? "partial"
        : "visible"
  if (state === "visible") return { state, ...(visible !== undefined ? { visibleRect: visible } : {}) }
  return { state, ...(visible !== undefined ? { visibleRect: visible } : {}), ...scrollIntoView(element, elements) }
}

/** The container's own CONTENT signature: its frame plus every descendant's role/label/value/frame. */
function descendantElements(container: Element, elements: readonly Element[]): readonly Element[] {
  const rect = frameOf(container)
  if (container.element_index === undefined || rect === undefined)
    return elements.filter((candidate) => {
      const frame = candidate === container ? undefined : frameOf(candidate)
      return rect !== undefined && frame !== undefined && enclosesFrame(rect, frame)
    })
  const byParent = new Map<number, Element[]>()
  for (const candidate of elements) {
    if (candidate.parent_index === undefined) continue
    const bucket = byParent.get(candidate.parent_index)
    if (bucket) bucket.push(candidate)
    else byParent.set(candidate.parent_index, [candidate])
  }
  const out: Element[] = []
  const stack = [...(byParent.get(container.element_index) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined) continue
    out.push(next)
    if (next.element_index !== undefined) stack.push(...(byParent.get(next.element_index) ?? []))
  }
  return out
}

/**
 * CONTAINER-SCOPED VERIFICATION — the observable signature of a CONTAINER's own
 * content (its frame plus its descendants' role/label/value/frame). A targeted
 * scroll is DELIVERED only when THIS signature moved, so a scroll that moved some
 * other window or region (leaving the intended container's content untouched) is
 * reported undelivered rather than assumed to have worked. Deliberately excludes
 * element_token/snapshot id, so a re-snapshot alone is never read as movement.
 */
export function containerSignature(container: Element, elements: readonly Element[]): string {
  return [container, ...descendantElements(container, elements)]
    .map((element) => {
      const frame = frameOf(element)
      return `${element.role ?? ""}\u0000${element.label ?? ""}\u0000${element.value ?? ""}\u0000${frame?.x ?? ""},${frame?.y ?? ""},${frame?.width ?? ""},${frame?.height ?? ""}`
    })
    .join("\u0001")
}

/** A scroll whose own container content did NOT move — a delivery failure, not a success. */
export const CONTAINER_UNMOVED = "scroll container unmoved"

/**
 * A TARGETED scroll toward an off-screen target: the direction it overflows on and
 * just enough lines to bring it in, scoped to the scroll container when one is
 * known (a bare window scroll otherwise). Pure; the caller issues the call.
 */
export function scrollArgs(
  window: WindowRef,
  frame: Frame,
  bounds: Frame,
  container?: Element,
): Record<string, unknown> {
  const direction = scrollDirection(frame, bounds)
  const overflow =
    direction === "down"
      ? frame.y + frame.height - (bounds.y + bounds.height)
      : direction === "up"
        ? bounds.y - frame.y
        : direction === "right"
          ? frame.x + frame.width - (bounds.x + bounds.width)
          : bounds.x - frame.x
  const amount = Math.max(1, Math.min(REVEAL_SCROLL_MAX, Math.ceil(overflow / REVEAL_LINE)))
  return {
    pid: window.pid,
    window_id: window.window_id,
    ...(container?.element_token !== undefined ? { element_token: container.element_token } : {}),
    direction,
    by: "line",
    amount,
  }
}

/** Args for the driver's window-frame capability, growing the height to `height`. */
export function resizeArgs(window: WindowRef, height: number): Record<string, unknown> {
  return { pid: window.pid, window_id: window.window_id, height: Math.round(height) }
}

/**
 * The driver's `cua-driver_launch_app` ACCEPTED argument names — its declared
 * interface, the source of truth quoted from a live refusal:
 *   "launch_app: unknown argument app; accepted: additional_arguments, bundle_id,
 *    creates_new_application_instance, name, urls, webkit_inspector_port".
 * The application NAME rides under `name` (never the live-rejected `app`).
 */
export const LAUNCH_APP_ACCEPTED = [
  "additional_arguments",
  "bundle_id",
  "creates_new_application_instance",
  "name",
  "urls",
  "webkit_inspector_port",
] as const
/** The accepted argument the application name rides under. */
export const LAUNCH_APP_NAME_ARG = "name"

/** The driver's `cua-driver_launch_app` args: the app name under its accepted `name` argument. */
export function launchAppArgs(app: string): Record<string, unknown> {
  return { [LAUNCH_APP_NAME_ARG]: app }
}

/**
 * Args to invoke an element's OWN declared scroll action through the driver's
 * per-element action mechanism (`cua-driver_click` with the scroll verb): the
 * reveal route that precedes any computed scroll delta or window resize.
 */
export function scrollActionArgs(window: WindowRef, element: Element, action: ClickAction): Record<string, unknown> {
  return {
    pid: window.pid,
    window_id: window.window_id,
    ...(element.element_token !== undefined ? { element_token: element.element_token } : {}),
    action,
  }
}

export interface WindowRef {
  readonly pid: number
  readonly window_id: number
}

export interface ActuationRung {
  readonly mode: "declared" | "foreground" | "pixel"
  /** Telemetry handle: the declared verb, `<verb>+foreground`, or `pixel(x,y)`. */
  readonly label: string
  /** Full `cua-driver_click` args for this rung. */
  readonly args: Record<string, unknown>
  /** The ordered declared actions an ELEMENT rung walks; absent for a pixel rung. */
  readonly actions?: readonly ClickAction[]
}

/**
 * The ordered actuation plan for one click: declared rung first (carrying the
 * element's FULL ordered action list to walk), pixel frame click second. A rung is
 * tried only when its predecessor fails. A pixel rung is emitted only when the
 * frame is known; when no declared action exists the first rung is a plain element
 * click (the pre-existing behaviour).
 *
 * COORDINATE RUNG + AUTHORIZATION: the pixel rung is a coordinate click at the
 * element's frame centre. The driver guards that path — it refuses a raw
 * coordinate click on an AX-exposed element unless the caller passes the
 * documented PER-CALL authorization parameter `allow_px:true`. That flag is
 * supplied ONLY when `authorizeCoordinate` is true (the brain authorized this
 * specific act); by default it is ABSENT, and the refusal is surfaced as the
 * distinct `authorization-required` outcome rather than hidden. No guard, policy
 * or config is touched — only the driver's own sanctioned per-call parameter is used.
 */
export function actuationPlan(
  element: Element,
  window: WindowRef,
  authorizeCoordinate = false,
): readonly ActuationRung[] {
  const base = { pid: window.pid, window_id: window.window_id, element_token: element.element_token }
  const actions = declaredActions(element)
  const declared = actions[0]
  const rungs: ActuationRung[] = [
    declared !== undefined
      ? { mode: "declared", label: declared, args: { ...base, action: declared }, actions }
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
        ...(authorizeCoordinate ? { [AUTHORIZATION_FLAG]: true } : {}),
      },
    })
  return rungs
}

/**
 * The FOREGROUND re-issue of an element rung — the SAME resolved element click,
 * delivered as a real input event. It is the modality that lands where a
 * background AXPress silently no-ops, and it needs no screenshot frame.
 * `undefined` means the rung is already terminal (a `foreground`/`pixel` rung is
 * not escalated further; the frame centre is a coordinate, not an element).
 *
 * INVARIANT OWNED: actuation ESCALATES through EVERY permitted modality before it
 * is declared failed — a silent no-op is not an answer, and a policy refusal is
 * recorded, never a silent stop while a permitted mode remains.
 * hardcode-guard:allow the named live no-op is one instance cited to ground the rule
 * LIVE FAILURE AS ONE INSTANCE: the wallpaper row's declared rung delivered
 * nothing and the click was reported "undelivered on every rung" with the
 * remaining modes never attempted (`modes=[declared]`).
 * UNSEEN CASE COVERED: any second surface that no-ops a background element action
 * (a custom toggle, a canvas control that still exposes an element) escalates to a
 * real foreground input event the same way.
 */
export function escalateRung(rung: ActuationRung): ActuationRung | undefined {
  if (rung.mode !== "declared") return undefined
  return {
    mode: "foreground",
    label: `${rung.label}+foreground`,
    args: { ...rung.args, delivery_mode: "foreground" },
    ...(rung.actions !== undefined ? { actions: rung.actions } : {}),
  }
}

/**
 * ON-DEMAND SENSOR ESTABLISHMENT.
 * INVARIANT OWNED: a SENSOR-DEPENDENT actuator establishes the sensor state it
 * needs ON DEMAND, while an OBSERVER optimizes its own payload independently —
 * the two concerns never contaminate each other's call shape. The loop's
 * observations stay cheap (`include_screenshot:false`); the pixel click rung,
 * which needs a screenshot frame to aim at, establishes one itself when missing.
 * hardcode-guard:allow the named live refusal is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: the pixel click fails live with the driver's
 * no-screenshot-frame refusal because the loop's observations request
 * `include_screenshot:false`, so no frame ever exists when the pixel rung fires.
 * UNSEEN CASE COVERED: any second sensor-dependent actuator (an OCR- or
 * contrast-driven probe) that needs a screenshot frame establishes it the same
 * on-demand way, leaving observer payloads untouched.
 */
/** The driver's live refusal when a pixel click has no screenshot frame to aim at. */
export const NO_SCREENSHOT_FRAME = "No screenshot frame"

/**
 * The distinct reason a COORDINATE click was refused: its target could not be
 * re-resolved in a frame captured immediately before the click. A stale frame's
 * coordinates land on whatever moved into that spot (another window, a dialog), so
 * the click is refused and reported rather than aimed blind.
 */
export const PIXEL_UNVERIFIED = "pixel-target-unverified"

export function isNoFrameError(error: string | undefined): boolean {
  return error !== undefined && error.includes(NO_SCREENSHOT_FRAME)
}

/**
 * The loop's OWN observation payloads. `full_output` returns BOTH halves of the
 * driver's answer: the addressable `elements` array (geometry, tokens, roles) AND the
 * rendered `tree_markdown`, which carries the UNNUMBERED static-text nodes — a pane's
 * displayed labels and values that the elements array omits entirely. A read needs
 * the second half; a navigation decision needs the first.
 */
export function observationArgs(window: WindowRef): Record<string, unknown> {
  return {
    pid: window.pid,
    window_id: window.window_id,
    include_screenshot: false,
    tree_format: "elements",
    full_output: true,
  }
}

/**
 * The ON-DEMAND observation that ESTABLISHES a screenshot frame for a
 * sensor-dependent actuator. Issued only when the actuator reports no frame — the
 * observer never carries a screenshot on its own.
 */
export function frameEstablishingRead(window: WindowRef): Record<string, unknown> {
  return {
    pid: window.pid,
    window_id: window.window_id,
    include_screenshot: true,
    tree_format: "elements",
    full_output: true,
  }
}

/**
 * Whether the hand must establish a frame and retry: a PIXEL rung, not yet
 * frame-established, whose click reported no screenshot frame. Pure — the caller
 * performs the establishing read and the single retry.
 */
export function pixelFrameRetry(rung: ActuationRung, error: string | undefined, frameEstablished: boolean): boolean {
  return rung.mode === "pixel" && !frameEstablished && isNoFrameError(error)
}

/**
 * FUNCTIONAL DELIVERY — delivery is measured by the EFFECT a click exists to
 * produce, when no immediate signal can show it.
 * INVARIANT OWNED: when a click's whole job is to FOCUS a text-bearing target so a
 * consuming sub-step can land, the achievement is the consumer landing — not a
 * signal on the click itself. A raw-command policy that refuses a whole class of
 * gestures is a REFUSAL, reported as such, never a silent no-op.
 * hardcode-guard:allow the named live refusals are instances cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: live probes proved an element-token AXPress on a
 * text field focuses it (a typed char lands in the value) while screen signature,
 * target state, and the focus signal ALL stay unchanged — so the affirmative
 * contract wrongly called a delivered click undelivered. A second instance: the
 * driver REFUSES raw coordinate clicks for any element with an AX node (the pixel
 * path is reserved for canvas/WebGL targets); that refusal is not an undelivered
 * click but a policy refusal.
 * UNSEEN CASE COVERED: a focus click whose consumer is a key command (e.g. a
 * select-all then paste) rather than a type — the consumer landing on the target
 * still proves the click's focus landed.
 */
/** The driver's live refusal of a raw coordinate click on an AX-backed element. */
export const REFUSED_BY_POLICY = "Raw coordinate click blocked"

export function isPolicyRefused(error: string | undefined): boolean {
  return error !== undefined && error.includes(REFUSED_BY_POLICY)
}

/**
 * The authorization flag that gates the raw coordinate-click path (the ocu-guards
 * hook strips it before dispatch; the driver schema is `additionalProperties:false`).
 * A coordinate click on an element with NO accessible target is refused unless the
 * caller passes this flag — the refusal is the distinct `authorization-required`
 * outcome, never a silent undelivered.
 */
export const AUTHORIZATION_FLAG = "allow_px"
/** The distinct reason a coordinate click demands explicit authorization. */
export const AUTHORIZATION_REQUIRED = "authorization-required"

export function isAuthorizationRequired(error: string | undefined): boolean {
  if (error === undefined) return false
  return error.includes(AUTHORIZATION_FLAG) || (isPolicyRefused(error) && /authoriz/i.test(error))
}

/**
 * A click whose target DECLARES an AXPress — its job is to FOCUS the target, not
 * to change its state. Such a click's delivery can only be shown by its consumer.
 */
export function isFocusTarget(element: Element): boolean {
  return (element.actions ?? []).includes("AXPress")
}

/**
 * FUNCTIONAL delivery reasons for a focus click: the consumer sub-step LANDED —
 * either by its OWN success signal (`landed`: a verified value, a completed paste,
 * an arrival) or by the target's own value/label moving in the consumer's
 * observation. Pure — the caller measures both. INVARIANT: a click's delivery is
 * the EFFECT it exists to produce, so the consumer landing is the proof; a
 * consumer that neither lands nor moves a signal is NOT delivery.
 */
export function focusConsumerDelivery(
  before: ClickSignals,
  afterConsumer: ClickSignals,
  _target: Element,
  landed = false,
): ClickDeliveryReason[] {
  return landed || before.target !== afterConsumer.target ? ["focus-consumer"] : []
}

/** Re-judge an UNDELIVERED attempt as DELIVERED when its consumer landed. */
export function foldFocusConsumer(
  attempt: ClickAttemptEvidence,
  afterConsumer: ClickSignals,
  target: Element,
  landed = false,
): ClickAttemptEvidence {
  if (attempt.delivered) return attempt
  const reasons = focusConsumerDelivery(attempt.before, afterConsumer, target, landed)
  return reasons.length === 0 ? attempt : { ...attempt, delivered: true, reasons: [...attempt.reasons, ...reasons] }
}

/**
 * Re-judge an undelivered click OUTCOME as delivered when its consumer landed:
 * fold only the FIRST rung (the declared/focus rung) — the consumer proves that
 * rung's focus — then re-evaluate the verdict.
 */
export function foldFocusOutcome(
  outcome: ClickOutcome,
  afterConsumer: ClickSignals,
  target: Element,
): ClickOutcome {
  if (outcome.worked) return outcome
  const [first, ...rest] = outcome.attempts
  if (first === undefined) return outcome
  return clickVerdict([foldFocusConsumer(first, afterConsumer, target), ...rest])
}

/**
 * How an actuation was carried out: a click rung, a key press, a typed text
 * entry, a scroll, a browser bind/navigate, a clipboard write, an atomic paste,
 * or a read (the observation IS the result).
 */
export type ActuationMode =
  | ActuationRung["mode"]
  | "type"
  | "key"
  | "scroll"
  | "action"
  | "resize"
  | "read"
  | "prepare"
  | "bind"
  | "navigate"
  | "clipboard"
  | "paste"

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

/**
 * Args for the driver's `cua-driver_hotkey` verb: a chord (e.g. `["cmd","v"]`)
 * scoped to the window. The paste route uses it to deliver ONE atomic input
 * event where a surface accepts it, instead of N synthesized per-character
 * presses that land only a prefix.
 */
export function hotkeyArgs(window: WindowRef, keys: readonly string[]): Record<string, unknown> {
  return { pid: window.pid, window_id: window.window_id, keys: [...keys] }
}

/**
 * Evidence note for the paste route: the clipboard was OVERWRITTEN with the goal
 * value and never read back (privacy — the route never inspects the user's
 * clipboard content, and never restores it).
 */
export const CLIPBOARD_REPLACED_NOTE = "clipboard replaced with the goal value (not read back)"

/**
 * KEYSTROKE ROUTE — the sanctioned real-input verb for a target surface that
 * DROPS accessibility insertion.
 * INVARIANT OWNED: where a surface is known to discard accessibility-inserted
 * text, sanctioned REAL key events outrank the accessibility insertion route.
 * `type_text` writes by set-value/AXSetAttribute and only falls back to synthetic
 * keys; a surface that accepts the write but never commits it must be driven by
 * per-character key presses instead. `keySequence` is that verb: one
 * `cua-driver_press_key` arg per code point — exactly the delivery such a surface
 * commits on. Pure; the caller issues the calls and folds the before/after
 * signature.
 * hardcode-guard:allow the named live incident is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: Chromium's address bar shows an accessibility-
 * inserted URL (AXSetAttribute) but does NOT submit it on Return — the driver's
 * own warning; the value appears yet no navigation happens.
 * UNSEEN CASE COVERED: any second surface that drops accessibility insertion —
 * an Electron/WebGL field whose AXSetAttribute write is a no-op — is delivered by
 * the SAME per-character sequence, with no loop change.
 */
export function keySequence(text: string, window: WindowRef, element?: Element): readonly Record<string, unknown>[] {
  return Array.from(text).map((key) => keyPress(key, window, [], element))
}

// ── RESUMABLE TEXT DELIVERY + FRESH HANDLES ─────────────────────────────────
/**
 * INVARIANT OWNED: PARTIAL ACTUATOR OUTPUT IS RESUMABLE and must be driven to
 * completion, never treated as a failure and never submitted half-delivered.
 * `type_text` (foreground, real keystrokes) can land a PREFIX of a long string and
 * report it; the caller parses the report, retries ONLY the remaining suffix, and
 * stops at a bounded round count while keeping the leftover from the last report.
 * hardcode-guard:allow the named live report is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: `type_text` delivered 6 of 24 characters of a URL,
 * the loop pressed Return anyway, and the tab navigated to the 6-character prefix.
 * UNSEEN CASE COVERED: any second partial-delivery actuator (a paste that
 * truncates, a drag that stops short) reports its progress the same way and is
 * resumed by the SAME reducer, no loop change.
 */
export const TYPE_ROUND_MAX = 3

export interface PartialDelivery {
  readonly delivered: number
  readonly total: number
}

/** Parse the driver's partial text-delivery report, e.g. "delivered 6 of 24 character(s)". */
export function parsePartialDelivery(error: string | undefined): PartialDelivery | undefined {
  if (error === undefined) return undefined
  const match = error.match(/delivered\s+(\d+)\s+of\s+(\d+)\s+character/i)
  if (match === null) return undefined
  return { delivered: Number(match[1]), total: Number(match[2]) }
}

export interface TextDeliveryAttempt {
  readonly ok: boolean
  readonly error?: string
}

/** Resumable-delivery state: characters CONFIRMED delivered, rounds spent, and a terminal failure. */
export interface TextDelivery {
  readonly confirmed: number
  readonly rounds: number
  readonly failure?: string
}

export const initialTextDelivery = (): TextDelivery => ({ confirmed: 0, rounds: 0 })

/** The suffix still to deliver after `confirmed` characters landed. */
export const remainingSuffix = (text: string, delivery: TextDelivery): string => text.slice(delivery.confirmed)

export const textDeliveryComplete = (text: string, delivery: TextDelivery): boolean =>
  delivery.failure === undefined && delivery.confirmed >= text.length

/**
 * Advance the resumable-delivery state by ONE attempt: `ok` completes; a partial
 * report advances the confirmed prefix and keeps the leftover for the next round;
 * an unparsable error — or exceeding `maxRounds` with text still outstanding —
 * fails. A partial report is NEVER a failure.
 */
export function textDeliveryStep(
  text: string,
  current: TextDelivery,
  attempt: TextDeliveryAttempt,
  maxRounds = TYPE_ROUND_MAX,
): TextDelivery {
  if (current.failure !== undefined) return current
  const rounds = current.rounds + 1
  if (attempt.ok) return { confirmed: text.length, rounds }
  const partial = parsePartialDelivery(attempt.error)
  if (partial === undefined) return { confirmed: current.confirmed, rounds, failure: attempt.error ?? "type_text failed" }
  const confirmed = Math.min(text.length, current.confirmed + partial.delivered)
  if (confirmed >= text.length) return { confirmed, rounds }
  if (rounds >= maxRounds) return { confirmed, rounds, failure: `text incomplete after ${maxRounds} round(s)` }
  return { confirmed, rounds }
}

/**
 * INVARIANT OWNED: a SNAPSHOT-SCOPED HANDLE must be re-resolved after any call
 * that mints a new snapshot. `refindElement` re-resolves the skill's target by
 * role+label against the NEWEST observation, never the `element_token` captured
 * before an intervening driver call.
 * hardcode-guard:allow the named live error is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: the address-bar focus click used a token whose
 * snapshot a bind had invalidated ("element_token is stale; call get_window_state
 * again to refresh; current snapshots for pid …"), so the click never landed.
 * UNSEEN CASE COVERED: any handler re-resolved across a navigate/prepare that
 * renumbers the tree is refreshed the same way.
 */
export function refindElement(target: Element, elements: readonly Element[]): Element | undefined {
  return elements.find(
    (element) =>
      element.element_token !== undefined &&
      element.role === target.role &&
      (element.label ?? "") === (target.label ?? ""),
  )
}

/** The driver's live refusal when a handle outlives the snapshot that minted it. */
export const STALE_TOKEN = "element_token is stale"

export function isStaleToken(error: string | undefined): boolean {
  return error !== undefined && error.includes(STALE_TOKEN)
}

/**
 * INVARIANT OWNED: TYPED-ROUTE UNAVAILABILITY resolves by POLICY ANSWER, not
 * retry. `browser_prepare` answering `browser_requires_setup` means the target is
 * a live browser with no owned endpoint: retrying is futile, so the route
 * short-circuits to the address-bar sequence.
 * hardcode-guard:allow the named live answer is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: `browser_prepare` answered
 * "browser_requires_setup … no owned endpoint" and the route retried it in vain.
 * UNSEEN CASE COVERED: any second typed route that answers a terminal
 * "unavailable by policy" code short-circuits identically instead of retrying.
 */
export const BROWSER_REQUIRES_SETUP = "browser_requires_setup"

export function browserNeedsSetup(error: string | undefined): boolean {
  return error !== undefined && error.includes(BROWSER_REQUIRES_SETUP)
}

/** Whether a field's observed value matches the value a `type` sub-step delivered. */
export const valueMatches = (actual: string | undefined, expected: string): boolean =>
  actual !== undefined && actual.trim() === expected.trim()

/** The observed value of the target (by role+label) in a fresh element set. */
export function fieldValue(target: Element, elements: readonly Element[]): string | undefined {
  return refindElement(target, elements)?.value
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
/**
 * Which signal established delivery, plus the DIAGNOSTIC reason a rung was
 * refused by driver policy (a refusal is recorded, never a bare undelivered).
 */
export type ClickDeliveryReason =
  | "screen"
  | "target-state"
  | "focus"
  | "focus-consumer"
  | "refused-by-policy"
  | "authorization-required"

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

/**
 * Build one rung's evidence from its before/after signals. A driver POLICY
 * refusal (a raw coordinate click blocked on an AX-backed element) is appended as
 * the diagnostic reason `refused-by-policy`; a refusal that demands an explicit
 * authorization flag for the coordinate path is the distinct
 * `authorization-required` reason. Neither is EVER counted as delivery.
 */
export function clickAttempt(
  rung: ActuationRung,
  before: ClickSignals,
  after: ClickSignals,
  target: Element,
  error?: string,
): ClickAttemptEvidence {
  const reasons = deliveryReasons(before, after, target)
  const delivered = reasons.length > 0
  const refused: ClickDeliveryReason[] = []
  if (isPolicyRefused(error)) refused.push("refused-by-policy")
  if (isAuthorizationRequired(error)) refused.push("authorization-required")
  return {
    mode: rung.mode,
    label: rung.label,
    before,
    after,
    delivered,
    reasons: [...reasons, ...refused],
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
