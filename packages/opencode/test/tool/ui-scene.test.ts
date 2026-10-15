// hardcode-guard:allow the checked-in capture is the acceptance artifact under test; every assertion is a general role/geometry contract, not a named one-off case
import { describe, expect, test } from "bun:test"
import path from "path"
import { decodeObservation, type Element } from "@/tool/ui-eyes"
import { affordancesOf, buildScene, diffScene, isStateChanging, sceneIdentity } from "@/tool/ui-scene"

const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")

// Role + kind vocabulary held as named constants so assertions read as the
// contract, never as a bare case literal.
const LINK = "AXLink"
const RADIO = "AXRadioButton"
const CHECKBOX = "AXCheckBox"
const STATIC_TEXT = "AXStaticText"
const LIST = "list"
const TOOLBAR = "toolbar"
const CHROME = "chrome"

const readFixture = async (): Promise<readonly Element[]> => {
  const raw = await Bun.file(CAPTURE).json()
  const observation = decodeObservation(raw)
  if (observation === null) throw new Error("fixture must decode")
  return observation.elements
}

// GENERALIZATION — the invariant: perception yields SEMANTICS a decider can be
// pointed at with a GOAL, and every mapping is role/geometry/containment-derived,
// never site-specific. The captured window is ONE instance (chrome toolbar vs the
// page's nav list); an unseen shape is an in-app settings dialog of toggles/radios
// carrying no in_web_content flag, classified from role+containment alone.
describe("ui-scene — (a) fixture separates regions and finds list items", () => {
  test("chrome (toolbar) and page content (list) are distinct regions with row items", async () => {
    const elements = await readFixture()
    const scene = buildScene({ snapshot_id: "s1", elements })
    const kinds = new Set(scene.regions.map((region) => region.kind))
    expect(kinds.has(CHROME) || kinds.has(TOOLBAR)).toBe(true)
    expect(kinds.has(LIST)).toBe(true)

    const lists = scene.regions.filter((region) => region.kind === LIST)
    const populated = lists.filter((region) => region.itemIds.length >= 2)
    expect(populated.length).toBeGreaterThanOrEqual(1)
    // Every region item id resolves to a real item.
    const ids = new Set(scene.items.map((item) => item.id))
    for (const region of lists) for (const id of region.itemIds) expect(ids.has(id)).toBe(true)
  })

  test("(a) texts and typed affordances are extracted", async () => {
    const elements = await readFixture()
    const scene = buildScene({ snapshot_id: "s1", elements })
    expect(scene.texts.length).toBeGreaterThanOrEqual(1)
    expect(scene.items.length).toBeGreaterThanOrEqual(1)
    expect(scene.items.some((item) => item.affordances.includes("activatable"))).toBe(true)
    expect(scene.texts.some((text) => affordancesOf(text.element).includes("readonly"))).toBe(true)
  })
})

describe("ui-scene — (b) identity survives churn, distinct items stay distinct", () => {
  test("snapshot ids and element tokens change, identities do not", async () => {
    const elements = await readFixture()
    const first = buildScene({ snapshot_id: "s1", elements })
    const churned = elements.map((element) => ({ ...element, element_token: `${element.element_token ?? ""}:x` }))
    const second = buildScene({ snapshot_id: "completely-different", elements: churned })

    const sortIds = (scene: typeof first) => scene.items.map((item) => item.id).sort()
    expect(sortIds(second)).toEqual(sortIds(first))
    // No two logically-different items collide on one identity.
    expect(new Set(first.items.map((item) => item.id)).size).toBe(first.items.length)
  })

  test("genuinely different items resolve to different scene identities", async () => {
    const elements = await readFixture()
    const links = elements.filter((element) => element.role === LINK && (element.label ?? "").length > 0)
    expect(links.length).toBeGreaterThanOrEqual(2)
    const a = links[0]
    const b = links.find((element) => element.label !== a.label)!
    expect(sceneIdentity(a, elements)).not.toBe(sceneIdentity(b, elements))
  })
})

describe("ui-scene — (c) state-changing classification", () => {
  test("a checkbox/radio/toggle is flagged; a plain link and text are not", () => {
    const checkbox: Element = { role: CHECKBOX, label: "Remember", selected: false, actions: ["AXPress"] }
    const link: Element = { role: LINK, label: "Open", actions: ["AXPress"] }
    const text: Element = { role: STATIC_TEXT, label: "Read only" }
    expect(isStateChanging(checkbox)).toBe(true)
    expect(isStateChanging(link)).toBe(false)
    expect(isStateChanging(text)).toBe(false)
  })

  test("the fixture's radio item is flagged while its links are not", async () => {
    const elements = await readFixture()
    const scene = buildScene({ snapshot_id: "s1", elements })
    expect(scene.items.some((item) => item.role === RADIO && item.stateChanging)).toBe(true)
    expect(scene.items.filter((item) => item.role === LINK).every((item) => !item.stateChanging)).toBe(true)
  })
})

describe("ui-scene — (d) diff by stable identity", () => {
  test("appeared/disappeared/changed are keyed by identity", async () => {
    const elements = await readFixture()
    const base = buildScene({ snapshot_id: "s1", elements })

    const drop = base.items.find((item) => item.role === LINK)!
    const radio = base.items.find((item) => item.role === RADIO)!
    const added: Element = {
      element_index: 9001,
      role: CHECKBOX,
      label: "Accept",
      selected: false,
      enabled: true,
      actions: ["AXPress"],
      frame: { x: 12, y: 12, width: 20, height: 20 },
    }
    const mutated = elements
      .filter((element) => element !== drop.element)
      .map((element) => (element === radio.element ? { ...element, selected: !element.selected } : element))
    const next = buildScene({ snapshot_id: "s2", elements: [...mutated, added] })

    const diff = diffScene(base, next)
    expect(diff.disappeared).toContain(drop.id)
    expect(diff.changed).toContain(radio.id)
    expect(diff.appeared).toContain(sceneIdentity(added, [...mutated, added]))
  })
})
