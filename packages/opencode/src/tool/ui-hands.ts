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

export function isNoFrameError(error: string | undefined): boolean {
  return error !== undefined && error.includes(NO_SCREENSHOT_FRAME)
}

/** The loop's OWN observation payloads: no screenshot (payload economy). */
export function observationArgs(window: WindowRef): Record<string, unknown> {
  return { pid: window.pid, window_id: window.window_id, include_screenshot: false, tree_format: "elements" }
}

/**
 * The ON-DEMAND observation that ESTABLISHES a screenshot frame for a
 * sensor-dependent actuator. Issued only when the actuator reports no frame — the
 * observer never carries a screenshot on its own.
 */
export function frameEstablishingRead(window: WindowRef): Record<string, unknown> {
  return { pid: window.pid, window_id: window.window_id, include_screenshot: true, tree_format: "elements" }
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
export type ClickDeliveryReason = "screen" | "target-state" | "focus" | "focus-consumer" | "refused-by-policy"

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
 * the diagnostic reason `refused-by-policy` — it is NEVER counted as delivery.
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
  return {
    mode: rung.mode,
    label: rung.label,
    before,
    after,
    delivered,
    reasons: isPolicyRefused(error) ? [...reasons, "refused-by-policy"] : reasons,
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
