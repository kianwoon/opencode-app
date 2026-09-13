// File-level protection enforced in `tool.execute.before` (throws to block).
// `permission.ask` is declared in the plugin API but has zero trigger call
// sites, so it cannot enforce anything — this path is the real gate.

import * as path from "path"
import { lstatSync, realpathSync } from "node:fs"

const FILE_TOOLS = new Set(["read", "edit", "write"])

// Files the agent must never read or mutate. `.env.example`/`.env.sample` are
// intentionally readable so the agent can discover required key names.
const EXEMPT = new Set([".env.example", ".env.sample"])

function isProtected(basename: string): boolean {
  // Case-fold so `.ENV` / `ID_RSA` cannot slip past on case-insensitive or
  // case-preserving filesystems.
  const name = basename.toLowerCase()
  if (name === ".env" || name === ".envrc") return true
  if (name.startsWith(".env.")) return !EXEMPT.has(name)
  if (name.endsWith(".pem") || name.endsWith(".key")) return true
  if (name.startsWith("id_rsa") || name.startsWith("id_ed25519")) return true
  return false
}

/** Best-effort realpath so a symlink whose target basename differs from its
 *  link basename (e.g. `readme.txt -> .env`) cannot bypass the check.
 *  Fail-CLOSED: on ELOOP/ENOENT or any realpath error we return undefined and
 *  the caller denies whenever the path looks symlinked or the literal basename
 *  is itself protected. Never throws and never surfaces values. */
function resolvedBasename(filePath: string): string | undefined {
  try {
    return path.basename(realpathSync(filePath))
  } catch {
    return undefined
  }
}

/** True when the path is a symlink that realpath could NOT resolve (broken or
 *  looping link). Its literal basename is then not the real file name, so the
 *  caller must fail CLOSED rather than trust it. */
function isUnresolvedSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink()
  } catch {
    return false
  }
}

export type Denial = { tool: string; filePath: string }

/** Returns a Denial when the tool call must be blocked, otherwise undefined. */
export function check(tool: string, args: unknown): Denial | undefined {
  if (!FILE_TOOLS.has(tool)) return undefined
  // Accept both `filePath` (current read/edit/write schemas) and `path` so a
  // future schema rename cannot silently disable protection.
  const record = args as { filePath?: unknown; path?: unknown } | undefined
  const candidate = record?.filePath ?? record?.path
  const filePath = typeof candidate === "string" ? candidate : undefined
  if (filePath === undefined || filePath.length === 0) return undefined
  const trimmed = filePath.trim()
  const literal = path.basename(trimmed)
  const literalProtected = isProtected(literal)
  if (literalProtected) return { tool, filePath }
  const resolved = resolvedBasename(trimmed)
  // Fail CLOSED: realpath failed (ELOOP/ENOENT/…) on something that is itself a
  // symlink — a broken/looping link named `readme.txt` pointing at the denied
  // set must not slip through on its harmless link name.
  if (resolved === undefined) return isUnresolvedSymlink(trimmed) ? { tool, filePath } : undefined
  // The link resolves to a different real file: if EITHER name is protected, deny.
  if (resolved !== literal && (isProtected(resolved) || literalProtected)) return { tool, filePath }
  return undefined
}

/** Message intentionally omits any file contents. */
export function denialMessage(denial: Denial): string {
  return `Secret Broker blocked ${denial.tool} of protected file "${denial.filePath}". Read .env.example for the required key names instead.`
}
