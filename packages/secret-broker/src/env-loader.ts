// Parses .env / .env.example sources without ever surfacing values in logs.
// Supports: blank lines, `#` comments, `KEY=value`, `export KEY=value`,
// single/double quoted values (with `\n`/`\t`/`\"`/`\\` escapes in double
// quotes), multi-line double-quoted values (`KEY="a\nb"` spanning physical
// lines), and trailing ` # comment` on unquoted values. Malformed lines are
// collected as key NAMES only (spec §31) — never their contents.

import { readFile } from "node:fs/promises"

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

// A name that can be extracted from a malformed line for a names-only
// diagnostic. `=broken` yields none; `KEY without equals` yields KEY.
const LEADING_NAME = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)/

export type Parsed = {
  readonly values: ReadonlyMap<string, string>
  readonly keys: ReadonlySet<string>
  /** Names (never values) of lines that failed to parse. Empty names omitted. */
  readonly malformed: readonly string[]
}

/** True when `raw` opens a double quote that is not yet closed on this physical
 *  line — the value continues on following lines until a closing quote. */
function isOpenDoubleQuote(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed[0] !== '"' || trimmed.length < 2) return false
  // Complete when the value ends with an unescaped `"`: walk back over the
  // trailing backslashes; an even count means the quote is a real terminator.
  if (trimmed[trimmed.length - 1] !== '"') return true
  let backslashes = 0
  for (let i = trimmed.length - 2; i >= 0 && trimmed[i] === "\\"; i--) backslashes++
  return backslashes % 2 === 1
}

function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const quote = trimmed[0]
    if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
      const inner = trimmed.slice(1, -1)
      if (quote === "'") return inner
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
    }
  }
  const hash = trimmed.indexOf(" #")
  return (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim()
}

export function parse(source: string): Parsed {
  const values = new Map<string, string>()
  const malformed: string[] = []
  const lines = source.split("\n")
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    index++
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const match = ASSIGNMENT.exec(line)
    if (!match) {
      // Malformed: keep the key NAME when one is recoverable, never the value.
      const name = LEADING_NAME.exec(line)?.[1]
      if (name !== undefined) malformed.push(name)
      continue
    }
    const [, key, raw] = match
    if (key === undefined || raw === undefined) continue
    if (isOpenDoubleQuote(raw)) {
      // Multi-line double-quoted value: consume physical lines until the
      // closing quote. The final line may carry trailing content, which is
      // ignored because the value ends at the terminator.
      const parts = [raw]
      while (index < lines.length) {
        const next = lines[index] ?? ""
        index++
        parts.push(next)
        if (next.includes('"')) break
      }
      values.set(key, unquote(parts.join("\n")))
      continue
    }
    values.set(key, unquote(raw))
  }
  return { values, keys: new Set(values.keys()), malformed }
}

/** Returns `undefined` when the file does not exist (never throws on absence). */
export async function load(file: string): Promise<Parsed | undefined> {
  // node:fs/promises (not Bun's file API) so this works in the desktop app's
  // Node sidecar, where the global `Bun` is undefined.
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  return parse(text)
}

/** Keys only — used for allowlist snapshots where values must never escape. */
export async function loadKeys(file: string): Promise<ReadonlySet<string> | undefined> {
  const parsed = await load(file)
  return parsed?.keys
}
