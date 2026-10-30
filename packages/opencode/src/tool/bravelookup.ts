import { spawn, spawnSync } from "child_process"
import { mkdirSync } from "fs"
import { homedir } from "os"
import path from "path"
import { Effect, Result, Schema } from "effect"
import * as Tool from "./tool"

// Answer extraction is a direct port of Pop's Swift web-lookup extractor
// (~/Downloads/pop/Sources/Pop/WebLookup.swift). The JS below is the SAME
// algorithm, general across query types:
//   wall detection .................. L663-687
//   stopword-filtered content terms .. L689-717
//   echo strip + shared term regex ... L720-741
//   term-density anchor (+/-200 chars) L742-756
//   boundary-aware window ............ L762-912
//   relation test (inflections only) . L913-937
//   region selection ................. L938-960
//   neighbour locate ................. L961-1012
//   price-token detector ............. L1014-1025
//   wall resolution .................. L1104-1110
//   result object .................... L1112-1128
//   modelText + honest provenance .... L78-96, L488-502
// Deliberately omitted: the ASK-RULE slot inference (L1027-1102) — it keys on
// caller-DECLARED parameter slots, and bravelookup declares none (query-only
// parameters), so no page token can ever become a "missing parameter".
const SCRIPT = String.raw`(function () {
  var q = __QUERY__;
  var text = (document.body && document.body.innerText) ? document.body.innerText : "";
  var lower = text.toLowerCase();
  var relationApplied = false, relationPassed = false;

  // --- wall / consent / captcha detection (L663-687) ---
  var walls = ["before you continue", "consent", "unusual traffic", "enable javascript",
    "if you are not redirected", "are you a robot", "verify you are human", "captcha",
    "access denied", "unusual activity", "checking your browser",
    "confirm you're not a robot", "we just need to make sure"];
  var wallHit = false, wall = "";
  for (var i = 0; i < walls.length; i++) {
    var j = lower.indexOf(walls[i]);
    if (j !== -1) {
      wallHit = true;
      wall = text.substring(Math.max(0, j - 40), j + 280).replace(/\s+/g, " ").trim();
      break;
    }
  }

  // --- query content terms (L689-717): interrogatives/auxiliaries/pronouns are
  //     NOT content terms, so an answer is not required to echo the question word.
  var stop = {what:1,whats:1,is:1,the:1,and:1,or:1,to:1,in:1,of:1,for:1,on:1,at:1,
    my:1,me:1,you:1,it:1,this:1,that:1,how:1,when:1,where:1,which:1,are:1,do:1,does:1,
    can:1,could:1,will:1,would:1,a:1,an:1,i:1,s:1,t:1,
    who:1,whom:1,whose:1,why:1,was:1,were:1,been:1,being:1,am:1,should:1,
    must:1,may:1,might:1,has:1,have:1,had:1,shall:1,did:1};
  var terms = [];
  var qparts = q.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, " ").split(" ");
  for (var p = 0; p < qparts.length; p++) {
    var w = qparts[p];
    if (w.length >= 3 && !stop[w] && terms.indexOf(w) === -1) { terms.push(w); }
  }
  relationApplied = terms.length > 0;

  // Collapse whitespace and strip the echoed query (L720-730): a no-results page
  // prints the query back, and that echo must never become "the answer".
  function esc(s) { return s.replace(/[.*+?^${"$"}{}()|[\]\\]/g, "\\$&"); }
  var scan = text.replace(/\s+/g, " ");
  if (q.trim().length >= 4) {
    scan = scan.replace(new RegExp(esc(q.trim()), "gi"), " ");
  }
  scan = scan.replace(/\s+/g, " ").trim();
  var scanLower = scan.toLowerCase();

  // ONE shared term pattern for the density scorer and the relation test (L731-741).
  function termRe(term) {
    return new RegExp("\\b" + esc(term) + "(s|es|ed|ing)?\\b");
  }
  function near(pos, half) {
    var from = Math.max(0, pos - half), to = Math.min(scan.length, pos + half);
    var seg = scanLower.substring(from, to);
    var n = 0;
    for (var i = 0; i < terms.length; i++) {
      if (termRe(terms[i]).test(seg)) { n++; }
    }
    return n;
  }

  // --- term-density anchor (L742-756): the DENSEST region wins, first on a tie ---
  var anchor = -1, bestN = 0;
  for (var t = 0; t < terms.length; t++) {
    var re = new RegExp("\\b" + esc(terms[t]) + "(s|es|ed|ing)?\\b", "g");
    var mm;
    while ((mm = re.exec(scanLower)) !== null) {
      var sc = near(mm.index, 200);
      if (sc > bestN) { bestN = sc; anchor = mm.index; }
      if (mm.index === re.lastIndex) { re.lastIndex++; }
    }
  }
  var noResults = /did not match any documents|no results found|didn't match any|no results containing|make sure all words are spelled/.test(lower);
  var answer = "";
  var answerPrevChar = "", answerNextChar = "";
  var answerLocated = false;
  var sentenceTrimmed = "", wordTrimmed = "";
  if (!noResults && anchor !== -1 && bestN > 0) {
    // --- boundary-aware window (L762-912) ---
    var start = Math.max(0, anchor - 140);
    function isWordChar(ch) { return /[\p{L}\p{N}]/u.test(ch); }
    if (start > 0 && isWordChar(scan.charAt(start - 1))) {
      while (start < scan.length && isWordChar(scan.charAt(start))) { start++; }
    }
    while (start < scan.length && !isWordChar(scan.charAt(start))) { start++; }
    while (start < scan.length && /\s/.test(scan.charAt(start))) { start++; }
    var windowStart = start;
    var window = scan.substring(start, start + 640);
    if (window.length > 600) { window = window.substring(0, 600); }
    // SERP navigation run, detected GENERICALLY (L802-850): N consecutive short
    // bare words carrying no sentence punctuation ("All News Images Maps").
    var NAV_RUN_MIN = 4;
    function navRunLength(s) {
      var lead = /^[^\p{L}\p{N}]+/u.exec(s);
      var body = lead ? s.substring(lead[0].length) : s;
      var toks = body.split(" ");
      var n = 0;
      for (var t2 = 0; t2 < toks.length; t2++) {
        var w2 = toks[t2];
        if (!/^[A-Za-z]{1,7}$/.test(w2)) { break; }
        n++;
      }
      return n;
    }
    var headRun = navRunLength(window);
    if (headRun >= NAV_RUN_MIN) {
      var probe = windowStart;
      while (probe < scan.length && /\s/.test(scan.charAt(probe))) { probe++; }
      while (probe < scan.length && !/[\p{L}\p{N}]/u.test(scan.charAt(probe))) { probe++; }
      for (var c2 = 0; c2 < headRun; c2++) {
        while (probe < scan.length && !/\s/.test(scan.charAt(probe))) { probe++; }
        while (probe < scan.length && /\s/.test(scan.charAt(probe))) { probe++; }
      }
      while (probe < scan.length && !isWordChar(scan.charAt(probe))) { probe++; }
      windowStart = probe;
      window = scan.substring(windowStart, windowStart + 640);
      if (window.length > 600) { window = window.substring(0, 600); }
    }
    var cut = -1;
    for (var e = 0; e < window.length; e++) {
      var ch = window.charAt(e);
      if (ch === "." || ch === "!" || ch === "?" || ch === "\u2026") {
        if (ch === ".") {
          var tk = "";
          for (var b = e - 1; b >= 0 && !/\s/.test(window.charAt(b)); b--) {
            tk = window.charAt(b) + tk;
          }
          if (tk.indexOf(".") !== -1) { continue; }
          if (e + 1 < window.length && !/\s/.test(window.charAt(e + 1))
              && window.charAt(e + 1) !== "!" && window.charAt(e + 1) !== "?"
              && window.charAt(e + 1) !== "\u2026") { continue; }
        }
        cut = e;
      }
    }
    var lastSpace = window.lastIndexOf(" ");
    var wordEnd = lastSpace > 0 ? window.substring(0, lastSpace) : window;
    function endsOnHostFragment(s) {
      var tk2 = s.split(" ").pop() || "";
      tk2 = tk2.replace(/[.\u2026]+$/, "");
      if (tk2.toLowerCase() === "www") { return true; }
      return tk2.indexOf(".") !== -1;
    }
    var boundaryEnd = (cut !== -1 && cut < window.length - 1)
      ? window.substring(0, cut + 1)
      : wordEnd;
    var guard = 0;
    while (endsOnHostFragment(boundaryEnd) && boundaryEnd.length > 0
           && guard++ < 8) {
      var sp = boundaryEnd.lastIndexOf(" ");
      boundaryEnd = sp > 0 ? boundaryEnd.substring(0, sp) : "";
    }
    sentenceTrimmed = boundaryEnd;
    wordTrimmed = boundaryEnd;

    // --- relation test (L913-937): a region counts only if EVERY content term
    //     appears in it, INFLECTIONS ONLY, never an arbitrary suffix. ---
    function termsPresent(cand) {
      if (cand.length === 0) { return false; }
      var candLower = cand.toLowerCase();
      for (var rt = 0; rt < terms.length; rt++) {
        var re2 = new RegExp("\\b" + esc(terms[rt]) + "(s|es|ed|ing)?\\b");
        if (!re2.test(candLower)) { return false; }
      }
      return true;
    }
    if (sentenceTrimmed.length > 0 || wordTrimmed.length > 0) {
      // The relation test belongs to the REGION (the window), not the excerpt
      // (L938-960); a region sharing no content term is a NO-ANSWER.
      var regionOK = terms.length === 0 || termsPresent(window);
      relationPassed = regionOK;
      answer = regionOK ? (sentenceTrimmed.length > 0 ? sentenceTrimmed : wordTrimmed) : "";
      answerLocated = answer.length > 0;
      if (answerLocated) {
        // Robust neighbour locate (L961-1012): exact byte offset first, else a
        // whitespace-normalised forward scan.
        var at = -1;
        if (windowStart >= 0 && windowStart + answer.length <= scan.length
            && scan.substr(windowStart, answer.length) === answer) {
          at = windowStart;
        } else {
          function squeeze(s) { return s.replace(/[\s\u00a0\u3000]+/g, " ").trim(); }
          var target = squeeze(answer);
          var hay = squeeze(scan);
          var found = hay.indexOf(target);
          if (found !== -1 && target.length > 0) {
            var seen = 0, idx = 0;
            while (idx < scan.length && seen < found) {
              if (/[\s\u00a0\u3000]+/.test(scan.charAt(idx))) {
                while (idx < scan.length && /[\s\u00a0\u3000]+/.test(scan.charAt(idx))) { idx++; }
                seen += 1; continue;
              }
              idx++; seen += 1;
            }
            at = idx;
          }
        }
        if (at >= 0 && at < scan.length) {
          answerPrevChar = at > 0 ? scan.charAt(at - 1) : "";
          var after = at + answer.length;
          answerNextChar = after < scan.length ? scan.charAt(after) : "";
        } else {
          answerLocated = false;
        }
      }
    }
  }

  // --- price-like tokens (L1014-1025): what makes a result "listed fares"
  //     rather than "live availability". ---
  var priceRe = /(?:s?\$|sgd|usd|us\$|\u20ac|\u00a3)\s?[0-9][0-9,\.]*/gi;
  var priceSet = {};
  var pm;
  while ((pm = priceRe.exec(text)) !== null) {
    priceSet[pm[0].replace(/\s+/g, "").toUpperCase()] = true;
  }
  var priceKeys = Object.keys(priceSet);
  var priceCount = priceKeys.length;
  var hasPrice = priceCount > 0;
  var priceSample = priceKeys.slice(0, 3).join(", ");

  // WALL RESOLUTION (L1104-1110): a wall STRING on a page that still yields a
  // real answer is chrome, not a wall; only a page with no extractable result
  // is reported as blocked.
  var blocked = wallHit && answer.length === 0;

  var out = {
    blocked: blocked,
    wall: wall,
    domChars: text.length,
    answer: answer,
    answerPrevChar: answerPrevChar,
    answerNextChar: answerNextChar,
    answerLocated: answerLocated,
    relationApplied: relationApplied,
    relationPassed: relationPassed,
    hasPrice: hasPrice,
    priceCount: priceCount,
    priceSample: priceSample,
    title: document.title || ""
  };
  return JSON.stringify(out);
})()`

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Real-time question to answer from a live Google SERP" }),
})

// Shape of the object the extraction script JSON-encodes; kept in lockstep with
// the `out` literal above (WebLookup.swift L1112-1128).
export const Extraction = Schema.Struct({
  blocked: Schema.Boolean,
  wall: Schema.String,
  domChars: Schema.Number,
  answer: Schema.String,
  answerPrevChar: Schema.String,
  answerNextChar: Schema.String,
  answerLocated: Schema.Boolean,
  relationApplied: Schema.Boolean,
  relationPassed: Schema.Boolean,
  hasPrice: Schema.Boolean,
  priceCount: Schema.Number,
  priceSample: Schema.String,
  title: Schema.String,
})

// Portability note: this is the macOS default install path; override with
// OPENCODE_BRAVE_BIN on a non-default install location.
export const braveBinary = (env: NodeJS.ProcessEnv = process.env) =>
  env.OPENCODE_BRAVE_BIN ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
export const SEARCH_BASE = "https://www.google.com/search"
// 9333, NOT Chrome/Electron's default 9222: OpenCode's own Electron app listens on
// 9222, so a bare "/json/version answered 200" probe there describes the WRONG
// browser (live smoke: connectOverCDP attached to OpenCode/1.19.0 Electron and
// timed out). Override with OPENCODE_BRAVE_CDP_PORT.
export const DEFAULT_CDP_PORT = "9333"

export function cdpPort(env: NodeJS.ProcessEnv = process.env) {
  return env.OPENCODE_BRAVE_CDP_PORT ?? DEFAULT_CDP_PORT
}

// Positive Brave identification is impossible via /json/version: Brave hides its
// brand from the User-Agent and reports the same `Browser: "Chrome/..."` product
// string as Electron/Chrome (captured live). The dedicated localhost-only port
// (9333 default) is the primary control; this rejects known foreign debuggers.
export function isBravePayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false
  const record = payload as Record<string, unknown>
  const browser = typeof record["Browser"] === "string" ? record["Browser"].trim() : ""
  if (!browser) return false
  const userAgent = typeof record["User-Agent"] === "string" ? record["User-Agent"] : ""
  const marker = `${userAgent} ${browser}`.toLowerCase()
  return !["electron", "headless", "opencode"].some((foreign) => marker.includes(foreign))
}

export function searchURL(query: string) {
  return `${SEARCH_BASE}?q=${encodeURIComponent(query)}&hl=en`
}

export function extractScript(query: string) {
  return SCRIPT.replace("__QUERY__", JSON.stringify(query))
}

export function sourceHost(url: string) {
  const host = URL.canParse(url) ? new URL(url).host : ""
  return host.replace(/^www\./, "") || "google.com"
}

// host + path, matching Swift's `hostPath` marker (WebLookup.swift:481-486).
export function sourcePath(url: string) {
  const host = sourceHost(url)
  const path = URL.canParse(url) ? new URL(url).pathname : ""
  return host + (path && path !== "/" ? path : "")
}

const cdpAlive = (port: string) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) throw new Error("unreachable")
      if (!isBravePayload(await res.json())) throw new Error("not-brave")
      return true
    },
    catch: () => "unreachable" as const,
  }).pipe(Effect.result, Effect.map(Result.isSuccess))

// Minimal CDP client over Bun's native WebSocket. The previous third-party
// transport (chromium.connectOverCDP, and a direct ws:// through it) times out at
// the ws handshake against Brave (live-verified), while a raw Bun ws speaking CDP
// answers Target.getTargets in 4ms. This speaks only the calls bravelookup needs,
// so the TRANSPORT is live-smoke-verified only — no unit test (see test header).
const browserWsUrl = async (port: string): Promise<string> => {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
  if (!res.ok) throw new Error(`bravelookup: /json/version ${res.status} on ${port}`)
  const body = (await res.json()) as { webSocketDebuggerUrl?: unknown }
  if (typeof body.webSocketDebuggerUrl !== "string") throw new Error("bravelookup: no webSocketDebuggerUrl")
  return body.webSocketDebuggerUrl
}

type CdpReply = { result?: { value?: unknown }; exceptionDetails?: unknown }

// `closeBrowser` is set ONLY by path 3, whose caller created the automation
// instance. `Browser.close` is a browser-LEVEL method sent over THIS ws, which
// speaks to the automation instance's own endpoint — it can never reach the
// user's Brave (which has no port and was not spawned here). It must be sent
// before ws.close() so the frame flushes; the browser drops the socket as it
// exits, so no reply is awaited.
const cdpLookup = async (port: string, query: string, closeBrowser = false): Promise<{ raw: unknown; url: string }> => {
  const ws = new WebSocket(await browserWsUrl(port))
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, (params: unknown) => void>()
  let nextId = 1

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`bravelookup: CDP timed out on ${method}`))
      }, 30_000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
    })

  const once = (method: string) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (listeners.delete(method)) reject(new Error(`bravelookup: CDP timed out waiting for ${method}`))
      }, 30_000)
      listeners.set(method, (params) => {
        clearTimeout(timer)
        resolve(params)
      })
    })

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message?: string }
    }
    const waiter = message.id === undefined ? undefined : pending.get(message.id)
    if (waiter && message.id !== undefined) {
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? "bravelookup: CDP error"))
      else waiter.resolve(message.result)
      return
    }
    const listener = message.method === undefined ? undefined : listeners.get(message.method)
    if (listener && message.method !== undefined) {
      listeners.delete(message.method)
      listener(message.params)
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new Error("bravelookup: CDP websocket error")))
    })
    const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string }
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string }
    await send("Page.enable", {}, sessionId)
    const loaded = once("Page.loadEventFired")
    await send("Page.navigate", { url: searchURL(query) }, sessionId)
    await loaded
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const evaluated = (await send(
      "Runtime.evaluate",
      { expression: extractScript(query), returnByValue: true },
      sessionId,
    )) as CdpReply
    if (evaluated.exceptionDetails !== undefined) throw new Error("bravelookup: extraction script threw")
    const location = (await send(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sessionId,
    )) as CdpReply
    await send("Target.closeTarget", { targetId })
    return { raw: evaluated.result?.value, url: typeof location.result?.value === "string" ? location.result.value : "" }
  } finally {
    if (closeBrowser) ws.send(JSON.stringify({ id: nextId++, method: "Browser.close", params: {} }))
    ws.close()
  }
}

const braveRunning = Effect.sync(
  () => spawnSync("pgrep", ["-f", braveBinary()]).status === 0,
)

const waitForBraveExit = Effect.gen(function* () {
  for (let i = 0; i < 25; i++) {
    if (!(yield* braveRunning)) return
    yield* Effect.sleep("200 millis")
  }
})

// PATH 2 ONLY (launch AND restore). Quit the user's default-profile Brave via
// AppleScript, then relaunch it detached: WITH --remote-debugging-port when
// opening a session, and WITHOUT it (flagless) to restore. This is the ONLY
// place `osascript` may appear, and `execute` calls it ONLY on the branch that
// first proved Brave was NOT running — so the only browser this can quit is the
// one that same branch just launched. The invariant is structural: a session may
// only be terminated by the path that created it, and this helper is that path's
// creator/destructor.
// NOTE: CDP on 127.0.0.1 is UNAUTHENTICATED while active — anyone with local
// access can drive the signed-in profile.
// NOTE: only the URL/path builder is portable; the quit/relaunch path is macOS.
const relaunchBrave = (port: string | undefined) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => spawnSync("osascript", ["-e", 'tell application "Brave Browser" to quit']))
    yield* waitForBraveExit
    yield* Effect.sync(() => {
      // Chromium 111+ rejects the DevTools WebSocket unless the caller's Origin
      // is allow-listed — without this flag connectOverCDP times out at the ws
      // handshake even though /json/version answers. The port is loopback-only
      // and restored (no flag) after the lookup, so "*" is acceptable here.
      // node:child_process, not the Bun global — the desktop server bundles run
      // under NODE, where Bun is undefined.
      spawn(braveBinary(), port ? [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"] : [], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      }).unref()
    })
  })

// PATH 3 automation instance — a SECOND, CONCURRENT Brave on a dedicated profile
// so its windows/cookies/sign-in never mix with the user's. The user's running
// Brave is NEVER touched: this path owns exactly the process it spawns, and its
// teardown is the CDP `Browser.close` above (over the instance's own endpoint) —
// never `osascript`, so it cannot match the user's instance.
export const automationProfileDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.OPENCODE_BRAVE_PROFILE_DIR ?? path.join(homedir(), "Library", "Application Support", "bravelookup", "profile")

const launchAutomationBrave = (port: string, dir: string) =>
  Effect.sync(() => {
    mkdirSync(dir, { recursive: true })
    // --no-first-run / --no-default-browser-check keep the fallback instance from
    // presenting onboarding UI; it is unsigned (fresh profile), the honest cost
    // of not disturbing the user's signed-in session.
    spawn(
      braveBinary(),
      [
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${dir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    ).unref()
  })

const waitForCdp = (port: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 50; i++) {
      if (yield* cdpAlive(port)) return true
      yield* Effect.sleep("200 millis")
    }
    return false
  })


const DESCRIPTION = [
  "Answer a real-time question by loading a Google search results page and extracting the answer text",
  "with a general relevance extractor. Prefers the user's own signed-in Brave — attaching to it when it",
  "already exposes a debug endpoint, or launching it when it is not running. If the user's Brave IS running",
  "without a debug endpoint, it is left untouched: a separate, unsigned Brave instance on a dedicated",
  "profile answers instead. Use for live/current facts — weather, prices, scores, stock quotes, recent",
  "events — that may not be in training data. Returns the top-relevant result text plus honest provenance;",
  "a wall/consent/captcha page is reported as blocked rather than guessed at. Provide the question in",
  "natural language.",
].join(" ")

export const BraveLookupTool = Tool.define(
  "bravelookup",
  Effect.gen(function* () {
    return {
      get description() {
        return DESCRIPTION
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: { query: params.query },
          })

          const port = cdpPort()

          // INVARIANT: a browser session may only be terminated by the code path
          // that created it. The three paths below are each self-contained — a path
          // terminates a browser ONLY if it, and no other path, brought that browser
          // into existence. Consequently `osascript` (which can match the USER's
          // Brave) is reachable ONLY from path 2, the single branch that proved
          // Brave was down before it launched anything.
          //
          // The lookup itself is identical on every path; only readiness and teardown
          // differ, so the shared body is `lookup()` and each path wraps it in exactly
          // the ensuring IT owns. `closeBrowser` is true ONLY for the instance a path
          // created and must end (path 3).
          const lookup = (closeBrowser: boolean) =>
            Effect.gen(function* () {
              if (!(yield* waitForCdp(port)))
                return yield* Effect.die(new Error(`bravelookup: CDP endpoint unavailable on ${port}`))
              // CDP: createTarget → attachToTarget(flatten) → Page.enable → navigate
              // → Page.loadEventFired (not domcontentloaded, so the SERP has fired its
              // subresources, matching WKWebView's didFinish) → Pop's 5s settle
              // (settleDelay, WebLookup.swift:173) → Runtime.evaluate(extractScript).
              const { raw, url } = yield* Effect.promise(() => cdpLookup(port, params.query, closeBrowser))
              const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(Extraction))(raw)

              // modelText contract (WebLookup.swift L78-96) + honest provenance (L488-502):
              // an EMPTY answer is decided first so a wall is never dressed up as a result.
              const provenance = parsed.answer.length
                ? parsed.hasPrice
                  ? `listed fares ("starting from"), not live availability${parsed.priceSample ? ` (${parsed.priceSample})` : ""} — query: "${params.query}"`
                  : `search result text, not verified live — query: "${params.query}"`
                : parsed.blocked
                  ? `a wall page was served, not a result — query: "${params.query}"`
                  : `no extractable result text — query: "${params.query}"`
              const host = sourceHost(url)
              const lines = [
                `web: ${sourcePath(url)} — ${parsed.answer.length} chars`,
                `source: ${host} — "${parsed.title}"`,
                `answer: ${parsed.answer.length ? parsed.answer : "(no extractable answer)"}`,
                `provenance: ${provenance}`,
                ...(parsed.wall ? [`wall: ${parsed.wall}`] : []),
              ]
              yield* ctx.metadata({ title: `BraveLookup: ${params.query}`, metadata: { blocked: parsed.blocked } })

              return {
                output: lines.join("\n"),
                title: `BraveLookup: ${params.query}`,
                metadata: { blocked: parsed.blocked },
              }
            })

          // PATH 1 — an endpoint is already live: the user opted in. We did NOT
          // create this session, so there is no teardown; Brave is left as found.
          if (yield* cdpAlive(port)) return yield* lookup(false)

          // PATH 2 — Brave is NOT running: nothing of the user's is open, so this
          // branch owns the default-profile instance it launches. Its counterpart
          // (flagless relaunch) restores Brave and is safe precisely because Brave
          // was down. relaunchBrave is BOTH the creator and the destructor here.
          if (!(yield* braveRunning)) {
            yield* Effect.logInfo("bravelookup: Brave not running; launching it with remote debugging")
            yield* relaunchBrave(port)
            return yield* lookup(false).pipe(Effect.ensuring(relaunchBrave(undefined)))
          }

          // PATH 3 — the user's Brave IS running but without our port. NEVER quit
          // it. Launch a SECOND, concurrent instance on a dedicated profile; its
          // teardown is the CDP Browser.close over its own endpoint (in cdpLookup),
          // reachable only via this branch. The user's browser is untouched.
          yield* Effect.logInfo("bravelookup: Brave running without CDP; launching a separate automation instance")
          yield* launchAutomationBrave(port, automationProfileDir())
          return yield* lookup(true)
        }).pipe(Effect.orDie),
    }
  }),
)
