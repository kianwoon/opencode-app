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

// GENERALIZATION — INVARIANT: success is evidence-bound; read predicates are
// goal-anchored; URL identity is NEVER compared vacuously (scheme+path, never an
// empty host). LIVE INSTANCES: (i) a file-URL + 3-messages goal completed at step 0
// on an unrelated page; (ii) a dense unrelated page satisfied a read with no goal
// content. UNSEEN CASES: any no-host scheme (about:, data:) and any goal anchor
// absent from a dense page.
// hardcode-guard:allow the fixture labels/tokens are the enumerable input under test
describe("ui-plan — (a)/(c)/(e) honest arrival identity + goal-anchored reads", () => {
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
  const denseUnrelated = (labels: readonly string[]): Scene => ({
    snapshot: "s-dense",
    regions: [{ id: "r0:list", kind: "list", itemIds: [...labels], textIds: [] }],
    items: labels.map(row),
    texts: [],
  })
  const urlText = (text: string): Scene => ({
    snapshot: "s-url",
    regions: [],
    items: [],
    texts: [{ id: "u", role: "AXStaticText", text, owner: "scene", element: el(text, "AXStaticText") }],
  })

  test("(a) a file-URL + 3-messages goal over an unrelated page commits navigate-first, never read-here", () => {
    const scene = denseUnrelated(["Inbox", "Sent", "Drafts", "Archive"])
    const decision = plan('go to "file:///tmp/messages.html" and read the last 3 messages', scene)
    expect(decision.commitId).not.toBe("read-here")
    expect(decision.commit.subgoals[0].kind).toBe(NAVIGATE)
    expect(decision.commit.subgoals[0].success.op).toBe("url_identity")
    // the unrelated page is NOT the file destination — honest non-arrival
    expect(evalPredicate(decision.commit.subgoals[0].success, scene).verdict).not.toBe("true")
  })

  test("(a/c) a no-host URL identity is never a vacuous empty-host compare", () => {
    const target = { op: "url_identity", scheme: "file", path: "/tmp/messages.html" } as const
    // a different path on the SAME scheme is not arrived
    expect(evalPredicate(target, urlText("file:///tmp/other.html")).verdict).toBe("false")
    // a different no-host scheme is not arrived
    expect(evalPredicate(target, urlText("about:blank")).verdict).toBe("false")
    // the exact identity IS arrived, and the evidence cites it
    const hit = evalPredicate(target, urlText("file:///tmp/messages.html"))
    expect(hit.verdict).toBe("true")
    expect(hit.cited?.[0]).toContain("file:///tmp/messages.html")
  })

  test("(a) a browser-displayed file path WITHOUT its scheme is arrival for the same file: goal", () => {
    const target = { op: "url_identity", scheme: "file", path: "/tmp/messages.html" } as const
    // Chromium's omnibox shows only the path — the LIVE arrived-page shape.
    const hit = evalPredicate(target, urlText("/tmp/messages.html"))
    expect(hit.verdict).toBe("true")
    expect(hit.cited?.[0]).toContain("/tmp/messages.html")
    // a different displayed path is still honest non-arrival
    expect(evalPredicate(target, urlText("/tmp/other.html")).verdict).toBe("false")
  })

  test("(c) a dense unrelated page cannot satisfy a read whose goal anchors are absent", () => {
    const scene = denseUnrelated(["alpha", "beta", "gamma", "delta", "epsilon"])
    const decision = plan("read the 3 messages from zeta", scene)
    const read = decision.commit.subgoals.find((subgoal) => subgoal.success.op === READ_COUNT)
    expect(read?.success).toMatchObject({ anchors: ["zeta"] })
    // five unrelated readable units do NOT satisfy the anchored read
    expect(evalPredicate(read!.success, scene).verdict).toBe("false")
    // when the anchors ARE present it holds, and the evidence names them
    const withAnchor = denseUnrelated(["zeta-1", "zeta-2", "zeta-3", "other"])
    const hit = evalPredicate(read!.success, withAnchor)
    expect(hit.verdict).toBe("true")
    expect(hit.evidence).toContain("zeta")
    expect(hit.cited?.join(" ")).toContain("zeta-1")
  })
})

