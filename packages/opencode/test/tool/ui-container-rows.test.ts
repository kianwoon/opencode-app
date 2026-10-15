// hardcode-guard:allow the synthetic list below is a general container-built shape (no row roles, no site/app/url name); every assertion is a structural contract, not a named one-off case
import { describe, expect, test } from "bun:test"
import type { Element } from "@/tool/ui-eyes"
import { buildScene } from "@/tool/ui-scene"
import { deriveManeuvers } from "@/tool/ui-maneuvers"

// A container-built list: the list's children carry NO row role (generic
// containers), each holding its own text cells. This is the general shape a web
// app produces; the sender/name/preview strings are ordinary filler.
const CONTAINERS = [
  { name: "Ada", preview: "Ada: see you at five" },
  { name: "Grace", preview: "Grace: sent an attachment" },
  { name: "Linus", preview: "Linus: the build is green" },
  { name: "Ada", preview: "Ada: see you at five" }, // same-shaped sibling: must stay distinct
]

function containerList(): Element[] {
  const els: Element[] = []
  const add = (element: Omit<Element, "element_index">): number => {
    const index = els.length
    els.push({ element_index: index, ...element })
    return index
  }
  const window = add({ role: "AXWindow", frame: { x: 0, y: 0, width: 1200, height: 800 } })
  const web = add({
    role: "AXWebArea",
    parent_index: window,
    depth: 1,
    in_web_content: true,
    frame: { x: 0, y: 0, width: 1200, height: 800 },
  })
  // Header filter controls: state-changing, sitting OUTSIDE the conversation list.
  add({
    role: "AXCheckBox",
    label: "Jobs",
    parent_index: web,
    depth: 2,
    in_web_content: true,
    selected: false,
    actions: ["AXPress"],
    frame: { x: 10, y: 10, width: 60, height: 20 },
  })
  add({
    role: "AXCheckBox",
    label: "Unread",
    parent_index: web,
    depth: 2,
    in_web_content: true,
    selected: false,
    actions: ["AXPress"],
    frame: { x: 90, y: 10, width: 60, height: 20 },
  })
  const list = add({
    role: "AXList",
    label: "Conversation List",
    parent_index: web,
    depth: 2,
    in_web_content: true,
    frame: { x: 0, y: 40, width: 340, height: 400 },
  })
  CONTAINERS.forEach((conversation, i) => {
    const top = 50 + i * 80
    const container = add({
      role: "AXGroup",
      parent_index: list,
      depth: 3,
      in_web_content: true,
      frame: { x: 0, y: top, width: 320, height: 72 },
    })
    const cell = (element: Omit<Element, "element_index" | "parent_index" | "depth" | "in_web_content">, dy: number) =>
      add({ ...element, parent_index: container, depth: 4, in_web_content: true, frame: { x: 8, y: top + dy, width: 200, height: 16 } })
    cell({ role: "AXImage" }, 4)
    cell({ role: "AXCheckBox", label: `Select conversation with ${conversation.name}`, selected: false, actions: ["AXPress"] }, 6)
    cell({ role: "AXHeading", label: conversation.name }, 8)
    cell({ role: "AXStaticText", label: "10:00 AM", value: "10:00 AM" }, 30)
    cell({ role: "AXStaticText", label: conversation.preview, value: conversation.preview }, 48)
    cell({ role: "AXButton", label: "More options", actions: ["AXPress"] }, 4)
  })
  return els
}

const churn = (elements: readonly Element[]): Element[] =>
  elements.map((element) => ({ ...element, element_token: `${element.element_token ?? "t"}:x` }))

describe("ui-scene — container-built rows (no row role)", () => {
  test("repeated sibling containers become list items exposing their text cells", () => {
    const scene = buildScene({ snapshot_id: "s1", elements: containerList() })
    const lists = scene.regions.filter((region) => region.kind === "list")
    expect(lists.length).toBeGreaterThanOrEqual(1)
    const list = lists.reduce((best, region) => (region.itemIds.length > best.itemIds.length ? region : best))
    expect(list.itemIds.length).toBeGreaterThanOrEqual(4)
    const items = scene.items.filter((item) => list!.itemIds.includes(item.id))
    expect(items.length).toBeGreaterThanOrEqual(4)
    expect(items.every((item) => !item.stateChanging)).toBe(true)
    // Each item exposes the name AND the preview text of its own cells.
    // hardcode-guard:allow the fixture reads its own filler data back, no named case is asserted
    const second = CONTAINERS[1]
    expect(items.some((item) => item.label.includes(second.name) && item.label.includes(second.preview))).toBe(true)
    // The name heading and preview are owned by the item they sit inside, not the region.
    const owned = scene.texts.filter((text) => list!.itemIds.includes(text.owner))
    expect(owned.some((text) => text.text === "Grace")).toBe(true)
    expect(owned.some((text) => text.text === "Grace: sent an attachment")).toBe(true)
  })

  test("identity survives token churn and same-shaped siblings stay distinct", () => {
    const first = buildScene({ snapshot_id: "s1", elements: containerList() })
    const second = buildScene({ snapshot_id: "different", elements: churn(containerList()) })
    const ids = (scene: typeof first) => scene.items.map((item) => item.id).sort()
    expect(ids(second)).toEqual(ids(first))
    expect(new Set(first.items.map((item) => item.id)).size).toBe(first.items.length)
    // Two containers exposing identical text still resolve to different identities.
    const twins = first.items.filter((item) => item.label === "Ada 10:00 AM Ada: see you at five")
    expect(twins.length).toBe(2)
    expect(twins[0].id).not.toBe(twins[1].id)
  })
})

describe("ui-maneuvers — read-only subgoal over a container-built list", () => {
  test("read options bind to items; no state-changing option is offered", () => {
    const scene = buildScene({ snapshot_id: "s1", elements: containerList() })
    expect(scene.items.some((item) => item.stateChanging)).toBe(true)

    const set = deriveManeuvers({ kind: "read_items", count: 3 }, scene)
    expect(set.reason).toBeUndefined()
    expect(set.options.some((option) => option.name === "read_items")).toBe(true)
    for (const option of set.options) {
      for (const target of option.targets) {
        const item = scene.items.find((entry) => entry.id === target.id)
        if (item === undefined) continue
        expect(item.stateChanging).toBe(false)
      }
    }
    // The selection checkboxes are never offered as read targets.
    const targetedLabels = set.options.flatMap((option) => option.targets.map((target) => target.label ?? ""))
    expect(targetedLabels.some((label) => label.startsWith("Select conversation"))).toBe(false)
  })
})
