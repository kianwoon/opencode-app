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

export interface ManeuverOption {
  readonly name: string
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

type Planner = (subgoal: Subgoal, scene: Scene) => ManeuverOption[]

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
        { name: "address-bar-present", met: true, detail: "a labelled address/text field is in the scene" },
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
      preconditions: [{ name: "text-field-present", met: true, detail: "a generic (non-address) text field is in the scene" }],
      success: success("clickDrivenSuccess", "the type changed the screen and the focus click landed"),
      inputs: [input("value", true, true, value)],
    })
  }
  return options
}

const planReadItems: Planner = (subgoal, scene) => {
  const elements = sceneElements(scene)
  const listed = listedItems(scene)
  const count = subgoal.count ?? DEFAULT_READ_COUNT
  const matching = subgoal.matching
  const chosen = (matching ? listed.filter((item) => includesToken(item.label, matching)) : listed).slice(0, count)
  const options: ManeuverOption[] = []
  if (chosen.length > 0) {
    const targets = chosen.map((item) => targetOf(item.element, scene))
    options.push({
      name: "read_items",
      label: `read_items: read up to ${count} list item(s)`,
      targets,
      preconditions: [
        { name: "list-items-present", met: true, detail: `${listed.length} non-state-changing list item(s) available` },
      ],
      success: success("readFound", "at least one listed item's readable text was folded into the trace"),
      inputs: [input("count", false, true, String(count))],
    })
    options.push({
      name: "open_item",
      label: "open_item: open a listed item (a navigational row, never a state-changing control)",
      targets,
      preconditions: [
        {
          name: "item-not-state-changing",
          met: true,
          detail: "checkboxes/radios/toggles/selectable rows are excluded by the L1 state-changing classification",
        },
      ],
      success: success("screenChanged", "opening the item changed the screen / navigated to it"),
      inputs: [input("matching", false, matching !== undefined, matching)],
    })
    const activatable = chosen.filter((item) => item.affordances.includes("activatable"))
    if (activatable.length > 0) {
      options.push({
        name: "activate",
        label: "activate: activate a listed activatable control",
        targets: activatable.map((item) => targetOf(item.element, scene)),
        preconditions: [{ name: "activatable-target", met: true, detail: "the option names activatable, non-state-changing targets" }],
        success: success("screenChanged", "the activation changed the screen"),
        inputs: [],
      })
    }
  }
  if (matching !== undefined && readText.applies(elements, matching)) {
    const hit = readText.select(elements, matching)
    options.push({
      name: readText.name,
      label: readText.option,
      targets: hit ? [targetOf(hit, scene)] : [],
      preconditions: [{ name: "matching-text-present", met: true, detail: "an on-screen text carries the subgoal token" }],
      success: success("readFound", "the matching text was read into the trace"),
      inputs: [input("matching", true, true, matching)],
    })
  }
  return options
}

const planOpenItem: Planner = (subgoal, scene) => {
  const matching = subgoal.matching
  const elements = sceneElements(scene)
  const listed = listedItems(scene, subgoal.selectable === true)
  const chosen = (matching ? listed.filter((item) => includesToken(item.label, matching)) : listed).slice(
    0,
    subgoal.count ?? DEFAULT_READ_COUNT,
  )
  const options: ManeuverOption[] = []
  if (chosen.length > 0) {
    const targets = chosen.map((item) => targetOf(item.element, scene))
    options.push({
      name: "open_item",
      label: "open_item: open the matching listed item (a navigational row)",
      targets,
      preconditions: [
        { name: "item-not-state-changing", met: true, detail: "state-changing controls are never offered as open targets" },
        ...(matching !== undefined
          ? [{ name: "matching-item-present", met: true, detail: "a listed item's label carries the subgoal token" }]
          : []),
      ],
      success: success("screenChanged", "opening the item changed the screen / navigated to it"),
      inputs: [input("matching", false, matching !== undefined, matching)],
    })
    const activatable = chosen.filter((item) => item.affordances.includes("activatable"))
    if (activatable.length > 0) {
      options.push({
        name: "activate",
        label: "activate: activate the matching activatable element",
        targets: activatable.map((item) => targetOf(item.element, scene)),
        preconditions: [{ name: "activatable-target", met: true, detail: "a matching activatable element is in the scene" }],
        success: success("screenChanged", "the activation changed the screen"),
        inputs: [],
      })
    }
  }
  if (matching !== undefined && readText.applies(elements, matching)) {
    const hit = readText.select(elements, matching)
    options.push({
      name: readText.name,
      label: readText.option,
      targets: hit ? [targetOf(hit, scene)] : [],
      preconditions: [{ name: "matching-text-present", met: true }],
      success: success("readFound", "the matching text was read into the trace"),
      inputs: [input("matching", true, true, matching)],
    })
  }
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
        { name: "scroll-region-present", met: true, detail: "a scrollable region is in the scene" },
        { name: "target-not-visible", met: true, detail: "the token is not yet on screen" },
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
          met: true,
          detail: "a cancel/close/dismiss affordance, an Escape-capable dialog, or a dialog region is in the scene",
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
        { name: "navigation-chrome-present", met: true, detail: "a toolbar/chrome region carrying navigation controls is in the scene" },
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
        { name: "matching-option-present", met: true, detail: `a scene item whose label carries "${matching}" is present` },
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
        { name: "matching-option-text-present", met: true, detail: `a scene text carrying "${matching}" is present` },
      ],
      success: success("optionSelected", "the matching option's observed state (selected/checked/on) is set, not its text"),
      inputs: [input("matching", true, true, matching)],
    })
  return options
}

/**
 * `open_app` — launch or activate an application named by the goal. The app name
 * is supplied by the plan (derived from the goal's own words), never invented
 * here; the option is offered whenever the subgoal carries one. Success = the app
 * is frontmost (its name/window observable in the scene).
 */
const planOpenApp: Planner = (subgoal, _scene) => {
  const app = subgoal.value
  if (app === undefined || app.length === 0) return []
  return [
    {
      name: "open_app",
      label: `open_app: launch or activate "${app}"`,
      targets: [],
      preconditions: [{ name: "app-named-by-goal", met: true, detail: `the plan carries the application name "${app}"` }],
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
 * Derive the candidate maneuvers for a subgoal against a Scene. Only maneuvers
 * that can advance the subgoal kind are offered; each is bound to Scene targets
 * and carries preconditions, a success predicate and its inputs. An unadvanceable
 * subgoal returns an EMPTY option set with a reason.
 */
export function deriveManeuvers(subgoal: Subgoal, scene: Scene): ManeuverSet {
  const planner = PLANNERS[subgoal.kind]
  const options = planner ? planner(subgoal, scene).slice(0, MAX_OPTIONS) : []
  return { options, reason: options.length > 0 ? undefined : emptyReason(subgoal) }
}
