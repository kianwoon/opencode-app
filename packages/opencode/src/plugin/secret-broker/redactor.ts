// Exact-value redaction with encoded-variant coverage.
//
// A secret is not only emitted verbatim; a compromised upstream (or a tool that
// echoes a URL, a JSON body, a base64 blob, or a shell-quoted argument) can
// reconstruct it from a deterministic transform. So for each eligible value we
// also redact the transforms a hostile reader would trivially run:
//
//   - plain
//   - encodeURIComponent          (query strings / path segments)
//   - JSON-escaped body           (quotes + backslashes)
//   - shell single-quote escaped  ('\'')
//   - base64 standard + URL-safe, with and without padding
//   - hex (lowercase)
//
// Precision/recall tradeoff: every extra variant is a substring that will be
// rewritten wherever it appears, so recall improves at the cost of precision.
// Base64 amplification is the noisiest channel — a short value maps to a short
// base64 string that could collide with unrelated text — so base64 variants
// shorter than MIN_BASE64_LENGTH are dropped, and any variant shorter than
// `minLength` is dropped. Plain/URL/JSON/shell variants are kept whenever they
// clear `minLength`. Longest-first ordering across ALL variants means a value
// that contains another value's transform is replaced before its substring,
// so no partial rewrite can leave reconstructable residue.

const SCHEME = "secret://project"

/** Placeholder a streaming sink emits in place of a chunk whose redaction threw. */
export const STREAM_WITHHELD =
  "[secret-broker] redaction failed; streamed chunk withheld to avoid leaking secrets."

export type Entry = {
  readonly key: string
  readonly value: string
}

type Variant = {
  readonly value: string
  readonly key: string
}

/** Base64 output below this length is disproportionately likely to collide
 *  with ordinary text, so we skip it (documented precision tradeoff above). */
const MIN_BASE64_LENGTH = 12

function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, `'\\''`)
}

function base64Variants(value: string): string[] {
  const bytes = Buffer.from(value, "utf8")
  const standard = bytes.toString("base64")
  const url = bytes.toString("base64url")
  // Base64 is the noisiest channel: short outputs collide with ordinary text,
  // so drop any base64 variant below MIN_BASE64_LENGTH entirely.
  return [standard, url, standard.replace(/=+$/, ""), url.replace(/=+$/, "")].filter(
    (text) => text.length >= MIN_BASE64_LENGTH,
  )
}

function hexVariants(value: string): string[] {
  // Hex is even lower-entropy per byte than base64 (2 chars/byte, lowercase),
  // so it is dropped below the same collision floor unless it clears `minLength`.
  const hex = Buffer.from(value, "utf8").toString("hex")
  return hex.length >= MIN_BASE64_LENGTH ? [hex] : []
}

function variantsFor(value: string, minLength: number): string[] {
  const candidates = [
    value,
    encodeURIComponent(value),
    jsonEscape(value),
    shellSingleQuote(value),
    ...base64Variants(value),
    ...hexVariants(value),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of candidates) {
    if (candidate.length < minLength || seen.has(candidate)) continue
    seen.add(candidate)
    out.push(candidate)
  }
  return out
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * One combined matcher for every sub-`minLength` value. A bare substring scan is
 * unsafe at that length (`sh0rt7` would rewrite ordinary prose), so a short
 * value is matched ONLY when its context proves it IS that secret:
 *
 *   - an assignment — `KEY=value`, `KEY: value`, `"KEY": "value"`, optionally
 *     `export`ed — where the name is the secret's own key; the assignment keeps
 *     its prefix/quotes and only the value is replaced; or
 *   - a whole word-boundary token (`(?<![\w-])value(?![\w-])`), so a longer word
 *     that merely contains the value is left intact.
 *
 * All entries share ONE regex and one `String.replace` pass, so a handle
 * inserted for one entry is never rescanned and rewritten by another.
 * Encoded variants are intentionally NOT generated for short values: a short
 * base64/hex blob collides with ordinary text far too often to be worth it.
 */
function shortPattern(entries: readonly Entry[]): { pattern: RegExp; entries: readonly Entry[] } | undefined {
  if (entries.length === 0) return undefined
  const alternatives = entries.map((entry, index) => {
    const name = escapeRegExp(entry.key)
    const value = escapeRegExp(entry.value)
    const assignment =
      `(?<pre${index}>(?:export\\s+)?["']?${name}["']?\\s*[=:]\\s*["']?)` +
      `(?<val${index}>${value})` +
      `(?<post${index}>["']?)`
    return `(?:${assignment}|(?<tok${index}>(?<![\\w-])${value}(?![\\w-])))`
  })
  return { pattern: new RegExp(alternatives.join("|"), "g"), entries }
}

/** Callback invoked with a key NAME whenever that key was redacted. Used for
 *  metadata-only audit (spec §23) — never receives a value. */
export type RedactReport = (key: string) => void

function redactShort(
  input: string,
  matcher: { pattern: RegExp; entries: readonly Entry[] },
  report?: RedactReport,
): string {
  return input.replace(matcher.pattern, (...args: unknown[]) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>
    const index = matcher.entries.findIndex(
      (_, i) => groups[`val${i}`] !== undefined || groups[`tok${i}`] !== undefined,
    )
    const entry = matcher.entries[index]
    if (entry === undefined) return String(args[0])
    const replacement = `${SCHEME}/${entry.key}`
    report?.(entry.key)
    return groups[`val${index}`] === undefined
      ? replacement
      : `${groups[`pre${index}`] ?? ""}${replacement}${groups[`post${index}`] ?? ""}`
  })
}

export class Redactor {
  private entries: Variant[]
  private short?: { pattern: RegExp; entries: readonly Entry[] }
  private keys: number
  private readonly retain: number

  constructor(
    entries: Iterable<Entry>,
    private readonly minLength: number = 8,
  ) {
    const byValue = new Map<string, string>()
    const keys = new Set<string>()
    const shorts: Entry[] = []
    let longest = 0
    for (const entry of entries) {
      if (entry.value.length === 0) continue
      keys.add(entry.key)
      // Track the raw length even for short values: a `StreamRedactor` must hold
      // back an incomplete short value so a split `key=sh0rt7` cannot leak.
      if (entry.value.length > longest) longest = entry.value.length
      if (entry.value.length < minLength) {
        shorts.push(entry)
        continue
      }
      for (const value of variantsFor(entry.value, minLength)) {
        if (!byValue.has(value)) byValue.set(value, entry.key)
        if (value.length > longest) longest = value.length
      }
    }
    this.keys = keys.size
    this.entries = [...byValue.entries()]
      .map(([value, key]) => ({ value, key }))
      .sort((a, b) => b.value.length - a.value.length)
    this.short = shortPattern(shorts)
    // Retain one fewer char than the longest variant so a secret straddling a
    // chunk boundary is still whole when its final char arrives.
    this.retain = Math.max(0, longest - 1)
  }

  /** Number of distinct secret values eligible for redaction. */
  get size(): number {
    return this.keys
  }

  /** Raw chars a {@link StreamRedactor} must hold back to avoid a boundary leak. */
  get retainLength(): number {
    return this.retain
  }

  private replacement(key: string): string {
    return `${SCHEME}/${key}`
  }

  redact(input: string, report?: RedactReport): string {
    let out = input
    for (const entry of this.entries) {
      if (!out.includes(entry.value)) continue
      out = out.split(entry.value).join(this.replacement(entry.key))
      report?.(entry.key)
    }
    return this.short === undefined ? out : redactShort(out, this.short, report)
  }

  /** Recursively redacts strings anywhere in the structure; leaves other
   *  primitives untouched. Used for tool output metadata and error payloads. */
  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as unknown as T
    // Error.message is NON-enumerable, so an Object.keys walk misses the very
    // field a leak hides in. Project to a plain object with every text field redacted.
    if (value instanceof Error) {
      return {
        name: this.redact(value.name),
        message: this.redact(value.message),
        stack: typeof value.stack === "string" ? this.redact(value.stack) : undefined,
      } as unknown as T
    }
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as unknown as T
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.redactDeep(item)
      }
      return out as unknown as T
    }
    return value
  }

  /** Like {@link redactDeep} but MUTATES strings in place and preserves object
   *  identity/prototypes — used on model messages, whose parts may be class
   *  instances or error objects that must not be re-hydrated as plain objects. */
  redactInPlace<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as unknown as T
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = this.redactInPlace(value[i])
      return value
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) record[key] = this.redactInPlace(record[key])
      return value
    }
    return value
  }
}

/**
 * Suffix-buffer redactor for incrementally emitted streams. Each push redacts
 * the ENTIRE accumulated buffer and releases all but the last `retain` chars of
 * the redacted text. This is what makes it boundary-safe: redacting the whole
 * buffer replaces every COMPLETE secret, and an INCOMPLETE secret can only be a
 * raw suffix of length < longest, so withholding `retain = longest - 1` chars
 * guarantees no fragment of it is ever released before its final char arrives.
 * Concatenating every `push` result with `flush` reproduces {@link Redactor.redact}
 * of the whole stream without ever exposing a boundary-spanning secret.
 *
 * Fail-closed: if redaction throws, the buffer is dropped and the withheld
 * placeholder is returned instead of any raw chunk.
 */
export class StreamRedactor {
  private buffer = ""

  constructor(private readonly redactor: Redactor) {}

  push(chunk: string): string {
    this.buffer += chunk
    try {
      const redacted = this.redactor.redact(this.buffer)
      const keep = this.redactor.retainLength
      if (redacted.length <= keep) {
        this.buffer = redacted
        return ""
      }
      this.buffer = redacted.slice(redacted.length - keep)
      return redacted.slice(0, redacted.length - keep)
    } catch {
      this.buffer = ""
      return STREAM_WITHHELD
    }
  }

  flush(): string {
    const buffered = this.buffer
    this.buffer = ""
    try {
      return this.redactor.redact(buffered)
    } catch {
      return STREAM_WITHHELD
    }
  }
}
