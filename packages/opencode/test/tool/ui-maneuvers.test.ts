// hardcode-guard:allow the checked-in capture is the acceptance artifact under test; every assertion is a general subgoal->maneuver contract, not a named one-off case
import { describe, expect, test } from "bun:test"
import path from "path"
import { decodeObservation, type Element } from "@/tool/ui-eyes"
import { buildScene } from "@/tool/ui-scene"
import { MAX_OPTIONS, deriveManeuvers, type ManeuverOption, type Subgoal } from "@/tool/ui-maneuvers"

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
