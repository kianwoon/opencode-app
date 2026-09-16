// Metadata-only audit channel (spec §23). Every entry carries KEY NAMES, paths,
// ids and counts — NEVER a secret value. This is the single place the broker
// writes to stderr, so a reviewer can confirm no value ever reaches it.

import { appendFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/** Structured, value-free audit record. `keys` are variable names, not values. */
export type AuditEvent =
  | { action: "startup"; allowlisted: number; injected: number; missing: readonly string[]; malformed: readonly string[] }
  | { action: "inject"; key: string; pid: number; sessionID?: string; callID?: string }
  | { action: "redact"; key: string; tool: string; sessionID: string; callID: string }
  | { action: "block"; tool: string; filePath: string; sessionID: string; callID: string }

/** Durable audit sink. stderr alone is not captured unless OPENCODE_PRINT_LOGS=1,
 *  so a denial could leave no trace (observed: a threaded run with no
 *  `[secret-broker] block` line anywhere). Append the SAME value-free record to a
 *  file instead. Path is overridable; the default sits under the OS temp dir so
 *  it never depends on the host global-config layout. Best-effort: if the write
 *  fails we still emit to stderr and never throw into the tool path. */
function auditFile(): string {
  return process.env.OPENCODE_SECRET_BROKER_AUDIT_FILE ?? path.join(tmpdir(), "opencode", "secret-broker-audit.log")
}

/** Emits one `[secret-broker] <action> <metadata>` line. The payload is
 *  constructed by the caller from names/ids only — never a secret value. */
export function audit(event: AuditEvent): void {
  console.error(`[secret-broker] ${event.action}`, event)
  try {
    const file = auditFile()
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { mode: 0o600 })
  } catch {
    // Audit is best-effort: stderr already carries the value-free record.
  }
}
