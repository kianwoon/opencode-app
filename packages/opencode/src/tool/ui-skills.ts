/**
 * SKILLS organ — the MANEUVER layer between the decider and the hands.
 *
 * CONTRACT:
 *   1. ONE DECISION, MANY ACTIONS — a composite navigation intent (navigate the
 *      address bar to a URL) is offered to jev as ONE frontier option. Choosing
 *      it executes a FIXED sub-sequence with no per-sub-step jev decision, so a
 *      four-fragile-decision struggle collapses into one maneuver.
 *   2. DETERMINISTIC DECOMPOSITION — a skill declares { name, option (the single
 *      frontier label), precondition (a pure predicate over the observation),
 *      select (the element it drives), steps (the fixed hand sequence, values
 *      drawn from the goal's extracted value), success (what change evidence
 *      means it worked) }. The loop executes the steps literally.
 *   3. VALUES FROM THE GOAL — a step's text is the goal's extracted value; the
 *      skill neither knows nor names any site.
 *   4. REGISTRY — skills are contract objects in `SKILLS`; adding a skill is
 *      adding an entry. The loop never special-cases a site.
 *   5. AFFIRMATIVE CLICK SUB-STEPS — a click sub-step must be DELIVERED (world
 *      state changed) before the next sub-step runs; an undelivered click aborts
 *      the maneuver with its evidence rather than proceeding on a driver ok code.
 *   6. BOUNDED A-PRIORI LIBRARY + MINING — the registry holds the STANDARD GUI
 *      maneuvers (type, search, scroll, switch, dismiss, read) so the user never
 *      feeds cases. Telemetry only FLAGS repeated delivered sub-sequences as
 *      promotion candidates; promotion into the registry stays a human decision
 *      — there is NO runtime self-modification.
 *
 * INVARIANT OWNED: the decider chooses maneuvers; the loop interprets the
 * registry; skills decompose deterministically; values come from the goal; the
 * registry is closed (a-priori entries plus human-promoted additions).
 * LIVE FAILURE AS ONE INSTANCE: PER-CASE FEEDING — every new flow arrived as a
 * bespoke instruction the user had to hand the agent ("go to this URL", "dismiss
 * that dialog", "scroll to the footer"); the standard library replaces the feed
 * with declared maneuvers pickable from the frontier.
 * LIVE FAILURE AS ONE INSTANCE (cont.): reaching a URL took four separate
 * decisions (focus the field, select-all, type, Enter), each fragile; `go_to_url`
 * collapses them into one option.
 * hardcode-guard:allow the named live partial-delivery incident is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE (cont.): the address bar's per-character entry
 * landed only a prefix of the goal value; the route now writes the goal value to
 * the clipboard and delivers it with ONE atomic `cmd+v` paste (bounded type
 * fallback only when the clipboard write is unavailable).
 * UNSEEN CASE THE REGISTRY SHAPE COVERS: a `drag_to` maneuver (press, move,
 * release) — same contract object, no loop change.
 */

import type { Element } from "./ui-eyes"
import type { ActuationMode } from "./ui-hands"
import type { ManeuverName } from "./ui-maneuvers"

/** A fixed hand action a skill's sub-sequence performs. */
export type SkillStep =
  | { readonly kind: "click"; readonly label: string }
  | { readonly kind: "key"; readonly label: string; readonly key: string; readonly modifiers: readonly string[] }
  /**
   * A text entry. `verify` asks the loop to read the target's value back and, on a
   * mismatch (a partially-delivered entry), re-do select-all + the entry ONCE —
   * the destination is confirmed before any later submit (Return).
   */
  | { readonly kind: "type"; readonly label: string; readonly text: string; readonly verify?: boolean }
  /**
   * The SANCTIONED KEYSTROKE verb: deliver `text` as REAL per-character key
   * events (never accessibility insertion), for a surface known to drop an
   * inserted value without committing it.
   */
  | { readonly kind: "keys"; readonly label: string; readonly text: string }
  /**
   * CLIPBOARD WRITE — replace the clipboard with the goal's value as ONE atomic
   * payload, the precondition for a single-event paste. The route never reads the
   * clipboard back (privacy); a failed write is disclosed, not fatal — the paste
   * sub-step then falls back to the bounded resumable type path.
   */
  | { readonly kind: "clipboard"; readonly label: string; readonly text: string }
  /**
   * ATOMIC PASTE — enter the clipboard as ONE `cmd+v` input event, never N
   * synthesized per-character presses (which land only a prefix). The runner falls
   * back to the bounded resumable type path when the clipboard write did not land.
   */
  | { readonly kind: "paste"; readonly label: string; readonly text: string; readonly verify?: boolean }
  /**
   * VALUE GATE — read the target's value back and confirm it matches the goal's
   * value BEFORE any later submit (Return). A mismatch aborts the maneuver rather
   * than navigating to a malformed destination.
   */
  | { readonly kind: "verifyValue"; readonly label: string; readonly text: string }
  | {
      readonly kind: "scroll"
      readonly label: string
      readonly direction: "up" | "down"
      readonly by?: string
      readonly amount?: number
    }
  /** No actuation: the observation is the result. `match` selects the labels to fold. */
  | { readonly kind: "read"; readonly label: string; readonly match: string }
  /**
   * SANCTIONED TYPED ROUTES. `prepare` attaches/owns the browser DevTools endpoint
   * for the window's pid (`browser_prepare`), the precondition for a bind to
   * succeed on a Chromium window; `bind` binds the window to a browser target
   * (mode 1: pid+window_id) and CLASSIFIES it; `navigate` drives the bound tab to
   * a URL through the browser tool; `verifyUrl`/`verifyScreen` RE-READ the world and
   * set `urlChanged` to the URL/title/page actually changing — never an
   * intermediate.
   */
  | { readonly kind: "prepare"; readonly label: string }
  | { readonly kind: "bind"; readonly label: string }
  | { readonly kind: "navigate"; readonly label: string; readonly url: string }
  | { readonly kind: "verifyUrl"; readonly label: string; readonly url: string }
  | { readonly kind: "verifyScreen"; readonly label: string }
  /** A runtime branch: a browser-classified bind takes `browser`, else `fallback`. */
  | {
      readonly kind: "branch"
      readonly label: string
      readonly browser: readonly SkillStep[]
      readonly fallback: readonly SkillStep[]
    }

/** A skill matched against one observation: the skill, its target element, and the goal's value. */
export interface SkillMatch {
  readonly skill: Skill
  readonly element: Element
  readonly value: string
}

/** Per-sub-step evidence folded into the skill's ONE step in the loop's trace. */
export interface SkillSubstepEvidence {
  readonly label: string
  readonly mode: ActuationMode
  readonly before: string
  readonly after: string
  readonly changed: boolean
  /**
   * Affirmative click delivery (multi-signal world state), when the sub-step was
   * a click. `false` means the click changed nothing observable; the skill aborts
   * rather than proceeding to the next sub-step on an undelivered click.
   */
  readonly delivered?: boolean
  /** A read sub-step's result: the observed labels matching the step's `match` token. */
  readonly read?: readonly string[]
  /**
   * A verify sub-step's result: the browser page URL/title (or the window's page
   * signature on the native fallback) actually CHANGED. The only success signal a
   * `go_to_url` route may rely on — Chromium does not submit an
   * accessibility-inserted address-bar entry on Return, so intermediate signals
   * (the typed value, the key press landing) must never be read as success.
   */
  readonly urlChanged?: boolean
  /**
   * The URL this sub-step REQUESTED (a navigate/paste destination). Recorded for
   * every navigate/paste attempt so the evidence carries the request independent
   * of whether the landing was readable.
   */
  readonly urlRequested?: string
  /**
   * The ARRIVAL measurement for a verify sub-step: where the page LANDED relative
   * to the goal URL, by destination identity (host). `arrived-via-redirect` means
   * a same-host redirect (login/feed/canonical); `different-host` is honest
   * failure. Carries both the requested (goal) and the landed URL.
   */
  readonly arrival?: Arrival
  /**
   * A value-gate sub-step's result: the target's observed value MATCHED the
   * goal's value, so the following Return may proceed. `false` aborts the
   * maneuver before submitting a malformed destination.
   */
  readonly valueMatched?: boolean
  /**
   * A privacy/actuation disclosure on a sub-step (e.g. the clipboard was replaced
   * with the goal value and never read back). Never carries clipboard contents.
   */
  readonly note?: string
  /**
   * A text sub-step's resumable-delivery accounting: rounds spent driving the
   * string to completion and the FINAL confirmed character count. Partial output
   * is not failure — a completed delivery records `delivered === text.length`.
   */
  readonly textDelivery?: { readonly rounds: number; readonly delivered: number }
}

export interface Skill {
  /** The maneuver name — drawn from the shared registry (`ManeuverName`). */
  readonly name: ManeuverName
  /** The single frontier option jev is offered for this maneuver. */
  readonly option: string
  /** Pure precondition over the observation; `value` is the goal's extracted value (may be absent). */
  readonly applies: (elements: readonly Element[], value: string | undefined) => boolean
  /** The element the skill drives (e.g. the address bar), or undefined when absent. */
  readonly select: (elements: readonly Element[], value?: string) => Element | undefined
  /** The fixed sub-sequence, values drawn from the goal's value. */
  readonly steps: (match: SkillMatch) => readonly SkillStep[]
  /** What the folded change evidence means the skill worked. */
  readonly succeeded: (evidence: readonly SkillSubstepEvidence[]) => boolean
}

// DRIVER VOCABULARY — site/app-agnostic role names and label markers the AX wire
// exposes. No site or app name appears anywhere in this registry.
// hardcode-guard:allow AX role/label vocabulary is driver naming, not a case literal
const URL_BAR_ROLES = new Set(["AXTextField", "AXSearchField", "AXComboBox"])
/** Role/label marks a text field as the address/URL bar (site-agnostic). */
const URL_BAR_LABEL = /(address|url|location).*(bar|field|box)?/i
/** Enabled text-entry roles a generic text field can be declared as. */
const TEXT_ROLES = new Set(["AXTextField", "AXSearchField", "AXComboBox", "AXTextArea"])
/** Label marks a text field as a search field. */
const SEARCH_LABEL = /search/i
/** Label marks a control as the dialog's dismiss/cancel affordance. */
const DISMISS_LABEL = /\b(cancel|close|dismiss|not now|later|no thanks|don'?t)\b/i
/** Roles a dialog/sheet/alert can be declared as (Escape fallback target). */
const DIALOG_ROLES = new Set(["AXSheet", "AXDialog", "AXAlert"])
/** Role a scrollable region is declared as (the scroll_to anchor). */
const SCROLL_ROLES = new Set(["AXScrollArea"])
/** Tab/window control roles and label markers. */
const TAB_ROLES = new Set(["AXRadioButton", "AXTabGroup", "AXTab"])
const TAB_LABEL = /\b(tab|window)\b/i
/** Label marks a control as a window container (the `Cmd+`` cycle fallback). */
const WINDOW_LABEL = /\bwindow\b/i
// END DRIVER VOCABULARY

const enabled = (element: Element): boolean => element.enabled !== false
/** A usable control: a token + role present and enabled. */
const usable = (element: Element): boolean =>
  element.element_token !== undefined && element.role !== undefined && enabled(element)
const labelled = (element: Element, re: RegExp): boolean => re.test(element.label ?? "")

/** Actuation modes that are CLICKS (a click sub-step must show affirmative delivery). */
const CLICK_MODES = new Set<ActuationMode>(["declared", "pixel"])

// hardcode-guard:allow the driver's browser tool/status vocabulary is driver naming, not a case literal
/** A browser bind result: whether the window classifies as a browser, plus the bound page. */
export interface BrowserBinding {
  readonly browser: boolean
  readonly url?: string
  readonly title?: string
  readonly target_id?: string
  readonly tab_id?: string
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * ARRIVAL — where a navigation LANDED, measured by destination IDENTITY, not
 * string equality.
 * INVARIANT OWNED: arrival is measured by destination identity, not string
 * equality — servers redirect. A navigation that leaves the previous page but is
 * then redirected by the site (login/feed/canonical) HAS arrived when the landed
 * URL's host matches the goal URL's host; only a different HOST is honest failure.
 * `viaRedirect` distinguishes an exact/canonical landing from a same-host redirect.
 * hardcode-guard:allow the named live redirect is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: `go_to_url(https://www.linkedin.com/messaging/` was
 * redirected by LinkedIn to a same-host login/feed URL, so an exact-string compare
 * read a successful arrival as failure and the loop re-issued the maneuver.
 * UNSEEN CASE COVERED: any host that canonicalizes (trailing slash, `www.`,
 * locale path, `?utm_…`) — the identity compare ignores the string variance.
 */
export interface Arrival {
  readonly status: "arrived" | "arrived-via-redirect" | "different-host" | "unknown"
  readonly goalUrl: string
  readonly landedUrl?: string
}

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/** Host identity: case-insensitive, with a leading `www.` dropped (a pure alias). */
const hostIdentity = (host: string): string => (host.startsWith("www.") ? host.slice(4) : host).toLowerCase()

/**
 * Measure arrival of `landedUrl` at `goalUrl`. Different host → `different-host`
 * (never arrival). Same host with the same normalized path → `arrived`; a deeper
 * path under the goal path → `arrived`; any other same-host landing (a redirect to
 * login/feed/canonical) → `arrived-via-redirect`. Unparseable input → `unknown`.
 */
export function arrival(goalUrl: string, landedUrl: string | undefined): Arrival {
  const landed = landedUrl !== undefined ? parseUrl(landedUrl) : undefined
  if (landed === undefined) return { status: "unknown", goalUrl, ...(landedUrl !== undefined ? { landedUrl } : {}) }
  const goal = parseUrl(goalUrl)
  if (goal === undefined) return { status: "unknown", goalUrl, landedUrl }
  if (hostIdentity(goal.host) !== hostIdentity(landed.host)) return { status: "different-host", goalUrl, landedUrl }
  const goalPath = goal.pathname.replace(/\/$/, "")
  const landedPath = landed.pathname.replace(/\/$/, "")
  if (landedPath === goalPath) return { status: "arrived", goalUrl, landedUrl }
  if (goalPath !== "" && landedPath.startsWith(`${goalPath}/`)) return { status: "arrived", goalUrl, landedUrl }
  return { status: "arrived-via-redirect", goalUrl, landedUrl }
}

/**
 * Classify a `get_browser_state` BIND result (mode 1: pid+window_id). A browser is
 * a result reporting a usable binding (`status:"ok"`, and `mutation_allowed` not
 * false); a non-browser window or a failed bind yields `browser:false` and the
 * caller falls back to the address-bar route. Fields the wire omits stay
 * undefined; the first tab is preferred when a `tabs` array is present.
 */
export function decodeBrowserBinding(input: unknown): BrowserBinding {
  const raw = asRecord(input)
  if (raw === undefined) return { browser: false }
  const status = asString(raw.status)
  const browser = status === "ok" && raw.mutation_allowed !== false
  const tabs = Array.isArray(raw.tabs) ? raw.tabs : []
  const active = tabs.map(asRecord).find((tab) => tab?.active === true) ?? asRecord(tabs[0])
  const scope = active ?? raw
  return {
    browser,
    url: asString(scope?.url) ?? asString(raw.url),
    title: asString(scope?.title) ?? asString(raw.title),
    target_id: asString(raw.target_id),
    tab_id: asString(scope?.tab_id) ?? asString(raw.tab_id),
  }
}

/**
 * The address-bar route: focus the bar, write the goal's URL to the clipboard as
 * ONE atomic payload, select-all, deliver it as a single `cmd+v` PASTE (one input
 * event Chromium accepts and submits on Return — never N synthesized keystrokes,
 * which land only a prefix), CONFIRM the bar's value matches the URL before
 * submitting, then Return, then VERIFY the page changed. The `verifyValue` gate
 * holds the Return until the destination actually landed, so a truncated or
 * mismatched entry never navigates. The clipboard is OVERWRITTEN and never read
 * back; the paste sub-step falls back to the bounded resumable type path when the
 * clipboard write fails. The verify is the only success signal — the delivered
 * value and the Return landing are intermediate.
 */
// hardcode-guard:allow the sub-step verb vocabulary is the registry's own contract, not a case literal
const addressBarRoute = (value: string): readonly SkillStep[] => [
  { kind: "click", label: "focus address bar" },
  { kind: "clipboard", label: "copy url to clipboard", text: value },
  { kind: "key", label: "select all", key: "a", modifiers: ["cmd"] },
  { kind: "paste", label: "paste url", text: value, verify: true },
  { kind: "verifyValue", label: "verify url value", text: value },
  { kind: "key", label: "enter", key: "return", modifiers: [] },
  { kind: "verifyScreen", label: "verify page changed" },
]

/**
 * The SANCTIONED browser route: drive the bound tab to the URL through the typed
 * browser tool (no synthesized key sequence), then verify the page URL/title
 * changed.
 */
const browserRoute = (value: string): readonly SkillStep[] => [
  { kind: "navigate", label: `navigate to ${value}`, url: value },
  { kind: "verifyUrl", label: "verify url arrived", url: value },
]

/**
 * The non-browser fallback, in two rungs. A Chromium window's bind FAILS until the
 * DevTools endpoint is attached, so the first rung PREPARES the browser endpoint
 * (`browser_prepare`) and re-binds; when the window now classifies as a browser the
 * typed `browser_navigate` route runs, and only a window that is still not
 * browser-classifiable falls to the LAST-resort keystroke address-bar route.
 */
const preparedFallback = (value: string): readonly SkillStep[] => [
  { kind: "prepare", label: "prepare browser" },
  { kind: "bind", label: "rebind browser" },
  {
    kind: "branch",
    label: "route after prepare",
    browser: browserRoute(value),
    fallback: addressBarRoute(value),
  },
]

/**
 * Resolve the `go_to_url` arm: the sanctioned typed `browser_navigate` when the
 * window already classifies as a browser, else the prepare-then-rebind fallback.
 * Pure — the loop supplies the bind classification.
 */
export const goToUrlRoute = (isBrowser: boolean, value: string): readonly SkillStep[] =>
  isBrowser ? browserRoute(value) : preparedFallback(value)

/** Success = the LAST sub-step changed the screen AND every click sub-step was DELIVERED. */
const clickDrivenSuccess = (evidence: readonly SkillSubstepEvidence[]): boolean =>
  evidence.length > 0 &&
  (evidence.at(-1)?.changed ?? false) &&
  evidence.every((sub) => (CLICK_MODES.has(sub.mode) ? sub.delivered !== false : true))

/** Success = a read sub-step found the target text on screen. */
const readFound = (evidence: readonly SkillSubstepEvidence[]): boolean =>
  evidence.some((sub) => (sub.read?.length ?? 0) > 0)

/**
 * Success = ARRIVAL at the goal's destination identity: a verify sub-step measured
 * a same-host landing (`arrived`/`arrived-via-redirect`), OR the native address-bar
 * fallback's screen-change verify moved the page. A `different-host` arrival never
 * counts. This is the only honest success signal for a navigation route: neither
 * the requested value nor the Return key landing proves the page moved, and a
 * redirect to the goal host is arrival, not failure.
 */
const arrived = (evidence: readonly SkillSubstepEvidence[]): boolean =>
  evidence.some(
    (sub) =>
      sub.arrival?.status === "arrived" ||
      sub.arrival?.status === "arrived-via-redirect" ||
      sub.urlChanged === true,
  )

/**
 * `go_to_url` — navigate to the goal's URL by the SANCTIONED route. First BIND the
 * window to a browser target (`get_browser_state`, mode 1); when it classifies as a
 * browser, drive the bound tab with `browser_navigate` — no synthesized key
 * sequence. When the bind fails, PREPARE the browser endpoint (`browser_prepare`),
 * re-bind, and again prefer `browser_navigate`; only a window that is still not
 * browser-classifiable falls to the LAST-resort address-bar sequence (clipboard
 * paste, value-gated before Return). EVERY arm ends with a VERIFY sub-step and
 * success is ARRIVAL, measured by destination identity — never string equality. A
 * prepare, bind, or navigate that fails, or a delivery that does not submit,
 * reports honest failure with its evidence chain.
 *
 * INVARIANT (gate c): PREFER THE TARGET'S TYPED, SANCTIONED API over synthesized
 * input sequences. Instances: a raw-coordinate click refused where the AX action
 * exists; Chromium's AX-insert-no-submit where the browser tool exists; absurd
 * per-character typing where `browser_navigate` exists. UNSEEN CASE COVERED: any
 * future typed route (e.g. a native app's AppleScript/URL-scheme verb) slots in as
 * the browser arm and demotes the synthesized fallback identically.
 *
 * INVARIANT (gate e): PREFER ONE ATOMIC INPUT EVENT over N synthesized events when
 * the surface accepts it. Instance: the live per-character `type_text` that landed
 * only a prefix of the goal value, so the address-bar route now writes the goal
 * value to the clipboard and delivers it with ONE `cmd+v` paste. UNSEEN CASE
 * COVERED: any second surface that accepts a single paste but drops synthesized
 * keystrokes (an Electron/WebGL field) takes the SAME atomic-paste route, with a
 * bounded type fallback only when the clipboard write is unavailable.
 *
 * hardcode-guard:allow the named live redirect is one instance cited to ground the invariant
 * INVARIANT (gate d): ARRIVAL IS MEASURED BY DESTINATION IDENTITY, NOT STRING
 * EQUALITY — servers redirect. Instance: the live `go_to_url` the site redirected
 * to a same-host login/feed URL, so an exact-string compare read a successful
 * arrival as failure. UNSEEN CASE COVERED: any host that canonicalizes (trailing
 * slash, `www.`, locale path, tracking query) — the identity compare ignores the
 * string variance and only a different HOST is honest failure.
 */
export const goToUrl: Skill = {
  name: "go_to_url",
  option: "go_to_url: navigate to the goal's URL (browser route, else the address bar)",
  applies: (elements, value) => value !== undefined && value.length > 0 && goToUrl.select(elements) !== undefined,
  select: (elements) =>
    elements.find((element) => usable(element) && URL_BAR_ROLES.has(element.role ?? "") && labelled(element, URL_BAR_LABEL)),
  steps: (match) => [
    { kind: "bind", label: "bind browser" },
    {
      kind: "branch",
      label: "route",
      browser: goToUrlRoute(true, match.value),
      fallback: goToUrlRoute(false, match.value),
    },
  ],
  // hardcode-guard:allow the arrival predicate is the registry's own contract, not a case literal
  succeeded: arrived,
}

/**
 * `type_into` — focus a generic text field (NOT the address/URL bar) and type the
 * goal's value. Success = the type changed the screen and the focus click landed.
 */
export const typeInto: Skill = {
  name: "type_into",
  option: "type_into: focus a text field and type the goal's value",
  applies: (elements, value) => value !== undefined && value.length > 0 && typeInto.select(elements) !== undefined,
  select: (elements) =>
    elements.find(
      (element) => usable(element) && TEXT_ROLES.has(element.role ?? "") && !labelled(element, URL_BAR_LABEL),
    ),
  steps: (match) => [
    { kind: "click", label: `focus ${match.element.label ?? "field"}` },
    { kind: "type", label: "type value", text: match.value },
  ],
  succeeded: clickDrivenSuccess,
}

/**
 * `search_within` — focus a search field, type the goal's query, submit with
 * Enter. Success = the final Enter changed the screen and the focus click landed.
 */
export const searchWithin: Skill = {
  name: "search_within",
  option: "search_within: focus a search field, type the goal's query, submit",
  applies: (elements, value) => value !== undefined && value.length > 0 && searchWithin.select(elements) !== undefined,
  // hardcode-guard:allow AX role vocabulary is driver naming, not a case literal
  select: (elements) =>
    elements.find(
      (element) =>
        usable(element) &&
        TEXT_ROLES.has(element.role ?? "") &&
        !labelled(element, URL_BAR_LABEL) &&
        (element.role === "AXSearchField" || labelled(element, SEARCH_LABEL)),
    ),
  steps: (match) => [
    { kind: "click", label: `focus ${match.element.label ?? "search field"}` },
    { kind: "type", label: "type query", text: match.value },
    { kind: "key", label: "submit", key: "return", modifiers: [] },
  ],
  succeeded: clickDrivenSuccess,
}

/**
 * `scroll_to` — a BOUNDED scroll-down sequence followed by a read of the goal's
 * token. Success = the read found the token's label; the bound keeps it finite
 * when the target never appears.
 */
export const scrollTo: Skill = {
  name: "scroll_to",
  option: "scroll_to: scroll until the goal's text appears",
  // hardcode-guard:allow AX role vocabulary is driver naming, not a case literal
  applies: (elements, value) =>
    value !== undefined &&
    value.length > 0 &&
    // the target must not already be visible — otherwise there is nothing to scroll to
    !elements.some((element) => (element.label ?? "").includes(value)) &&
    scrollTo.select(elements) !== undefined,
  select: (elements) => elements.find((element) => usable(element) && SCROLL_ROLES.has(element.role ?? "")),
  steps: (match) => [
    { kind: "scroll", label: "scroll down", direction: "down", by: "page", amount: 1 },
    { kind: "scroll", label: "scroll down", direction: "down", by: "page", amount: 1 },
    { kind: "read", label: `read ${match.value}`, match: match.value },
  ],
  succeeded: readFound,
}

/**
 * `switch_window_or_tab` — select the tab/window control whose label matches the
 * goal's token; when no control matches, cycle with `Cmd+\`` (the driver's window
 * switch). Success = the screen changed and any click landed.
 */
export const switchWindowOrTab: Skill = {
  name: "switch_window_or_tab",
  option: "switch_window_or_tab: select the tab/window whose label matches the goal's token",
  applies: (elements, value) =>
    value !== undefined && value.length > 0 && switchWindowOrTab.select(elements, value) !== undefined,
  // hardcode-guard:allow AX role vocabulary is driver naming, not a case literal
  select: (elements, value) => {
    const controls = elements.filter(
      (element) => usable(element) && (TAB_ROLES.has(element.role ?? "") || labelled(element, TAB_LABEL)),
    )
    const matched = controls.find((element) => value !== undefined && (element.label ?? "").includes(value))
    // else fall back to a window container, which the Cmd+` step then cycles
    return matched ?? controls.find((element) => labelled(element, WINDOW_LABEL))
  },
  steps: (match) =>
    (match.element.label ?? "").includes(match.value)
      ? [{ kind: "click", label: `select ${match.element.label}` }]
      : [{ kind: "key", label: "cycle windows", key: "`", modifiers: ["cmd"] }],
  succeeded: clickDrivenSuccess,
}

/**
 * `dismiss_dialog` — click the dialog's dismiss/cancel control, else press
 * Escape. The precondition needs no goal value: a dismiss affordance or a dialog
 * role is enough. Success = the screen changed and any click landed.
 */
export const dismissDialog: Skill = {
  name: "dismiss_dialog",
  option: "dismiss_dialog: close the dialog via its cancel control or Escape",
  applies: (elements) => dismissDialog.select(elements) !== undefined,
  select: (elements) =>
    elements.find((element) => usable(element) && labelled(element, DISMISS_LABEL)) ??
    elements.find((element) => usable(element) && DIALOG_ROLES.has(element.role ?? "")),
  steps: (match) =>
    DISMISS_LABEL.test(match.element.label ?? "")
      ? [{ kind: "click", label: `click ${match.element.label}` }]
      : [{ kind: "key", label: "escape", key: "escape", modifiers: [] }],
  succeeded: clickDrivenSuccess,
}

/**
 * `read_text` — no actuation: fold the labels matching the goal's token into the
 * step trace as the read result. Success = at least one label matched.
 */
export const readText: Skill = {
  name: "read_text",
  option: "read_text: read the on-screen text matching the goal's token",
  applies: (elements, value) => value !== undefined && value.length > 0 && readText.select(elements, value) !== undefined,
  // Case-insensitive: a goal-derived token is lower-cased, an on-screen label is not —
  // the same token match the deriver's `includesToken` uses, so a read is offered.
  select: (elements, value) =>
    elements.find(
      (element) => usable(element) && value !== undefined && (element.label ?? "").toLowerCase().includes(value.toLowerCase()),
    ),
  steps: (match) => [{ kind: "read", label: `read ${match.value}`, match: match.value }],
  succeeded: readFound,
}

/** The skill registry. Adding a skill is adding an entry — the loop changes never. */
export const SKILLS: readonly Skill[] = [
  goToUrl,
  typeInto,
  searchWithin,
  scrollTo,
  switchWindowOrTab,
  dismissDialog,
  readText,
]

/**
 * Match every skill whose precondition holds against this observation and the
 * goal's value. A value-less maneuver (e.g. `dismiss_dialog`) may match without a
 * goal value; a value-consuming one is absent (gate b) when the goal carries no
 * value it can consume or its target element is missing.
 */
export function matchSkills(elements: readonly Element[], value: string | undefined): SkillMatch[] {
  return SKILLS.flatMap((skill) => {
    if (!skill.applies(elements, value)) return []
    const element = skill.select(elements, value)
    return element ? [{ skill, element, value: value ?? "" }] : []
  })
}

/** Index the matched skills by the frontier label jev chooses among. */
export function skillIndex(matches: readonly SkillMatch[]): Map<string, SkillMatch> {
  return new Map(matches.map((match) => [match.skill.option, match]))
}

/**
 * A sub-step's URL record: the destination REQUESTED (a navigate/paste) and, for a
 * verify sub-step, the ARRIVAL measured against the goal URL. Both URLs are kept
 * so the evidence never loses the request when the landing is unreadable.
 */
export interface UrlRecord {
  readonly requested?: string
  readonly arrival?: Arrival
}

/**
 * Fold per-sub-step `{ label, mode }`, the observed signatures (`signatures[i]` =
 * before step i, `signatures[i+1]` = after step i), read results, and URL records
 * into the folded evidence the skill is one trace step over. Same before/after
 * contract as the hands' `changeEvidence`.
 */
export function foldSubstepEvidence(
  steps: readonly { readonly label: string; readonly mode: ActuationMode }[],
  signatures: readonly string[],
  delivered?: readonly (boolean | undefined)[],
  reads?: readonly (readonly string[] | undefined)[],
  urlChanges?: readonly (boolean | undefined)[],
  texts?: readonly ({ readonly rounds: number; readonly delivered: number } | undefined)[],
  valueMatches?: readonly (boolean | undefined)[],
  notes?: readonly (string | undefined)[],
  urls?: readonly (UrlRecord | undefined)[],
): SkillSubstepEvidence[] {
  return steps.map((step, i) => {
    const before = signatures[i] ?? ""
    const after = signatures[i + 1] ?? before
    const delivery = delivered?.[i]
    const read = reads?.[i]
    const urlChanged = urlChanges?.[i]
    const textDelivery = texts?.[i]
    const valueMatched = valueMatches?.[i]
    const note = notes?.[i]
    const url = urls?.[i]
    return {
      label: step.label,
      mode: step.mode,
      before,
      after,
      changed: before !== after,
      ...(delivery !== undefined ? { delivered: delivery } : {}),
      ...(read !== undefined ? { read } : {}),
      ...(urlChanged !== undefined ? { urlChanged } : {}),
      ...(textDelivery !== undefined ? { textDelivery } : {}),
      ...(valueMatched !== undefined ? { valueMatched } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(url?.requested !== undefined ? { urlRequested: url.requested } : {}),
      ...(url?.arrival !== undefined ? { arrival: url.arrival } : {}),
    }
  })
}

/** The minimal per-step shape mining scans: the action, its target, and whether it progressed. */
export interface MiningStep {
  readonly action: string | null
  readonly target: string | null
  readonly progressed: boolean
}

/** A repeated progressed sub-sequence flagged for promotion. Candidates only. */
export interface MinedSequence {
  readonly sequence: readonly string[]
  readonly occurrences: number
}

/** Pairs are the smallest promotable maneuver (e.g. focus-click → type). */
const MINING_WINDOW = 2

/**
 * MINE the trace for repeated PROGRESSED sub-sequences (e.g. focus-click → type on
 * the same target, seen >= `threshold` times) and return them as promotion
 * CANDIDATES. This only flags; it never mutates the registry — promotion is a
 * human/brain decision.
 */
export function mineSequences(steps: readonly MiningStep[], threshold = 2): MinedSequence[] {
  const counts = new Map<string, MinedSequence>()
  for (let i = 0; i + MINING_WINDOW <= steps.length; i++) {
    const window = steps.slice(i, i + MINING_WINDOW)
    if (!window.every((step) => step.progressed && step.action !== null)) continue
    const sequence = window.map((step) => `${step.action} ${step.target ?? ""}`.trim())
    const key = sequence.join(" → ")
    const found = counts.get(key)
    counts.set(key, { sequence, occurrences: (found?.occurrences ?? 0) + 1 })
  }
  return [...counts.values()].filter((candidate) => candidate.occurrences >= threshold)
}
