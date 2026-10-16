/**
 * MANEUVERS organ — the decider's OPTION SPACE.
 *
 * CONTRACT: given a SUBGOAL (a short typed descriptor) and the L1 Scene, this
 * module returns the CANDIDATE MANEUVERS: a small ordered, bounded set of typed
 * options, each bound to concrete SCENE targets (item ids / region ids / element
 * refs) with preconditions, a success predicate, and the inputs it needs. The
 * option space is DERIVED from the subgoal + scene SEMANTICS, never from the raw
 * control list — a subgoal is answered with the maneuvers that can advance it, or
 * an explicit empty set, so the loop stops and reports instead of falling back to
 * clicking raw controls. Values come from the subgoal only.
 *
 * LAW 1 (read-only means read-only): a read/open subgoal NEVER offers a
 * state-changing target — checkboxes, radios, toggles and selectable rows are
 * excluded by the L1 classification, so the loop can no longer click a
 * message-list checkbox when asked to open a row.
 *
 * INVARIANT OWNED: the decider's option space is derived from the subgoal +
 * semantics, never from raw controls; every offered option carries a success
 * predicate and is precondition-checked; an unadvanceable subgoal yields an
 * explicit empty set with a reason.
 * LIVE INSTANCE IT FIXES: a loop asked to open a message-list row clicked the
 * list's selection checkboxes and opened a selection toolbar — the option space
 * offered raw state-changing controls instead of navigational items.
 * UNSEEN SUBGOAL SHAPE IT HANDLES: a `dismiss` over a modal whose only control is
 * a dialog region (no cancel label) — the region itself is the target, with
 * Escape as the success-predicate fallback — and an unknown subgoal kind, which
 * degrades to an empty set + reason rather than to raw controls.
 */

import type { Element } from "./ui-eyes"
import type { Scene, SceneItem } from "./ui-scene"
import { dismissDialog, goToUrl, readText, scrollTo, typeInto } from "./ui-skills"

export type SubgoalKind =
  | "navigate"
  | "read_items"
  | "open_item"
  | "scroll_to"
  | "dismiss"
  | "back"
  /** A MUTATION: choose the option whose label/state matches the goal's term. */
  | "apply"
  /** Launch or activate an application the goal named. */
  | "open_app"

export interface Subgoal {
  readonly kind: SubgoalKind
  /** The goal's value (a destination/query/token); supplied, never invented here. */
  readonly value?: string
  /** How many items a read should cover. */
  readonly count?: number
  /** A token the subgoal is about (a label/fragment). */
  readonly matching?: string
  /**
   * MUTATION-only: allow `open_item` to bind a SELECTABLE row (a single-selection
   * navigation row such as a sidebar entry), which LAW 1 excludes for reads/open
   * subgoals. The target is still precondition-checked; the governor still gates it.
   */
  readonly selectable?: boolean
}

export type ManeuverTargetKind = "item" | "region" | "element"

export interface ManeuverTarget {
  readonly kind: ManeuverTargetKind
  readonly id: string
  readonly role?: string
  readonly label?: string
}

export interface ManeuverPrecondition {
  readonly name: string
  readonly met: boolean
  readonly detail?: string
}

export interface ManeuverInput {
  readonly name: string
  readonly required: boolean
  readonly supplied: boolean
  readonly value?: string
}

export interface ManeuverSuccess {
  /** The predicate the loop/verifier checks; a token from the skill vocabulary. */
  readonly predicate: string
  readonly detail: string
}

/**
 * THE SHARED TYPED OPTION REGISTRY — the SINGLE SOURCE OF TRUTH for every
 * maneuver/strategy option name. A union type (`ManeuverName`) plus the runtime
 * array (`MANEUVER_NAMES`) and the category registry (`MANEUVER_REGISTRY`).
 *
 * INVARIANT OWNED: a name can never exist on one side of the boundary (deriver)
 * and not the other (dispatch). The DERIVER builds `ManeuverOption`s whose `name`
 * is a `ManeuverName`; the DISPATCH switches on it exhaustively with a
 * `never`-checked default — so a name the deriver emits but the dispatch cannot
 * route, or vice versa, is a COMPILE error, never a silent fall-through. No
 * literal string comparison gates a code path.
 * hardcode-guard:allow the registry IS the contract vocabulary it declares (names + categories), not case literals
 * LIVE FAILURE AS ONE INSTANCE: the read path was gated on `option.name ===
 * "read_items"` while the deriver emitted `read_text` — the fix was dead code live.
 * UNSEEN CASE COVERED: a new maneuver added to `MANEUVER_NAMES` without a dispatch
 * case fails the `never` check at build time; a dispatch case naming a maneuver
 * absent from the registry is a type error on the `ManeuverName` switch.
 */
export const MANEUVER_NAMES = [
  "go_to_url",
  "type_into",
  "search_within",
  "scroll_to",
  "switch_window_or_tab",
  "dismiss_dialog",
  "read_items",
  "read_text",
  "open_item",
  "activate",
  "select_option",
  "back",
  "open_app",
] as const
export type ManeuverName = (typeof MANEUVER_NAMES)[number]

/** The distinct READ strategies, in attempt order. A strategy is an OFFERED option attribute. */
export const READ_STRATEGY_NAMES = ["direct-token", "label-pairing", "observation-fallback"] as const
export type ReadStrategyName = (typeof READ_STRATEGY_NAMES)[number]

/** How the dispatch routes a maneuver — one category per registered name. */
export type ManeuverCategory = "read" | "skill" | "open_app" | "back" | "actuate"

export const MANEUVER_REGISTRY: Record<ManeuverName, { readonly category: ManeuverCategory }> = {
  go_to_url: { category: "skill" },
  type_into: { category: "skill" },
  search_within: { category: "skill" },
  scroll_to: { category: "skill" },
  switch_window_or_tab: { category: "skill" },
  dismiss_dialog: { category: "skill" },
  read_items: { category: "read" },
  read_text: { category: "read" },
  open_item: { category: "actuate" },
  activate: { category: "actuate" },
  select_option: { category: "actuate" },
  back: { category: "back" },
  open_app: { category: "open_app" },
}

/** The maneuver names that are READS — resolved as observations, never actuated. */
export const READ_MANEUVERS: ReadonlySet<ManeuverName> = new Set(
  (Object.keys(MANEUVER_REGISTRY) as ManeuverName[]).filter(
    (name) => MANEUVER_REGISTRY[name].category === "read",
  ),
)

export interface ManeuverOption {
  readonly name: ManeuverName
  /**
   * For a READ option: the STRATEGY this offered option carries. The loop supplies
   * it (depleting offers), never the executor after the fact.
   */
  readonly strategy?: ReadStrategyName
  readonly label: string
  readonly targets: readonly ManeuverTarget[]
  readonly preconditions: readonly ManeuverPrecondition[]
  readonly success: ManeuverSuccess
  readonly inputs: readonly ManeuverInput[]
}

export interface ManeuverSet {
  readonly options: readonly ManeuverOption[]
  /** Present when no maneuver can advance the subgoal — the loop stops and reports. */
  readonly reason: string | undefined
}

export const MAX_OPTIONS = 12
const DEFAULT_READ_COUNT = 3

const LIST_KIND = "list"
const DIALOG_KIND = "dialog"
const TOOLBAR_KIND = "toolbar"
const CHROME_KIND = "chrome"

const success = (predicate: string, detail: string): ManeuverSuccess => ({ predicate, detail })

const input = (name: string, required: boolean, supplied: boolean, value?: string): ManeuverInput => ({
  name,
  required,
  supplied,
  ...(value !== undefined ? { value } : {}),
})

const includesToken = (haystack: string, token: string): boolean =>
  haystack.toLowerCase().includes(token.toLowerCase())

/** THE SCENE'S OWN TREE — children by `parent_index`, nothing assumed. */
const childrenByParent = (elements: readonly Element[]): Map<number, Element[]> => {
  const byParent = new Map<number, Element[]>()
  for (const element of elements) {
    if (element.parent_index === undefined) continue
    const bucket = byParent.get(element.parent_index)
    if (bucket === undefined) byParent.set(element.parent_index, [element])
    else bucket.push(element)
  }
  return byParent
}

/**
 * DOES THIS ROW LEAD TO THE TARGET? — walks DOWN the scene's own `parent_index`
 * chain from a candidate row and answers whether anything beneath it names the
 * target. This is the ONLY honest reason a row whose own label does not carry the
 * token may be targeted: its subtree leads toward it.
 *
 * INVARIANT OWNED: a navigation candidate is a row that LEADS to the target — its
 * own label carries the token, or its subtree does. Position in the offered list is
 * never a reason to activate anything.
 * LIVE INSTANCE IT FIXES: run #9 activated the first listed row of a non-target pane
 * and the surface went Accessibility -> VoiceOver (the target was nowhere near it).
 * UNSEEN INPUT: a collapsed group whose children the observation still exposes.
 */
const subtreeCarriesToken = (elements: readonly Element[], root: Element, token: string): boolean => {
  if (root.element_index === undefined) return false
  const byParent = childrenByParent(elements)
  const visited = new Set<number>()
  const stack = [...(byParent.get(root.element_index) ?? [])]
  while (stack.length > 0) {
    const current = stack.pop() as Element
    if (current.element_index === undefined || visited.has(current.element_index)) continue
    visited.add(current.element_index)
    stack.push(...(byParent.get(current.element_index) ?? []))
    if (includesToken(`${current.label ?? ""} ${current.value ?? ""}`, token)) return true
  }
  return false
}

/** Every element the Scene exposes — the only controls an option may bind to. */
const sceneElements = (scene: Scene): Element[] => {
  const seen = new Set<Element>()
  for (const item of scene.items) seen.add(item.element)
  for (const text of scene.texts) seen.add(text.element)
  return [...seen]
}

/** Bind an element to a Scene target: item/text id when known, else an element ref. */
const targetOf = (element: Element, scene: Scene): ManeuverTarget => {
  const item = scene.items.find((entry) => entry.element === element)
  if (item) return { kind: "item", id: item.id, role: item.role, label: item.label }
  const text = scene.texts.find((entry) => entry.element === element)
  if (text) return { kind: "element", id: text.id, role: text.role, label: text.text }
  return {
    kind: "element",
    id: element.element_token ?? element.label ?? "element",
    role: element.role ?? "",
    label: element.label ?? "",
  }
}

/** Scene items that sit in a LIST region and are NOT state-changing — the safe rows. */
const listedItems = (scene: Scene, includeSelectable = false): SceneItem[] => {
  const ids = new Set<string>()
  for (const region of scene.regions) {
    if (region.kind !== LIST_KIND) continue
    for (const id of region.itemIds) ids.add(id)
  }
  return scene.items.filter((item) => ids.has(item.id) && (includeSelectable || !item.stateChanging))
}

const regionTarget = (id: string, label?: string): ManeuverTarget => ({
  kind: "region",
  id,
  ...(label !== undefined ? { label } : {}),
})

/** One readable observed element: its Element plus the label/text a read binds to. */
interface Readable {
  readonly element: Element
  readonly label: string
}

/**
 * READABLE OBSERVED ELEMENTS — the labelled rows/values a read may bind to, whether
 * or not they sit in a LIST region: every non-state-changing item plus every
 * standalone (region/item-owned) text. A settled pane's labelled values are
 * readable even when the pane exposes no list.
 */
const observedReadables = (scene: Scene): Readable[] => {
  const itemIds = new Set(scene.items.map((item) => item.id))
  const out: Readable[] = []
  for (const item of scene.items) if (!item.stateChanging) out.push({ element: item.element, label: item.label })
  for (const text of scene.texts) if (!itemIds.has(text.owner)) out.push({ element: text.element, label: text.text })
  return out
}


type Planner = (
  subgoal: Subgoal,
  scene: Scene,
  consumed: readonly ReadStrategyName[],
) => ManeuverOption[]

/**
 * THE OFFERED read-text option: EXACTLY ONE, carrying the NEXT UNCONSUMED strategy
 * as its payload. The loop supplies `consumed` (its ledger records the strategy
 * spent after each attempt), so the PAYLOAD ADVANCES across rounds —
 * direct-token, then label-pairing, then observation-fallback — and an identical
 * re-pick is impossible by construction, with no repeat counter.
 * Emitting one option PER unconsumed strategy made a read subgoal a choice among
 * three near-duplicate labels (`... [direct-token]`, `... [label-pairing]`,
 * `... [observation-fallback]`): the gate could not discriminate them, split their
 * probability mass, and returned no maneuver (`choice-unusable`). One depleting
 * option keeps the choice space non-degenerate while the ledger still spends each
 * strategy exactly once.
 */
/**
 * A MEASURABLE REQUIREMENT PER READ STRATEGY — the verdict comes from the scene, so a
 * strategy is offered only when what it needs is actually present: a direct token
 * match, a label with a value beside it, or readable elements at all. The ladder
 * therefore advances on MEASURED applicability instead of on asserted detail text.
 */
const readStrategyRequirement = (
  strategy: ReadStrategyName,
  scene: Scene,
  matching: string,
): ManeuverPrecondition => {
  const elements = sceneElements(scene)
  if (strategy === "direct-token") {
    const hit = readText.select(elements, matching)
    return {
      name: "matching-text-present",
      met: hit !== undefined,
      detail:
        hit === undefined
          ? `no on-screen label or value carries "${matching}"`
          : `an on-screen element carries the token "${matching}"`,
    }
  }
  if (strategy === "label-pairing") {
    const labels = elements.filter((element) => includesToken(element.label ?? "", matching))
    return {
      name: "labelled-element-present",
      met: labels.length > 0,
      detail:
        labels.length > 0
          ? `${labels.length} element(s) carry a label with "${matching}" for the pairing strategy to pair with a value`
          : `no element carries a label with "${matching}", so the pairing strategy has nothing to pair`,
    }
  }
  const readable = observedReadables(scene)
  return {
    name: "readable-elements-present",
    met: readable.length > 0,
    detail: `${readable.length} readable element(s) available to the observation strategy`,
  }
}

const readTextOptions = (
  scene: Scene,
  matching: string,
  consumed: readonly ReadStrategyName[],
): ManeuverOption[] => {
  const elements = sceneElements(scene)
  const strategy = READ_STRATEGY_NAMES.find(
    (name) => !consumed.includes(name) && readStrategyRequirement(name, scene, matching).met,
  )
  if (strategy === undefined) return []
  const requirement = readStrategyRequirement(strategy, scene, matching)
  const hit = readText.select(elements, matching)
  return [
    {
      name: readText.name,
      strategy,
      label: `${readText.option} [${strategy}]`,
      targets: hit ? [targetOf(hit, scene)] : [],
      preconditions: [requirement],
      success: success("readFound", "the matching text was read into the trace"),
      inputs: [input("matching", true, true, matching)],
    },
  ]
}

const planNavigate: Planner = (subgoal, scene) => {
  const elements = sceneElements(scene)
  const value = subgoal.value ?? ""
  const options: ManeuverOption[] = []
  if (goToUrl.applies(elements, value)) {
    const bar = goToUrl.select(elements, value)
    options.push({
      name: goToUrl.name,
      label: goToUrl.option,
      targets: bar ? [targetOf(bar, scene)] : [],
      preconditions: [
        {
          name: "address-bar-present",
          met: bar !== undefined,
          detail: bar === undefined ? "no labelled address/text field is in the scene" : "a labelled address/text field is in the scene",
        },
        { name: "goal-value-supplied", met: value.length > 0, detail: "the subgoal carries the destination" },
      ],
      success: success(
        "arrived",
        "the landed page's host matches the goal value's host; only a different host is honest failure",
      ),
      inputs: [input("value", true, value.length > 0, value)],
    })
  }
  if (typeInto.applies(elements, value)) {
    const field = typeInto.select(elements, value)
    options.push({
      name: typeInto.name,
      label: typeInto.option,
      targets: field ? [targetOf(field, scene)] : [],
      preconditions: [{ name: "text-field-present", met: field !== undefined, detail: field === undefined ? "no generic text field is in the scene" : "a generic (non-address) text field is in the scene" }],
      success: success("clickDrivenSuccess", "the type changed the screen and the focus click landed"),
      inputs: [input("value", true, true, value)],
    })
  }
  return options
}

const planReadItems: Planner = (subgoal, scene, consumed) => {
  const elements = sceneElements(scene)
  const listed = listedItems(scene)
  const count = subgoal.count ?? DEFAULT_READ_COUNT
  const matching = subgoal.matching
  // The READ targets are the labelled elements the scene supports: list rows when
  // present (a goal-anchored token still filters them), else every observed labelled
  // row/value — so a settled pane with no LIST region still offers its readable values.
  const observed = observedReadables(scene)
  const pool: readonly Readable[] =
    matching !== undefined
      ? observed.filter((entry) => includesToken(entry.label, matching))
      : listed.length > 0
        ? listed.map((item) => ({ element: item.element, label: item.label }))
        : observed
  const chosen = pool.slice(0, count)
  const options: ManeuverOption[] = []
  if (chosen.length > 0) {
    const targets = chosen.map((entry) => targetOf(entry.element, scene))
    options.push({
      name: "read_items",
      label: `read_items: read up to ${count} list item(s)`,
      targets,
      preconditions: [
        { name: "readable-elements-present", met: observed.length > 0, detail: `${observed.length} readable element(s) available` },
      ],
      success: success("readFound", "at least one readable element's content was folded into the trace"),
      inputs: [input("count", false, true, String(count))],
    })
  }
  // OPEN/ACTIVATE bind only rows that LEAD somewhere — the SAME path rule as
  // planOpenItem: a row whose own label carries the token, else a row whose SUBTREE
  // does; never a position pick, and no option at all when nothing leads there.
  const listedDirect =
    matching === undefined ? listed.slice(0, count) : listed.filter((item) => includesToken(item.label, matching))
  const listedByPath =
    matching === undefined || listedDirect.length > 0
      ? []
      : listed.filter((item) => subtreeCarriesToken(elements, item.element, matching))
  const listedChosen = listedDirect.length > 0 ? listedDirect : listedByPath
  if (listedChosen.length > 0) {
    const targets = listedChosen.map((item) => targetOf(item.element, scene))
    options.push({
      name: "open_item",
      label: "open_item: open a listed item (a navigational row, never a state-changing control)",
      targets,
      preconditions: [
        {
          name: "item-not-state-changing",
          met: targets.length > 0 && listedChosen.every((item) => !item.stateChanging),
          detail: `${listedChosen.length} navigational row(s); state-changing controls are excluded by the L1 classification`,
        },
        ...(listedByPath.length > 0
          ? [
              {
                name: "navigable-path-present",
                met: true,
                detail: `no listed row carries "${matching}"; ${listedByPath.length} row(s) expose it in their subtree`,
              },
            ]
          : []),
      ],
      success: success("screenChanged", "opening the item changed the screen / navigated to it"),
      inputs: [input("matching", false, matching !== undefined, matching)],
    })
    const activatable = listedDirect.filter((item) => item.affordances.includes("activatable"))
    if (activatable.length > 0) {
      options.push({
        name: "activate",
        label: "activate: activate a listed activatable control",
        targets: activatable.map((item) => targetOf(item.element, scene)),
        preconditions: [
          {
            name: "activatable-target",
            met: activatable.length > 0,
            detail: `${activatable.length} matching element(s) expose an activating affordance`,
          },
        ],
        success: success("screenChanged", "the activation changed the screen"),
        inputs: [],
      })
    }
  }
  if (matching !== undefined) options.push(...readTextOptions(scene, matching, consumed))
  return options
}

/**
 * LOCATE, THEN NAVIGATE. A row is a navigation candidate for ONE reason: it LEADS to
 * the target — its own label carries the token, or its SUBTREE does. When no row
 * leads there, NO option is offered (the loop stops with the distinct
 * nothing-applicable outcome) instead of activating a row in the hope of progress.
 *
 * INVARIANT OWNED: the target of a navigation is derived from the current location
 * and the observed structure — never from goal text, never from list position.
 * LIVE INSTANCE IT FIXES: run #9 (a non-target pane showing) took the FIRST listed
 * row (`listed.slice(0, count)`) and the surface went Accessibility -> VoiceOver,
 * while the target "About" sat under a different group entirely.
 * UNSEEN INPUT: a target reachable only through a group row whose own label differs
 * from the token but whose descendants carry it -> that group row is the target.
 * hardcode-guard:allow the named live incident is one instance cited to ground the invariant
 */
const planOpenItem: Planner = (subgoal, scene, consumed) => {
  const matching = subgoal.matching
  const elements = sceneElements(scene)
  const listed = listedItems(scene, subgoal.selectable === true)
  const count = subgoal.count ?? DEFAULT_READ_COUNT
  const direct =
    matching === undefined
      ? listed.slice(0, count)
      : listed.filter((item) => includesToken(item.label, matching))
  const byPath =
    matching === undefined || direct.length > 0
      ? []
      : listed.filter((item) => subtreeCarriesToken(elements, item.element, matching))
  const targets = (direct.length > 0 ? direct : byPath).slice(0, count)
  const options: ManeuverOption[] = []
  if (targets.length > 0) {
    options.push({
      name: "open_item",
      label:
        byPath.length > 0
          ? `open_item: navigate the surface toward "${matching}" (a row whose subtree carries it)`
          : "open_item: open the matching listed item (a navigational row)",
      targets: targets.map((item) => targetOf(item.element, scene)),
      preconditions: [
        {
          name: "item-not-state-changing",
          met: targets.every((item) => !item.stateChanging),
          detail: `${targets.length} navigational row(s); state-changing controls are excluded by the L1 classification`,
        },
        ...(byPath.length > 0
          ? [
              {
                name: "navigable-path-present",
                met: true,
                detail: `no listed row carries "${matching}"; ${byPath.length} row(s) expose it in their subtree`,
              },
            ]
          : matching !== undefined
            ? [
                {
                  name: "matching-item-present",
                  met: true,
                  detail: `a listed item's label carries "${matching}"`,
                },
              ]
            : []),
      ],
      success: success("screenChanged", "opening the item changed the screen / navigated to it"),
      inputs: [input("matching", false, matching !== undefined, matching)],
    })
    const activatable = direct.filter((item) => item.affordances.includes("activatable"))
    if (activatable.length > 0) {
      options.push({
        name: "activate",
        label: "activate: activate the matching activatable element",
        targets: activatable.map((item) => targetOf(item.element, scene)),
        preconditions: [
          {
            name: "activatable-target",
            met: activatable.length > 0,
            detail: `${activatable.length} matching element(s) expose an activating affordance`,
          },
        ],
        success: success("screenChanged", "the activation changed the screen"),
        inputs: [],
      })
    }
  }
  if (matching !== undefined) options.push(...readTextOptions(scene, matching, consumed))
  return options
}

const planScrollTo: Planner = (subgoal, scene) => {
  const elements = sceneElements(scene)
  const token = subgoal.matching ?? subgoal.value ?? ""
  if (token.length === 0 || !scrollTo.applies(elements, token)) return []
  const region = scrollTo.select(elements, token)
  return [
    {
      name: scrollTo.name,
      label: scrollTo.option,
      targets: region ? [targetOf(region, scene)] : [],
      preconditions: [
        {
          name: "scroll-region-present",
          met: region !== undefined,
          detail: region === undefined ? "no scrollable region is in the scene" : "a scrollable region is in the scene",
        },
        {
          name: "target-not-visible",
          met: !elements.some((element) => includesToken(element.label ?? "", token)),
          detail: "the token is not yet on screen",
        },
      ],
      success: success("readFound", "the scroll revealed the matching text"),
      inputs: [input("matching", true, true, token)],
    },
  ]
}

const planDismiss: Planner = (_subgoal, scene) => {
  const elements = sceneElements(scene)
  const dialog = scene.regions.find((region) => region.kind === DIALOG_KIND)
  const control = dismissDialog.select(elements)
  if (!dialog && !control) return []
  const target = dialog ? regionTarget(dialog.id, dialog.label) : targetOf(control as Element, scene)
  return [
    {
      name: dismissDialog.name,
      label: dismissDialog.option,
      targets: [target],
      preconditions: [
        {
          name: "dismiss-affordance-present",
          met: dialog !== undefined || control !== undefined,
          detail:
            dialog === undefined && control === undefined
              ? "no dismiss affordance and no dialog region is in the scene"
              : "a cancel/close/dismiss affordance or a dialog region is in the scene",
        },
      ],
      success: success("screenChanged", "the dialog closed (the screen changed)"),
      inputs: [],
    },
  ]
}

const planBack: Planner = (_subgoal, scene) => {
  const toolbar = scene.regions.find((region) => region.kind === TOOLBAR_KIND)
  const chrome = scene.regions.find((region) => region.kind === CHROME_KIND)
  const nav = toolbar ?? chrome
  if (!nav) return []
  return [
    {
      name: "back",
      label: "back: return to the previous view",
      targets: [regionTarget(nav.id, nav.label)],
      preconditions: [
        { name: "navigation-chrome-present", met: nav !== undefined, detail: "a toolbar/chrome region carrying navigation controls is in the scene" },
      ],
      success: success("navigationChanged", "the previous view returned (the screen / path changed)"),
      inputs: [],
    },
  ]
}

/**
 * `apply` — a MUTATION. Offer `select_option` for every scene target whose
 * label (or text) carries the goal's term, so the option is chosen through the
 * SAME affirmative click path as any other activated control (AX→pixel escalation
 * and refused-by-policy reporting apply unchanged; the macOS wallpaper swatches
 * are known to under-declare AX actions, so the pixel rung matters). The success
 * is a STATE reading, never text presence. A scene with no matching option yields
 * an empty set with a reason — the loop stops and reports rather than guessing.
 */
const planApply: Planner = (subgoal, scene) => {
  const matching = subgoal.matching ?? subgoal.value
  if (matching === undefined || matching.length === 0) return []
  const ownedText = new Set(scene.items.map((item) => item.id))
  const options: ManeuverOption[] = []
  const itemTargets = scene.items
    .filter((item) => includesToken(item.label, matching))
    .map((item) => targetOf(item.element, scene))
  if (itemTargets.length > 0)
    options.push({
      name: "select_option",
      label: `select_option: choose the option matching "${matching}"`,
      targets: itemTargets,
      preconditions: [
        { name: "matching-option-present", met: itemTargets.length > 0, detail: `${itemTargets.length} scene item(s) carry "${matching}"` },
      ],
      success: success("optionSelected", "the matching option's observed state (selected/checked/on) is set, not its text"),
      inputs: [input("matching", true, true, matching)],
    })
  const textTargets = scene.texts
    .filter((text) => !ownedText.has(text.owner) && includesToken(text.text, matching))
    .map((text) => targetOf(text.element, scene))
  if (textTargets.length > 0)
    options.push({
      name: "select_option",
      label: `select_option: choose the option whose text matches "${matching}"`,
      targets: textTargets,
      preconditions: [
        { name: "matching-option-text-present", met: textTargets.length > 0, detail: `${textTargets.length} scene text(s) carry "${matching}"` },
      ],
      success: success("optionSelected", "the matching option's observed state (selected/checked/on) is set, not its text"),
      inputs: [input("matching", true, true, matching)],
    })
  return options
}

/**
 * SCENE-FIRST RESOLUTION — the ITEM that exists in the observed tree for a name,
 * descending through the scene's items/texts when the named pane is not a
 * top-level row. Resolution order (case-insensitive): an item whose label IS the
 * name, then an item whose label carries it, then a text carrying it mapped to its
 * OWING (hence nesting) item. `undefined` when the name exists nowhere in the scene.
 * hardcode-guard:allow the named live incident is one instance cited to ground the invariant
 * LIVE FAILURE AS ONE INSTANCE: the goal named the "About" pane, which is not a
 * top-level sidebar row (it sits under "General"); resolving through the scene's
 * items/texts finds the item that exists instead of launching a non-existent app.
 * UNSEEN CASE COVERED: a deeply nested row (parent row -> child row) resolves to
 * the child item by the same descent, never a launch.
 */
export function resolveNamedItem(scene: Scene, name: string): SceneItem | undefined {
  const needle = name.trim().toLowerCase()
  if (needle.length === 0) return undefined
  const exact = scene.items.find((item) => item.label.trim().toLowerCase() === needle)
  if (exact !== undefined) return exact
  const contains = scene.items.find((item) => {
    const label = item.label.trim().toLowerCase()
    return label.length > 0 && (label.includes(needle) || needle.includes(label))
  })
  if (contains !== undefined) return contains
  const text = scene.texts.find((entry) => {
    const value = entry.text.trim().toLowerCase()
    return value.length > 0 && (value === needle || value.includes(needle) || needle.includes(value))
  })
  return text === undefined ? undefined : scene.items.find((item) => item.id === text.owner)
}

/**
 * `open_app` — launch or activate an application named by the goal. The app name
 * is supplied by the plan (derived from the goal's own words), never invented
 * here. SCENE-FIRST: a target that already EXISTS in the observed tree is reached
 * by UI navigation, never by launching an application — so `open_app` is offered
 * ONLY when the named application is absent from the scene. Success = the app is
 * frontmost (its name/window observable in the scene).
 *
 * WHAT THE SCENE CAN AND CANNOT MEASURE: which resource of the frontmost app a name
 * refers to IS measurable — a name the observed tree already holds is navigated to,
 * never launched — and that measurement is the precondition below. Whether a name is
 * an INSTALLED application is NOT observable from a scene; the option is therefore
 * offered only for a name the plan explicitly carries AND which resolves nowhere in
 * the observed tree, so an unknown name fails loudly at the driver instead of being
 * clicked around. Preconditions state measurements, never assertions.
 */
const planOpenApp: Planner = (subgoal, scene) => {
  const app = subgoal.value
  if (app === undefined || app.length === 0) return []
  const inScene = resolveNamedItem(scene, app)
  if (inScene !== undefined) return []
  return [
    {
      name: "open_app",
      label: `open_app: launch or activate "${app}"`,
      targets: [],
      preconditions: [
        { name: "app-named-by-goal", met: app.length > 0, detail: `the plan carries the application name "${app}"` },
        {
          name: "app-absent-from-scene",
          met: inScene === undefined,
          detail: `"${app}" resolves nowhere in the observed tree, so the frontmost app is not already showing it`,
        },
      ],
      success: success("appFrontmost", "the named application is frontmost / its window is present"),
      inputs: [input("app", true, true, app)],
    },
  ]
}

const PLANNERS: Record<SubgoalKind, Planner> = {
  navigate: planNavigate,
  read_items: planReadItems,
  open_item: planOpenItem,
  scroll_to: planScrollTo,
  dismiss: planDismiss,
  back: planBack,
  apply: planApply,
  open_app: planOpenApp,
}

const emptyReason = (subgoal: Subgoal): string =>
  `no maneuver can advance subgoal "${subgoal.kind}": no scene target satisfies any maneuver's precondition — the loop must stop and report rather than fall back to raw controls`

/**
 * NO TWO OPTIONS OFFERED TOGETHER FOR ONE SUBGOAL MAY SHARE A LABEL. A choice
 * space with colliding labels is DEGENERATE: the decider matches an option BY
 * LABEL, so two options carrying the same label are indistinguishable — the verdict
 * lands on one arbitrarily and the other is unreachable. A derived space is
 * therefore asserted label-distinct and fails LOUDLY (throws) rather than silently
 * offering an undecidable set.
 * INVARIANT: option labels in one derived set are pairwise distinct.
 * LIVE INSTANCE: the read offer set degenerated into three near-duplicate labels
 * (`read_text ... [direct-token]`, `[label-pairing]`, `[observation-fallback]`),
 * splitting the choice's probability mass so nothing cleared the gate.
 * UNSEEN INPUT: any future maneuver pair that would emit the same label fails here
 * at derivation.
 * hardcode-guard:allow this names the invariant it enforces, not a case literal
 */
export function assertDistinctOptionLabels(options: readonly ManeuverOption[]): void {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const option of options) {
    if (seen.has(option.label)) duplicates.add(option.label)
    seen.add(option.label)
  }
  if (duplicates.size > 0)
    throw new Error(
      `degenerate choice space: offered options share label(s) [${[...duplicates].join(" | ")}] — options for one subgoal must be label-distinct`,
    )
}

/**
 * Derive the candidate maneuvers for a subgoal against a Scene. Only maneuvers
 * that can advance the subgoal kind are offered; each is bound to Scene targets
 * and carries preconditions, a success predicate and its inputs. An unadvanceable
 * subgoal returns an EMPTY option set with a reason. The derived set is asserted
 * LABEL-DISTINCT before it is bounded (a colliding set is degenerate and fails
 * loudly rather than offering an undecidable choice).
 */
export function deriveManeuvers(
  subgoal: Subgoal,
  scene: Scene,
  consumed: readonly ReadStrategyName[] = [],
): ManeuverSet {
  const planner = PLANNERS[subgoal.kind]
  const derived = planner ? planner(subgoal, scene, consumed) : []
  assertDistinctOptionLabels(derived)
  const options = derived.slice(0, MAX_OPTIONS)
  return { options, reason: options.length > 0 ? undefined : emptyReason(subgoal) }
}
