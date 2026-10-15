// hardcode-guard:allow the checked-in capture is the acceptance artifact under test; every assertion is a general predicate->progress contract, not a named one-off case
import { describe, expect, test } from "bun:test"
import path from "path"
import { decodeObservation, type Element } from "@/tool/ui-eyes"
import { buildScene, type Scene, type SceneItem, type SceneRegion, type SceneText } from "@/tool/ui-scene"
import { evalPredicate, plan, type Plan, type StepRecord } from "@/tool/ui-plan"
import { MANEUVER_REPEAT_LIMIT, progress } from "@/tool/ui-progress"

const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")

const READ_GOAL = "read the last 3 messages"
const REASON_OSCILLATION = "scene-oscillation"
const REASON_REPEAT = "maneuver-repeat-limit"
const REASON_BUDGET = "budget-exhausted"

const readFixture = async (): Promise<Scene> => {
  const raw = await Bun.file(CAPTURE).json()
  const observation = decodeObservation(raw)
  if (observation === null) throw new Error("fixture must decode")
  return buildScene({ snapshot_id: "s1", elements: observation.elements })
}

const element = (label: string, role = "AXLink"): Element => ({ element_token: label, role, label })

const sceneItem = (label: string): SceneItem => ({
  id: label,
  role: "AXLink",
  label,
  affordances: ["activatable"],
  stateChanging: false,
  enabled: true,
  element: element(label),
})

const syntheticScene = (items: readonly SceneItem[]): Scene => ({ snapshot: "s-synth", regions: [], items, texts: [] })

const viewA = syntheticScene([sceneItem("view-alpha")])
const viewB = syntheticScene([sceneItem("view-beta")])

const destinationPlan = (budget: number): Plan => ({
  goal: "reach the destination",
  subgoals: [
    {
      kind: "navigate",
      params: { kind: "navigate", value: "desired.example" },
      success: { op: "url_host", host: "desired.example" },
      budget,
    },
  ],
})

describe("ui-progress — (b) measured progress over the world model", () => {
  test("a scene satisfying read_count(3) reports 3/3 and stops", async () => {
    const scene = await readFixture()
    const decision = plan(READ_GOAL, scene)
    const result = progress(decision.commit, scene, [])
    expect(result.total).toBe(3)
    expect(result.done).toBe(3)
    expect(result.nextSubgoal).toBeUndefined()
    expect(result.perSubgoal[0].success).toBe(true)
    expect(result.shouldReplan).toBe(false)
  })

  test("a scene satisfying 1 of 3 reports 1/3 and names the next subgoal", () => {
    const scene = syntheticScene([sceneItem("row-1")])
    const decision = plan(READ_GOAL, scene)
    const result = progress(decision.commit, scene, [])
    expect(result.done).toBe(1)
    expect(result.total).toBe(3)
    expect(result.nextSubgoal).toBe(0)
    expect(result.perSubgoal[0].success).toBe(false)
    expect(result.perSubgoal[0].evidence).toContain("1/3")
  })

  test("A↔B oscillation yields shouldReplan with the alternation reason", () => {
    const history: StepRecord[] = [
      { maneuver: "press", scene: viewA, subgoalIndex: 0 },
      { maneuver: "back", scene: viewB, subgoalIndex: 0 },
      { maneuver: "press", scene: viewA, subgoalIndex: 0 },
      { maneuver: "back", scene: viewB, subgoalIndex: 0 },
    ]
    const result = progress(destinationPlan(10), viewA, history)
    expect(result.shouldReplan).toBe(true)
    expect(result.reason).toBe(REASON_OSCILLATION)
    expect(result.exhausted).toBe(false)
  })

  test("a repeated identical maneuver reports the repeat reason", () => {
    const history: StepRecord[] = Array.from({ length: MANEUVER_REPEAT_LIMIT + 1 }, () => ({
      maneuver: "same",
      scene: viewA,
      subgoalIndex: 0,
    }))
    const result = progress(destinationPlan(10), viewA, history)
    expect(result.shouldReplan).toBe(true)
    expect(result.reason).toBe(REASON_REPEAT)
  })

  test("step budget exhaustion reports the budget reason", () => {
    const history: StepRecord[] = [{ maneuver: "m", scene: viewA, subgoalIndex: 0 }]
    const result = progress(destinationPlan(1), viewA, history)
    expect(result.exhausted).toBe(true)
    expect(result.shouldReplan).toBe(false)
    expect(result.reason).toBe(REASON_BUDGET)
  })

  test("an unevaluable predicate reports unknown, never true", () => {
    // viewA carries no url/host anywhere, so url_host cannot be evaluated.
    const result = progress(destinationPlan(10), viewA, [])
    expect(result.perSubgoal[0].verdict).toBe("unknown")
    expect(result.perSubgoal[0].success).toBe(false)
    expect(result.done).toBe(0)
    expect(result.nextSubgoal).toBe(0)
  })
})

// GENERALIZATION — INVARIANT: a predicate is satisfied only by content the goal
// IDENTIFIES, and a read is never credited before the plan's arrival/target
// predicate holds. LIVE INSTANCE: the harness goal (navigate to a file:// page and
// read its last 3 messages) reached 4/5 with ZERO actions on an unrelated browser
// page — the reads counted that page's rows. UNSEEN CASE COVERED: any goal whose
// target is not yet reached cannot have its reads satisfied by whatever page is
// on screen (a bare list, a dense page), because the gate is on the plan's own
// preceding predicate, not on the page's shape.
describe("ui-progress — (b) a non-target page cannot satisfy the goal's read predicates", () => {
  const el = (label: string, role = "AXLink"): Element => ({ element_token: label, role, label })
  const row = (label: string): SceneItem => ({
    id: label,
    role: "AXLink",
    label,
    affordances: ["activatable"],
    stateChanging: false,
    enabled: true,
    element: el(label),
  })
  const rowScene = (labels: readonly string[]): Scene => ({
    snapshot: "s-rows",
    regions: [{ id: "r0:list", kind: "list", itemIds: [...labels], textIds: [] }],
    items: labels.map(row),
    texts: [],
  })
  const fileUrl = "file:///tmp/messages.html"
  const urlText: SceneText = {
    id: "u",
    role: "AXStaticText",
    text: fileUrl,
    owner: "scene",
    element: el(fileUrl, "AXStaticText"),
  }
  const arrivedRowScene = (labels: readonly string[]): Scene => ({
    snapshot: "s-arrived",
    regions: [
      { id: "r0:content", kind: "content", itemIds: [], textIds: ["u"] },
      { id: "r1:list", kind: "list", itemIds: [...labels], textIds: [] },
    ] as readonly SceneRegion[],
    items: labels.map(row),
    texts: [urlText],
  })
  const GOAL = `go to "${fileUrl}" and read the last 3 messages`

  test("(b) reads count nothing until the arrival/target predicate holds", () => {
    const unrelated = rowScene(["Inbox", "Sent", "Drafts", "Archive"])
    const decision = plan(GOAL, unrelated)
    expect(decision.commit.subgoals[0].kind).toBe("navigate")
    const before = progress(decision.commit, unrelated, [])
    // the dense unrelated page satisfies the read predicate ALONE, but the read is
    // not credited before arrival — progress stays 0 (and names the navigate next).
    expect(evalPredicate(decision.commit.subgoals[1].success, unrelated).verdict).toBe("true")
    expect(before.done).toBe(0)
    expect(before.nextSubgoal).toBe(0)
    expect(before.perSubgoal[1].success).toBe(false)
  })

  test("(b) arrival — then the reads count the arrived page's content", () => {
    const arrived = arrivedRowScene(["m1", "m2", "m3", "m4"])
    const decision = plan(GOAL, arrived)
    const full = progress(decision.commit, arrived, [])
    expect(full.perSubgoal[0].success).toBe(true)
    expect(full.done).toBe(full.total)
    expect(full.nextSubgoal).toBeUndefined()
  })
})

describe("ui-progress — (e) generalization invariants", () => {
  test("done depends only on the Scene, not on how many maneuvers ran", async () => {
    const satisfied = await readFixture()
    const partial = syntheticScene([sceneItem("row-1")])
    const acted: StepRecord[] = Array.from({ length: 20 }, (_unused, index) => ({
      maneuver: `m${index}`,
      scene: partial,
      subgoalIndex: 0,
    }))
    const decision = plan(READ_GOAL, satisfied)
    // A long history of actions cannot manufacture progress.
    expect(progress(decision.commit, partial, acted).done).toBe(1)
    // A satisfying Scene yields full progress with no history at all.
    expect(progress(decision.commit, satisfied, []).done).toBe(3)
  })

  test("an unseen structurally different A↔B pair is still detected as oscillation", () => {
    const unseenA = syntheticScene([sceneItem("panel-one"), sceneItem("panel-shared")])
    const unseenB = syntheticScene([sceneItem("panel-two"), sceneItem("panel-shared")])
    const history: StepRecord[] = [
      { maneuver: "toggle", scene: unseenA, subgoalIndex: 0 },
      { maneuver: "toggle", scene: unseenB, subgoalIndex: 0 },
      { maneuver: "toggle", scene: unseenA, subgoalIndex: 0 },
      { maneuver: "toggle", scene: unseenB, subgoalIndex: 0 },
    ]
    const result = progress(destinationPlan(10), unseenA, history)
    expect(result.reason).toBe(REASON_OSCILLATION)
  })
})
