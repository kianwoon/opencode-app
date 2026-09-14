// Metadata-only audit channel (spec §23). Every entry carries KEY NAMES, paths,
// ids and counts — NEVER a secret value. This is the single place the broker
// writes to stderr, so a reviewer can confirm no value ever reaches it.

/** Structured, value-free audit record. `keys` are variable names, not values. */
export type AuditEvent =
  | { action: "startup"; allowlisted: number; injected: number; missing: readonly string[]; malformed: readonly string[] }
  | { action: "inject"; key: string; pid: number; sessionID?: string; callID?: string }
  | { action: "redact"; key: string; tool: string; sessionID: string; callID: string }
  | { action: "block"; tool: string; filePath: string; sessionID: string; callID: string }

/** Emits one `[secret-broker] <action> <metadata>` line. The payload is
 *  constructed by the caller from names/ids only — never a secret value. */
export function audit(event: AuditEvent): void {
  console.error(`[secret-broker] ${event.action}`, event)
}
