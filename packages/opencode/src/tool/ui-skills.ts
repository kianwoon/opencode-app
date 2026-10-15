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
 * UNSEEN CASE THE REGISTRY SHAPE COVERS: a `drag_to` maneuver (press, move,
 * release) — same contract object, no loop change.
 */

import type { Element } from "./ui-eyes"
import type { ActuationMode } from "./ui-hands"

/** A fixed hand action a skill's sub-sequence performs. */
export type SkillStep =
  | { readonly kind: "click"; readonly label: string }
  | { readonly kind: "key"; readonly label: string; readonly key: string; readonly modifiers: readonly string[] }
  | { readonly kind: "type"; readonly label: string; readonly text: string }
  | {
      readonly kind: "scroll"
      readonly label: string
      readonly direction: "up" | "down"
      readonly by?: string
      readonly amount?: number
    }
  /** No actuation: the observation is the result. `match` selects the labels to fold. */
  | { readonly kind: "read"; readonly label: string; readonly match: string }

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
}

export interface Skill {
  readonly name: string
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

/** Success = the LAST sub-step changed the screen AND every click sub-step was DELIVERED. */
const clickDrivenSuccess = (evidence: readonly SkillSubstepEvidence[]): boolean =>
  evidence.length > 0 &&
  (evidence.at(-1)?.changed ?? false) &&
  evidence.every((sub) => (CLICK_MODES.has(sub.mode) ? sub.delivered !== false : true))

/** Success = a read sub-step found the target text on screen. */
const readFound = (evidence: readonly SkillSubstepEvidence[]): boolean =>
  evidence.some((sub) => (sub.read?.length ?? 0) > 0)

/**
 * `go_to_url` — focus the address bar, select-all (`Cmd+A`), type the goal's URL,
 * press Enter. One maneuver for a navigation intent that otherwise costs four
 * fragile decisions. Success = the final Enter changed the screen.
 */
export const goToUrl: Skill = {
  name: "go_to_url",
  option: "go_to_url: navigate the address bar to the goal's URL",
  applies: (elements, value) => value !== undefined && value.length > 0 && goToUrl.select(elements) !== undefined,
  select: (elements) =>
    elements.find((element) => usable(element) && URL_BAR_ROLES.has(element.role ?? "") && labelled(element, URL_BAR_LABEL)),
  steps: (match) => [
    { kind: "click", label: `focus ${match.element.label ?? "address bar"}` },
    { kind: "key", label: "select all", key: "a", modifiers: ["cmd"] },
    { kind: "type", label: "type url", text: match.value },
    { kind: "key", label: "enter", key: "return", modifiers: [] },
  ],
  succeeded: clickDrivenSuccess,
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
  select: (elements, value) =>
    elements.find((element) => usable(element) && value !== undefined && (element.label ?? "").includes(value)),
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
 * Fold per-sub-step `{ label, mode }`, the observed signatures (`signatures[i]` =
 * before step i, `signatures[i+1]` = after step i) and any read results into the
 * folded evidence the skill is one trace step over. Same before/after contract as
 * the hands' `changeEvidence`.
 */
export function foldSubstepEvidence(
  steps: readonly { readonly label: string; readonly mode: ActuationMode }[],
  signatures: readonly string[],
  delivered?: readonly (boolean | undefined)[],
  reads?: readonly (readonly string[] | undefined)[],
): SkillSubstepEvidence[] {
  return steps.map((step, i) => {
    const before = signatures[i] ?? ""
    const after = signatures[i + 1] ?? before
    const delivery = delivered?.[i]
    const read = reads?.[i]
    return {
      label: step.label,
      mode: step.mode,
      before,
      after,
      changed: before !== after,
      ...(delivery !== undefined ? { delivered: delivery } : {}),
      ...(read !== undefined ? { read } : {}),
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
