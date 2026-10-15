import { describe, expect, test } from "bun:test"
import path from "path"
import { LABEL_MAX } from "@/jev/controller"
import { advanceMap, decodeObservation, extractGoalValue, screenSignature } from "@/tool/ui-run"
// hardcode-guard:allow the driver's browser tool/status vocabulary is the contract under test
import {
  CLIPBOARD_REPLACED_NOTE,
  browserNeedsSetup,
  clickAttempt,
  clickSignals,
  foldFocusConsumer,
  initialTextDelivery,
  keySequence,
  parsePartialDelivery,
  refindElement,
  remainingSuffix,
  textDeliveryStep,
} from "@/tool/ui-hands"
import {
  SKILLS,
  decodeBrowserBinding,
  dismissDialog,
  foldSubstepEvidence,
  goToUrl,
  goToUrlRoute,
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
// hardcode-guard:allow the quoted URL is the live goal value under test

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
  // hardcode-guard:allow the captured payload's role/label are the live inputs under test
  test("(a) jev is offered go_to_url; its steps are a bind plus a browser/fallback branch", async () => {
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

    const labels = ["c1 AXButton Back", ...skillIndex(matches).keys()]
    expect(labels).toContain(goToUrl.option)

    // ONE decision executes: a bind, then the arm the bind classification picks.
    const steps = match.skill.steps(match)
    expect(steps.map((s) => s.kind)).toEqual(["bind", "branch"])
    const branch = steps[1]
    if (branch.kind !== "branch") throw new Error("expected a branch")
    expect(branch.browser.map((s) => s.kind)).toEqual(["navigate", "verifyUrl"])
    expect(branch.browser[0]).toMatchObject({ kind: "navigate", url: VALUE }) // value from the GOAL
    // hardcode-guard:allow the prepare/rebind route shape is the registry contract under test
    // bind failed → prepare the browser endpoint, re-bind, then retry the browser arm.
    expect(branch.fallback.map((s) => s.kind)).toEqual(["prepare", "bind", "branch"])
    const afterPrepare = branch.fallback[2]
    if (afterPrepare.kind !== "branch") throw new Error("expected a post-prepare branch")
    expect(afterPrepare.browser.map((s) => s.kind)).toEqual(["navigate", "verifyUrl"])
    expect(afterPrepare.browser[0]).toMatchObject({ kind: "navigate", url: VALUE })
    // keystroke route demoted to the LAST resort: the non-browser arm's clipboard-paste route
    // hardcode-guard:allow the fallback route shape is the registry contract under test
    expect(afterPrepare.fallback.map((s) => s.kind)).toEqual([
      "click",
      "clipboard",
      "key",
      "paste",
      "verifyValue",
      "key",
      "verifyScreen",
    ])
    expect(afterPrepare.fallback[1]).toMatchObject({ kind: "clipboard", text: VALUE })
    expect(afterPrepare.fallback[3]).toMatchObject({ kind: "paste", text: VALUE, verify: true })
    expect(afterPrepare.fallback[4]).toMatchObject({ kind: "verifyValue", text: VALUE })
    expect(afterPrepare.fallback[5]).toMatchObject({ key: "return", modifiers: [] })
  })

  test("(a) the route's sub-steps fold into ONE trace step with per-step evidence", () => {
    // The address-bar fallback: focus/clipboard/select/paste/verify change no role-label signature; the verify reads the page.
    // hardcode-guard:allow the route's sub-step labels/modes are the trace inputs under test
    const modes = [
      { label: "focus address bar", mode: "declared" as const },
      { label: "copy url to clipboard", mode: "clipboard" as const },
      { label: "select all", mode: "key" as const },
      { label: "paste url", mode: "paste" as const },
      { label: "verify url value", mode: "read" as const },
      { label: "enter", mode: "key" as const },
      { label: "verify page changed", mode: "read" as const },
    ]
    // hardcode-guard:allow synthetic signatures are the trace inputs under test
    const signatures = ["nA", "nA", "nA", "nA", "nA", "nA", "nA", "nB"]
    const evidence = foldSubstepEvidence(
      modes,
      signatures,
      undefined,
      undefined,
      [undefined, undefined, undefined, undefined, undefined, undefined, true],
      undefined,
      [undefined, undefined, undefined, undefined, true, undefined, undefined],
      [undefined, CLIPBOARD_REPLACED_NOTE, undefined, CLIPBOARD_REPLACED_NOTE, undefined, undefined, undefined],
    )
    expect(evidence).toHaveLength(7)
    expect(evidence.map((e) => e.changed)).toEqual([false, false, false, false, false, false, true])
    expect(evidence[6].before).toBe("nA")
    expect(evidence[6].after).toBe("nB")
    expect(evidence[6].urlChanged).toBe(true)
    // (a) the paste route discloses the clipboard overwrite; the value gate confirms before Return.
    expect(evidence[1].mode).toBe("clipboard")
    expect(evidence[1].note).toBe(CLIPBOARD_REPLACED_NOTE)
    expect(evidence[3].mode).toBe("paste")
    expect(evidence[3].note).toBe(CLIPBOARD_REPLACED_NOTE)
    expect(evidence[4].valueMatched).toBe(true)
    expect(goToUrl.succeeded(evidence)).toBe(true)
    // No verify result yet → not yet a success.
    expect(goToUrl.succeeded(evidence.slice(0, 6))).toBe(false)
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

  test("(a) an undelivered focus click whose consumer type lands is DELIVERED (focus-consumer)", () => {
    const field = { element_token: "t1", role: "AXTextField", label: "Field", actions: ["AXPress"], value: "" }
    const elements = [field]
    const before = clickSignals("nA", field, elements)
    const rung = { mode: "declared" as const, label: "press", args: {} }
    const attempt = clickAttempt(rung, before, before, field) // the click changes no signal
    expect(attempt.delivered).toBe(false)
    expect(attempt.reasons).toEqual([])

    // The consumer (a type on the SAME target) lands: the target's value changes.
    const afterConsumer = clickSignals("nA", field, [{ ...field, value: "typed" }])
    const folded = foldFocusConsumer(attempt, afterConsumer, field)
    expect(folded.delivered).toBe(true)
    expect(folded.reasons).toContain("focus-consumer")
  })

  // hardcode-guard:allow the driver's refusal token is the live error under test
  test("(b) a pixel refusal surfaces as refused-by-policy, not a bare undelivered", () => {
    const target = { element_token: "t1", role: "AXButton", label: "B", actions: ["AXPress"] }
    const before = clickSignals("nA", target, [target])
    const rung = { mode: "pixel" as const, label: "pixel(1,2)", args: {} }
    const attempt = clickAttempt(
      rung,
      before,
      before,
      target,
      "Raw coordinate click blocked: the px path is reserved for canvas/WebGL targets",
    )
    expect(attempt.delivered).toBe(false)
    expect(attempt.reasons).toContain("refused-by-policy")
  })

  // hardcode-guard:allow the driver's browser status vocabulary is the contract under test
  test("(c) a browser-classified bind selects the navigate arm; a non-browser the prepare-rebind arm", () => {
    expect(goToUrlRoute(true, VALUE).map((s) => s.kind)).toEqual(["navigate", "verifyUrl"])
    // hardcode-guard:allow the route's sub-step kinds are the registry contract under test
    expect(goToUrlRoute(false, VALUE).map((s) => s.kind)).toEqual(["prepare", "bind", "branch"])
    const bound = decodeBrowserBinding({
      status: "ok",
      mutation_allowed: true,
      target_id: "t",
      tab_id: "0",
      url: "https://example.test",
      title: "Example",
    })
    expect(bound.browser).toBe(true)
    expect(bound.target_id).toBe("t")
    expect(bound.tab_id).toBe("0")
    expect(decodeBrowserBinding({ status: "error" }).browser).toBe(false)
    expect(decodeBrowserBinding(null).browser).toBe(false)
  })

  test("(c) go_to_url success is the URL/title change, never an intermediate signal", () => {
    const navigated = [
      { label: "bind browser", mode: "bind" as const, before: "nA", after: "nA", changed: false },
      { label: "navigate to url", mode: "navigate" as const, before: "nA", after: "nA", changed: false },
      { label: "verify url changed", mode: "read" as const, before: "nA", after: "nA", changed: false, urlChanged: true },
    ]
    expect(goToUrl.succeeded(navigated)).toBe(true)
    // A screen change with NO url/title change is an intermediate, not success.
    const intermediate = [
      { label: "bind browser", mode: "bind" as const, before: "nA", after: "nA", changed: false },
      { label: "navigate to url", mode: "navigate" as const, before: "nA", after: "nB", changed: true },
      { label: "verify url changed", mode: "read" as const, before: "nA", after: "nB", changed: true },
    ]
    expect(goToUrl.succeeded(intermediate)).toBe(false)
  })

  test("(b) no address-bar precondition → the skill is absent from the frontier", () => {
    const noBar = [{ role: "AXButton", label: "Reload", element_token: "s1:1" }]
    expect(matchSkills(noBar, VALUE)).toHaveLength(0)
    // An address bar with no goal value the skill can consume is also absent.
    expect(matchSkills(noBar, undefined)).toHaveLength(0)
  })
})

// GENERALIZATION — INVARIANT: PREFER ONE ATOMIC INPUT EVENT over N synthesized
// events when the surface accepts it. The address bar takes a clipboard paste
// (clipboard_write then ONE cmd+v) instead of per-character keystrokes; the live
// per-character `type_text` that landed only a prefix of the URL is ONE instance.
// An unseen second surface that accepts a single paste but drops synthesized
// keystrokes (an Electron/WebGL field) takes the SAME atomic-paste route, with the
// bounded per-character type path as a fallback only when the clipboard is unavailable.
// hardcode-guard:allow the per-character key args + route vocabulary are the hand contract under test
describe("ui-skills — atomic-paste address-bar route", () => {
  const win = { pid: 4242, window_id: 7 }

  test("(a) keySequence (the bounded fallback verb) delivers ONE real key press per character", () => {
    const field = { element_token: "t1", role: "AXTextField", label: "Address and search bar" }
    const seq = keySequence("a/b", win, field)
    expect(seq).toHaveLength(3)
    expect(seq.map((args) => args.key)).toEqual(["a", "/", "b"])
    // real key events: every arg carries the key, none carries an inserted `text` value
    expect(seq.every((args) => args.text === undefined && args.pid === win.pid)).toBe(true)
    expect(seq.every((args) => args.element_token === "t1")).toBe(true)
  })

  // hardcode-guard:allow the route's sub-step kinds are the registry contract under test
  test("(a) the address-bar fallback is last-resort and pastes (clipboard → cmd+a → cmd+v → verify → return)", () => {
    const route = goToUrlRoute(false, VALUE)
    // the non-browser arm PREPARES and RE-BINDS before any address-bar entry
    expect(route.map((s) => s.kind)).toEqual(["prepare", "bind", "branch"])
    const branch = route[2]
    if (branch.kind !== "branch") throw new Error("expected a post-prepare branch")
    // re-bind classified as a browser → the SANCTIONED typed navigate, no address-bar entry
    expect(branch.browser.map((s) => s.kind)).toEqual(["navigate", "verifyUrl"])
    // only a still-unclassifiable window reaches the address-bar route
    expect(branch.fallback.map((s) => s.kind)).toEqual([
      "click",
      "clipboard",
      "key",
      "paste",
      "verifyValue",
      "key",
      "verifyScreen",
    ])
    // NO per-character key step: the URL entry is a single paste, and the value gate
    // holds the Return until the destination landed.
    expect(branch.fallback.some((s) => s.kind === "keys")).toBe(false)
    expect(branch.fallback[1]).toMatchObject({ kind: "clipboard", text: VALUE })
    expect(branch.fallback[2]).toMatchObject({ key: "a", modifiers: ["cmd"] })
    expect(branch.fallback[3]).toMatchObject({ kind: "paste", text: VALUE, verify: true })
    expect(branch.fallback[4]).toMatchObject({ kind: "verifyValue", text: VALUE })
  })

  test("(b)/(d) the paste route succeeds only on a real URL change; no navigation is honest failure", () => {
    // hardcode-guard:allow the trace labels/signatures are the folded-evidence inputs under test
    const modes = [
      { label: "focus address bar", mode: "declared" as const },
      { label: "copy url to clipboard", mode: "clipboard" as const },
      { label: "select all", mode: "key" as const },
      { label: "paste url", mode: "paste" as const },
      { label: "verify url value", mode: "read" as const },
      { label: "enter", mode: "key" as const },
      { label: "verify page changed", mode: "read" as const },
    ]
    const sig = (last: string) => ["nA", "nA", "nA", "nA", "nA", "nA", "nA", last]
    const navigated = foldSubstepEvidence(modes, sig("nB"), undefined, undefined, [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ])
    expect(goToUrl.succeeded(navigated)).toBe(true)
    // a delivered paste + Return landing but NO url change → honest failure, never success
    const noNav = foldSubstepEvidence(modes, sig("nA"), undefined, undefined, [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    ])
    expect(goToUrl.succeeded(noNav)).toBe(false)
  })
})

// GENERALIZATION — INVARIANT: prefer the target's TYPED, SANCTIONED API over
// synthesized input sequences. Instances: a raw-coordinate click refused where the
// AX action exists; Chromium's AX-insert-no-submit where the browser tool exists;
// absurd per-character typing where browser_navigate exists. One unseen case: any
// future typed route (a URL-scheme/AppleScript verb) slots in as the browser arm
// and demotes the synthesized fallback identically.
// hardcode-guard:allow the driver browser-tool vocabulary is the route contract under test
describe("go_to_url — prepare → rebind → navigate is the primary route", () => {
  test("(a) a bind failure emits prepare → rebind → navigate (value from the goal)", () => {
    const route = goToUrlRoute(false, VALUE)
    expect(route.map((s) => s.kind)).toEqual(["prepare", "bind", "branch"])
    const branch = route[2]
    if (branch.kind !== "branch") throw new Error("expected a post-prepare branch")
    expect(branch.browser.map((s) => s.kind)).toEqual(["navigate", "verifyUrl"])
    expect(branch.browser[0]).toMatchObject({ kind: "navigate", url: VALUE })
  })

  test("(a) a successful navigate sets urlChanged for the whole route", () => {
    const evidence = [
      { label: "bind browser", mode: "bind" as const, before: "nA", after: "nA", changed: false },
      { label: "prepare browser", mode: "prepare" as const, before: "nA", after: "nA", changed: false },
      { label: "rebind browser", mode: "bind" as const, before: "nA", after: "nA", changed: false },
      { label: "navigate to url", mode: "navigate" as const, before: "nA", after: "nA", changed: false },
      { label: "verify url changed", mode: "read" as const, before: "nA", after: "nA", changed: false, urlChanged: true },
    ]
    expect(goToUrl.succeeded(evidence)).toBe(true)
  })

  test("(a) a failed prepare is honest failure with its evidence, never success", () => {
    // prepare failed → executeSkill stops; the folded evidence still carries the prepare sub-step.
    const evidence = foldSubstepEvidence(
      [
        { label: "bind browser", mode: "bind" as const },
        { label: "prepare browser", mode: "prepare" as const },
      ],
      ["nA", "nA", "nA"],
      undefined,
      undefined,
      [undefined, undefined],
    )
    expect(evidence.map((e) => e.label)).toContain("prepare browser")
    expect(evidence.every((e) => e.changed === false)).toBe(true)
    expect(goToUrl.succeeded(evidence)).toBe(false)
  })
})

// GENERALIZATION — INVARIANTS: partial actuator output is RESUMABLE and must be
// driven to completion; a snapshot-scoped handle must be RE-RESOLVED after any
// call that mints a new snapshot; typed-route unavailability resolves by POLICY
// ANSWER, not retry. Live instances: type_text delivered 6 of 24 chars of a URL
// (then the tab navigated to the 6-char prefix); the address-bar focus click used
// a stale element_token after a bind minted a new snapshot; browser_prepare
// answered browser_requires_setup for a live browser. Unseen cases: a paste that
// truncates resumes the same way; a token churned by an insertion is re-resolved
// by role+label; a second typed route answering "unavailable by policy"
// short-circuits identically.
// hardcode-guard:allow the driver's partial/delivery vocabulary is the contract under test
describe("ui-hands — resumable delivery, fresh handles, policy short-circuit", () => {
  const TEXT = "https://www.linkedin.com" // 24 chars, the live goal value
  const PARTIAL =
    "type_text incomplete: delivered 6 of 24 character(s) via foreground keystrokes (30ms delay); retry only the remaining suffix"

  test("(a) a partial-delivery report resumes the remaining suffix to completion", () => {
    expect(TEXT).toHaveLength(24)
    expect(parsePartialDelivery(PARTIAL)).toEqual({ delivered: 6, total: 24 })
    const first = textDeliveryStep(TEXT, initialTextDelivery(), { ok: false, error: PARTIAL })
    expect(first.confirmed).toBe(6)
    expect(first.rounds).toBe(1)
    expect(first.failure).toBeUndefined()
    // ONLY the remaining suffix is retried
    expect(remainingSuffix(TEXT, first)).toBe(TEXT.slice(6))
    const done = textDeliveryStep(TEXT, first, { ok: true })
    expect(done.confirmed).toBe(24)
    expect(done.rounds).toBe(2)
    expect(done.failure).toBeUndefined()
  })

  test("(a) resumable delivery is BOUNDED — repeated partials fail after the round cap", () => {
    const delivery = [0, 1, 2].reduce(
      (state) =>
        textDeliveryStep(TEXT, state, { ok: false, error: "delivered 1 of 24 character(s); retry the remaining suffix" }),
      initialTextDelivery(),
    )
    expect(delivery.rounds).toBe(3)
    expect(delivery.confirmed).toBe(3)
    expect(delivery.failure).toBeDefined()
  })

  test("(b) a target is re-resolved from the NEWEST observation, never an older token", () => {
    const older = { element_token: "s000000cd:1", role: "AXTextField", label: "Address and search bar" }
    const newest = [{ element_token: "s000000ef:1", role: "AXTextField", label: "Address and search bar" }]
    const resolved = refindElement(older, newest)
    expect(resolved?.element_token).toBe("s000000ef:1")
    expect(resolved?.element_token).not.toBe(older.element_token)
    // a target absent from the newest observation is NOT invented
    expect(refindElement(older, [{ element_token: "x:1", role: "AXButton", label: "Go" }])).toBeUndefined()
  })

  test("(c) a live-browser policy answer short-circuits to the address bar without a second prepare", () => {
    expect(browserNeedsSetup("browser_requires_setup: the window is a live browser with no owned endpoint")).toBe(true)
    expect(browserNeedsSetup("some other error")).toBe(false)
    // the non-browser route holds exactly ONE prepare — it is never retried
    expect(goToUrlRoute(false, VALUE).filter((s) => s.kind === "prepare")).toHaveLength(1)
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
