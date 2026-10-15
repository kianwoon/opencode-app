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

import type { RegionKind, Scene, SceneText } from "./ui-scene"
import type { Subgoal, SubgoalKind } from "./ui-maneuvers"

// ---------------------------------------------------------------------------
// Predicate vocabulary — the only things progress may be judged by
// ---------------------------------------------------------------------------

export type Predicate =
  | { readonly op: "url_host"; readonly host: string; readonly pathPrefix?: string }
  | { readonly op: "text_present"; readonly text: string; readonly regionKind?: RegionKind }
  | { readonly op: "item_present"; readonly matching: string }
  | { readonly op: "region_present"; readonly kind: RegionKind; readonly label?: string }
  | { readonly op: "read_count"; readonly n: number; readonly regionKind?: RegionKind }
  | { readonly op: "dialog_absent" }

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

interface UrlParts {
  readonly host: string
  readonly path: string
}

// Optionally-schemed host with at least one dot, optional port and path. A
// regex (not `new URL`) so an unparseable string is a non-match, never a throw.
const URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d+)?(\/[^\s]*)?$/i

function urlParts(value: string): UrlParts | undefined {
  const match = URL_RE.exec(value.trim())
  if (!match) return undefined
  return { host: normalizeHost(match[1]), path: match[3] ?? "" }
}

/** Every string the Scene exposes to a text/host predicate. */
function observables(scene: Scene): readonly string[] {
  return [
    ...scene.items.map((item) => item.label),
    ...scene.items.map((item) => item.element.value ?? ""),
    ...scene.texts.map((text) => text.text),
  ]
}

/** A readable unit is a non-state-changing row item or a standalone (region-owned) text. */
function readableCount(scene: Scene, regionKind?: RegionKind): number {
  const itemIds = new Set(scene.items.map((item) => item.id))
  if (regionKind === undefined) {
    // No content region is derivable: a region-less scene counts every readable unit;
    // a scene of ONLY chrome/toolbar/dialog contributes NONE (chrome is never content).
    if (scene.regions.length > 0) return 0
    const items = scene.items.filter((item) => !item.stateChanging).length
    const texts = scene.texts.filter((text) => !itemIds.has(text.owner)).length
    return items + texts
  }
  const inRegion = textIdsInRegionKind(scene, regionKind)
  const items = scene.items.filter(
    (item) =>
      !item.stateChanging &&
      scene.regions.some((region) => region.kind === regionKind && region.itemIds.includes(item.id)),
  ).length
  const texts = scene.texts.filter((text) => inRegion.has(text.id) && !itemIds.has(text.owner)).length
  return items + texts
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
 * Evaluate a predicate against a Scene. A predicate whose required observation is
 * absent (e.g. no url/host anywhere in the scene) returns `unknown` — it is never
 * silently `true`.
 */
export function evalPredicate(predicate: Predicate, scene: Scene): PredicateResult {
  switch (predicate.op) {
    case "url_host": {
      const found = observables(scene)
        .map(urlParts)
        .filter((parts): parts is UrlParts => parts !== undefined)
      if (found.length === 0) return { verdict: "unknown", evidence: "no url/host is observable in the scene" }
      const host = normalizeHost(predicate.host)
      const hit = found.find(
        (parts) => parts.host === host && (predicate.pathPrefix === undefined || parts.path.startsWith(predicate.pathPrefix)),
      )
      const seen = [...new Set(found.map((parts) => parts.host))].join(", ")
      return {
        verdict: hit ? "true" : "false",
        evidence: hit ? `reached ${hit.host}${hit.path}` : `observed hosts: ${seen}`,
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
      }
    }
    case "item_present": {
      const hit = scene.items.find((item) => includesToken(item.label, predicate.matching))
      return {
        verdict: hit ? "true" : "false",
        evidence: hit ? `item matching "${predicate.matching}" present` : `item matching "${predicate.matching}" absent`,
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
      }
    }
    case "read_count": {
      // hardcode-guard:allow the goal-relevant-region scoping is this module's own predicate contract, not a case literal
      const kind = predicate.regionKind ?? targetRegionKind(scene)
      const seen = readableCount(scene, kind)
      return {
        verdict: seen >= predicate.n ? "true" : "false",
        evidence: `${seen}/${predicate.n} readable unit(s)`,
        satisfied: Math.min(seen, predicate.n),
        target: predicate.n,
      }
    }
    case "dialog_absent": {
      const dialog = scene.regions.some((region) => region.kind === DIALOG_KIND)
      return { verdict: dialog ? "false" : "true", evidence: dialog ? "a dialog region is present" : "no dialog region" }
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
  return !WRITE_INTENT.test(goal)
}

function firstInteger(goal: string): number | undefined {
  const match = goal.match(/\d+/)
  return match ? Number(match[0]) : undefined
}

/** The goal's own value: a quoted token, else a bare URL. Never invented. */
function goalValue(goal: string): string | undefined {
  const quoted = goal.match(/["'`]([^"'`]+)["'`]/)?.[1]?.trim()
  if (quoted) return quoted
  return goal.match(/https?:\/\/\S+/)?.[0]
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
  return parts === undefined
    ? { op: "text_present", text: value }
    : { op: "url_host", host: parts.host, ...(parts.path.length > 0 ? { pathPrefix: parts.path } : {}) }
}

/**
 * Derive the candidate decompositions for a goal against a Scene. The primary
 * (commit) candidate is navigate-first when the goal names a destination not yet
 * reached; otherwise the scene-semantics decomposition is primary. All plausible
 * candidates are returned so an external chooser may reorder them.
 */
export function plan(goal: string, scene: Scene, prior?: Plan): PlanDecision {
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
  // plan carries no stale region binding when evaluated against another Scene.
  const readSub = plannedSubgoal("read_items", { kind: "read_items", count }, { op: "read_count", n: count }, DEFAULT_BUDGET)
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
