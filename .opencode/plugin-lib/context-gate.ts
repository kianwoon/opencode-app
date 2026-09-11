import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"

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
  /** Disable LLM summarization of oversize markdown sections (default on). */
  summarizeEnabled: boolean
  /** Sections with more words than this get summarized before entering context. */
  summarizeWordLimit: number
  /** "provider/model" override for the summarizer; defaults to the session's model. */
  summarizerModel: string
  /** A file-read of a withheld guide path pins it for the rest of the session (default on). */
  retrievalPromotion: boolean
}

const DEFAULTS: GateConfig = {
  maxSystemTokens: 24_000,
  sectionWarnTokens: 8_000,
  scopingEnabled: true,
  pinnedPaths: [],
  evictablePaths: [],
  summarizeEnabled: true,
  summarizeWordLimit: 2_000,
  summarizerModel: "",
  retrievalPromotion: true,
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
  // Build the complete new config, then swap the reference atomically —
  // concurrent readers must never observe a half-applied config.
  void (async () => {
    try {
      const next = { ...DEFAULTS }
      for (const p of CONFIG_PATHS()) {
        const raw = await fs.readFile(p, "utf8").catch(() => undefined)
        if (!raw) continue
        const parsed = JSON.parse(raw) as Partial<GateConfig>
        if (typeof parsed.maxSystemTokens === "number") next.maxSystemTokens = parsed.maxSystemTokens
        if (typeof parsed.sectionWarnTokens === "number") next.sectionWarnTokens = parsed.sectionWarnTokens
        if (typeof parsed.scopingEnabled === "boolean") next.scopingEnabled = parsed.scopingEnabled
        if (Array.isArray(parsed.pinnedPaths)) next.pinnedPaths = parsed.pinnedPaths
        if (Array.isArray(parsed.evictablePaths)) next.evictablePaths = parsed.evictablePaths
        if (typeof parsed.summarizeEnabled === "boolean") next.summarizeEnabled = parsed.summarizeEnabled
        if (typeof parsed.summarizeWordLimit === "number") next.summarizeWordLimit = parsed.summarizeWordLimit
        if (typeof parsed.summarizerModel === "string") next.summarizerModel = parsed.summarizerModel
        if (typeof parsed.retrievalPromotion === "boolean") next.retrievalPromotion = parsed.retrievalPromotion
        break
      }
      configCache = next
      precompiledEvictable = next.evictablePaths.map((p) => ({
        path: p,
        re: p ? new RegExp(`(^|[^\\w.-])${escapeRegExp(p)}([^\\w.-]|$)`) : undefined,
      }))
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
      const dir = `${dataRoot()}/opencode`
      const file = `${dir}/context-gate.jsonl`
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
  // Real headers carry the path and nothing else; trailing prose marks a
  // body-text mention ("Instructions from: /abs/path.md for details").
  if (/\s/.test(payload)) return false
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
    // A real header is emitted at column 0 by core's concatenation. Quoted,
    // blockquoted, or list-indented mentions in body text are prose, not
    // boundaries.
    const lineStart = systemBlock.lastIndexOf("\n", (match.index ?? 0) - 1) + 1
    if (/^\s*(>|-|\*|\d+\.)\s/.test(systemBlock.slice(lineStart, match.index ?? 0))) continue
    headers.push({
      path: payload,
      start: match.index ?? 0,
      textStart: (match.index ?? 0) + match[0].length + 1,
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
  "/.config/opencode/agent/brain.md",
  "/.claude/CLAUDE.md",
]

// FIX 4 precompiled evictable regexes (rebuilt when config swaps atomically).
interface PrecompiledEvictable {
  path: string
  re: RegExp | undefined
}
let precompiledEvictable: PrecompiledEvictable[] = []

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

export interface WithheldEntry {
  path: string
  scope: string | undefined
  reason: "no-activity" | "over-budget" | "oversize"
  tokens: number
}

export interface GateDecision {
  kept: Section[]
  dropped: Section[]
  withheld: WithheldEntry[]
  output: string
  tokensBefore: number
  tokensAfter: number
  alarms: { path: string; tokens: number }[]
  deduped: { path: string; keptPath: string }[]
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
  inputSections: Section[],
  activeScopes: Set<string>,
  config: GateConfig,
  pinnedOverride: Set<string> = new Set(),
): GateDecision {
  let sections = inputSections
  const alarms = sections
    .filter((s) => tokensOf(s.text) > config.sectionWarnTokens)
    .map((s) => ({ path: s.path ?? "(prologue)", tokens: tokensOf(s.text) }))
  if (alarms.length > 0) {
    log("bloat-alarm", { sections: alarms })
  }

  // Dedup pass: sections with byte-identical text carry no extra information.
  // Keep the first occurrence, drop later ones and disclose in the footer.
  const deduped: { path: string; keptPath: string }[] = []
  const seenText = new Map<string, string>()
  const unique: Section[] = []
  for (const section of sections) {
    const hash = hashOf(section.text.replace(/\n+$/, ""))
    const keptPath = seenText.get(hash)
    if (keptPath !== undefined) {
      deduped.push({ path: section.path ?? "(prologue)", keptPath })
      continue
    }
    seenText.set(hash, section.path ?? "(prologue)")
    unique.push(section)
  }
  sections = unique

  if (!config.scopingEnabled) {
    const output = joinSections(prologue, sections)
    return { kept: sections, dropped: [], withheld: [], output, tokensBefore: tokensOf(output), tokensAfter: tokensOf(output), alarms, deduped }
  }

  const pinned: Section[] = []
  const scoped: { section: Section; active: boolean }[] = []
  for (const section of sections) {
    const path = section.path ?? ""
    const scope = section.path ? packageScopeOf(section.path) : undefined
    // A previously-retrieved guide (model read the file) is pinned for the
    // rest of the session regardless of scope state.
    if (path && pinnedOverride.has(path)) {
      pinned.push(section)
      continue
    }
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
  // sections lowest-relevance first. Eviction order (deterministic, no LLM):
  //   1. Bigger section (tokens) — largest footprint freed first.
  //   2. Deeper path (more segments = more specific guide = less shared).
  //   3. Path string — final tiebreak so the order is fully deterministic.
  // Pinned sections are never evicted.
  const evictOrder = (a: Section, b: Section) =>
    tokensOf(b.text) - tokensOf(a.text) ||
    (b.path ?? "").split("/").length - (a.path ?? "").split("/").length ||
    (a.path ?? "").localeCompare(b.path ?? "")
  const kept = [...pinned]
  let budget = config.maxSystemTokens - tokensOf(prologue) - pinned.reduce((sum, s) => sum + tokensOf(s.text), 0)
  for (const section of [...keptScoped.map((s) => s.section)].sort(evictOrder)) {
    const t = tokensOf(section.text)
    if (t <= budget) {
      kept.push(section)
      budget -= t
    }
  }

  const overBudget = new Set(keptScoped.filter((s) => !kept.includes(s.section)).map((s) => s.section.path))
  const withheld: WithheldEntry[] = [
    ...droppedScoped.map((s) => ({
      path: s.section.path ?? "(prologue)",
      scope: s.section.path ? packageScopeOf(s.section.path) : undefined,
      reason: "no-activity" as const,
      tokens: tokensOf(s.section.text),
    })),
    ...keptScoped
      .filter((s) => !kept.includes(s.section))
      .map((s) => ({
        path: s.section.path ?? "(prologue)",
        scope: s.section.path ? packageScopeOf(s.section.path) : undefined,
        reason: "over-budget" as const,
        tokens: tokensOf(s.section.text),
      })),
  ].sort((a, b) => a.path.localeCompare(b.path))
  const dropped = [...droppedScoped.map((s) => s.section), ...keptScoped.filter((s) => overBudget.has(s.section.path)).map((s) => s.section)]
  const ordered = sections.filter((s) => kept.includes(s))
  let output = joinSections(prologue, ordered)
  if (withheld.length > 0) {
    // Machine-readable disclosure: one line per withheld guide so the model
    // can read the exact path back with its file tools. Human-readable
    // summary line retained below.
    output += "\nContext gate: withheld guides:"
    for (const w of withheld) {
      output += `\nwithheld: ${w.path} (scope: ${w.scope ?? "none"}, reason: ${w.reason}, tokens: ~${w.tokens})`
    }
    output += "\nContext gate: read a withheld file if you need it — it stays in context for the rest of the session."
  }
  if (deduped.length > 0) {
    const note = deduped.map((d) => `deduped: ${d.path} (= ${d.keptPath})`).join("; ")
    output += `\nContext gate: ${note} — identical content kept once.`
  }

  return {
    kept: ordered,
    dropped,
    withheld,
    output,
    tokensBefore: tokensOf(prologue) + inputSections.reduce((sum, s) => sum + tokensOf(s.text), 0),
    tokensAfter: tokensOf(output),
    alarms,
    deduped,
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
  for (const p of precompiledEvictable) {
    if (p.re?.test(text)) {
      entry.scopes.add(p.path)
    }
  }
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Turn stability caches. system[0] is the provider prompt-cache header block:
// flipping its bytes mid-turn (fallback → LLM summary, or a scope unlock that
// changes kept sections) invalidates the cached prefix for every later chunk —
// a full cache-write of the whole system block on the very next loop step.
// Both caches trade minutes of staleness for byte-stable turns and fail open:
// expiry just means "refresh on next read".
// ---------------------------------------------------------------------------

/** How long a served extractive-fallback variant stays pinned per (session, content). */
const FALLBACK_PIN_MS = 5 * 60_000
/** How long a scope snapshot is reused before live activity is re-read. */
const SCOPE_SNAPSHOT_MS = 90_000

/** (session, summaryCacheKey) → served-as-fallback-at. Content edits produce a new key and adopt fresh summaries immediately. */
export const fallbackPins = new Map<string, Map<string, number>>()
/** session → scope-set snapshot taken at the turn's first transform. */
export const scopeSnapshots = new Map<string, { scopes: Set<string>; at: number }>()

function pinFallback(sessionID: string, key: string) {
  let pins = fallbackPins.get(sessionID)
  if (!pins) {
    if (fallbackPins.size >= MAX_SESSIONS) fallbackPins.delete(fallbackPins.keys().next().value!)
    pins = new Map()
    fallbackPins.set(sessionID, pins)
  }
  pins.set(key, Date.now())
}

function pinnedToFallback(sessionID: string, key: string): boolean {
  const at = fallbackPins.get(sessionID)?.get(key)
  if (at === undefined) return false
  if (Date.now() - at > FALLBACK_PIN_MS) {
    fallbackPins.get(sessionID)!.delete(key)
    return false
  }
  return true
}

/** Snapshot view of activity scopes: new scopes adopted at most once per window. */
function turnScopes(sessionID: string): Set<string> {
  const snap = scopeSnapshots.get(sessionID)
  if (snap && Date.now() - snap.at < SCOPE_SNAPSHOT_MS) return snap.scopes
  const scopes = new Set(activity.get(sessionID)?.scopes)
  if (scopeSnapshots.size >= MAX_SESSIONS) scopeSnapshots.delete(scopeSnapshots.keys().next().value!)
  scopeSnapshots.set(sessionID, { scopes, at: Date.now() })
  return scopes
}

// ---------------------------------------------------------------------------
// Retrieval promotion: paths of withheld guides the model actually read via
// its file tools. A read is a strong relevance signal — the guide is pinned
// (kept regardless of scope activity) for the rest of the session. Paths
// listed here bypass scoping in applyGate (pinnedOverride).
// ---------------------------------------------------------------------------

export const retrievedPaths = new Map<string, Set<string>>()

function recordRetrieval(sessionID: string, path: string) {
  let paths = retrievedPaths.get(sessionID)
  if (!paths) {
    if (retrievedPaths.size >= MAX_SESSIONS) retrievedPaths.delete(retrievedPaths.keys().next().value!)
    paths = new Set()
    retrievedPaths.set(sessionID, paths)
  }
  paths.add(path)
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

function memoKey(sessionID: string, decision: Omit<GateDecision, "output">, sections: Section[], prologue: string, config: GateConfig) {
  const shape = sections
    .map((s) => `${s.path}:${hashOf(s.text)}`)
    .join("|")
  return [
    sessionID,
    Array.from(decision.kept.map((s) => s.path)).join(","),
    decision.tokensBefore,
    hashOf(prologue),
    shape,
    config.maxSystemTokens,
    String(config.scopingEnabled),
    config.pinnedPaths.join(">"),
    config.evictablePaths.join(">"),
  ].join("#")
}

// ---------------------------------------------------------------------------
// Summarization: oversize markdown sections are compressed BEFORE they enter
// context. One LLM call per file version, sha-keyed disk cache, extractive
// fallback so the request path never blocks on a slow or failing model.
// ---------------------------------------------------------------------------

const SUMMARIZE_TIMEOUT_MS = 30_000

export function wordCount(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}

const cacheDir = () => `${dataRoot()}/opencode/context-gate-cache`

/** Cache key binds content AND path: same text at two paths summarizes twice (provenance differs). */
export function summaryCacheKey(path: string, content: string): string {
  return createHash("sha256").update(`${path}\n${content}`).digest("hex")
}

export function isSummarizable(section: Section, config: GateConfig): boolean {
  if (!section.path) return false
  if (!/\.(md|mdx|txt|mdc)\b/i.test(section.path)) return false
  if (!config.summarizeEnabled) return false
  return wordCount(section.text) > config.summarizeWordLimit
}

/**
 * Cheap, deterministic fallback: keep the document skeleton (headings), the
 * opening lines, and bullet lists — the parts instruction files use for
 * imperatives. Never throws.
 */
export function extractiveFallback(text: string): string {
  const words = wordCount(text)
  if (words === 0) return ""
  // Compaction policy: aim for ~50% of the input words. Headings take ≤15% of
  // the target, lead lines ≤25%, and bullets absorb whatever budget remains —
  // sequential budgeting keeps total output ≈ target when bullets are plentiful.
  const target = Math.max(1, Math.floor(words * 0.5))
  const lines = text.split("\n")
  const headings = lines.filter((l) => /^#{1,4}\s+\S/.test(l))
  const bullets = lines.filter((l) => /^\s*([-*+]|\d+\.)\s+\S/.test(l))
  const lead = lines.filter((l) => l.trim().length > 0).slice(0, 12)
  const cap = (items: string[], max: number) => {
    const out: string[] = []
    let used = 0
    for (const item of items) {
      const w = wordCount(item)
      if (used + w > max && out.length > 0) break
      out.push(item)
      used += w
    }
    return { out, used }
  }
  const pickedHeadings = cap(headings, Math.floor(target * 0.15))
  const pickedLead = cap(lead, Math.floor(target * 0.25))
  const bulletBudget = Math.max(0, target - pickedHeadings.used - pickedLead.used)
  const parts = [...pickedHeadings.out, "", ...pickedLead.out, "", ...cap(bullets, bulletBudget).out]
  return parts.join("\n").trim()
}

async function loadCachedSummary(fs: typeof import("node:fs/promises"), key: string): Promise<string | undefined> {
  return fs.readFile(`${cacheDir()}/${key}.md`, "utf8").catch(() => undefined)
}

async function storeSummary(fs: typeof import("node:fs/promises"), key: string, summary: string) {
  const dir = cacheDir()
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${dir}/${key}.${process.pid}.tmp`
  await fs.writeFile(tmp, summary)
  await fs.rename(tmp, `${dir}/${key}.md`).catch(async () => fs.writeFile(`${dir}/${key}.md`, summary))
}

function extractSummaryText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const texts = parts
    .filter((p): p is { type: "text"; text: string } => (p as { type?: string })?.type === "text" && typeof (p as { text?: unknown })?.text === "string")
    .map((p) => p.text.trim())
    .filter(Boolean)
  return texts.length > 0 ? texts.join("\n\n") : undefined
}

/**
 * LLM summary via the gate's own hidden helper session. Returns undefined on
 * any failure (caller falls back to extractive).
 */
async function llmSummarize(
  client: PluginInput["client"],
  model: { providerID: string; modelID: string } | undefined,
  path: string,
  text: string,
): Promise<string | undefined> {
  const created = await client.session.create({ body: { title: `context-gate summary: ${path}` } })
  const session = created.data
  if (!session) return undefined
  const words = wordCount(text)
  const target = Math.max(1, Math.floor(words * 0.5))
  try {
    const response = await client.session.prompt({
      path: { id: session.id },
      body: {
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        system: `You compress instruction guides for an AI coding agent. Preserve every imperative, rule, constraint, command, and file path. Drop examples, prose, and repetition. Output ONLY the compressed guide in markdown, no preamble. Target at most ~${target} words (about half of the original ~${words} words).`,
        parts: [{ type: "text", text: `Summarize this instruction file (${path}):\n\n${text}` }],
      },
    })
    return extractSummaryText(response.data?.parts)
  } catch {
    return undefined
  } finally {
    // The helper session must never outlive its use — delete it on every path.
    await client.session.delete({ path: { id: session.id } }).catch(() => {})
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

interface SummarizeContext {
  client: PluginInput["client"]
  /** Last model seen per session (chat.params); summarizer defaults to it. */
  sessionModel: Map<string, { providerID: string; modelID: string }>
}

const inflight = new Map<string, Promise<string | undefined>>()

/**
 * Replace an oversize section's text with its summary. NEVER blocks the
 * request path: disk cache hit serves instantly; on a miss the extractive
 * fallback is served immediately while the LLM summary (timeout-capped)
 * populates the disk cache in the background — the next request gets the
 * real summary. Concurrent misses share one background flight.
 */
export async function summarizeSection(
  section: Section,
  ctx: SummarizeContext,
  sessionID: string,
  options?: { spawnFlight?: boolean },
): Promise<Section & { cached: boolean; fallback: boolean; spawned: boolean }> {
  const config = loadConfig()
  const path = section.path!
  const key = summaryCacheKey(path, section.text)
  const words = wordCount(section.text)

  const cached = await withTimeout(
    (async () => {
      return loadCachedSummary(fs, key)
    })(),
    5_000,
  )

  // Within the pin window, keep serving the variant the session already saw —
  // even if the LLM summary lands on disk mid-turn — so system[0] stays
  // byte-identical across loop steps. Crucially, a pinned session must NOT
  // respawn a flight for a summary that is already cached (or already
  // in-flight): that was the source of the per-loop-step session storm.
  const pinned = pinnedToFallback(sessionID, key)
  if (cached) {
    if (pinned) {
      log("summarize", { path, words, cached: true, pinned: true, fallback: true })
      return { path, text: provenance(extractiveFallback(section.text), path, words), cached: true, fallback: true, spawned: false }
    }
    log("summarize", { path, words, cached: true, fallback: false })
    return { path, text: provenance(cached, path, words), cached: true, fallback: false, spawned: false }
  }

  // True disk miss: only spawn a new flight when the caller allows it
  // (gateSystem caps this at one per transform) and none is already running.
  let spawned = false
  if (!inflight.has(key) && options?.spawnFlight !== false) {
    spawned = true
    const flight = (async () => {
      const model = resolveSummarizerModel(ctx, sessionID)
      const llm = await withTimeout(llmSummarize(ctx.client, model, path, section.text), SUMMARIZE_TIMEOUT_MS)
      if (!llm) return undefined
      try {
        await storeSummary(fs, key, llm)
      } catch {
        // Cache write is best-effort.
      }
      return llm
    })().catch(() => undefined)
    inflight.set(key, flight)
    // Intentionally not awaited: the miss path returns the extractive
    // fallback right away; the flight only warms the disk cache.
    void flight.finally(() => inflight.delete(key))
  }

  log("summarize", { path, words, cached: false, fallback: true, model: resolveSummarizerModel(ctx, sessionID) })
  pinFallback(sessionID, key)
  return { path, text: provenance(extractiveFallback(section.text), path, words), cached: false, fallback: true, spawned }
}

function resolveSummarizerModel(ctx: SummarizeContext, sessionID: string): { providerID: string; modelID: string } | undefined {
  const override = loadConfig().summarizerModel
  if (override) {
    const slash = override.indexOf("/")
    if (slash > 0) return { providerID: override.slice(0, slash), modelID: override.slice(slash + 1) }
  }
  return ctx.sessionModel.get(sessionID)
}

function provenance(summary: string, path: string, words: number): string {
  return `${summary}\n\n[Summarized from ~${words} words — original: ${path}]`
}



export const ContextGatePlugin: import("@opencode-ai/plugin").Plugin = async (input) => {
  const config = loadConfig()
  // mkdir once at plugin init (log appends and cache writes assume it exists).
  void fs.mkdir(`${dataRoot()}/opencode`, { recursive: true }).catch(() => {})
  // Precompile evictable regexes from the init-time config; rebuilt when the
  // async config swap lands (see loadConfig).
  precompiledEvictable = config.evictablePaths.map((p) => ({
    path: p,
    re: p ? new RegExp(`(^|[^\\w.-])${escapeRegExp(p)}([^\\w.-]|$)`) : undefined,
  }))
  const summarizeCtx: SummarizeContext = { client: input.client, sessionModel: new Map() }

  const hooks: Hooks = {
    // Retrieval hook: when the model reads a withheld guide's file, promote
    // it — the read is recorded as a pinned override so the NEXT gateSystem
    // keeps the guide for the rest of the session. Read-only hook; fail-open.
    "tool.execute.before": async (hookInput) => {
      try {
        if (!loadConfig().retrievalPromotion) return
        if (!hookInput.sessionID) return
        const tool = String((hookInput as { tool?: string }).tool ?? "").toLowerCase()
        if (tool !== "read" && tool !== "cat") return
        const args = (hookInput as { args?: Record<string, unknown> }).args ?? {}
        const path = [args.filePath, args.file_path, args.path].find((v): v is string => typeof v === "string" && v.length > 0)
        if (path) recordRetrieval(hookInput.sessionID, path)
      } catch {
        // Retrieval tracking must never break tool execution.
      }
    },

    "tool.execute.after": async (hookInput, hookOutput) => {
      try {
        const text =
          JSON.stringify(hookInput.args ?? {}).slice(0, 4_000) +
          " " +
          (hookOutput?.title ?? "").slice(0, 4_000) +
          " " +
          String(hookOutput?.output ?? "").slice(0, 2_000)
        recordActivity(hookInput.sessionID, text)
      } catch {
        // Activity tracking must never break tool execution.
      }
    },

    "chat.params": async (hookInput) => {
      try {
        const model = hookInput.model
        if (model?.providerID && model?.id) {
          summarizeCtx.sessionModel.set(hookInput.sessionID, { providerID: model.providerID, modelID: model.id })
          if (summarizeCtx.sessionModel.size > MAX_SESSIONS) {
            summarizeCtx.sessionModel.delete(summarizeCtx.sessionModel.keys().next().value!)
          }
        }
      } catch {
        // Model capture is advisory only.
      }
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      try {
        await gateSystem(hookInput, output, summarizeCtx)
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
  summarizeCtx: SummarizeContext,
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

  // Summarize oversize markdown sections BEFORE policy/budget: a compressed
  // section is cheap to keep, so scoping stops withholding guides it could
  // have kept. Fail-open per section: a summarization failure keeps the
  // original text and the gate proceeds normally.
  const config = loadConfig()
  const expanded: Section[] = []
  // Cap LLM flights at one per transform call: later true-miss sections serve
  // fallback without spawning, so a single loop-step can never fan out into a
  // storm of helper sessions.
  let flightSpawned = false
  for (const section of sections) {
    if (!isSummarizable(section, config)) {
      expanded.push(section)
      continue
    }
    try {
      const result = await summarizeSection(section, summarizeCtx, sessionID, { spawnFlight: !flightSpawned })
      expanded.push(result)
      // Only a call that actually created this flight counts against the
      // per-transform cap (returned flag — no re-probing inflight state).
      if (result.spawned) flightSpawned = true
    } catch (error) {
      log("summarize-error", { sessionID, path: section.path, message: String(error) })
      expanded.push(section)
    }
  }
  sections.splice(0, sections.length, ...expanded)

  const scopes = turnScopes(sessionID)
  const pinned = retrievedPaths.get(sessionID)
  const decision = applyGate(prologue, sections, scopes, config, pinned)

  const key = memoKey(sessionID, decision, sections, prologue, config)
  const cached = memo.get(key)
  if (cached !== undefined) {
    output.system[0] = cached
    return
  }

  output.system[0] = decision.output
  if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value!)
  memo.set(key, decision.output)
  for (const w of decision.withheld) {
    if (retrievedPaths.get(sessionID)?.has(w.path)) log("guide-retrieved", { sessionID, path: w.path })
  }

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
