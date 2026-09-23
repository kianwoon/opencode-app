import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  JEV_EXEMPT_TOOLS,
  JEV_OPENROUTER_ENDPOINT,
  JEV_OPENROUTER_MODEL,
  JEV_DEFAULT_MODEL,
  clearJevMemo,
  jevDecide,
  jevNoulKeep,
  jevScoreRank,
  jevGaugeKeep,
  jevKeepTools,
  jevBelowFloor,
  jevTransport,
  jevModelFor,
  resolveJevModel,
  resolveJevSurface,
} from "@/jev/client"

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
    const names = [...exempt, "bash", "edit", "skill"]
    const keep = jevKeepTools(skipAll(names), names, 0.7)
    for (const name of exempt) expect(keep?.has(name)).toBe(true)
    // Core execution tools are exempt too: the head is session-frozen, so a
    // unanimous skip must not strip them for the rest of the session.
    expect(keep?.has("bash")).toBe(true)
    expect(keep?.has("edit")).toBe(true)
    // The exemption must stay narrow: genuinely routable tools still drop.
    expect(keep?.has("skill")).toBe(false)
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

describe("jevTransport — provider/model spec selects the endpoint", () => {
  test("absent spec defaults to typesafe/jev-latest on SystemOne", () => {
    const t = jevTransport()
    expect(t?.provider).toBe("typesafe")
    expect(t?.id).toBe("jev-latest")
    expect(t?.endpoint).toBe("https://api.typesafe.ai/v1/systemone")
    expect(JEV_DEFAULT_MODEL).toBe("typesafe/jev-latest")
  })

  test("openrouter prefix routes to the OpenRouter decisions endpoint", () => {
    const t = jevTransport("openrouter/anthropic/claude-3.5")
    expect(t?.provider).toBe("openrouter")
    // Model id keeps its own slashes — only the FIRST segment is the provider.
    expect(t?.id).toBe("anthropic/claude-3.5")
    expect(t?.endpoint).toBe(JEV_OPENROUTER_ENDPOINT)
  })

  test("unknown provider or missing model id fails open (undefined)", () => {
    expect(jevTransport("deepseek/deepseek-chat")).toBeUndefined()
    expect(jevTransport("typesafe")).toBeUndefined()
    expect(jevTransport("/jev-latest")).toBeUndefined()
  })

  test("typesafe alias jev-1.13 normalizes to the wire-accepted jev-latest", () => {
    // The live regression: config `typesafe/jev-1.13` was POSTed verbatim and
    // rejected with HTTP 400 ⇒ fail-open no-decision:http on every turn.
    expect(jevTransport("typesafe/jev-1.13")?.id).toBe("jev-latest")
  })

  test("canonical jev-1.13.0 is passed through unchanged", () => {
    expect(jevTransport("typesafe/jev-1.13.0")?.id).toBe("jev-1.13.0")
  })

  test("an unknown typesafe id degrades to jev-latest (never a 400)", () => {
    expect(jevTransport("typesafe/jev-nonsense")?.id).toBe("jev-latest")
  })

  test("openrouter ids are never normalized", () => {
    expect(jevTransport("openrouter/typesafe/jev-1.13")?.id).toBe("typesafe/jev-1.13")
  })

  test("an unknown provider makes jevDecide abstain WITHOUT a request", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    clearJevMemo()
    const decision = await jevDecide({
      key: "k",
      state: "s",
      names: ["read"],
      threshold: 0.7,
      timeoutMs: 100,
      model: "deepseek/deepseek-chat",
    })
    globalThis.fetch = originalFetch
    expect(calls).toBe(0)
    expect(decision.keep).toBeUndefined()
    expect(decision.failure).toBe("parse")
  })
})

describe("jevGaugeKeep — drop-only governor fold", () => {
  const row = (choice: string, strength: number) => ({ type: "choice", choice, probabilities: { [choice]: strength } })

  test("drops only an explicit, measured `drop` above threshold", () => {
    const keep = jevGaugeKeep(
      { s0: row("keep", 0.9), s1: row("drop", 0.95), s2: row("drop", 0.4), s3: row("keep", 0.8) },
      ["s0", "s1", "s2", "s3"],
      0.7,
    )
    expect([...(keep ?? [])]).toEqual(["s0", "s2", "s3"])
  })

  test("a missing probabilities map keeps the section (never gates on `confidence`)", () => {
    // The routing lesson: `confidence` is confidence in the LABEL. A row with a
    // confident drop label but no `probabilities[drop]` must NOT drop.
    const keep = jevGaugeKeep({ s0: { type: "choice", choice: "drop", confidence: 0.99 } }, ["s0"], 0.7)
    expect(keep?.has("s0")).toBe(true)
  })

  test("a drop measured below the confidence floor keeps the section", () => {
    // threshold 0 but floor 0.3: a 0.1 drop is not trusted → fail open keep.
    const keep = jevGaugeKeep({ s0: row("drop", 0.1) }, ["s0"], 0, 0.3)
    expect(keep?.has("s0")).toBe(true)
  })

  test("an empty/unusable payload fails open (undefined ⇒ keep all)", () => {
    expect(jevGaugeKeep({}, ["s0"], 0.7)).toBeUndefined()
    expect(jevGaugeKeep(undefined, ["s0"], 0.7)).toBeUndefined()
  })
})

describe("resolveJevModel — default-provider silent-disable fallback", () => {
  const keyMap = (keys: Record<string, string>) => (provider: string) => keys[provider]

  test("default typesafe spec + no typesafe key + openrouter key ⇒ OpenRouter fallback", () => {
    const r = resolveJevModel(undefined, keyMap({ openrouter: "or" }))
    expect(r.spec).toBe(JEV_OPENROUTER_MODEL)
    expect(r.fallback).toBe(true)
    expect(jevTransport(r.spec)?.endpoint).toBe(JEV_OPENROUTER_ENDPOINT)
  })

  test("default typesafe spec + typesafe key ⇒ configured spec stands (no fallback)", () => {
    const r = resolveJevModel(undefined, keyMap({ typesafe: "ts", openrouter: "or" }))
    expect(r.spec).toBe(JEV_DEFAULT_MODEL)
    expect(r.fallback).toBe(false)
  })

  test("explicit openrouter spec is never redirected", () => {
    const r = resolveJevModel("openrouter/anthropic/claude-3.5", keyMap({ typesafe: "ts", openrouter: "or" }))
    expect(r.spec).toBe("openrouter/anthropic/claude-3.5")
    expect(r.fallback).toBe(false)
  })

  test("unset everything stays fail-open off (no key, no fallback)", () => {
    const r = resolveJevModel(undefined, keyMap({}))
    expect(r.spec).toBe(JEV_DEFAULT_MODEL)
    expect(r.fallback).toBe(false)
  })
})

describe("jevModelFor — feature model ⇒ shared default ⇒ built-in", () => {
  test("feature model wins when set", () => {
    expect(jevModelFor("openrouter/foo", "typesafe/bar")).toBe("openrouter/foo")
  })

  test("shared default applies when feature model is unset", () => {
    expect(jevModelFor(undefined, "openrouter/bar")).toBe("openrouter/bar")
  })

  test("built-in default when both are unset", () => {
    expect(jevModelFor(undefined, undefined)).toBe(JEV_DEFAULT_MODEL)
  })

  test("empty/whitespace strings fall through to the default", () => {
    expect(jevModelFor("", "openrouter/bar")).toBe("openrouter/bar")
    expect(jevModelFor("   ", "typesafe/bar")).toBe("typesafe/bar")
    expect(jevModelFor("", "")).toBe(JEV_DEFAULT_MODEL)
  })
})

describe("resolveJevSurface — one precedence point for jev / governor / brainBooster", () => {
  const fallback = { threshold: 0.7, timeoutMs: 3000 }

  test("enabled is true only for a literal true", () => {
    // An absent block means OFF (documented design); only a literal true enables.
    expect(resolveJevSurface({ enabled: true }, undefined, fallback).enabled).toBe(true)
    expect(resolveJevSurface({ enabled: false }, undefined, fallback).enabled).toBe(false)
    expect(resolveJevSurface({}, undefined, fallback).enabled).toBe(false)
  })

  test("an absent surface is disabled", () => {
    expect(resolveJevSurface(undefined, undefined, fallback).enabled).toBe(false)
  })

  test("model: the surface model wins over the shared default", () => {
    expect(resolveJevSurface({ model: "openrouter/foo" }, "typesafe/bar", fallback).model).toBe("openrouter/foo")
  })

  test("model: the shared default applies when the surface model is absent", () => {
    expect(resolveJevSurface({}, "typesafe/bar", fallback).model).toBe("typesafe/bar")
  })

  test("model: an empty-string surface model falls through to the shared default", () => {
    // Empty string is absent, not a value.
    expect(resolveJevSurface({ model: "" }, "typesafe/bar", fallback).model).toBe("typesafe/bar")
  })

  test("model: both absent stay undefined so jevModelFor supplies the built-in", () => {
    expect(resolveJevSurface({}, undefined, fallback).model).toBeUndefined()
  })

  test("threshold: a number wins, a non-number falls through", () => {
    expect(resolveJevSurface({ threshold: 0.2 }, undefined, fallback).threshold).toBe(0.2)
    expect(resolveJevSurface({ threshold: undefined }, undefined, fallback).threshold).toBe(0.7)
  })

  test("timeoutMs: a number wins, a non-number falls through", () => {
    expect(resolveJevSurface({ timeoutMs: 50 }, undefined, fallback).timeoutMs).toBe(50)
    expect(resolveJevSurface({ timeoutMs: undefined }, undefined, fallback).timeoutMs).toBe(3000)
  })

  test("an absent surface resolves to the fallback defaults, disabled", () => {
    expect(resolveJevSurface(undefined, undefined, fallback)).toEqual({
      enabled: false,
      model: undefined,
      threshold: 0.7,
      timeoutMs: 3000,
    })
  })
})

describe("jevNoulKeep — numeric-only, fail-open prefilter", () => {
  test("keeps a numeric noul at or above the threshold", () => {
    expect(jevNoulKeep(0.7)).toBe(true)
    expect(jevNoulKeep({ noul: 0.95 })).toBe(true)
  })

  test("drops a numeric noul below the threshold", () => {
    expect(jevNoulKeep(0.2)).toBe(false)
    expect(jevNoulKeep({ noul: 0.1 })).toBe(false)
  })

  test("fails open on missing/non-numeric noul", () => {
    expect(jevNoulKeep(undefined)).toBe(true)
    expect(jevNoulKeep({})).toBe(true)
    expect(jevNoulKeep({ noul: "high" })).toBe(true)
  })

  test("ignores a boolean noul (spec is numeric-only)", () => {
    expect(jevNoulKeep({ noul: false })).toBe(true)
    expect(jevNoulKeep(true)).toBe(true)
  })

  test("ignores a truthy boolean noul in a row", () => {
    expect(jevNoulKeep({ noul: true })).toBe(true)
  })
})

describe("jevScoreRank — numeric score or undefined", () => {
  test("returns a finite numeric score", () => {
    expect(jevScoreRank(0.42)).toBe(0.42)
    expect(jevScoreRank({ score: 0.9 })).toBe(0.9)
  })

  test("returns undefined for a missing/non-numeric score", () => {
    expect(jevScoreRank(undefined)).toBeUndefined()
    expect(jevScoreRank({})).toBeUndefined()
    expect(jevScoreRank({ score: "0.9" })).toBeUndefined()
    expect(jevScoreRank(Number.NaN)).toBeUndefined()
  })
})
