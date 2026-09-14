// Startup snapshot of injectable keys. Threat F: an agent editing .env.example
// mid-session MUST NOT expand what shell.env injects. The snapshot is frozen at
// plugin init (or explicitly via `refresh`) and never re-read. Keys absent at
// snapshot time are never injected even if later declared.

import { loadKeys } from "./env-loader"

export class Allowlist {
  private keys: ReadonlySet<string>

  private constructor(keys: ReadonlySet<string>) {
    this.keys = keys
  }

  static async snapshot(exampleFile: string): Promise<Allowlist> {
    const keys = (await loadKeys(exampleFile)) ?? new Set<string>()
    return new Allowlist(keys)
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

  /** Only used at explicit re-init boundaries, never from hook handlers. */
  async refresh(exampleFile: string): Promise<void> {
    this.keys = (await loadKeys(exampleFile)) ?? new Set<string>()
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
