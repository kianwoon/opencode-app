// hardcode-guard:allow the checked-in capture is the acceptance artifact under test; every assertion is a general goal->plan contract, not a named one-off case
import { describe, expect, test } from "bun:test"
import path from "path"
import { decodeObservation, type Element } from "@/tool/ui-eyes"
import { buildScene, type Scene, type SceneItem, type SceneRegion, type SceneText } from "@/tool/ui-scene"
import { evalPredicate, plan, replan, targetRegionKind, type Plan, type StepRecord } from "@/tool/ui-plan"

const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")

// The fixture is one live instance; a synthetic two-view pair stands for the
// unseen shape (any structurally different A/B scenes) the same rules must cover.
const READ = "read_items"
const NAVIGATE = "navigate"
const READ_COUNT = "read_count"
const URL_HOST = "url_host"
const GOAL_DESTINATION = "https://example.invalid/inbox"
const READ_GOAL = "read the last 3 messages"

const readFixture = async (): Promise<Scene> => {
  const raw = await Bun.file(CAPTURE).json()
  const observation = decodeObservation(raw)
  if (observation === null) throw new Error("fixture must decode")
  return buildScene({ snapshot_id: "s1", elements: observation.elements })
}

const element = (label: string, role = "AXLink"): Element => ({ element_token: label, role, label })

const sceneItem = (label: string, stateChanging = false): SceneItem => ({
  id: label,
  role: "AXLink",
  label,
  affordances: ["activatable"],
  stateChanging,
  enabled: true,
  element: element(label),
})

const dialogRegion = (): SceneRegion => ({ id: "r0:dialog", kind: "dialog", itemIds: [], textIds: [] })

const syntheticScene = (items: readonly SceneItem[], regions: readonly SceneRegion[] = []): Scene => ({
  snapshot: "s-synth",
  regions,
  items,
  texts: [],
})

describe("ui-plan — (a) goal + scene semantics → candidate decompositions", () => {
  test("a messaging-style read goal over the fixture yields a plan with evaluable predicates", async () => {
    const scene = await readFixture()
    const decision = plan(READ_GOAL, scene)
    expect(decision.candidates.length).toBeGreaterThanOrEqual(1)
    expect(decision.commit.subgoals.length).toBeGreaterThanOrEqual(1)
    expect(decision.commit.subgoals[0].kind).toBe(READ)
    expect(decision.commit.subgoals[0].success.op).toBe(READ_COUNT)

    // Every predicate over the fixture is genuinely evaluable (a real verdict).
    for (const subgoal of decision.commit.subgoals) {
      const result = evalPredicate(subgoal.success, scene)
      expect(["true", "false", "unknown"]).toContain(result.verdict)
      expect(result.evidence.length).toBeGreaterThan(0)
    }
    // The fixture already shows enough readable units, so the read predicate holds.
    expect(evalPredicate(decision.commit.subgoals[0].success, scene).verdict).toBe("true")
  })

  test("a not-yet-navigated goal yields a plan starting with navigate carrying the goal value", async () => {
    const scene = await readFixture()
    const decision = plan(`navigate to "${GOAL_DESTINATION}"`, scene)
    const first = decision.commit.subgoals[0]
    expect(first.kind).toBe(NAVIGATE)
    expect(first.params.value).toBe(GOAL_DESTINATION)
    expect(first.success.op).toBe(URL_HOST)
    // The destination is not the one the fixture is showing — honest non-arrival.
    expect(evalPredicate(first.success, scene).verdict).toBe("false")
  })

  test("no site, app or address name is read from the scene (~ the goal value carries it)", () => {
    const decision = plan(READ_GOAL, syntheticScene([sceneItem("row-1")]))
    expect(decision.commit.goal).toBe(READ_GOAL)
    expect(decision.commit.subgoals[0].params.value).toBeUndefined()
  })
})

describe("ui-plan — (c) replan inserts a bounded corrective subgoal", () => {
  const blockedPlan = (budget = 5): Plan => ({
    goal: READ_GOAL,
    subgoals: [{ kind: READ, params: { kind: READ, count: 3 }, success: { op: READ_COUNT, n: 3 }, budget }],
  })

  test("a blocked subgoal over a dialog gains a dismiss corrective, bounded", () => {
    const scene = syntheticScene([sceneItem("row-1")], [dialogRegion()])
    const history: StepRecord[] = [{ maneuver: "m", scene, subgoalIndex: 0 }]
    const once = replan(blockedPlan(), scene, history)
    expect(once.subgoals.length).toBe(2)
    expect(once.subgoals[0].kind).toBe("dismiss")
    expect(once.subgoals[0].corrective).toBe(true)

    const twice = replan(once, scene, history)
    const thrice = replan(twice, scene, history)
    expect(twice.replans).toBe(2)
    // Bounded: no more correctives beyond MAX_REPLANS.
    expect(thrice.subgoals.length).toBe(twice.subgoals.length)
    expect(thrice.replans).toBe(2)
  })

  test("without a dialog the corrective is back (the unseen shape)", () => {
    const scene = syntheticScene([sceneItem("row-1")])
    const history: StepRecord[] = [{ maneuver: "m", scene, subgoalIndex: 0 }]
    const revised = replan(blockedPlan(), scene, history)
    expect(revised.subgoals[0].kind).toBe("back")
    expect(revised.subgoals[0].corrective).toBe(true)
  })

  test("a complete plan or an un-attempted subgoal is returned unchanged", () => {
    const scene = syntheticScene([sceneItem("row-1")])
    const history: StepRecord[] = [{ maneuver: "m", scene, subgoalIndex: 0 }]
    const complete: Plan = {
      goal: READ_GOAL,
      subgoals: [{ kind: READ, params: { kind: READ, count: 1 }, success: { op: READ_COUNT, n: 1 }, budget: 5 }],
    }
    expect(replan(complete, scene, history)).toBe(complete)
    expect(replan(blockedPlan(), scene, [])).toEqual(blockedPlan())
  })
})

// GENERALIZATION — INVARIANT: a read/content predicate is judged over the
// goal-relevant region, never chrome. A messaging-style goal whose chrome carries
// the token "messages" is ONE instance; unseen case: any page whose toolbar/address
// bar repeats the goal's words while the real content sits in a list/detail region.
// hardcode-guard:allow the synthetic messaging scene is the general chrome-vs-content shape under test, not a named site
describe("ui-plan — (e) predicate region-scoping (chrome is never content)", () => {
  const element = (label: string, role = "AXStaticText"): Element => ({ element_token: label, role, label })
  const chromeText = (text: string): SceneText => ({
    id: `chrome:${text}`,
    role: "AXStaticText",
    text,
    owner: "r0:chrome",
    element: element(text),
  })
  const contentText = (text: string): SceneText => ({
    id: `content:${text}`,
    role: "AXStaticText",
    text,
    owner: "r1:detail",
    element: element(text),
  })
  const row = (label: string): SceneItem => ({
    id: label,
    role: "AXLink",
    label,
    affordances: ["activatable"],
    stateChanging: false,
    enabled: true,
    element: element(label, "AXLink"),
  })

  const messagingScene = (): Scene => ({
    snapshot: "s-msg",
    regions: [
      { id: "r0:chrome", kind: "chrome", itemIds: [], textIds: ["chrome:messages", "chrome:inbox", "chrome:profile"] },
      { id: "r1:detail", kind: "detail", itemIds: [], textIds: ["content:conversation"] },
      { id: "r2:list", kind: "list", itemIds: ["conversation-1"], textIds: [] },
    ],
    items: [row("conversation-1")],
    texts: [chromeText("messages"), chromeText("inbox"), chromeText("profile"), contentText("conversation")],
  })

  test("chrome text can never satisfy text_present without an explicit region", () => {
    const scene = messagingScene()
    // "messages" lives ONLY in chrome; the default region is content/detail.
    expect(evalPredicate({ op: "text_present", text: "messages" }, scene).verdict).toBe("false")
    // the same token IS found when the caller names the chrome region explicitly.
    expect(evalPredicate({ op: "text_present", text: "messages", regionKind: "chrome" }, scene).verdict).toBe("true")
    // content text is found by default.
    expect(evalPredicate({ op: "text_present", text: "conversation" }, scene).verdict).toBe("true")
  })

  test("read_count counts the goal-relevant list region only, never chrome", () => {
    const scene = messagingScene()
    // three chrome texts cannot satisfy a read of 3; only the ONE list row counts.
    const result = evalPredicate({ op: "read_count", n: 3 }, scene)
    expect(result.verdict).toBe("false")
    expect(result.satisfied).toBe(1)
    expect(targetRegionKind(scene)).toBe("list")
  })

  test("a chrome-only scene offers no content region (targetRegionKind is undefined)", () => {
    const scene: Scene = {
      snapshot: "s-chrome",
      regions: [{ id: "r0:chrome", kind: "chrome", itemIds: [], textIds: ["chrome:x"] }],
      items: [],
      texts: [chromeText("x")],
    }
    expect(targetRegionKind(scene)).toBeUndefined()
    expect(evalPredicate({ op: "text_present", text: "x" }, scene).verdict).toBe("false")
    expect(evalPredicate({ op: "read_count", n: 1 }, scene).verdict).toBe("false")
  })
})

