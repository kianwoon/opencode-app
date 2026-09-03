import type { Hooks } from "@opencode-ai/plugin"

/**
 * Context Gate — a permanent policy engine for fixed context overhead.
 *
 * Root cause it addresses: instruction files (AGENTS.md chains), tool
 * descriptions, and prompt text only ever grow. Point-in-time trimming
 * decays; the gate instead enforces a POLICY on every request:
 *
 *   1. Parse the assembled system block into delimited sections.
 *   2. PIN what must always ride along (global rules, project root rules).
 *   3. SCOPE the rest: package-level guides stay only while the session
 *      shows file activity in their subtree, and only while the system
 *      fits the budget (lowest-priority sections evicted first).
 *   4. Disclose every withholding in a one-line footer so the model can
 *      pull a withheld guide back via its file tools when actually needed.
 *   5. Log decisions to a JSONL file for audit, including a growth alarm
 *      when any single section outgrows a sanity threshold — the "bloat
 *      creeps back" detector.
 *
 * Mechanics (public plugin API only, no core changes):
 * - `tool.execute.after` records file paths the session actually touches
 *   (edit/write/read/bash cwd args, per-session, bounded map).
 * - `experimental.chat.system.transform` splits `system[0]` on the
 *   `Instructions from: <path>` headers, applies the policy above, and
 *   rewrites `system[0]` IN PLACE (never reindexes the array: core treats
 *   `system[0]` as the cache-stable header block).
 * - Decisions are memoized per (session, activity-set, content lengths)
 *   so repeated loop steps within one turn produce byte-identical system
 *   text — provider prompt cache stays warm.
 *
 * What it deliberately does NOT do: touch message history (the
 * context-optimizer plugin owns pruning), touch tool definitions (no
 * per-request hook exists yet), or touch model params (effort-router's
 * job).
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GateConfig {
  /** Token ceiling for the gated system[0] block (chars/4 estimate). */
  maxSystemTokens: number
  /** Warn (log) threshold for any single section. */
  sectionWarnTokens: number
  /** Disable scoping entirely (gate only enforces budget + logging). */
  scopingEnabled: boolean
  /** Extra path substrings treated as pinned. */
  pinnedPaths: string[]
  /**
   * Path substrings that override the pin-by-default rule for sections
   * with no package scope (root guides, remote URLs). Matching sections
   * become evictable: withheld until session activity mentions the path.
   */
  evictablePaths: string[]
}

const DEFAULTS: GateConfig = {
  maxSystemTokens: 24_000,
  sectionWarnTokens: 8_000,
  scopingEnabled: true,
  pinnedPaths: [],
  evictablePaths: [],
}

const CONFIG_PATHS = () => {
  const home = process.env.HOME ?? ""
  return [
    `${process.env.OPENCODE_CONFIG_DIR ?? `${home}/.config/opencode`}/context-gate.json`,
  ]
}

let configCache: GateConfig | undefined

function loadConfig(): GateConfig {
  if (configCache) return configCache
  configCache = { ...DEFAULTS }
  void (async () => {
    try {
      const fs = await import("node:fs/promises")
      for (const p of CONFIG_PATHS()) {
        const raw = await fs.readFile(p, "utf8").catch(() => undefined)
        if (!raw) continue
        const parsed = JSON.parse(raw) as Partial<GateConfig>
        if (typeof parsed.maxSystemTokens === "number") configCache!.maxSystemTokens = parsed.maxSystemTokens
        if (typeof parsed.sectionWarnTokens === "number") configCache!.sectionWarnTokens = parsed.sectionWarnTokens
        if (typeof parsed.scopingEnabled === "boolean") configCache!.scopingEnabled = parsed.scopingEnabled
        if (Array.isArray(parsed.pinnedPaths)) configCache!.pinnedPaths = parsed.pinnedPaths
        if (Array.isArray(parsed.evictablePaths)) configCache!.evictablePaths = parsed.evictablePaths
        break
      }
    } catch {
      // Defaults are fine.
    }
  })()
  return configCache
}

// ---------------------------------------------------------------------------
// Observability (same shape as effort-router: JSONL, best-effort, rotated)
// ---------------------------------------------------------------------------

const dataRoot = () => process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`

const MAX_LOG_BYTES = 4 * 1024 * 1024
const ROTATION_CHECK_EVERY = 500

let appendsSinceCheck = 0

async function rotateIfNeeded(fs: typeof import("node:fs/promises"), file: string) {
  appendsSinceCheck += 1
  if (appendsSinceCheck < ROTATION_CHECK_EVERY) return
  appendsSinceCheck = 0
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat || stat.size < MAX_LOG_BYTES) return
  const raw = await fs.readFile(file, "utf8").catch(() => "")
  const lines = raw.split("\n").filter(Boolean)
  const keep = lines.slice(Math.floor(lines.length / 2))
  if (keep.length === lines.length) return
  await fs.writeFile(file, keep.join("\n") + "\n")
}

function log(event: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: Date.now(), event, ...fields }) + "\n"
  void (async () => {
    try {
      const fs = await import("node:fs/promises")
      const dir = `${dataRoot()}/opencode`
      const file = `${dir}/context-gate.jsonl`
      await fs.mkdir(dir, { recursive: true })
      await fs.appendFile(file, line)
      await rotateIfNeeded(fs, file)
    } catch {
      // Best-effort by design.
    }
  })()
}

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

export interface Section {
  /** Path from the `Instructions from:` header; undefined for the prologue. */
  path?: string
  text: string
}

const HEADER_RE = /^Instructions from: (.+)$/gm

/**
 * A header line is only a real section boundary if its payload looks like a
 * path or URL. Instruction content that QUOTES the header format (docs,
 * examples like "Instructions from: /some/path") must not split a section.
 */
function looksLikeHeaderPath(payload: string): boolean {
  if (/^https?:\/\//.test(payload)) return true
  // Absolute or ~-rooted file path with an extension (instruction files are
  // .md/.mdx/.txt; section content rarely matches this shape at line start).
  return /^(~\/|\/[\w.@+-]+\/)/.test(payload) && /\.(md|mdx|txt|mdc)\b/i.test(payload)
}

/**
 * Split the joined system block into the prologue (everything before the
 * first `Instructions from:` header) and one section per header. Inverse of
 * core's concatenation in instruction.ts (`Instructions from: ${path}\n${content}`).
 */
export function parseSections(systemBlock: string): { prologue: string; sections: Section[] } {
  const headers: { path: string; start: number; textStart: number; end: number }[] = []
  for (const match of systemBlock.matchAll(HEADER_RE)) {
    const payload = match[1]!.trim()
    if (!looksLikeHeaderPath(payload)) continue
    const idx = match.index ?? 0
    headers.push({
      path: payload,
      start: idx,
      textStart: idx + match[0].length + 1,
      end: systemBlock.length,
    })
  }
  for (let i = 0; i < headers.length - 1; i++) headers[i]!.end = headers[i + 1]!.start

  if (headers.length === 0) return { prologue: systemBlock, sections: [] }
  const prologue = systemBlock.slice(0, headers[0]!.start)
  const sections = headers.map((h) => ({
    path: h.path,
    text: systemBlock.slice(h.textStart, h.end),
  }))
  return { prologue, sections }
}

/** Reassemble gated output exactly like core would have concatenated it. */
export function joinSections(prologue: string, sections: Section[]): string {
  const body = sections.map((s) => `Instructions from: ${s.path}\n${s.text.replace(/\n+$/, "")}`).join("\n")
  const sep = prologue && body ? "\n" : ""
  return prologue + sep + body
}

// ---------------------------------------------------------------------------
// Policy: pinning, scoping, budget
// ---------------------------------------------------------------------------

const PINNED_SUFFIXES = [
  "/.config/opencode/AGENTS.md",
  "/.claude/CLAUDE.md",
]

function isPinnedPath(path: string, extra: string[] = [], evictable: string[] = []): boolean {
  if (evictable.some((p) => path.includes(p))) return false
  if (extra.some((p) => path.includes(p))) return true
  if (path.includes(`/.opencode/`)) return true
  if (path.includes(`${process.env.HOME}/.claude/`)) return true
  return PINNED_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

function isEvictablePath(path: string, evictable: string[] = []): boolean {
  return evictable.some((p) => path.includes(p))
}

/** Package directory (e.g. "packages/llm") a path belongs to, if any. */
export function packageScopeOf(path: string): string | undefined {
  const match = path.match(/(^|\/)(packages\/[^/]+)\//)
  return match?.[2]
}

const tokensOf = (text: string) => Math.ceil(text.length / 4)

export interface GateDecision {
  kept: Section[]
  dropped: Section[]
  output: string
  tokensBefore: number
  tokensAfter: number
  alarms: { path: string; tokens: number }[]
}

/**
 * Apply the gate policy to a parsed system block.
 * - Prologue always kept (agent prompt, environment, appended notices).
 * - Sections with no path-derivable scope (root guides) are pinned by
 *   default: dropping project root rules would surprise the user.
 *   `evictablePaths` overrides the pin per path: those sections are kept
 *   only while session activity mentions the path (word-boundary match).
 * - Scoped (package) sections are kept only when active; evicted by
 *   descending token count when the budget is exceeded. Pinned sections
 *   are never evicted — the budget floor is the pinned set.
 */
export function applyGate(
  prologue: string,
  sections: Section[],
  activeScopes: Set<string>,
  config: GateConfig,
): GateDecision {
  const alarms = sections
    .filter((s) => tokensOf(s.text) > config.sectionWarnTokens)
    .map((s) => ({ path: s.path ?? "(prologue)", tokens: tokensOf(s.text) }))
  if (alarms.length > 0) {
    log("bloat-alarm", { sections: alarms })
  }

  if (!config.scopingEnabled) {
    const output = joinSections(prologue, sections)
    return { kept: sections, dropped: [], output, tokensBefore: tokensOf(output), tokensAfter: tokensOf(output), alarms }
  }

  const pinned: Section[] = []
  const scoped: { section: Section; active: boolean }[] = []
  for (const section of sections) {
    const path = section.path ?? ""
    const scope = section.path ? packageScopeOf(section.path) : undefined
    if (scope && !isPinnedPath(path, config.pinnedPaths, config.evictablePaths)) {
      scoped.push({ section, active: activeScopes.has(scope) })
      continue
    }
    if (!scope && isEvictablePath(path, config.evictablePaths)) {
      // Root-level or remote section explicitly marked evictable: keep only
      // while the session's activity mentions its path.
      scoped.push({ section, active: activeScopes.has(path) })
      continue
    }
    pinned.push(section)
  }

  const keptScoped = scoped.filter((s) => s.active)
  const droppedScoped = scoped.filter((s) => !s.active)

  // Budget: if pinned + active sections still exceed the cap, evict active
  // sections largest-first. Pinned sections are never evicted.
  const kept = [...pinned]
  let budget = config.maxSystemTokens - tokensOf(prologue) - pinned.reduce((sum, s) => sum + tokensOf(s.text), 0)
  for (const { section } of [...keptScoped].sort((a, b) => tokensOf(b.section.text) - tokensOf(a.section.text))) {
    const t = tokensOf(section.text)
    if (t <= budget) {
      kept.push(section)
      budget -= t
    }
  }

  const dropped = [...droppedScoped.map((s) => s.section), ...keptScoped.filter((s) => !kept.includes(s.section)).map((s) => s.section)]
  const ordered = sections.filter((s) => kept.includes(s))
  let output = joinSections(prologue, ordered)
  if (dropped.length > 0) {
    const scopes = Array.from(
      new Set(dropped.map((s) => packageScopeOf(s.path ?? "")).filter((v): v is string => v !== undefined)),
    )
    output += `\nContext gate: instruction guides withheld for ${scopes.join(", ")} — read the file if you need them.`
  }

  return {
    kept: ordered,
    dropped,
    output,
    tokensBefore: tokensOf(prologue) + sections.reduce((sum, s) => sum + tokensOf(s.text), 0),
    tokensAfter: tokensOf(output),
    alarms,
  }
}

// ---------------------------------------------------------------------------
// Session activity tracking
// ---------------------------------------------------------------------------

interface SessionActivity {
  scopes: Set<string>
}

const activity = new Map<string, SessionActivity>()
const MAX_SESSIONS = 1_000

const SCOPE_RE = /(packages\/[^/\s"'`)]+)\//g

let evictablePathsCache: string[] | undefined

function recordActivity(sessionID: string, text: string) {
  let entry = activity.get(sessionID)
  if (!entry) {
    if (activity.size >= MAX_SESSIONS) {
      const oldest = activity.keys().next().value
      if (oldest) activity.delete(oldest)
    }
    entry = { scopes: new Set() }
    activity.set(sessionID, entry)
  }
  for (const match of text.matchAll(SCOPE_RE)) {
    entry.scopes.add(match[1]!)
  }
  // Exact-path mentions unlock evictable root/remote sections; word
  // boundaries stop "packages/llm/AGENTS.md" from unlocking
  // "...packages/llm-extra/...". Scanned on args+title+output so e.g. a
  // subagent summary citing a guide path unlocks it.
  for (const p of evictablePathsCache ?? []) {
    if (p && new RegExp(`(^|[^\\w.-])${escapeRegExp(p)}([^\\w.-]|$)`).test(text)) {
      entry.scopes.add(p)
    }
  }
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Memoization: stable output within a turn keeps the provider cache warm.
// Key = session + activity fingerprint + per-section content hash + config.
// Content hash (not length): a same-length AGENTS.md edit must NOT serve
// stale gated text.
// ---------------------------------------------------------------------------

const memo = new Map<string, string>()
const MAX_MEMO = 200

function hashOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function memoKey(sessionID: string, decision: Omit<GateDecision, "output">, sections: Section[], config: GateConfig) {
  const shape = sections
    .map((s) => `${s.path}:${hashOf(s.text)}`)
    .join("|")
  return [
    sessionID,
    Array.from(decision.kept.map((s) => s.path)).join(","),
    decision.tokensBefore,
    shape,
    config.maxSystemTokens,
    String(config.scopingEnabled),
    config.pinnedPaths.join(">"),
    config.evictablePaths.join(">"),
  ].join("#")
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const ContextGatePlugin: import("@opencode-ai/plugin").Plugin = async (input) => {
  const config = loadConfig()
  evictablePathsCache = config.evictablePaths

  const hooks: Hooks = {
    "tool.execute.after": async (hookInput, hookOutput) => {
      try {
        const text =
          JSON.stringify(hookInput.args ?? {}) +
          " " +
          (hookOutput?.title ?? "") +
          " " +
          String(hookOutput?.output ?? "").slice(0, 2_000)
        recordActivity(hookInput.sessionID, text)
      } catch {
        // Activity tracking must never break tool execution.
      }
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      try {
        await gateSystem(hookInput, output)
      } catch (error) {
        // The transform hook runs inside the LLM request: a thrown error
        // here would fail the whole provider call. Gate must fail open.
        log("gate-error", { sessionID: hookInput.sessionID, message: String(error) })
      }
    },
  }

  return hooks
}

async function gateSystem(
  hookInput: Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0],
  output: Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[1],
) {
  const sessionID = hookInput.sessionID
  if (!sessionID || output.system.length === 0) return

  // Gate only the header block (system[0]); later entries are plugin
  // appends and the rule anchor — small, deliberate, and order-sensitive.
  const block = output.system[0]!
  const { prologue, sections } = parseSections(block)
  if (sections.length === 0) {
    // Fail-open signal: if core's header format ever changes, the gate
    // silently no-ops. Oversize here is the only symptom — surface it.
    const oversized = tokensOf(block) > (loadConfig().maxSystemTokens ?? 0)
    if (oversized) log("gate-blind", { sessionID, tokens: tokensOf(block) })
    return
  }

  const config = loadConfig()
  const scopes = activity.get(sessionID)?.scopes ?? new Set<string>()
  const decision = applyGate(prologue, sections, scopes, config)

  const key = memoKey(sessionID, decision, sections, config)
  const cached = memo.get(key)
  if (cached !== undefined) {
    output.system[0] = cached
    return
  }

  output.system[0] = decision.output
  if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value!)
  memo.set(key, decision.output)

  log("gate", {
    sessionID,
    sections: sections.length,
    kept: decision.kept.length,
    dropped: decision.dropped.length,
    tokensBefore: decision.tokensBefore,
    tokensAfter: decision.tokensAfter,
    activeScopes: Array.from(scopes),
  })
}

export * as ContextGate from "./context-gate.ts"

// Default-export the PluginModule shape (server()) so the loader takes the v1
// path. Without it, the legacy fallback treats every exported function in this
// module (parseSections, applyGate, ...) as a plugin instance and crashes.
export default {
  id: "context-gate",
  server: ContextGatePlugin,
}
