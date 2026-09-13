// Auto-creates .env.example from .env when the example is missing. DEFAULT-DENY:
// every value is blanked unless its key matches a small, documented safe-config
// allow-pattern (ports, hosts, log levels, feature toggles). A secret that does
// not look secret by name (DATABASE_URL, MONGO_URI, SENTRY_DSN, WEBHOOK_URL,
// SMTP_URL, …) is therefore blanked by default. Atomic create via the `wx` flag
// so a concurrent run cannot clobber an existing example. Logs counts only.

import { existsSync, writeFileSync } from "node:fs"
import { parse } from "./env-loader"

// Keys safe to document with their real value in .env.example. An EXACT literal
// set (case-insensitive), no wildcards: a name like `FOO_ENABLED` is NOT safe
// by suffix alone — it can carry a toggle-shaped credential. Anything not
// matched is blanked. Anything carrying a credential (URLs with embedded auth,
// DSNs, URIs, webhook endpoints) is NOT safe and must stay blank.
const SAFE_KEYS = new Set([
  "APP_ENV",
  "APP_PORT",
  "PORT",
  "HOST",
  "NODE_ENV",
  "DEBUG",
  "LOG_LEVEL",
  "ENABLED",
  "DISABLED",
])

// Even a safe-named key can carry a secret value. These value SHAPES are always
// blanked: known token prefixes, credential-bearing URLs, and any value too long
// to plausibly be a config scalar.
const SECRET_VALUE = [
  /^(sk|ghp|gho|xox|AKIA)[-_A-Za-z0-9]{8,}/,
  /^postgres(ql)?:\/\//,
  /:\/\/[^/\s]+:[^/\s]+@/,
]
const MAX_SAFE_VALUE_LENGTH = 64

function isSafeValue(value: string): boolean {
  if (value.length > MAX_SAFE_VALUE_LENGTH) return false
  return !SECRET_VALUE.some((pattern) => pattern.test(value))
}

function isSafeKey(key: string, value: string): boolean {
  return SAFE_KEYS.has(key.toUpperCase()) && isSafeValue(value)
}

export type BootstrapResult = {
  readonly created: boolean
  readonly total: number
  readonly redacted: number
}

function render(values: ReadonlyMap<string, string>): { text: string; redacted: number } {
  const lines: string[] = []
  let redacted = 0
  for (const [key, value] of values) {
    if (isSafeKey(key, value)) {
      lines.push(`${key}=${value}`)
    } else {
      lines.push(`${key}=`)
      redacted++
    }
  }
  return { text: lines.join("\n") + (lines.length > 0 ? "\n" : ""), redacted }
}

/** Creates `exampleFile` from `envFile`. No-op when the source is absent, the
 *  example already exists, or there is nothing to copy. Returns counts only —
 *  never secret values. */
export async function bootstrap(envFile: string, exampleFile: string): Promise<BootstrapResult> {
  const none: BootstrapResult = { created: false, total: 0, redacted: 0 }
  const env = Bun.file(envFile)
  if (!(await env.exists())) return none
  if (existsSync(exampleFile)) return none

  const values = parse(await env.text()).values
  if (values.size === 0) return none

  const { text, redacted } = render(values)
  try {
    // "wx" fails if the path appeared concurrently — never clobbers. 0600 keeps
    // the example (which lists key names, not values) owner-only.
    writeFileSync(exampleFile, text, { flag: "wx", mode: 0o600 })
  } catch {
    return none
  }
  return { created: true, total: values.size, redacted }
}
