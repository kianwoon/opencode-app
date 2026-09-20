import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { JEV_EXEMPT_TOOLS, clearJevMemo, jevDecide, jevKeepTools, jevBelowFloor } from "@/jev/client"

// Live `cua-driver list-tools` names, namespaced by the MCP `server_tool` key.
const OBSERVERS = [
  "cua-driver_get_window_state",
  "cua-driver_get_accessibility_tree",
  "cua-driver_get_desktop_state",
  "cua-driver_list_windows",
  "cua-driver_verify_state",
  "cua-driver_zoom",
]
const ACTUATORS = [
  "cua-driver_click",
  "cua-driver_bring_to_front",
  "cua-driver_hotkey",
  "cua-driver_press_key",
  "cua-driver_clipboard_write",
  "cua-driver_type_text",
  "cua-driver_scroll",
  "cua-driver_drag",
  "cua-driver_set_value",
]
// Session lifecycle: `start_session` is the only revive path for a hand whose
// inherited transport session already ended.
const SESSION = [
  "cua-driver_start_session",
  "cua-driver_get_session",
  "cua-driver_list_sessions",
]

/** The endpoint's most hostile answer: every question shaped/really skipped. */
const skipAll = (names: string[]) => ({
  answers: Object.fromEntries(
    names.map((name) => [
      name,
      { type: "choice", choice: "skip", probabilities: { skip: 1, use: 0 }, confidence: 1 },
    ]),
  ),
})

describe("jevBelowFloor — the guard that refuses an over-narrowed turn", () => {
  test("refuses a non-empty fold below the floor", () => {
    // The live regression: 35 tools folded to 2 at threshold 0.7.
    expect(jevBelowFloor(2, 8)).toBe(true)
    expect(jevBelowFloor(7, 8)).toBe(true)
  })

  test("applies a fold that meets the floor", () => {
    expect(jevBelowFloor(8, 8)).toBe(false)
    expect(jevBelowFloor(26, 8)).toBe(false)
  })

  test("leaves an empty fold to the caller's own keep-all fallback", () => {
    // kept === 0 already fails open upstream as `tools_after: 0`; the guard must
    // not claim it or that distinct signal is hidden.
    expect(jevBelowFloor(0, 8)).toBe(false)
  })
})

describe("JEV_EXEMPT_TOOLS — CUA actuators", () => {
  test("every observer and actuator survives a skip-all payload", () => {
    const exempt = [...OBSERVERS, ...ACTUATORS, ...SESSION]
    const names = [...exempt, "bash", "edit"]
    const keep = jevKeepTools(skipAll(names), names, 0.7)
    for (const name of exempt) expect(keep?.has(name)).toBe(true)
    // The exemption must stay narrow: genuinely routable tools still drop.
    expect(keep?.has("bash")).toBe(false)
    expect(keep?.has("edit")).toBe(false)
  })

  test("start_session survives a skip-all payload", () => {
    // Without this, a fresh hand that inherits an ended transport session
    // ("session has ended") is left with no revive path for the whole turn.
    const names = ["cua-driver_start_session", "bash"]
    const keep = jevKeepTools(skipAll(names), names, 0.7)
    expect(keep?.has("cua-driver_start_session")).toBe(true)
  })

  test("actuators survive even when the response omits their answer", () => {
    // Routing is decided once per turn: a truncated echo must not strip the
    // hand of its only input path for the rest of the turn.
    const names = ["read", ...ACTUATORS]
    const keep = jevKeepTools(
      { answers: { read: { type: "choice", choice: "use", probabilities: { use: 0.9 } } } },
      names,
      0.7,
    )
    for (const name of ACTUATORS) expect(keep?.has(name)).toBe(true)
  })

  test("exempt set has no duplicate or un-namespaced entries", () => {
    const list = [...JEV_EXEMPT_TOOLS]
    expect(new Set(list).size).toBe(list.length)
    for (const name of [...ACTUATORS, ...SESSION]) expect(list).toContain(name)
  })
})

describe("jevDecide memo — threshold is part of the key", () => {
  const originalFetch = globalThis.fetch
  let calls = 0

  beforeEach(() => {
    clearJevMemo()
    calls = 0
    // Only option: jevDecide's sole external effect is its transport call, and
    // a memo HIT is observable exactly as "no call happened".
    globalThis.fetch = (async () => {
      calls++
      return new Response(
        JSON.stringify({
          answers: { read: { type: "choice", choice: "skip", probabilities: { skip: 1, use: 0 } } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("changing only the threshold re-evaluates instead of replaying", async () => {
    const state = "identical state text"
    const names = ["read"]
    await jevDecide({ key: "k", state, names, threshold: 0.7, timeoutMs: 1000 })
    expect(calls).toBe(1)
    // Same state + same names, different threshold: a replay here would serve a
    // keep-set folded at 0.7 to a caller asking for 0.01.
    await jevDecide({ key: "k", state, names, threshold: 0.01, timeoutMs: 1000 })
    expect(calls).toBe(2)
    // ...and the 0.01 entry is itself memoized.
    await jevDecide({ key: "k", state, names, threshold: 0.01, timeoutMs: 1000 })
    expect(calls).toBe(2)
  })
})
