// Auto-creates .env.example from .env when the example is missing. DEFAULT-DENY:
// every value is blanked unless its key matches a small, documented safe-config
// allow-pattern (ports, hosts, log levels, feature toggles). A secret that does
// not look secret by name (DATABASE_URL, MONGO_URI, SENTRY_DSN, WEBHOOK_URL,
// SMTP_URL, …) is therefore blanked by default. Atomic create via the `wx` flag
// so a concurrent run cannot clobber an existing example. Logs counts only.

import { existsSync, writeFileSync } from "node:fs"
import { parse } from "./env-loader"

// Keys safe to document with their real value in .env.example. Deliberately
// small and additive-free: anything not matched is blanked. Anything carrying a
// credential (URLs with embedded auth, DSNs, URIs, webhook endpoints) is NOT
// safe and must stay blank.
const SAFE_KEY = /^(APP_ENV|APP_PORT|PORT|HOST|NODE_ENV|DEBUG|LOG_LEVEL|.*_ENABLED|.*_DISABLED)$/i

export type BootstrapResult = {
  readonly created: boolean
  readonly total: number
  readonly redacted: number
}

function render(values: ReadonlyMap<string, string>): { text: string; redacted: number } {
  const lines: string[] = []
  let redacted = 0
  for (const [key, value] of values) {
    if (SAFE_KEY.test(key)) {
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
