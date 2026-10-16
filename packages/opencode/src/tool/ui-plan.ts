// hardcode-guard:allow the goal examples in the header are general contract illustrations (a count, a quoted value), not case/site literals; the module reads no site, app or address name
/**
 * PLAN organ — the task/route planner.
 *
 * CONTRACT: given a GOAL (a short natural-language task) and the current Scene,
 * this module derives the CANDIDATE PLAN decompositions — each an ordered list of
 * subgoals, every subgoal carrying a typed PREDICATE that can be evaluated later
 * against a Scene. The decompositions are derived from Scene SEMANTICS (is a
 * readable list already here? a dialog? a navigation affordance?) and the goal's
 * own VALUES (a quoted token / URL / count) — never from a site, app or address
 * name. When more than one decomposition is plausible the candidates are all
 * exposed so the wiring layer can ask jev to choose; the module makes no jev call.
 *
 * INVARIANT OWNED: every subgoal's success is a PREDICATE over the world model
 * (never "we acted"), the derivation is goal-value + scene-semantics only, and
 * `replan` can only ADD a bounded number of corrective subgoals.
 * LIVE INSTANCE: a read-last-N goal over a page already showing a list yields a
 * single `read_items(count N)`; the same goal on a window not yet at that list
 * yields `navigate(goal value)` first.
 * UNSEEN CASE: an oscillation between two views with no dialog present replans
 * with a `back` corrective (no dialog to dismiss) rather than a `dismiss`.
 */

import { carriesTokenWord, isMenuRole, pairInTreeText } from "./ui-eyes"
import type { RegionKind, Scene, SceneItem, SceneRegion, SceneText } from "./ui-scene"
import type { Subgoal, SubgoalKind } from "./ui-maneuvers"
import { resolveNamedItem } from "./ui-maneuvers"

// ---------------------------------------------------------------------------
// Predicate vocabulary — the only things progress may be judged by
// ---------------------------------------------------------------------------

export type Predicate =
  | { readonly op: "url_host"; readonly host: string; readonly pathPrefix?: string }
  /** No-host URL identity (file:, about:, data:): scheme+path, never an empty host. */
  | { readonly op: "url_identity"; readonly scheme: string; readonly path: string }
  | { readonly op: "text_present"; readonly text: string; readonly regionKind?: RegionKind }
  /**
   * ARRIVAL BY SURFACE IDENTITY: the SURFACE'S OWN name (the window label the
   * observation carries) is what "reached the target surface" means — a pane's
   * identity is not a content text, so searching content reports "not arrived"
   * while the loop sits on the target pane. `unknown` when the observation carries
   * no window identity, never a fabricated true.
   */
  | { readonly op: "surface_is"; readonly text: string }
  | { readonly op: "item_present"; readonly matching: string }
  | { readonly op: "region_present"; readonly kind: RegionKind; readonly label?: string }
  | {
      readonly op: "read_count"
      readonly n: number
      readonly regionKind?: RegionKind
      /** Goal-anchor tokens; when present only anchored units count (never any readable unit). */
      readonly anchors?: readonly string[]
    }
  | { readonly op: "dialog_absent" }
  /**
   * READ a labelled element's OWN value: an element whose label/text carries the
   * goal's token is read, and the VALUE it holds (else its label) is cited. This is
   * the "named attribute value" read — a settled pane's labelled rows/values become
   * evidence without actuation.
   */
  | { readonly op: "read_value"; readonly matching: string }
  /**
   * MUTATION, PROVEN BY OBSERVED STATE: an option whose label matches carries an
   * OBSERVED selected/checked/on state. Never satisfied by text presence — a label
   * that merely says "black" is not a selection.
   */
  | { readonly op: "option_selected"; readonly matching: string }
  /** MUTATION: a matching target's observable state (selected/value) is explicitly set. */
  | { readonly op: "state_changed"; readonly matching: string }

export type PredicateKind = Predicate["op"]

/** `unknown` is a first-class verdict: an unevaluable predicate is never `true`. */
export type PredicateVerdict = "true" | "false" | "unknown"

export interface PredicateResult {
  readonly verdict: PredicateVerdict
  readonly evidence: string
  /** For a counting predicate: satisfied units already observed. */
  readonly satisfied?: number
  /** For a counting predicate: the target count. Absent for boolean predicates. */
  readonly target?: number
  /**
   * The concrete observed content that MADE the predicate true (labels/texts/url).
   * Success is evidence-bound: a satisfied predicate with no cited content cannot
   * back a `completed` report.
   */
  readonly cited?: readonly string[]
}

// ---------------------------------------------------------------------------
// Plan shapes
// ---------------------------------------------------------------------------

export interface PlanSubgoal {
  readonly kind: SubgoalKind
  /** The maneuver descriptor (goal value / count / token) — supplied, never invented. */
  readonly params: Subgoal
  readonly success: Predicate
  readonly budget: number
  /** True for a corrective inserted by `replan` (dismiss/back), not derived from the goal. */
  readonly corrective?: boolean
}

export interface Plan {
  readonly goal: string
  readonly subgoals: readonly PlanSubgoal[]
  /** Corrective replans already applied to this plan (bounded by MAX_REPLANS). */
  readonly replans?: number
}

export interface PlanCandidate {
  readonly id: string
  readonly plan: Plan
  readonly rationale: string
}

export interface PlanDecision {
  readonly candidates: readonly PlanCandidate[]
  /** The decomposition to commit to when no external chooser overrides. */
  readonly commit: Plan
  readonly commitId: string
}

/** One executed step: the maneuver key re-issued, the Scene seen after it, its subgoal. */
export interface StepRecord {
  /** Identical re-issues share a maneuver key (skill name + goal value). */
  readonly maneuver: string
  /** The Scene observed after this step. */
  readonly scene: Scene
  /** The plan subgoal index this step targeted, when known. */
  readonly subgoalIndex?: number
}

export const DEFAULT_READ_COUNT = 3
export const MAX_REPLANS = 2
export const NAVIGATE_BUDGET = 6
export const DEFAULT_BUDGET = 6
export const CORRECTIVE_BUDGET = 1

const DIALOG_KIND: RegionKind = "dialog"
const LIST_KIND: RegionKind = "list"
const CONTENT_KIND: RegionKind = "content"

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

const includesToken = (haystack: string, token: string): boolean =>
  haystack.toLowerCase().includes(token.toLowerCase())

const normalizeHost = (host: string): string => host.toLowerCase().replace(/^www\./, "")

/**
 * A parsed URL identity. `host` is empty for scheme-only URLs (file:, about:,
 * data:) — those carry their identity in `scheme`+`path` and must NEVER be
 * compared host-vs-host (an empty host equals every empty host).
 */
interface UrlParts {
  readonly scheme: string
  readonly host: string
  readonly path: string
}

// Optionally-schemed host with at least one dot, optional port and path. A
// regex (not `new URL`) so an unparseable string is a non-match, never a throw.
const URL_RE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d+)?(\/[^\s]*)?$/i
// A scheme-qualified URL with NO host (file:///x, about:blank, data:…). Anything
// with whitespace is prose, not a URL.
const NO_HOST_URL_RE = /^([a-z][a-z0-9+.-]*):(\/{0,2}[^\s]*)$/i
// hardcode-guard:allow the named live incident is one instance cited to ground the invariant
/**
 * A browser DISPLAYS a `file:` URL WITHOUT its scheme — Chromium's omnibox shows
 * only `/…/page.html` — so that bare absolute path carries the SAME `file:`
 * identity and must parse as one.
 * LIVE FAILURE AS ONE INSTANCE: a `file:` goal's arrival was UNOBSERVABLE even on
 * the arrived page, because the omnibox value parsed as no URL, so the loop
 * re-navigated to the repeat bound forever.
 * UNSEEN CASE COVERED: any file-path display (Finder-style, a scheme that hides
 * its scheme) reads as the same `file:` identity, no loop change.
 */
const BARE_FILE_PATH_RE = /^(\/[^\s]+)$/

function urlParts(value: string): UrlParts | undefined {
  const trimmed = value.trim()
  const hostMatch = URL_RE.exec(trimmed)
  if (hostMatch)
    return { scheme: (hostMatch[1] ?? "").toLowerCase(), host: normalizeHost(hostMatch[2]), path: hostMatch[4] ?? "" }
  const noHost = NO_HOST_URL_RE.exec(trimmed)
  if (noHost !== null) {
    // Collapse the authority slashes (file:///x → /x) so scheme+path compare stably.
    const raw = noHost[2]
    return { scheme: noHost[1].toLowerCase(), host: "", path: raw.startsWith("/") ? `/${raw.replace(/^\/+/, "")}` : raw }
  }
  const bare = BARE_FILE_PATH_RE.exec(trimmed)
  if (bare === null) return undefined
  return { scheme: "file", host: "", path: bare[1] }
}

/** A URL rendered for evidence — the identity that actually exists. */
const urlText = (parts: UrlParts): string => {
  if (parts.host.length > 0) return parts.scheme.length > 0 ? `${parts.scheme}://${parts.host}${parts.path}` : `${parts.host}${parts.path}`
  // No host: file:///abs/path keeps its authority slashes; about:blank stays bare.
  return parts.path.startsWith("/") ? `${parts.scheme}://${parts.path}` : `${parts.scheme}:${parts.path}`
}

/** Every string the Scene exposes to a text/host predicate. */
function observables(scene: Scene): readonly string[] {
  return [
    ...scene.items.map((item) => item.label),
    ...scene.items.map((item) => item.element.value ?? ""),
    ...scene.texts.map((text) => text.text),
  ]
}

/** The readable units of ONE region: its non-state-changing row items + its own texts. */
function unitsOfRegion(scene: Scene, region: SceneRegion, allItemIds: ReadonlySet<string>): readonly string[] {
  const itemSet = new Set(region.itemIds)
  const items = scene.items.filter((item) => itemSet.has(item.id) && !item.stateChanging).map((item) => item.label)
  const textIds = new Set(region.textIds)
  const texts = scene.texts
    .filter((text) => textIds.has(text.id) && !allItemIds.has(text.owner))
    .map((text) => text.text)
  return [...items, ...texts]
}

/**
 * The READABLE UNIT labels in the goal-relevant region — the concrete content a
 * read predicate can cite as evidence. A readable unit is a non-state-changing
 * row item or a standalone (region-owned) text.
 */
function readableUnits(scene: Scene, regionKind?: RegionKind): readonly string[] {
  const itemIds = new Set(scene.items.map((item) => item.id))
  if (regionKind === undefined) {
    // No content region is derivable: a region-less scene counts every readable unit;
    // a scene of ONLY chrome/toolbar/dialog contributes NONE (chrome is never content).
    if (scene.regions.length > 0) return []
    const items = scene.items.filter((item) => !item.stateChanging).map((item) => item.label)
    const texts = scene.texts.filter((text) => !itemIds.has(text.owner)).map((text) => text.text)
    return [...items, ...texts]
  }
  // hardcode-guard:allow the content-richest-region rule is this module's own read contract, not a case literal
  // Several regions can share the LIST kind: a page's content list plus incidental
  // nav/control strips. A READ is about CONTENT, so bind it to the TEXT-RICHEST list
  // region — a strip of controls must never stand in for the list being read.
  if (regionKind === LIST_KIND) {
    const lists = scene.regions.filter((region) => region.kind === LIST_KIND)
    if (lists.length > 1) {
      const units = lists.map((region) => unitsOfRegion(scene, region, itemIds))
      return units.reduce((best, next) => (next.join(" ").length > best.join(" ").length ? next : best))
    }
  }
  const inRegion = textIdsInRegionKind(scene, regionKind)
  const items = scene.items
    .filter(
      (item) =>
        !item.stateChanging &&
        scene.regions.some((region) => region.kind === regionKind && region.itemIds.includes(item.id)),
    )
    .map((item) => item.label)
  const texts = scene.texts.filter((text) => inRegion.has(text.id) && !itemIds.has(text.owner)).map((text) => text.text)
  return [...items, ...texts]
}

/**
 * GOAL-RELEVANT REGION — the region kind a `read_count` predicate is judged over by
 * default. Prefers a readable LIST (rows), else the DETAIL pane, else the CONTENT
 * area. CHROME (browser toolbar / address bar) is NEVER a target: a goal about the
 * page's content can never be satisfied by chrome. `undefined` means the scene
 * exposes no content region at all. Values are derived from the Scene only — no
 * site, app or address name is read.
 * LIVE INSTANCE: a messaging-style read goal counted a chrome label as a readable
 * unit; the target region excludes chrome by construction.
 * UNSEEN CASE: an in-app settings scene with only a DETAIL pane derives `detail`
 * with no loop change.
 */
export function targetRegionKind(scene: Scene): RegionKind | undefined {
  const kinds = new Set(scene.regions.map((region) => region.kind))
  if (kinds.has(LIST_KIND)) return LIST_KIND
  if (kinds.has("detail")) return "detail"
  if (kinds.has(CONTENT_KIND)) return CONTENT_KIND
  return undefined
}

/**
 * The default text pool for `text_present` with no explicit region: the content/detail
 * region ONLY. Chrome text can never satisfy a content predicate. A scene that exposes
 * regions but none of them content/detail yields an EMPTY pool; a region-less scene
 * (a synthetic world model) falls back to all texts, preserving prior behaviour.
 */
function defaultTextPool(scene: Scene): readonly SceneText[] {
  const kinds = new Set(scene.regions.map((region) => region.kind))
  const kind: RegionKind | undefined = kinds.has("detail") ? "detail" : kinds.has(CONTENT_KIND) ? CONTENT_KIND : undefined
  if (kind === undefined) return scene.regions.length === 0 ? scene.texts : []
  const ids = textIdsInRegionKind(scene, kind)
  return scene.texts.filter((text) => ids.has(text.id))
}

/** Text ids reachable through a region of the given kind (directly or via an owned item). */
function textIdsInRegionKind(scene: Scene, regionKind: RegionKind): Set<string> {
  const ids = new Set<string>()
  const itemKind = new Map<string, RegionKind>()
  for (const region of scene.regions) for (const id of region.itemIds) itemKind.set(id, region.kind)
  for (const region of scene.regions) {
    if (region.kind !== regionKind) continue
    for (const id of region.textIds) ids.add(id)
  }
  for (const text of scene.texts) if (itemKind.get(text.owner) === regionKind) ids.add(text.id)
  return ids
}

/**
 * OBSERVED STATE of a scene item — the affirmative "on" of a control, read from
 * the element's OWN selected flag or value (never from its label text). `undefined`
 * means the scene exposes no state for it (e.g. an AX button that under-declares
 * selection), so a state predicate over it stays unproven rather than guessed.
 */
const STATE_ON = new Set(["1", "true", "on", "yes", "selected", "checked", "enabled"])
function observedState(item: SceneItem): "on" | "off" | undefined {
  if (item.selected === true) return "on"
  if (item.selected === false) return "off"
  const value = (item.element.value ?? "").trim().toLowerCase()
  if (value.length === 0) return undefined
  return STATE_ON.has(value) ? "on" : "off"
}

const stateLabel = (item: SceneItem): string =>
  item.selected !== undefined ? `selected=${item.selected}` : `value=${item.element.value ?? ""}`

/**
 * Evaluate a predicate against a Scene. A predicate whose required observation is
 * absent (e.g. no url/host anywhere in the scene) returns `unknown` — it is never
 * silently `true`.
 */
export function evalPredicate(predicate: Predicate, scene: Scene): PredicateResult {
  switch (predicate.op) {
    case "url_host": {
      // Only host-bearing URLs participate: an empty host must never match (never
      // compare empty-to-empty). No-host URLs are handled by `url_identity`.
      const found = observables(scene)
        .map(urlParts)
        .filter((parts): parts is UrlParts => parts !== undefined && parts.host.length > 0)
      if (found.length === 0) return { verdict: "unknown", evidence: "no url/host is observable in the scene" }
      const host = normalizeHost(predicate.host)
      const hit = found.find(
        (parts) => parts.host === host && (predicate.pathPrefix === undefined || parts.path.startsWith(predicate.pathPrefix)),
      )
      const seen = [...new Set(found.map((parts) => parts.host))].join(", ")
      return {
        verdict: hit ? "true" : "false",
        evidence: hit ? `reached ${hit.host}${hit.path}` : `observed hosts: ${seen}`,
        ...(hit !== undefined ? { cited: [urlText(hit)] } : {}),
      }
    }
    case "url_identity": {
      // No-host URL identity: compare the scheme+path that actually exists.
      const found = observables(scene)
        .map(urlParts)
        .filter((parts): parts is UrlParts => parts !== undefined)
      if (found.length === 0) return { verdict: "unknown", evidence: "no url is observable in the scene" }
      const hit = found.find(
        (parts) => parts.scheme === predicate.scheme.toLowerCase() && parts.path.startsWith(predicate.path),
      )
      const seen = [...new Set(found.map(urlText))].join(", ")
      return {
        verdict: hit ? "true" : "false",
        evidence: hit ? `reached ${urlText(hit)}` : `observed urls: ${seen}`,
        ...(hit !== undefined ? { cited: [urlText(hit)] } : {}),
      }
    }
    case "text_present": {
      // hardcode-guard:allow the content/detail-scoping rule is this module's own predicate contract, not a case literal
      // No explicit region → the content/detail region ONLY (chrome text never
      // satisfies a content predicate). An explicit region scopes to that kind.
      const pool =
        predicate.regionKind === undefined
          ? defaultTextPool(scene)
          : (() => {
              const ids = textIdsInRegionKind(scene, predicate.regionKind)
              return scene.texts.filter((text) => ids.has(text.id))
            })()
      const hit = pool.find((text) => includesToken(text.text, predicate.text))
      return {
        verdict: hit ? "true" : "false",
        evidence: hit ? `text "${predicate.text}" present` : `text "${predicate.text}" absent`,
        ...(hit !== undefined ? { cited: [hit.text] } : {}),
      }
    }
    case "surface_is": {
      const surface = scene.window
      if (surface === undefined)
        return { verdict: "unknown", evidence: "the observation carries no window identity to test arrival against" }
      const hit = includesToken(surface, predicate.text)
      return {
        verdict: hit ? "true" : "false",
        evidence: hit ? `surface "${surface}" is the target` : `surface "${surface}" is not "${predicate.text}"`,
        ...(hit ? { cited: [surface] } : {}),
      }
    }
    case "item_present": {
      const hit = scene.items.find((item) => includesToken(item.label, predicate.matching))
      return {
        verdict: hit ? "true" : "false",
        evidence: hit ? `item matching "${predicate.matching}" present` : `item matching "${predicate.matching}" absent`,
        ...(hit !== undefined ? { cited: [hit.label] } : {}),
      }
    }
    case "region_present": {
      const hit = scene.regions.find(
        (region) =>
          region.kind === predicate.kind &&
          (predicate.label === undefined || includesToken(region.label ?? "", predicate.label)),
      )
      return {
        verdict: hit ? "true" : "false",
        evidence: hit ? `${predicate.kind} region present` : `${predicate.kind} region absent`,
        // only the region's own label is citable content; an unlabelled region cites nothing
        ...(hit !== undefined && hit.label !== undefined ? { cited: [hit.label] } : {}),
      }
    }
    case "read_count": {
      // hardcode-guard:allow the goal-relevant-region scoping is this module's own predicate contract, not a case literal
      const kind = predicate.regionKind ?? targetRegionKind(scene)
      const units = readableUnits(scene, kind)
      const anchors = predicate.anchors ?? []
      // GOAL-ANCHORED: a goal that names anchors may only be satisfied by units
      // carrying them — a dense page of unrelated items can never satisfy it.
      const matched = anchors.length > 0 ? units.filter((unit) => anchors.some((a) => includesToken(unit, a))) : units
      const satisfied = Math.min(matched.length, predicate.n)
      const named = matched.slice(0, predicate.n)
      const qualifier = anchors.length > 0 ? ` matching [${anchors.join(", ")}]` : ""
      return {
        verdict: matched.length >= predicate.n ? "true" : "false",
        evidence: `${satisfied}/${predicate.n} readable unit(s)${qualifier}: ${named.length > 0 ? named.join(", ") : "none"}`,
        satisfied,
        target: predicate.n,
        cited: named,
      }
    }
    case "read_value": {
      // The element that carries the goal's token IS the read target; the value it
      // holds (else its own label) is the citable content.
      // MENU CHROME IS NEVER CONTENT and the match is WORD-BOUND: the goal asked for the
      // macOS VERSION, so a menu item that merely mentions the name can never satisfy it.
      const item = scene.items.find(
        (entry) => !isMenuRole(entry.role) && carriesTokenWord(entry.label, predicate.matching),
      )
      if (item !== undefined) {
        const value = (item.element.value ?? "").trim()
        const cited = value.length > 0 ? value : item.label
        return { verdict: "true", evidence: `"${item.label}" reads ${cited}`, cited: [cited] }
      }
      const text = scene.texts.find(
        (entry) => !isMenuRole(entry.role) && carriesTokenWord(entry.text, predicate.matching),
      )
      if (text !== undefined) return { verdict: "true", evidence: `read "${text.text}"`, cited: [text.text] }
      // THE RENDERED TREE IS THE SAME SOURCE THE READ BINDS FROM — one shared matcher,
      // word-bound, so a menu item that merely contains the name can never stand in for
      // the attribute (a false completion) and predicate/evidence can never disagree.
      const pair = pairInTreeText(scene.treeText, predicate.matching)
      if (pair !== undefined)
        return { verdict: "true", evidence: `"${pair.label}" reads ${pair.value}`, cited: [pair.value] }
      return { verdict: "unknown", evidence: `no labelled element carries "${predicate.matching}"` }
    }
    case "dialog_absent": {
      const dialog = scene.regions.some((region) => region.kind === DIALOG_KIND)
      return {
        verdict: dialog ? "false" : "true",
        evidence: dialog ? "a dialog region is present" : "no dialog region",
        ...(dialog ? {} : { cited: ["no dialog region"] }),
      }
    }
    case "option_selected": {
      const matches = scene.items.filter((item) => includesToken(item.label, predicate.matching))
      if (matches.length === 0)
        return {
          verdict: "unknown",
          evidence: `no option whose label carries "${predicate.matching}" is observable in the scene`,
        }
      const on = matches.find((item) => observedState(item) === "on")
      return {
        verdict: on ? "true" : "false",
        evidence: on
          ? `option "${on.label}" is observed selected (${stateLabel(on)})`
          : `${matches.length} option(s) matching "${predicate.matching}" present but none observed selected`,
        ...(on !== undefined ? { cited: [`${on.label} [${stateLabel(on)}]`] } : {}),
      }
    }
    case "state_changed": {
      const matches = scene.items.filter((item) => includesToken(item.label, predicate.matching))
      if (matches.length === 0)
        return {
          verdict: "unknown",
          evidence: `no target whose label carries "${predicate.matching}" is observable in the scene`,
        }
      const set = matches.find((item) => observedState(item) !== undefined)
      return {
        verdict: set ? "true" : "false",
        evidence: set
          ? `target "${set.label}" carries the explicit observed state (${stateLabel(set)})`
          : `${matches.length} target(s) matching "${predicate.matching}" carry no observable state`,
        ...(set !== undefined ? { cited: [`${set.label} [${stateLabel(set)}]`] } : {}),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Goal reading
// ---------------------------------------------------------------------------

const READ_INTENT = /\b(read|reading|summar\w*|check|view|see|show|inspect|list)\b/
const NAV_INTENT = /\b(go|navigate|visit|browse|open|load|search|find)\b/
const DISMISS_INTENT = /\b(close|dismiss|cancel)\b/
/**
 * WRITE INTENT — verbs whose fulfilment mutates state. hardcode-guard:allow the
 * verb list is a general write-intent vocabulary (a governor input), not a case
 * literal. A goal carrying none of these is READ-ONLY: the governor may then never
 * execute a state-changing maneuver, whatever option space the scene derives.
 */
const WRITE_INTENT =
  /\b(send|submit|post|reply|delete|remove|toggle|check|uncheck|mark|select|deselect|enable|disable|turn on|turn off|confirm|buy|purchase|pay|subscribe|follow|unfollow|like|share|save|apply|reset)\b/i

/** A goal is READ-ONLY when it names no state-mutating verb. */
export function readOnlyGoal(goal: string): boolean {
  return goalIntent(goal) !== "mutate" && !WRITE_INTENT.test(goal)
}

/**
 * INTENT CLASSIFICATION — the goal's OWN words select the plan SHAPE. A MUTATION
 * goal (change/set/make/turn/enable/…, or one that names an application to
 * launch) is never planned as a read and never completes on a read predicate; a
 * NAVIGATE goal (go/open/visit, or a URL value) reaches a destination; everything
 * else is a READ. hardcode-guard:allow the verb families are a general
 * goal-reading grammar (an intent input), not case literals.
 */
export type GoalIntent = "mutate" | "navigate" | "read"

const MUTATE_INTENT =
  /\b(change|set|make|turn|enable|disable|toggle|switch|adjust|apply|assign|configure|rename|resize|move|select|choose|pick|update|edit)\b/i

export function goalIntent(goal: string): GoalIntent {
  if (MUTATE_INTENT.test(goal) || goalApp(goal) !== undefined) return "mutate"
  if (NAV_INTENT.test(goal) || goalValue(goal) !== undefined) return "navigate"
  return "read"
}

/**
 * The MUTATION's value: the goal's target state. A quoted token, else the token
 * after `to`/`into`/`as` (e.g. "... wall to black" → "black"). `undefined` when the
 * goal names no target state.
 */
export function mutationValue(goal: string): string | undefined {
  const quoted = goal.match(/["'`]([^"'`]+)["'`]/)?.[1]?.trim()
  if (quoted) return quoted
  return goal.match(/\b(?:to|into|as)\s+([^\s"']+)\s*$/i)?.[1]?.trim()
}

/** Tokens that name no selectable surface — generic verbs/fillers, never a target noun. */
// hardcode-guard:allow the stopword/mutate-verb sets are a general goal-reading grammar, not case literals
const GOAL_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "my",
  "your",
  "our",
  "their",
  "its",
  "this",
  "that",
  "these",
  "those",
  "to",
  "into",
  "as",
  "for",
  "of",
  "on",
  "off",
  "in",
  "at",
  "by",
  "and",
  "or",
  "is",
  "it",
  "mac",
  "macos",
  "computer",
  "please",
  "now",
])
const GOAL_VERB = /\b(change|set|make|turn|enable|disable|toggle|switch|adjust|apply|assign|configure|rename|resize|move|select|choose|pick|update|edit|read|show|list|open|go|navigate|visit|launch|activate|start|run)\b/gi

/**
 * The goal's TARGET SURFACE term: the salient noun the mutation acts on (e.g.
 * "wallpaper"), with the verb, the value clause and generic fillers removed.
 * Derived from the goal's own words only.
 */
export function targetTerm(goal: string): string | undefined {
  const value = mutationValue(goal)?.toLowerCase()
  const cleaned = goal
    .replace(/["'`][^"'`]*["'`]/g, " ")
    .replace(GOAL_VERB, " ")
    .replace(/\b(?:to|into|as)\b[\s\S]*$/i, " ")
  const tokens = cleaned.toLowerCase().match(/[a-z][a-z0-9-]+/g) ?? []
  const salient = tokens.filter((token) => !GOAL_STOPWORDS.has(token) && token !== value && token.length >= 3)
  return salient.at(-1)
}

/**
 * An application the goal NAMES to launch/activate — never hardcoded, bound from
 * the goal's words: the "<Name> app/application" form, else a capitalized name
 * directly after a launch verb (a lowercase scheme like `https:` never matches).
 */
export function goalApp(goal: string): string | undefined {
  const explicit = goal.match(/\bthe\s+([A-Za-z][\w .-]*?)\s+(?:app|application)\b/i)
  if (explicit?.[1]?.trim()) return explicit[1].trim()
  const launched = goal.match(/\b(?:launch|activate|start|run|open)\s+(?:the\s+)?([A-Z][\w.-]*)/)
  return launched?.[1]
}

/**
 * Whether the goal EXPLICITLY NAMES AN APPLICATION — the only shape in which a
 * launch is warranted. A goal that says "<Name> app/application", or that uses a
 * real LAUNCH verb (launch/activate/start/run) on a capitalized name, names an
 * application; a bare capitalized noun after a pure NAVIGATION verb (`open`/`go`/
 * `navigate`) names a TARGET — a pane, section or item of the frontmost app — and
 * must be reached by navigation, never launched (an unknown bare name is never a
 * launch).
 * INVARIANT: a launch requires the goal to name an application; a pane is not an app.
 * LIVE INSTANCE: the goal "open the About pane and report the macOS version, chip and
 * total memory" classified "About" as an app and launched it: verbatim
 * `failed: launch_app failed: No installed macOS app found for name 'About'.`
 * UNSEEN INPUT: any bare capitalized target after open/go/navigate is navigated to
 * (or explored) inside the frontmost app, never launched.
 * hardcode-guard:allow the launch-verb family is a general goal-reading grammar (an intent input), not case literals
 */
export function goalExplicitApp(goal: string): string | undefined {
  const explicit = goal.match(/\bthe\s+([A-Za-z][\w .-]*?)\s+(?:app|application)\b/i)
  if (explicit?.[1]?.trim()) return explicit[1].trim()
  return goal.match(/\b(?:launch|activate|start|run)\s+(?:the\s+)?([A-Z][\w.-]*)/)?.[1]
}

function firstInteger(goal: string): number | undefined {
  // A COUNT is a bare integer in the goal's PROSE. Digits inside a goal VALUE (a
  // URL path/port, a quoted token) are part of the destination, never a count —
  // otherwise `file:///var/folders/m4/…` reads "4" and a 3-message goal counts 4.
  const prose = goal.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").replace(/["'`][^"'`]*["'`]/g, " ")
  const match = prose.match(/\d+/)
  return match ? Number(match[0]) : undefined
}

/** The goal's own value: a quoted token, else a bare URL (any scheme, incl. file:). */
function goalValue(goal: string): string | undefined {
  const quoted = goal.match(/["'`]([^"'`]+)["'`]/)?.[1]?.trim()
  if (quoted) return quoted
  return goal.match(/\b[a-z][a-z0-9+.-]*:\/\/\S+/i)?.[0] ?? goal.match(/\b(?:about|data):[^\s]+/i)?.[0]
}

// hardcode-guard:allow the connector vocabulary is a general goal-reading grammar (an anchor input), not a case literal
const ANCHOR_CONNECTOR = /\b(?:from|about|containing|matching|match|titled|named|subject|sender)\s+([^\s"']+)/gi
// hardcode-guard:allow the scheme prefix is the URL grammar itself, not a case literal
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i

/**
 * GOAL ANCHORS — the distinctive terms the goal names: quoted strings (excluding
 * URLs) and tokens following a connector (from/about/containing/matching/subject/
 * sender). Generic verbs, nouns and counts are not anchors. An EMPTY set means the
 * goal names no anchor, so the read stays region-scoped and cites the OBSERVED
 * content; a non-empty set binds the read to those terms alone.
 */
export function goalAnchors(goal: string): readonly string[] {
  const out = new Set<string>()
  for (const match of goal.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    const token = match[1].trim()
    if (token.length > 0 && !SCHEME_PREFIX.test(token)) out.add(token)
  }
  for (const match of goal.matchAll(ANCHOR_CONNECTOR)) {
    const token = match[1].replace(/[^\p{L}\p{N}_.-]+/gu, "")
    if (token.length > 0 && !/^\d+$/.test(token)) out.add(token)
  }
  return [...out]
}

/**
 * REPORTED ATTRIBUTE TOKENS — the distinctive terms the goal asks to REPORT. The
 * tail after a reporting verb is split into attribute phrases (comma / "and" / "or")
 * and each phrase contributes its first non-generic token, so a goal naming
 * labelled values ("… report the macOS version, chip and total memory") yields the
 * matchable tokens ["macos", "chip", "memory"] — never the full phrase, which a
 * label would not carry. An EMPTY set means the goal reports nothing named.
 */
// hardcode-guard:allow the reporting-verb/generic-token sets are a general goal-reading grammar, not case literals
const REPORT_VERB = /\b(?:read|report|show|list|tell|describe|state|summari[sz]e|check|view|see|inspect|get|find|return|provide)\b/i
const REPORT_GENERIC = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "its",
  "this",
  "that",
  "from",
  "with",
  "value",
  "values",
  "version",
  "total",
  "size",
  "amount",
  "number",
  "current",
  "please",
])

export function reportedTokens(goal: string): readonly string[] {
  const match = REPORT_VERB.exec(goal)
  if (match === null) return []
  const tail = goal.slice(match.index + match[0].length)
  const out = new Set<string>()
  for (const phrase of tail.split(/,|\band\b|\bor\b|;/i)) {
    // A POSSESSIVE IS A MODIFIER, NOT THE ATTRIBUTE NAME: "this Mac's macOS version"
    // must yield "macos" — the earlier first-salient-token rule yielded "mac", which then
    // matched "Kian's MacBook Pro" and was reported as the macOS version.
    const tokens = phrase
      .replace(/['\u2019]s\b/g, " ")
      .toLowerCase()
      .match(/[a-z][a-z0-9]+/g) ?? []
    const salient = tokens.filter((token) => !REPORT_GENERIC.has(token))
    // the LAST salient token is the phrase's head noun ("this Mac macOS version" -> macos)
    const token = salient[salient.length - 1]
    if (token !== undefined) out.add(token)
  }
  return [...out]
}

function hasReadableList(scene: Scene): boolean {
  return scene.regions.some(
    (region) => region.kind === LIST_KIND && scene.items.some((item) => region.itemIds.includes(item.id) && !item.stateChanging),
  )
}

// ---------------------------------------------------------------------------
// Plan derivation
// ---------------------------------------------------------------------------

function plannedSubgoal(kind: SubgoalKind, params: Subgoal, success: Predicate, budget: number): PlanSubgoal {
  return { kind, params, success, budget }
}

function navigateSuccess(value: string): Predicate {
  const parts = urlParts(value)
  if (parts === undefined) return { op: "text_present", text: value }
  if (parts.host.length > 0)
    return { op: "url_host", host: parts.host, ...(parts.path.length > 0 ? { pathPrefix: parts.path } : {}) }
  // No host (file:, about:, data:): compare the identity that actually exists.
  // Never a host-vs-host compare — an empty host must not count as "arrived".
  return { op: "url_identity", scheme: parts.scheme, path: parts.path }
}

/**
 * MUTATION PLAN SHAPE — reach the target SURFACE (an `open_app` ONLY when the
 * goal names an application ABSENT from the scene, else an `open_item` over the
 * item that exists), then APPLY the goal's value with a STATE predicate
 * (`option_selected`). A mutation goal NEVER decomposes to a read: the read plan
 * is unreachable from here.
 *
 * SCENE-FIRST: a target that already exists in the observed tree (a pane/row/item
 * by label, descending through ancestors) is navigated to, never launched — so a
 * goal naming a pane present in the scene yields `open_item`, and `open_app` is
 * reserved for an application genuinely absent from the scene.
 */
function mutationSubgoals(goal: string, scene: Scene): PlanSubgoal[] {
  const app = goalApp(goal)
  const appInScene = app === undefined ? undefined : resolveNamedItem(scene, app)
  // A LAUNCH IS FOR AN APPLICATION THE GOAL EXPLICITLY NAMES AND THE SCENE DOES NOT
  // HOLD. A bare capitalized target (a pane/section/item of the FRONTMOST app) is
  // reached by navigating INSIDE that app, never by launching — an unknown name must
  // never yield a launch.
  // The goal's WORDING is a HINT only (it may name an application or a bare target);
  // the LIVE verdict is the observed scene — the check below. A name the tree already
  // holds is navigated to inside the app; only a name the scene does NOT hold may be
  // launched, and the hint can never override the observed structure.
  const appHintedByGoal = goalExplicitApp(goal) !== undefined
  const surface = targetTerm(goal)
  const value = mutationValue(goal)
  const openAppSub =
    app === undefined || appInScene !== undefined || !appHintedByGoal
      ? undefined
      : plannedSubgoal(
          "open_app",
          { kind: "open_app", value: app },
          { op: "surface_is", text: app },
          NAVIGATE_BUDGET,
        )
  // A named target that EXISTS in the scene is reached by UI navigation.
  const existingSub =
    app === undefined || appInScene === undefined
      ? undefined
      : plannedSubgoal(
          "open_item",
          { kind: "open_item", matching: app, selectable: true },
          { op: "surface_is", text: app },
          DEFAULT_BUDGET,
        )
  // PANE-INSIDE-THE-FRONTMOST-APP: a bare named target absent from the scene is
  // navigated to through the app's OWN navigation surface (a sidebar/outline/list),
  // never launched. The deriver offers the option only when such a surface exists.
  const navigateInsideSub =
    app === undefined || appInScene !== undefined || appHintedByGoal
      ? undefined
      : plannedSubgoal(
          "open_item",
          { kind: "open_item", matching: app, selectable: true },
          { op: "surface_is", text: app },
          DEFAULT_BUDGET,
        )
  // A pure launch goal ("open the Calculator app") is just the launch.
  if (openAppSub !== undefined && !MUTATE_INTENT.test(goal)) return [openAppSub]
  const subs: PlanSubgoal[] = []
  if (openAppSub !== undefined) subs.push(openAppSub)
  if (existingSub !== undefined) subs.push(existingSub)
  if (navigateInsideSub !== undefined) subs.push(navigateInsideSub)
  // REPORT OVER A REACHED SURFACE: when the goal names attributes to report and has
  // NO mutation VALUE to set, the surface reach is followed by one goal-anchored
  // READ per attribute — never the bogus `open_item`/`apply` pair for a term that is
  // not an option. The reads become evidence once the surface is settled.
  const attrs = value === undefined ? reportedTokens(goal) : []
  if (attrs.length > 0) {
    if (subs.length === 0)
      subs.push(plannedSubgoal("read_items", { kind: "read_items" }, { op: "read_count", n: DEFAULT_READ_COUNT }, DEFAULT_BUDGET))
    for (const token of attrs)
      subs.push(
        plannedSubgoal(
          "read_items",
          { kind: "read_items", count: 1, matching: token },
          { op: "read_value", matching: token },
          DEFAULT_BUDGET,
        ),
      )
    return subs
  }
  // The surface term is a second reach when it names a different target.
  const surfaceDistinct =
    surface !== undefined && (app === undefined || !surface.toLowerCase().includes(app.toLowerCase()))
  if (surfaceDistinct)
    subs.push(
      plannedSubgoal(
        "open_item",
        // A mutation may reach its surface through a SELECTABLE navigation row (a
        // sidebar entry), which a read/open subgoal would never bind.
        { kind: "open_item", matching: surface, selectable: true },
        { op: "surface_is", text: surface },
        DEFAULT_BUDGET,
      ),
    )
  const target = value ?? surface
  subs.push(
    plannedSubgoal(
      "apply",
      { kind: "apply", ...(target !== undefined ? { matching: target } : {}) },
      target !== undefined ? { op: "option_selected", matching: target } : { op: "state_changed", matching: goal },
      DEFAULT_BUDGET,
    ),
  )
  return subs
}

/**
 * Derive the candidate decompositions for a goal against a Scene. The primary
 * (commit) candidate is navigate-first when the goal names a destination not yet
 * reached; otherwise the scene-semantics decomposition is primary. All plausible
 * candidates are returned so an external chooser may reorder them.
 */
export function plan(goal: string, scene: Scene, prior?: Plan): PlanDecision {
  // INTENT SELECTS THE SHAPE: a mutation goal gets the mutation decomposition and
  // can never fall through to the read fallback that produced the false completion.
  if (goalIntent(goal) === "mutate") {
    const mutation: PlanCandidate = {
      id: "mutate",
      plan: { goal, subgoals: mutationSubgoals(goal, scene) },
      rationale: "a mutation goal: reach the target surface, then apply the value, proven by observed state",
    }
    if (prior !== undefined && prior.goal === goal) {
      const reused: PlanCandidate = { id: "prior", plan: prior, rationale: "reusing the prior decomposition for the same goal" }
      return { candidates: [reused, mutation], commit: prior, commitId: "reused" }
    }
    return { candidates: [mutation], commit: mutation.plan, commitId: mutation.id }
  }
  const value = goalValue(goal)
  const count = firstInteger(goal) ?? DEFAULT_READ_COUNT
  const readIntent = READ_INTENT.test(goal)
  const dismissIntent = DISMISS_INTENT.test(goal)
  const list = hasReadableList(scene)
  const dialog = scene.regions.some((region) => region.kind === DIALOG_KIND)

  const navigateSub =
    value === undefined
      ? undefined
      : plannedSubgoal("navigate", { kind: "navigate", value }, navigateSuccess(value), NAVIGATE_BUDGET)
  // The read predicate stays region-agnostic: `read_count` derives the
  // goal-relevant region from the Scene AT EVAL TIME (see targetRegionKind), so a
  // plan carries no stale region binding when evaluated against another Scene. When
  // the goal names ANCHORS the read is bound to them, so a dense page of unrelated
  // items can never satisfy it.
  const anchors = goalAnchors(goal)
  // The read's attribute token is BOUND into its params so the maneuver deriver can
  // offer the READ STRATEGIES for it: an anchored read must carry its token exactly as
  // a report read does, else `read_text` is never derived and the ladder is dead.
  const anchor = anchors[0]
  const readSub = plannedSubgoal(
    "read_items",
    { kind: "read_items", count, ...(anchor !== undefined ? { matching: anchor } : {}) },
    { op: "read_count", n: count, ...(anchors.length > 0 ? { anchors } : {}) },
    DEFAULT_BUDGET,
  )
  const dismissSub = plannedSubgoal("dismiss", { kind: "dismiss" }, { op: "dialog_absent" }, CORRECTIVE_BUDGET)
  const arrived = navigateSub !== undefined && evalPredicate(navigateSub.success, scene).verdict === "true"

  const candidates: PlanCandidate[] = []
  if (dismissIntent && dialog) {
    candidates.push({
      id: "dismiss",
      plan: { goal, subgoals: [dismissSub] },
      rationale: "a dialog is present and the goal asks to close it",
    })
  }
  if (list && (readIntent || firstInteger(goal) !== undefined)) {
    candidates.push({ id: "read-here", plan: { goal, subgoals: [readSub] }, rationale: "a readable list is already in the scene" })
  }
  if (navigateSub !== undefined) {
    const opening = arrived ? [] : [navigateSub]
    const further = readIntent || list ? [readSub] : []
    const subgoals = [...opening, ...further]
    candidates.push({
      id: arrived ? "read-here" : "navigate-first",
      plan: { goal, subgoals: subgoals.length > 0 ? subgoals : [navigateSub] },
      rationale: arrived ? "the destination is already reached; read from here" : "navigate to the goal value, then read",
    })
  }
  if (candidates.length === 0) {
    candidates.push({
      id: dialog ? "dismiss" : "read-here",
      plan: { goal, subgoals: [dialog ? dismissSub : readSub] },
      rationale: "scene semantics leave one safe decomposition",
    })
  }

  const commit = candidates.find((candidate) => !arrived && candidate.plan.subgoals[0]?.kind === "navigate") ?? candidates[0]
  const ordered = [commit, ...candidates.filter((candidate) => candidate !== commit)]

  if (prior !== undefined && prior.goal === goal) {
    const reused: PlanCandidate = { id: "prior", plan: prior, rationale: "reusing the prior decomposition for the same goal" }
    return {
      candidates: [reused, ...ordered.filter((candidate) => candidate.plan !== prior)],
      commit: prior,
      commitId: "reused",
    }
  }
  return { candidates: ordered, commit: commit.plan, commitId: commit.id }
}

// ---------------------------------------------------------------------------
// Replanning
// ---------------------------------------------------------------------------

function correctiveFor(scene: Scene): PlanSubgoal {
  const dialog = scene.regions.some((region) => region.kind === DIALOG_KIND)
  if (dialog) {
    return { ...plannedSubgoal("dismiss", { kind: "dismiss" }, { op: "dialog_absent" }, CORRECTIVE_BUDGET), corrective: true }
  }
  return {
    ...plannedSubgoal("back", { kind: "back" }, { op: "region_present", kind: CONTENT_KIND }, CORRECTIVE_BUDGET),
    corrective: true,
  }
}

function firstUnsatisfiedIndex(plan: Plan, scene: Scene): number | undefined {
  const index = plan.subgoals.findIndex((subgoal) => evalPredicate(subgoal.success, scene).verdict !== "true")
  return index === -1 ? undefined : index
}

/**
 * Revise a plan after a failure: when the first unsatisfied subgoal has already
 * been attempted, insert one corrective subgoal (dismiss before a dialog, else
 * back) ahead of it. Bounded by MAX_REPLANS; a complete plan or an un-attempted
 * subgoal is returned unchanged.
 */
export function replan(plan: Plan, scene: Scene, history: readonly StepRecord[]): Plan {
  const applied = plan.replans ?? 0
  if (applied >= MAX_REPLANS) return plan
  const index = firstUnsatisfiedIndex(plan, scene)
  if (index === undefined) return plan
  if (!history.some((step) => (step.subgoalIndex ?? 0) === index)) return plan
  const corrective = correctiveFor(scene)
  return {
    goal: plan.goal,
    subgoals: [...plan.subgoals.slice(0, index), corrective, ...plan.subgoals.slice(index)],
    replans: applied + 1,
  }
}
