// Startup snapshot of injectable keys. Threat F: an agent editing .env.example
// mid-session MUST NOT expand what shell.env injects. The snapshot is frozen at
// plugin init (or explicitly via `refresh`) and never re-read. Keys absent at
// snapshot time are never injected even if later declared.
//
// `refresh` is used by the broker's §25 reload path. To keep Threat F intact it
// accepts an optional `baseline`: the reload may SHRINK or update the key set
// (a key removed from .env.example stops being injected) but can never ADD a key
// that was not present at session start.

import { loadKeys } from "./env-loader.js"

export class Allowlist {
  private keys: ReadonlySet<string>

  private constructor(keys: ReadonlySet<string>) {
    this.keys = keys
  }

  static async snapshot(exampleFile: string, baseline?: ReadonlySet<string>): Promise<Allowlist> {
    const keys = (await loadKeys(exampleFile)) ?? new Set<string>()
    return new Allowlist(baseline === undefined ? keys : intersect(keys, baseline))
  }

  static empty(): Allowlist {
    return new Allowlist(new Set())
  }

  has(key: string): boolean {
    return this.keys.has(key)
  }

  get size(): number {
    return this.keys.size
  }

  /** Frozen key names, sorted. Names only — never values (spec §23). */
  names(): string[] {
    return [...this.keys].sort()
  }

  /** Only used at explicit re-init boundaries, never from hook handlers. When
   *  `baseline` is provided the result can never expand the session key set. */
  async refresh(exampleFile: string, baseline?: ReadonlySet<string>): Promise<void> {
    const keys = (await loadKeys(exampleFile)) ?? new Set<string>()
    this.keys = baseline === undefined ? keys : intersect(keys, baseline)
  }

  /** Filters declared values down to the frozen allowlist. Only length-0 (unset)
   *  values are withheld — a SHORT value is a credential too and is injected, as
   *  the redactor covers it with key-anchored + word-boundary matching. Absent
   *  and empty values are reported as `missing` (never their contents). */
  select(declared: ReadonlyMap<string, string>, minLength = 1): { env: Record<string, string>; missing: string[] } {
    const env: Record<string, string> = {}
    const missing: string[] = []
    for (const key of this.keys) {
      const value = declared.get(key)
      if (value === undefined || value.length < minLength || value.length === 0) missing.push(key)
      else env[key] = value
    }
    return { env, missing }
  }
}

function intersect(keys: ReadonlySet<string>, baseline: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const key of keys) if (baseline.has(key)) out.add(key)
  return out
}
