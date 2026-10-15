import { describe, expect, test } from "bun:test"
import path from "path"
import { LABEL_MAX } from "@/jev/controller"
import { advanceMap, decodeObservation, extractGoalValue, screenSignature } from "@/tool/ui-run"
import {
  SKILLS,
  dismissDialog,
  foldSubstepEvidence,
  goToUrl,
  matchSkills,
  mineSequences,
  readText,
  scrollTo,
  searchWithin,
  skillIndex,
  switchWindowOrTab,
  typeInto,
} from "@/tool/ui-skills"

const CAPTURE = path.join(import.meta.dir, "fixtures", "brave-window-capture.json")

// GENERALIZATION — the invariant: the decider chooses MANEUVERS; skills decompose
// them deterministically; values come from the goal. The four-decision struggle to
// reach a URL (focus / select-all / type / Enter) is ONE instance; the registry
// shape also covers an unseen `dismiss_dialog` skill (Escape or click its cancel
// control) with no loop change.
// hardcode-guard:allow the captured payload + quoted URL are the live inputs under test
const GOAL = `go to "https://www.linkedin.com" and sign in`
const VALUE = "https://www.linkedin.com"

const modesOf = (steps: readonly { label: string; kind: string }[]) =>
  steps.map((s) => ({ label: s.label, mode: s.kind === "click" ? ("declared" as const) : (s.kind as "key" | "type") }))

describe("ui-skills — contract + registry", () => {
  test("go_to_url declares the contract shape (name, option, precondition, select, steps, success)", () => {
    expect(goToUrl.name).toBe("go_to_url")
    expect(goToUrl.option.length).toBeLessThanOrEqual(LABEL_MAX)
    expect(typeof goToUrl.applies).toBe("function")
    expect(typeof goToUrl.select).toBe("function")
    expect(typeof goToUrl.steps).toBe("function")
    expect(typeof goToUrl.succeeded).toBe("function")
    expect(SKILLS).toContain(goToUrl)
  })

  test("its option label is one frontier option, not one per sub-step", () => {
    expect(goToUrl.option).toContain("go_to_url")
    const matches = matchSkills([], VALUE)
    expect(matches).toHaveLength(0) // no elements, no match
  })
})

describe("ui-skills — go_to_url over the captured Brave frontier", () => {
  test("(a) jev is offered go_to_url; choosing it yields the four sub-steps in order", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    expect(observation).not.toBeNull()
    if (observation === null) return
    const elements = observation.elements
    expect(extractGoalValue(GOAL)).toBe(VALUE)

    // Precondition holds → the skill is matched and its option is IN the frontier.
    const matches = matchSkills(elements, extractGoalValue(GOAL))
    expect(matches).toHaveLength(1)
    const match = matches[0]
    expect(match.skill.name).toBe("go_to_url")
    expect(match.value).toBe(VALUE)
    expect(match.element.role).toBe("AXTextField")
    expect(match.element.label).toBe("Address and search bar")

    const labels = ["c1 AXButton Back", ...skillIndex(matches).keys()]
    expect(labels).toContain(goToUrl.option)

    // Choosing it executes the FIXED sub-sequence directly — four actions, one decision.
    const steps = match.skill.steps(match)
    expect(steps.map((s) => s.kind)).toEqual(["click", "key", "type", "key"])
    expect(steps.map((s) => s.label)).toEqual([
      "focus Address and search bar",
      "select all",
      "type url",
      "enter",
    ])
    expect(steps[1]).toMatchObject({ key: "a", modifiers: ["cmd"] })
    expect(steps[2]).toMatchObject({ kind: "type", text: VALUE }) // value drawn from the GOAL
    expect(steps[3]).toMatchObject({ key: "return", modifiers: [] })
  })

  test("(a) the sub-steps fold into ONE trace step with per-step before/after evidence", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const match = matchSkills(observation.elements, VALUE)[0]
    const steps = match.skill.steps(match)

    // Focus + select-all + type change no role/label signature; Enter does.
    const signatures = ["nA", "nA", "nA", "nA", "nB"]
    const evidence = foldSubstepEvidence(modesOf(steps), signatures)
    expect(evidence).toHaveLength(4)
    expect(evidence.map((e) => e.mode)).toEqual(["declared", "key", "type", "key"])
    expect(evidence.map((e) => e.changed)).toEqual([false, false, false, true])
    expect(evidence[3].before).toBe("nA")
    expect(evidence[3].after).toBe("nB")
    expect(goToUrl.succeeded(evidence)).toBe(true)
    expect(goToUrl.succeeded(evidence.slice(0, 3))).toBe(false)
  })

  test("(a) the post-skill observation advances the map (new node, appended path)", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const elements = observation.elements
    const frontier = [...skillIndex(matchSkills(elements, VALUE)).keys()]
    const map0 = advanceMap(GOAL, undefined, elements, frontier)

    const post = [...elements, { role: "AXButton", label: "Loaded", element_token: "s00000067:99" }]
    const map1 = advanceMap(GOAL, map0, post, frontier)
    expect(map1.current).toBe(screenSignature(post))
    expect(map1.current).not.toBe(map0.current)
    expect(map1.start).toBe(map0.start)
    expect(map1.path).toEqual([map0.current, map1.current])
  })

  // hardcode-guard:allow the captured payload + quoted URL are the live inputs under test
  test("(c) an undelivered click sub-step aborts the maneuver, even if a later step changed the screen", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const match = matchSkills(observation.elements, VALUE)[0]
    const steps = match.skill.steps(match)

    // Focus + select-all + type change no role/label signature; Enter does.
    const signatures = ["nA", "nA", "nA", "nA", "nB"]
    // The focus click (step 0) is NOT delivered → the maneuver must abort.
    const undelivered = foldSubstepEvidence(modesOf(steps), signatures, [false, undefined, undefined, undefined])
    expect(undelivered[0].delivered).toBe(false)
    expect(goToUrl.succeeded(undelivered)).toBe(false)

    // When the focus click IS delivered (focus moved), success follows the final change.
    const delivered = foldSubstepEvidence(modesOf(steps), signatures, [true, undefined, undefined, undefined])
    expect(goToUrl.succeeded(delivered)).toBe(true)
  })

  test("(b) no address-bar precondition → the skill is absent from the frontier", () => {
    const noBar = [{ role: "AXButton", label: "Reload", element_token: "s1:1" }]
    expect(matchSkills(noBar, VALUE)).toHaveLength(0)
    // An address bar with no goal value the skill can consume is also absent.
    expect(matchSkills(noBar, undefined)).toHaveLength(0)
  })
})

// GENERALIZATION — the invariant: maneuvers are declared CONTRACT OBJECTS in a
// bounded a-priori registry; the loop interprets the registry; values come from
// the goal; mining FLAGS candidates but never self-promotes. The per-case-feeding
// problem (every new flow handed to the agent as a bespoke instruction) is the
// instance this closes. UNSEEN MANEUVER THE SHAPE COVERS: `drag_to` (press, move,
// release) — same contract object, no loop change.
// hardcode-guard:allow fixture role/label vocabulary is the enumerable input under test
describe("ui-skills — standard library (declared maneuvers)", () => {
  const el = (role: string, label: string, extra: Record<string, unknown> = {}) => ({
    element_token: `s1:${role}:${label}`,
    role,
    label,
    enabled: true,
    ...extra,
  })

  test("type_into: present on a generic text field, absent on the address bar / no field", () => {
    const field = [el("AXTextField", "Full name")]
    expect(typeInto.applies(field, "Alice")).toBe(true)
    const match = matchSkills(field, "Alice").find((m) => m.skill.name === "type_into")
    expect(match).toBeDefined()
    expect(match?.skill.steps(match)).toEqual([
      { kind: "click", label: "focus Full name" },
      { kind: "type", label: "type value", text: "Alice" },
    ])
    // the address bar belongs to go_to_url, not type_into
    expect(typeInto.applies([el("AXTextField", "Address and search bar")], "x")).toBe(false)
    expect(typeInto.applies([], "x")).toBe(false)
    expect(typeInto.applies(field, undefined)).toBe(false)
  })

  test("search_within: present on a search field, absent on the address bar", () => {
    const search = [el("AXSearchField", "Search docs")]
    expect(searchWithin.applies(search, "widgets")).toBe(true)
    const match = matchSkills(search, "widgets").find((m) => m.skill.name === "search_within")
    expect(match).toBeDefined()
    const steps = match!.skill.steps(match!)
    expect(steps.map((s) => s.kind)).toEqual(["click", "type", "key"])
    expect(steps[2]).toMatchObject({ key: "return" })
    expect(searchWithin.applies([el("AXTextField", "Address and search bar")], "x")).toBe(false)
    expect(searchWithin.applies([], "x")).toBe(false)
  })

  test("scroll_to: present on a scroll region when the target is not visible; absent when visible / no region", () => {
    const region = [el("AXScrollArea", ""), el("AXStaticText", "Top of page")]
    expect(scrollTo.applies(region, "Footer")).toBe(true)
    const match = matchSkills(region, "Footer").find((m) => m.skill.name === "scroll_to")
    expect(match).toBeDefined()
    expect(match!.skill.steps(match!).map((s) => s.kind)).toEqual(["scroll", "scroll", "read"])
    // already visible → nothing to scroll to
    expect(scrollTo.applies([...region, el("AXStaticText", "Footer")], "Footer")).toBe(false)
    // no scroll region
    expect(scrollTo.applies([el("AXStaticText", "x")], "Footer")).toBe(false)
  })

  test("switch_window_or_tab: present on a matching tab (Brave frontier); absent when nothing matches", async () => {
    const raw = await Bun.file(CAPTURE).json()
    const observation = decodeObservation(raw)
    if (observation === null) throw new Error("fixture must decode")
    const match = matchSkills(observation.elements, "Following").find((m) => m.skill.name === "switch_window_or_tab")
    expect(match).toBeDefined()
    expect(match!.element.label).toBe("Following")
    expect(match!.skill.steps(match!).map((s) => s.kind)).toEqual(["click"])
    // no control matches a URL token, and there is no window container → absent
    expect(switchWindowOrTab.applies(observation.elements, "https://example.test")).toBe(false)
  })

  test("dismiss_dialog: dismiss control → click; dialog without one → Escape; absent on an ordinary screen", () => {
    const cancel = [el("AXButton", "Cancel")]
    expect(dismissDialog.applies(cancel, undefined)).toBe(true)
    const clickMatch = matchSkills(cancel, undefined).find((m) => m.skill.name === "dismiss_dialog")
    expect(clickMatch).toBeDefined()
    expect(clickMatch!.skill.steps(clickMatch!)).toEqual([{ kind: "click", label: "click Cancel" }])
    // a dialog with no dismiss control → Escape fallback
    const dialog = [el("AXSheet", "Preferences")]
    const escMatch = matchSkills(dialog, undefined).find((m) => m.skill.name === "dismiss_dialog")
    expect(escMatch).toBeDefined()
    expect(escMatch!.skill.steps(escMatch!)).toEqual([{ kind: "key", label: "escape", key: "escape", modifiers: [] }])
    // a value-less maneuver matches with NO goal value
    expect(matchSkills(cancel, undefined).some((m) => m.skill.name === "dismiss_dialog")).toBe(true)
    expect(matchSkills([el("AXButton", "Reload")], undefined)).toHaveLength(0)
  })

  test("read_text: present when the token appears in a label, absent when it does not", () => {
    const screen = [el("AXStaticText", "Order #4821 shipped")]
    expect(readText.applies(screen, "4821")).toBe(true)
    const match = matchSkills(screen, "4821").find((m) => m.skill.name === "read_text")
    expect(match).toBeDefined()
    expect(match!.skill.steps(match!)).toEqual([{ kind: "read", label: "read 4821", match: "4821" }])
    expect(readText.applies(screen, "9999")).toBe(false)
    expect(readText.applies(screen, undefined)).toBe(false)
  })

  test("a read sub-step folds its matched labels into the evidence (readFound)", () => {
    const steps = [{ label: "read 4821", mode: "read" as const }]
    const found = foldSubstepEvidence(steps, ["nA", "nA"], undefined, [["Order #4821 shipped"]])
    expect(found[0].read).toEqual(["Order #4821 shipped"])
    expect(readText.succeeded(found)).toBe(true)
    const missing = foldSubstepEvidence(steps, ["nA", "nA"], undefined, [[]])
    expect(readText.succeeded(missing)).toBe(false)
  })

  test("the registry holds the standard maneuvers as contract objects", () => {
    expect(SKILLS.map((s) => s.name)).toEqual([
      "go_to_url",
      "type_into",
      "search_within",
      "scroll_to",
      "switch_window_or_tab",
      "dismiss_dialog",
      "read_text",
    ])
  })
})

describe("ui-skills — skill mining (promotion candidates only)", () => {
  const step = (action: string, target: string, progressed = true) => ({ action, target, progressed })

  test("(c) repeated delivered focus→type sub-sequences emit a promotion candidate", () => {
    const trace = [
      step("click", "c1 AXTextField Search"),
      step("type", "c1 AXTextField Search"),
      step("click", "c1 AXTextField Search"),
      step("type", "c1 AXTextField Search"),
    ]
    const candidates = mineSequences(trace)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].occurrences).toBe(2)
    expect(candidates[0].sequence).toEqual(["click c1 AXTextField Search", "type c1 AXTextField Search"])
  })

  test("(c) a clean run (no repetition or nothing progressed) emits no candidate", () => {
    expect(mineSequences([step("click", "X"), step("type", "Y")])).toEqual([])
    expect(
      mineSequences([
        step("click", "X", false),
        step("type", "X", false),
        step("click", "X", false),
        step("type", "X", false),
      ]),
    ).toEqual([])
    expect(mineSequences([])).toEqual([])
  })
})
