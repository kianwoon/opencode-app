// Parses .env / .env.example sources without ever surfacing values in logs.
// Supports: blank lines, `#` comments, `KEY=value`, `export KEY=value`,
// single/double quoted values (with `\n`/`\t`/`\"`/`\\` escapes in double
// quotes), and trailing ` # comment` on unquoted values.

import { readFile } from "node:fs/promises"

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

export type Parsed = {
  readonly values: ReadonlyMap<string, string>
  readonly keys: ReadonlySet<string>
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
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const match = ASSIGNMENT.exec(line)
    if (!match) continue
    const [, key, raw] = match
    if (key === undefined || raw === undefined) continue
    values.set(key, unquote(raw))
  }
  return { values, keys: new Set(values.keys()) }
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
