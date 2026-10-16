// hardcode-guard:allow the checked-in capture is the acceptance artifact under test; every assertion is a general goal->plan contract, not a named one-off case
import { describe, expect, test } from "bun:test"
import path from "path"
import { decodeObservation, type Element } from "@/tool/ui-eyes"
import { buildScene, type Scene, type SceneItem, type SceneRegion, type SceneText } from "@/tool/ui-scene"
import { evalPredicate, goalApp, goalIntent, mutationValue, plan, reportedTokens, replan, targetRegionKind, targetTerm, type Plan, type StepRecord } from "@/tool/ui-plan"
import { resolveNamedItem } from "@/tool/ui-maneuvers"

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

// GENERALIZATION — INVARIANT: a goal's INTENT (its own verb family) selects the
// plan SHAPE, and a MUTATION is proven by OBSERVED STATE, never by reading text.
// LIVE INSTANCE: "change my mac wallpaper to black" "completed" by reading the
// Settings sidebar (0 actions). UNSEEN SHAPES COVERED: "open the Calculator app"
// (pure launch) and "turn on dark mode" (toggle) take the same mutation shape.
// hardcode-guard:allow the goal phrasings are the enumerable inputs under test
describe("ui-plan — (e) intent selects the plan shape; mutation proven by state", () => {
  const el = (label: string, role = "AXLink"): Element => ({ element_token: label, role, label })
  const item = (label: string, extra: Partial<SceneItem> = {}): SceneItem => ({
    id: label,
    role: "AXLink",
    label,
    affordances: ["activatable"],
    stateChanging: false,
    enabled: true,
    element: el(label),
    ...extra,
  })
  const settingsScene = (): Scene => ({
    snapshot: "s-settings",
    regions: [
      { id: "r0:list", kind: "list", itemIds: ["About", "Software Update", "Storage", "Wallpaper"], textIds: [] },
      { id: "r1:content", kind: "content", itemIds: [], textIds: ["h"] },
    ],
    items: [item("About"), item("Software Update"), item("Storage"), item("Wallpaper")],
    texts: [{ id: "h", role: "AXHeading", text: "About", owner: "r1:content", element: el("About", "AXStaticText") }],
  })

  test("(a) intent classification maps the verb families", () => {
    expect(goalIntent("change my mac wallpaper to black")).toBe("mutate")
    expect(goalIntent("toggle the checkbox")).toBe("mutate")
    expect(goalIntent("open the Calculator app")).toBe("mutate")
    expect(goalIntent(READ_GOAL)).toBe("read")
    expect(goalIntent(`go to "${GOAL_DESTINATION}"`)).toBe("navigate")
  })

  test("(b) a mutation goal never yields a read plan and never a read predicate", () => {
    const decision = plan("change my mac wallpaper to black", settingsScene())
    expect(decision.commitId).toBe("mutate")
    expect(decision.commit.subgoals.some((subgoal) => subgoal.kind === READ)).toBe(false)
    expect(decision.commit.subgoals.every((subgoal) => subgoal.success.op !== READ_COUNT)).toBe(true)
    // the mutation is the LAST step and it is a STATE predicate
    const applyLast = decision.commit.subgoals.at(-1)
    expect(applyLast?.kind).toBe("apply")
    expect(applyLast?.success.op).toBe("option_selected")
    // the surface step may reach a selectable navigation row (mutation-only)
    const surface = decision.commit.subgoals.find((subgoal) => subgoal.kind === "open_item")
    expect(surface?.params.selectable).toBe(true)
    // reading the sidebar can never satisfy it (the option is absent → unknown)
    expect(evalPredicate(applyLast!.success, settingsScene()).verdict).not.toBe("true")
  })

  test("(b) the mutation derivations come from the goal's own words", () => {
    expect(mutationValue("change my mac wallpaper to black")).toBe("black")
    expect(targetTerm("change my mac wallpaper to black")).toBe("wallpaper")
    expect(goalApp("open the Calculator app")).toBe("Calculator")
    expect(goalApp("change my mac wallpaper to black")).toBeUndefined()
  })

  test("(b) option_selected reads STATE, never text: a labelled-but-unselected option is not a selection", () => {
    const labelled = syntheticScene([item("Black")])
    expect(evalPredicate({ op: "option_selected", matching: "black" }, labelled).verdict).toBe("false")
    const selected = syntheticScene([item("Black", { selected: true })])
    const hit = evalPredicate({ op: "option_selected", matching: "black" }, selected)
    expect(hit.verdict).toBe("true")
    expect(hit.cited?.[0]).toContain("Black")
    // an option that is not observable at all is unknown, never true
    expect(evalPredicate({ op: "option_selected", matching: "black" }, syntheticScene([])).verdict).toBe("unknown")
  })
})

// GENERALIZATION — INVARIANT: the plan consults the OBSERVED SCENE before choosing
// a maneuver — a target present in the tree is reached by UI navigation, never by
// launching an application; a genuinely absent application is launched with its
// real name. LIVE INSTANCE: the goal "open the About pane and report the macOS
// version, chip and total memory" classified as open_app "About" (0.88) without
// consulting the tree, and the launch failed "unknown argument app". The sidebar
// has no top-level "About" row (it is nested under "General"). UNSEEN CASES: a
// parent row -> child row target, and a bundle-style absent app.
// hardcode-guard:allow the live goal/error strings and their scene shapes are the inputs under repair
describe("ui-plan — (a) scene-first maneuver choice: navigation before launch", () => {
  const el = (label: string, role = "AXRow", parent?: number): Element => ({
    element_token: label,
    role,
    label,
    ...(parent !== undefined ? { parent_index: parent } : {}),
  })
  const rowItem = (label: string, element: Element): SceneItem => ({
    id: label,
    role: element.role ?? "AXRow",
    label,
    affordances: ["activatable"],
    stateChanging: false,
    enabled: true,
    element,
  })
  const settingsPaneScene = (): Scene => ({
    snapshot: "s-settings",
    regions: [{ id: "r0:list", kind: "list", itemIds: ["General", "Wallpaper", "About"], textIds: [] }],
    items: [
      rowItem("General", el("General", "AXRow", 0)),
      rowItem("Wallpaper", el("Wallpaper", "AXRow", 0)),
      // "About" is NOT a top-level row: it is nested under "General".
      rowItem("About", el("About", "AXRow", 1)),
    ],
    texts: [],
  })

  test("(a) a goal naming a pane whose row is PRESENT in the scene yields navigation, never an open_app launch", () => {
    const decision = plan("open the About pane and report the macOS version, chip and total memory", settingsPaneScene())
    expect(decision.commit.subgoals.some((subgoal) => subgoal.kind === "open_app")).toBe(false)
    const surface = decision.commit.subgoals.find((subgoal) => subgoal.kind === "open_item")
    expect(surface?.params.matching).toBe("About")
    expect(surface?.params.selectable).toBe(true)
  })

  test("(b) a NESTED item (parent row -> child row) resolves by descending, not failing or launching", () => {
    const scene = settingsPaneScene()
    expect(resolveNamedItem(scene, "About")?.id).toBe("About")
    const decision = plan("open the About pane", scene)
    expect(decision.commit.subgoals.some((subgoal) => subgoal.kind === "open_app")).toBe(false)
    expect(
      decision.commit.subgoals.some((subgoal) => subgoal.kind === "open_item" && subgoal.params.matching === "About"),
    ).toBe(true)
  })

  test("(c) an open_app for a genuinely ABSENT application still works and carries the real name", () => {
    const decision = plan("open the Calculator app", settingsPaneScene())
    const app = decision.commit.subgoals.find((subgoal) => subgoal.kind === "open_app")
    expect(app?.params.value).toBe("Calculator")
    // a pure launch is just the launch — no bogus navigation step
    expect(decision.commit.subgoals.some((subgoal) => subgoal.kind === "open_item")).toBe(false)
  })

  // hardcode-guard:allow the live goal and its pane names are the inputs under repair
  const differentPaneScene = (): Scene => ({
    snapshot: "s-accessibility",
    regions: [
      { id: "r0:list", kind: "list", itemIds: ["Wi-Fi", "Accessibility", "General", "Wallpaper"], textIds: [] },
      { id: "r1:content", kind: "content", itemIds: [], textIds: ["h"] },
    ],
    items: [
      rowItem("Wi-Fi", el("Wi-Fi", "AXRow", 0)),
      rowItem("Accessibility", el("Accessibility", "AXRow", 0)),
      rowItem("General", el("General", "AXRow", 0)),
      rowItem("Wallpaper", el("Wallpaper", "AXRow", 0)),
    ],
    texts: [
      { id: "h", role: "AXHeading", text: "Accessibility", owner: "r1:content", element: el("Accessibility", "AXStaticText") },
    ],
  })

  test("(a) a pane of the FRONTMOST app absent from the scene yields navigation inside, never a launch", () => {
    // PRE-FIX: the plan collapsed to ONE subgoal `open_app {value:"About"}` (entered
    // path open_app, `failed: launch_app failed: No installed macOS app found for
    // name 'About'.`). The frontmost app shows a DIFFERENT pane (Accessibility) while
    // the target "About" lives inside the SAME app's navigation surface.
    const decision = plan(
      "open the About pane and report the macOS version, chip and total memory",
      differentPaneScene(),
    )
    expect(decision.commit.subgoals.some((subgoal) => subgoal.kind === "open_app")).toBe(false)
    expect(
      decision.commit.subgoals.some((subgoal) => subgoal.kind === "open_item" && subgoal.params.matching === "About"),
    ).toBe(true)
  })

  test("(b) a plain name that is not an application is never a launch (no open_app subgoal at all)", () => {
    // No navigation surface at all: an unknown bare name still never launches.
    const bare: Scene = {
      snapshot: "s-bare",
      regions: [],
      items: [rowItem("Accessibility", el("Accessibility", "AXRow", 0))],
      texts: [],
    }
    expect(plan("open the Frobnicator pane", bare).commit.subgoals.some((subgoal) => subgoal.kind === "open_app")).toBe(
      false,
    )
    // a launch VERB still names an application, and a genuinely absent one is launched
    const launched = plan("launch the Calculator app", bare).commit.subgoals.find(
      (subgoal) => subgoal.kind === "open_app",
    )
    expect(launched?.params.value).toBe("Calculator")
  })
})

// GENERALIZATION — INVARIANT: a goal that NAMES attribute values to report over a
// reached surface derives one goal-anchored READ per attribute, so the values become
// evidence once the surface settles — never the bogus open_item/apply pair for a term
// that is not an option. LIVE INSTANCE: "open the About pane and report the macOS
// version, chip and total memory" derived a mutate plan with no read subgoal and then
// stopped no-choice with only subgoal 0 emitted. UNSEEN INPUT: any report goal whose
// named attributes sit in a pane reached through navigation.
// hardcode-guard:allow the live goal and its pane values are the inputs under repair
describe("ui-plan — a report goal derives goal-anchored reads for its named attributes", () => {
  test("(a) the named attributes are extracted as matchable tokens, not full phrases", () => {
    expect(reportedTokens("open the About pane and report the macOS version, chip and total memory")).toEqual([
      "macos",
      "chip",
      "memory",
    ])
    expect(reportedTokens("change my mac wallpaper to black")).toEqual([])
  })

  test("(a) the report decomposition carries one read_value subgoal per attribute after the surface reach", () => {
    const el = (label: string, role = "AXRow", parent?: number): Element => ({
      element_token: label,
      role,
      label,
      ...(parent !== undefined ? { parent_index: parent } : {}),
    })
    const scene: Scene = {
      snapshot: "s-settings",
      regions: [{ id: "r0:list", kind: "list", itemIds: ["General", "About"], textIds: [] }],
      items: [
        { id: "General", role: "AXRow", label: "General", affordances: ["activatable"], stateChanging: false, enabled: true, element: el("General") },
        { id: "About", role: "AXRow", label: "About", affordances: ["activatable"], stateChanging: false, enabled: true, element: el("About") },
      ],
      texts: [],
    }
    const decision = plan("open the About pane and report the macOS version, chip and total memory", scene)
    expect(decision.commit.subgoals.some((subgoal) => subgoal.kind === "open_item" && subgoal.params.matching === "About")).toBe(true)
    const reads = decision.commit.subgoals.filter((subgoal) => subgoal.success.op === "read_value")
    expect(reads.map((subgoal) => (subgoal.success.op === "read_value" ? subgoal.success.matching : ""))).toEqual([
      "macos",
      "chip",
      "memory",
    ])
  })
})

// GENERALIZATION — INVARIANT (navigation): arrival is judged by the DESTINATION's own
// identity — the surface you arrive at — never by a reference point that merely
// mentions it (a breadcrumb, a heading, a sidebar row, a text somewhere in content).
// UNSEEN INPUT: an app whose content shows the target's name while the surface is
// something else — the reach stays unsatisfied.
// hardcode-guard:allow the fixture labels are the enumerable navigation inputs under test
describe("ui-plan — (a) navigation arrival is the destination, not a reference to it", () => {
  const scene = (window: string | undefined, breadcrumb: boolean): Scene => ({
    snapshot: "s-arrival",
    ...(window !== undefined ? { window } : {}),
    regions: [{ id: "r:content", kind: "content", itemIds: [], textIds: breadcrumb ? ["t:crumb"] : [] }],
    items: [],
    texts: breadcrumb
      ? [
          {
            id: "t:crumb",
            role: "AXStaticText",
            text: "About",
            owner: "r:content",
            element: { element_token: "t:crumb", role: "AXStaticText", label: "About" },
          },
        ]
      : [],
  })

  test("(a) the destination's own identity satisfies the reach; a reference to it never does", () => {
    expect(evalPredicate({ op: "surface_is", text: "About" }, scene("About", true)).verdict).toBe("true")
    // the word is present only as a REFERENCE — the surface is somewhere else
    expect(evalPredicate({ op: "surface_is", text: "About" }, scene("Accessibility", true)).verdict).toBe("false")
    // no observable window identity → unknown, never a fabricated arrival
    expect(evalPredicate({ op: "surface_is", text: "About" }, scene(undefined, true)).verdict).toBe("unknown")
  })

  // hardcode-guard:allow the fixture lines are the driver-rendered node forms under test
  test("(a) an attribute reads its OWN value — a menu item naming it is never the answer", () => {
    const rendered: Scene = {
      snapshot: "s-tree",
      treeText: [
        '  - AXMenuItem = "About This Mac"',
        '  - AXStaticText = "About This Mac"',
        '  - AXStaticText = "Chip"',
        '  - AXStaticText = "Apple M3 Max"',
        '  - AXStaticText = "macOS Golden Gate"',
        '  - AXStaticText = "Version 27.2 Beta (26B5112a)"',
      ].join("\n"),
      regions: [],
      items: [],
      texts: [],
    }
    // the goal asked for the macOS VERSION: the Apple-menu item mentioning the name
    // must not satisfy it — the version line beneath the label does.
    const macos = evalPredicate({ op: "read_value", matching: "macos" }, rendered)
    expect(macos.verdict).toBe("true")
    expect(macos.cited).toEqual(["Version 27.2 Beta (26B5112a)"])
    const chip = evalPredicate({ op: "read_value", matching: "chip" }, rendered)
    expect(chip.verdict).toBe("true")
    expect(chip.cited).toEqual(["Apple M3 Max"])
  })
})



