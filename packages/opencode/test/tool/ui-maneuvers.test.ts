// hardcode-guard:allow the checked-in capture is the acceptance artifact under test; every assertion is a general subgoal->maneuver contract, not a named one-off case
import { describe, expect, test } from "bun:test"
import path from "path"
import { decodeObservation, type Element } from "@/tool/ui-eyes"
import { buildScene } from "@/tool/ui-scene"
import { MAX_OPTIONS, deriveManeuvers, type ManeuverOption, type Subgoal } from "@/tool/ui-maneuvers"
import type { Scene, SceneItem } from "@/tool/ui-scene"

const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")

// Names + tokens held as constants so assertions read as the contract.
const READ_ITEMS = "read_items"
const OPEN_ITEMS = "open_item"
const GO_TO_URL = "go_to_url"
const ITEM = "item"
const VALUE_INPUT = "value"
const DESTINATION = "goal-destination-token"

const readFixture = async (): Promise<readonly Element[]> => {
  const raw = await Bun.file(CAPTURE).json()
  const observation = decodeObservation(raw)
  if (observation === null) throw new Error("fixture must decode")
  return observation.elements
}

const sceneFromFixture = async () => buildScene({ snapshot_id: "s1", elements: await readFixture() })

// GENERALIZATION — the invariant: the decider's option space is derived from the
// subgoal + Scene semantics, never from raw controls; a read-only subgoal never
// offers a state-changing target; an unadvanceable subgoal yields an explicit
// empty set + reason. The live instance it fixes is a loop asked to open a
// message-list row that clicked the list's selection checkboxes instead; an
// unseen subgoal shape is a `dismiss` over a label-less modal (the dialog region
// is the target) and an unknown kind, both degrading to empty + reason.
describe("ui-maneuvers — (a) subgoal → maneuvers over the fixture", () => {
  test("read_items yields read/open maneuvers bound to list items, no state-changing options", async () => {
    const scene = await sceneFromFixture()
    // The scene DOES hold state-changing rows; the read subgoal must exclude them.
    expect(scene.items.some((item) => item.stateChanging)).toBe(true)

    const set = deriveManeuvers({ kind: "read_items", count: 3 }, scene)
    expect(set.reason).toBeUndefined()
    expect(set.options.some((option) => option.name === READ_ITEMS)).toBe(true)
    expect(set.options.some((option) => option.name === OPEN_ITEMS)).toBe(true)

    for (const option of set.options) {
      for (const target of option.targets) {
        if (target.kind !== ITEM) continue
        const item = scene.items.find((entry) => entry.id === target.id)
        expect(item).toBeDefined()
        expect(item?.stateChanging).toBe(false)
      }
    }
  })

  test("navigate offers go_to_url carrying the goal value", async () => {
    const scene = await sceneFromFixture()
    const set = deriveManeuvers({ kind: "navigate", value: DESTINATION }, scene)
    const option = set.options.find((entry) => entry.name === GO_TO_URL)
    expect(option).toBeDefined()
    expect(option?.inputs.find((entry) => entry.name === VALUE_INPUT)?.value).toBe(DESTINATION)
  })

  test("an unadvanceable subgoal yields an empty set with a reason", async () => {
    const scene = await sceneFromFixture()
    const set = deriveManeuvers({ kind: "dismiss" }, scene)
    expect(set.options.length).toBe(0)
    expect(set.reason).toBeDefined()
    expect((set.reason ?? "").length).toBeGreaterThan(0)
  })

  test("the option count stays <= 12 on a 600-element scene", () => {
    const rows: Element[] = Array.from({ length: 600 }, (_unused, index) => ({
      element_index: index,
      element_token: `t${index}`,
      role: "AXLink",
      label: `row ${index}`,
      in_web_content: true,
      actions: ["AXPress"],
      frame: { x: 0, y: index * 20, width: 120, height: 18 },
    }))
    const scene = buildScene({ snapshot_id: "big", elements: rows })
    const set = deriveManeuvers({ kind: "read_items", count: 3 }, scene)
    expect(MAX_OPTIONS).toBe(12)
    expect(set.options.length).toBeLessThanOrEqual(MAX_OPTIONS)
  })
})

describe("ui-maneuvers — (b) every offered option carries a success predicate", () => {
  test("all options over several subgoal kinds name a non-empty success predicate", async () => {
    const scene = await sceneFromFixture()
    const subgoals: Subgoal[] = [
      { kind: "read_items", count: 3 },
      { kind: "navigate", value: DESTINATION },
      { kind: "open_item" },
      { kind: "back" },
    ]
    const offered: ManeuverOption[] = subgoals.flatMap((subgoal) => deriveManeuvers(subgoal, scene).options)
    expect(offered.length).toBeGreaterThan(0)
    for (const option of offered) {
      expect(option.success.predicate.length).toBeGreaterThan(0)
      expect(option.success.detail.length).toBeGreaterThan(0)
      expect(option.preconditions.length).toBeGreaterThan(0)
    }
  })
})

// GENERALIZATION — INVARIANT: a mutation subgoal offers `select_option` bound to
// the goal's term, whose success is a STATE reading (`optionSelected`); an app
// subgoal offers `open_app` bound to the app the goal named. LIVE INSTANCE: the
// macOS wallpaper swatches under-declare AX actions, so the option is executed by
// the same click path and proven only by observed state. UNSEEN SHAPE: any
// toggle/radio/selectable option on any pane takes the same `apply` shape.
// hardcode-guard:allow the fixture labels are the enumerable inputs under test
describe("ui-maneuvers — (e) mutation maneuvers (select_option, open_app)", () => {
  const el = (label: string, role = "AXButton"): Element => ({ element_token: label, role, label })
  const item = (label: string): SceneItem => ({
    id: label,
    role: "AXButton",
    label,
    affordances: ["activatable"],
    stateChanging: false,
    enabled: true,
    element: el(label),
  })
  const scene = (items: readonly SceneItem[]): Scene => ({ snapshot: "s", regions: [], items, texts: [] })
  const SELECT_OPTION = "select_option"
  const OPEN_APP = "open_app"
  const APPLY_TERM = "black"

  test("(b) select_option binds to the goal term and its success reads STATE, not text", () => {
    const set = deriveManeuvers({ kind: "apply", matching: APPLY_TERM }, scene([item("Black"), item("Blue")]))
    const option = set.options.find((entry) => entry.name === SELECT_OPTION)
    expect(option).toBeDefined()
    expect(option?.targets.length).toBe(1)
    expect(option?.success.predicate).toBe("optionSelected")
    expect(option?.inputs.find((entry) => entry.name === "matching")?.value).toBe(APPLY_TERM)
  })

  test("(b) an option space with no matching term is empty + reason (never a guess)", () => {
    const set = deriveManeuvers({ kind: "apply", matching: "chartreuse" }, scene([item("Black")]))
    expect(set.options).toHaveLength(0)
    expect(set.reason).toContain("apply")
  })

  test("(a) open_app derives from the app the goal named, and is offered", () => {
    const set = deriveManeuvers({ kind: "open_app", value: "Calculator" }, scene([]))
    const option = set.options.find((entry) => entry.name === OPEN_APP)
    expect(option).toBeDefined()
    expect(option?.inputs.find((entry) => entry.name === "app")?.value).toBe("Calculator")
    // without an app name there is no option
    expect(deriveManeuvers({ kind: "open_app" }, scene([])).options).toHaveLength(0)
  })

  test("(a) SCENE-FIRST: open_app is NOT offered when the named target already exists in the scene", () => {
    // a target present in the observed tree must be navigated to, never launched
    expect(deriveManeuvers({ kind: "open_app", value: "About" }, scene([item("About")])).options).toHaveLength(0)
    // a genuinely absent application is still offered
    expect(deriveManeuvers({ kind: "open_app", value: "Calculator" }, scene([item("About")])).options).toHaveLength(1)
  })

  test("(a) a label-less selectable row is recovered from its labelled descendant and reachable only as a mutation surface", () => {
    const els: Element[] = []
    const add = (element: Omit<Element, "element_index">): number => {
      const index = els.length
      els.push({ element_index: index, ...element })
      return index
    }
    const win = add({ role: "AXWindow", frame: { x: 0, y: 0, width: 800, height: 600 } })
    const outline = add({
      role: "AXOutline",
      label: "Sidebar",
      parent_index: win,
      depth: 1,
      frame: { x: 0, y: 0, width: 200, height: 600 },
    })
    const row = (label: string, y: number) => {
      const r = add({ role: "AXRow", parent_index: outline, depth: 2, selected: false, frame: { x: 0, y, width: 200, height: 28 } })
      add({ role: "AXButton", label, parent_index: r, depth: 3, actions: ["AXPress"], frame: { x: 8, y, width: 180, height: 24 } })
    }
    row("panel-alpha", 40)
    row("panel-beta", 72)
    const panelScene = buildScene({ snapshot_id: "s", elements: els })
    // the row's own label is empty; the labelled child is recovered structurally
    expect(panelScene.items.some((item) => item.label === "panel-alpha")).toBe(true)
    // a READ never binds the selectable row (LAW 1 intact)...
    const read = deriveManeuvers({ kind: "read_items", count: 3 }, panelScene)
    const readLabels = read.options.flatMap((option) => option.targets.map((target) => target.label ?? ""))
    expect(readLabels.some((label) => label.includes("panel-alpha"))).toBe(false)
    // ...but a mutation surface does
    const open = deriveManeuvers({ kind: "open_item", matching: "panel-alpha", selectable: true }, panelScene)
    expect(open.options.some((option) => option.name === OPEN_ITEMS)).toBe(true)
  })
})

// GENERALIZATION — INVARIANT: the reads a settled scene SUPPORTS are offered over its
// labelled elements even when it exposes no LIST region; a goal-anchored token binds the
// read to the labelled value. LIVE INSTANCE: the About pane's labelled values (macOS /
// Chip / Memory) were readable but no read was offered. UNSEEN INPUT: any in-app pane
// whose values are labelled rows/static texts rather than list rows.
// hardcode-guard:allow the fixture roles/labels are the enumerable read inputs under test
describe("ui-maneuvers — (a) reads are offered over observed labelled elements, not only LIST rows", () => {
  const valueRow = (id: string, label: string, value: string): SceneItem => ({
    id,
    role: "AXStaticText",
    label,
    affordances: ["readonly"],
    stateChanging: false,
    enabled: true,
    element: { element_token: `t:${id}`, role: "AXStaticText", label, value },
  })
  const pane = (): Scene => ({
    snapshot: "s-pane",
    regions: [{ id: "p:detail", kind: "detail", itemIds: ["p:macos", "p:chip", "p:memory"], textIds: [] }],
    items: [valueRow("p:macos", "macOS", "27.2 Beta"), valueRow("p:chip", "Chip", "Apple M3 Max"), valueRow("p:memory", "Memory", "128 GB")],
    texts: [],
  })

  test("(a) a goal-anchored read binds the labelled value on a pane with no list region", () => {
    const set = deriveManeuvers({ kind: "read_items", count: 1, matching: "chip" }, pane())
    expect(set.reason).toBeUndefined()
    const option = set.options.find((entry) => entry.name === READ_ITEMS)
    expect(option).toBeDefined()
    expect(option?.targets.some((target) => (target.label ?? "").includes("Chip"))).toBe(true)
  })

  test("(a) with no matching token the pane's labelled elements are still readable", () => {
    const set = deriveManeuvers({ kind: "read_items", count: 3 }, pane())
    expect(set.options.some((entry) => entry.name === READ_ITEMS)).toBe(true)
  })
})

