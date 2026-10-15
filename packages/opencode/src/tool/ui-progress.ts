// hardcode-guard:allow the reason tokens (scene-oscillation, maneuver-repeat-limit, budget-exhausted) are this module's own contract vocabulary asserted by tests, not case literals
/**
 * PROGRESS organ — the feedback / progress controller.
 *
 * CONTRACT: progress is MEASURED, never inferred from having acted. Given a plan,
 * the current Scene and the executed-step history, this module evaluates each
 * subgoal's predicate against the Scene (and the Scene diff) and returns the
 * measured progress. A predicate that cannot be evaluated returns `unknown` and
 * is never counted as success.
 *
 * INVARIANT OWNED: `done` counts satisfied predicate units over the world model,
 * so issuing maneuvers advances nothing by itself; no-progress is reported with a
 * DISTINCT reason token for each shape — a repeated identical maneuver
 * (`maneuver-repeat-limit`, the loop's existing bound mirrored), a Scene
 * oscillating A↔B without predicate progress (`scene-oscillation`), and step
 * budget exhaustion (`budget-exhausted`).
 * LIVE INSTANCE: the loop re-issuing the same maneuver while the screen flips
 * between two views is not progress and yields `scene-oscillation` + shouldReplan.
 * UNSEEN CASE: alternation between two structurally different views (any A≠B pair)
 * is detected by the same Scene-diff rule, no loop change.
 */

import { diffScene, type Scene } from "./ui-scene"
import { evalPredicate, type Plan, type PredicateVerdict, type StepRecord } from "./ui-plan"

export interface SubgoalProgress {
  readonly success: boolean
  readonly verdict: PredicateVerdict
  readonly evidence: string
}

export interface Progress {
  readonly perSubgoal: readonly SubgoalProgress[]
  /** Satisfied predicate units (partial reads count). */
  readonly done: number
  /** Total predicate units the plan demands. */
  readonly total: number
  readonly nextSubgoal: number | undefined
  readonly shouldReplan: boolean
  readonly exhausted: boolean
  readonly reason: string | undefined
}

/** Mirrors the loop's existing MAX_MANEUVER_REPEATS bound (same maneuver, N+1 times). */
export const MANEUVER_REPEAT_LIMIT = 2
export const OSCILLATION_WINDOW = 6

const REASON_OSCILLATION = "scene-oscillation"
const REASON_REPEAT = "maneuver-repeat-limit"
const REASON_BUDGET = "budget-exhausted"

const sameScene = (a: Scene, b: Scene): boolean => {
  const diff = diffScene(a, b)
  return diff.appeared.length === 0 && diff.disappeared.length === 0 && diff.changed.length === 0
}

/** Satisfied predicate units for one scene: full when true, the partial read otherwise. */
function doneOf(plan: Plan, scene: Scene): number {
  return plan.subgoals.reduce((sum, subgoal) => {
    const result = evalPredicate(subgoal.success, scene)
    return sum + (result.verdict === "true" ? (result.target ?? 1) : (result.satisfied ?? 0))
  }, 0)
}

/**
 * A↔B alternation: the tail oscillates between two scenes (each equal to the one
 * two steps back, different from its neighbour) with NO predicate progress across
 * the window — the diff is the world model's, never the act count.
 */
function oscillating(plan: Plan, history: readonly StepRecord[]): boolean {
  const tail = history.slice(-OSCILLATION_WINDOW)
  if (tail.length < 4) return false
  let run = 1
  for (let i = tail.length - 1; i >= 2; i--) {
    if (sameScene(tail[i].scene, tail[i - 2].scene) && !sameScene(tail[i].scene, tail[i - 1].scene)) run++
    else break
  }
  if (run < 2) return false
  const dones = tail.map((step) => doneOf(plan, step.scene))
  return Math.max(...dones) === Math.min(...dones)
}

function repeatedManeuver(history: readonly StepRecord[]): boolean {
  if (history.length < MANEUVER_REPEAT_LIMIT + 1) return false
  const tail = history.slice(-(MANEUVER_REPEAT_LIMIT + 1))
  const key = tail[tail.length - 1].maneuver
  return tail.every((step) => step.maneuver === key)
}

function budgetExceeded(plan: Plan, history: readonly StepRecord[]): boolean {
  return plan.subgoals.some(
    (subgoal, index) => history.filter((step) => (step.subgoalIndex ?? 0) === index).length >= subgoal.budget,
  )
}

/**
 * Measure progress of a plan against the current Scene and the step history. The
 * `reason`/`shouldReplan`/`exhausted` trio names the no-progress shape, if any.
 */
export function progress(plan: Plan, scene: Scene, history: readonly StepRecord[]): Progress {
  const results = plan.subgoals.map((subgoal) => evalPredicate(subgoal.success, scene))
  const perSubgoal: SubgoalProgress[] = results.map((result) => ({
    success: result.verdict === "true",
    verdict: result.verdict,
    evidence: result.evidence,
  }))
  const done = results.reduce(
    (sum, result) => sum + (result.verdict === "true" ? (result.target ?? 1) : (result.satisfied ?? 0)),
    0,
  )
  const total = plan.subgoals.reduce((sum, subgoal) => sum + (subgoal.success.op === "read_count" ? subgoal.success.n : 1), 0)
  const index = results.findIndex((result) => result.verdict !== "true")
  const nextSubgoal = index === -1 ? undefined : index
  const base = { perSubgoal, done, total, nextSubgoal }

  if (nextSubgoal === undefined) return { ...base, shouldReplan: false, exhausted: false, reason: undefined }
  if (oscillating(plan, history)) return { ...base, shouldReplan: true, exhausted: false, reason: REASON_OSCILLATION }
  if (repeatedManeuver(history)) return { ...base, shouldReplan: true, exhausted: false, reason: REASON_REPEAT }
  if (budgetExceeded(plan, history)) return { ...base, shouldReplan: false, exhausted: true, reason: REASON_BUDGET }
  return { ...base, shouldReplan: false, exhausted: false, reason: undefined }
}
