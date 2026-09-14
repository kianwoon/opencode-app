// File-level protection enforced in `tool.execute.before` (throws to block).
// `permission.ask` is declared in the plugin API but has zero trigger call
// sites, so it cannot enforce anything — this path is the real gate.

import * as path from "path"
import { lstatSync, realpathSync } from "node:fs"

const FILE_TOOLS = new Set(["read", "edit", "write"])

// Shell tools whose args carry a raw command string. `cat .env` never touches a
// file-tool schema, so the file check below cannot see it — the command string
// must be inspected instead.
const COMMAND_TOOLS = new Set(["bash"])

// Verbs that can lift a file's bytes into stdout/argv. A command is denied only
// when it names BOTH a protected file AND one of these (or redirects FROM a
// file), so ordinary commands that merely mention `.env` in prose still pass.
const EXFIL_VERBS = new Set([
  "cat",
  "tac",
  "less",
  "more",
  "most",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ripgrep",
  "sed",
  "awk",
  "gawk",
  "cut",
  "sort",
  "uniq",
  "tr",
  "strings",
  "xxd",
  "od",
  "hexdump",
  "base64",
  "base32",
  "cp",
  "mv",
  "scp",
  "rsync",
  "tar",
  "zip",
  "dd",
  "install",
  "open",
  "source",
  ".",
  "type",
  "tee",
  "pbcopy",
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "get-content",
  "read",
  "bat",
])

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

// Shell operators that start a new command in a pipeline/list. Splitting on
// them keeps a harmless `cat notes.md` from being disqualified by a protected
// path named in a DIFFERENT segment.
const SEGMENT_SPLIT = /\|\||&&|\||;|&|\n|`|\(|\)|\$\(/

// Redirection markers: `> .env` mutates a protected file even without an exfil
// verb, and `< .env` lifts its bytes into a program's stdin.
const REDIRECT = /^[0-9]*(>>|>|<)$/

// An inline env assignment (`KEY=.env`) hides the path behind `KEY=`, and a
// long option (`--file=.env`) hides it behind the flag.
const ASSIGN_PREFIX = /^-{0,2}[A-Za-z_][A-Za-z0-9_-]*=/

// Quotes/brackets a token can carry from command substitution, grouping or a
// quoted string, plus the `@`-file form (`curl --data @.env`). Stripped before a
// basename check so `.env)`, `".env"` and `@.env` are recognized as `.env`.
const TOKEN_NOISE = /^[`"'(@]+|[`"');,]+$/g

function unquote(token: string): string {
  const trimmed = token.replace(TOKEN_NOISE, "")
  const assigned = trimmed.replace(ASSIGN_PREFIX, "")
  return path.basename(assigned)
}

// Wrappers that sit BEFORE the real command in a segment (`sudo cat .env`).
// Skipped when locating the command token so the verb check still fires.
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "xargs"])

function segmentDenial(segment: string): Denial | undefined {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0)
  const target = tokens.find((token) => isProtected(unquote(token)))
  if (target === undefined) return undefined
  // The reading verb is in COMMAND position (first non-wrapper token); a word
  // like `read` passed as an echo argument must not disqualify the command.
  // Redirects (`< .env`, `> .env`) are denied on their own.
  const command = tokens
    .map((token) => token.replace(TOKEN_NOISE, "").toLowerCase())
    .find((token) => !WRAPPERS.has(token))
  return (command !== undefined && EXFIL_VERBS.has(command)) || tokens.some((token) => REDIRECT.test(token))
    ? { tool: "bash", filePath: target }
    : undefined
}

/** Inspects a shell command string for obvious secret-file exfiltration. Denies
 *  only when a segment names BOTH a protected file and an exfil verb (or
 *  redirects to/from it), so ordinary commands pass untouched. Fail-closed on
 *  match; `.env.example` stays readable. */
function checkCommand(args: unknown): Denial | undefined {
  const record = args as { command?: unknown } | undefined
  const command = typeof record?.command === "string" ? record.command : undefined
  if (command === undefined || command.length === 0) return undefined
  // `#` comments cannot execute, and a protected name in prose is not a read.
  const stripped = command.replace(/(^|\s)#[^\n]*/g, "$1")
  return stripped
    .split(SEGMENT_SPLIT)
    .map(segmentDenial)
    .find((denial) => denial !== undefined)
}

export type Denial = { tool: string; filePath: string }

/** Returns a Denial when the tool call must be blocked, otherwise undefined. */
export function check(tool: string, args: unknown): Denial | undefined {
  if (COMMAND_TOOLS.has(tool)) return checkCommand(args)
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
