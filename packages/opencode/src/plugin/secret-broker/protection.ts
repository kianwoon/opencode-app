// File-level protection enforced in `tool.execute.before` (throws to block).
// `permission.ask` is declared in the plugin API but has zero trigger call
// sites, so it cannot enforce anything — this path is the real gate.
//
// Residual risk (documented, spec §17): this denies plaintext reads of a
// protected FILE. It cannot stop a program that already holds a secret from
// encoding it as hex/base64 and writing it out, nor from sending it over the
// network. Those are sandbox/egress concerns, out of scope for the broker.

import * as path from "path"
import { lstatSync, realpathSync } from "node:fs"

const FILE_TOOLS = new Set(["read", "edit", "write"])

// Shell tools whose args carry a raw command string. `cat .env` never touches a
// file-tool schema, so the file check below cannot see it — the command string
// must be inspected instead.
const COMMAND_TOOLS = new Set(["bash"])

// Code/script execution tools whose payload does NOT live under `command`, so
// the bash scanner above never saw it (spec §11.2, §16). MCP tools are keyed
// `<server>_<tool>` with the server name sanitized but `-` preserved
// (mcp/catalog.ts), and the built-in code-mode tool id is `execute`. This is
// the live shell-exec bypass: `context-mode_execute` ran arbitrary code that
// read `.env` while `check` returned undefined.
const CODE_EXEC_TOOLS = new Set(["execute", "context-mode_execute", "context-mode_batch_execute"])

// Verbs/interpreters that can lift a file's bytes into stdout/argv. A command
// is denied only when it names BOTH a protected file AND one of these (or
// redirects FROM a file), so ordinary commands that merely mention `.env` in
// prose still pass. Language interpreters are included because
// `python -c 'print(open(".env").read())'` reads the file without any shell
// verb; `tar`/`zip`/`unzip` repackage it.
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
  "unzip",
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
  // Interpreters (spec §16): can read a protected file from inside the process.
  "python",
  "python3",
  "node",
  "nodejs",
  "bun",
  "ruby",
  "perl",
  "php",
])

// Code-API identifiers that, together with a protected-file reference inside a
// CODE_EXEC_TOOLS payload, mark an exfiltration attempt: file-read helpers and
// network/spawn sinks (the incident: read `.env`, loop its keys, `curl` them to
// an external host). Matched as whole case-folded identifier tokens so prose
// like `"set API_KEY in .env"` is not disqualified. `EXFIL_VERBS` already covers
// the shell verbs (`cat`, `open`, `curl`, …) for these same payloads.
const CODE_SINKS = new Set([
  "readfile",
  "readfilesync",
  "readtext",
  "readtextsync",
  "readlines",
  "opensync",
  "load",
  "getenv",
  "environ",
  "fetch",
  "axios",
  "request",
  "requests",
  "urlopen",
  "urllib",
  "http",
  "https",
  "socket",
  "exec",
  "execsync",
  "execcommand",
  "spawn",
  "spawnsync",
  "popen",
  "child_process",
  "subprocess",
  "system",
])

// Names that look like a declared contract, not a credential: `.env.example`,
// `.env.sample`, and the broader template/sample families (`*.template`,
// `*.example.*`, `*.sample.*`). These stay readable so the agent can discover
// required key names (spec §8, §15).
function isExemptName(name: string): boolean {
  if (name === ".env.example" || name === ".env.sample") return true
  if (name.endsWith(".template")) return true
  if (name.includes(".example.") || name.includes(".sample.")) return true
  return false
}

function isProtected(basename: string): boolean {
  // Case-fold so `.ENV` / `ID_RSA` cannot slip past on case-insensitive or
  // case-preserving filesystems.
  const name = basename.toLowerCase()
  if (name === ".env" || name === ".envrc") return true
  if (name.startsWith(".env.")) return !isExemptName(name)
  if (name.endsWith(".pem") || name.endsWith(".key")) return true
  if (name.startsWith("id_rsa") || name.startsWith("id_ed25519")) return true
  return false
}

// Home/credential paths beyond the project .env (spec §15 optional set). Kept
// CONSERVATIVE: any path segment ending in one of these is denied, even if it
// is a project-relative directory with the same name. Segment matching (not a
// bare basename) avoids denying every file called `config` or `credentials`.
const HOME_SUFFIXES = [
  ".aws/credentials",
  ".npmrc",
  ".pypirc",
  ".kube/config",
  ".docker/config.json",
]

function isProtectedPath(fullPath: string): boolean {
  const normalized = fullPath.replace(/\\/g, "/").toLowerCase()
  for (const suffix of HOME_SUFFIXES) {
    if (normalized === suffix || normalized.endsWith(`/${suffix}`)) return true
  }
  // Any file inside an `.ssh` directory (id_rsa/id_ed25519 are also caught by
  // isProtected; this covers the rest of ~/.ssh/*).
  return normalized === ".ssh" || normalized.endsWith("/.ssh") || normalized.includes("/.ssh/")
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
  const target = tokens.find((token) => isProtected(unquote(token)) || isProtectedPath(token.replace(TOKEN_NOISE, "")))
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

/** Recursively collects every string leaf from an arbitrary tool-arg structure
 *  (objects, arrays, nested). Bounded depth so a cyclic/hostile object cannot
 *  hang the gate. */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8) return
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1)
    return
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out, depth + 1)
  }
}

/** P1-d: ANY tool (not just read/edit/write) whose string arg RESOLVES to a
 *  protected basename is denied. Each string leaf is treated as a PATH (basename
 *  after stripping quotes/flags), so a path-valued arg (`/repo/.env`,
 *  `--file=.env`, `~/.aws/credentials`) is caught while a PROSE sentence that
 *  merely contains the word `.env` (`"set API_KEY in .env"`) is not — its
 *  basename is the whole string, not `.env`, and a leaf carrying whitespace is
 *  skipped outright so a prose `task` prompt that names a dotenv path passes.
 *  This keeps agent work uninterrupted.
 *  Command strings passed to a non-bash tool are out of scope here; the `bash`
 *  path (checkCommand) inspects those. `.env.example` and its sample/template
 *  siblings stay exempt (spec §15). */
function sweepArgs(tool: string, args: unknown): Denial | undefined {
  const strings: string[] = []
  collectStrings(args, strings)
  for (const string of strings) {
    const trimmed = string.trim()
    if (trimmed.length === 0) continue
    // A leaf with internal whitespace is prose (a task brief / description), not
    // a file argument: `path.basename` of a sentence ending in `.../ .env` would
    // otherwise read as a path. Only whitespace-free leaves are swept as paths,
    // so `{ filePath: ".env" }` and `--file=.env` stay blocked while prose that
    // merely names a dotenv path passes untouched.
    if (/\s/.test(trimmed)) continue
    if (isProtectedPath(trimmed)) return { tool, filePath: trimmed }
    const cleaned = trimmed.replace(TOKEN_NOISE, "").replace(ASSIGN_PREFIX, "")
    const basename = path.basename(cleaned)
    if (isProtected(basename)) return { tool, filePath: trimmed }
  }
  return undefined
}

/** Finds the first protected file reference inside a code/script payload.
 *  Tokens keep `.` and `/` (so `.env`, `/p/.env`, `~/.aws/credentials` survive)
 *  and drop quotes/operators, so a string literal `".env"` is seen as `.env`
 *  while prose whose whole basename is not protected is not. */
function codeFileTarget(source: string): string | undefined {
  return source
    .split(/[\s"`'()\[\]{},;:=!+*&|<>@#]+/)
    .map((token) => token.replace(TOKEN_NOISE, "").replace(ASSIGN_PREFIX, ""))
    .find((token) => token.length > 0 && (isProtected(path.basename(token)) || isProtectedPath(token)))
}

/** Denies a code payload that both references a protected file AND calls a
 *  read/network/exec sink (`readFileSync`, `fetch`, `curl`, `subprocess`, …).
 *  Both must appear in the SAME string leaf, so a benign call is not caught by
 *  a protected name mentioned in a different argument. Sinks are matched as
 *  whole case-folded identifiers (split on every non-word char, so
 *  `fs.readFileSync` yields `readfilesync`). */
function codeDenial(tool: string, source: string): Denial | undefined {
  const target = codeFileTarget(source)
  if (target === undefined) return undefined
  const hit = source
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .some((token) => CODE_SINKS.has(token) || EXFIL_VERBS.has(token))
  return hit ? { tool, filePath: target } : undefined
}

/** Scans every string leaf of a code-exec tool's args. Shell-shaped leaves
 *  (`context-mode_batch_execute` commands) go through the command scanner;
 *  code leaves (`context-mode_execute` / `execute`) through the source scanner.
 *  Fail-closed on a match, allow otherwise. */
function checkExecArgs(tool: string, args: unknown): Denial | undefined {
  const strings: string[] = []
  collectStrings(args, strings)
  for (const source of strings) {
    const viaCommand = checkCommand({ command: source })
    if (viaCommand) return { tool, filePath: viaCommand.filePath }
    const viaCode = codeDenial(tool, source)
    if (viaCode) return viaCode
  }
  return undefined
}

/** Returns a Denial when the tool call must be blocked, otherwise undefined. */
export function check(tool: string, args: unknown): Denial | undefined {
  if (COMMAND_TOOLS.has(tool)) return checkCommand(args)
  if (CODE_EXEC_TOOLS.has(tool)) return checkExecArgs(tool, args)
  if (FILE_TOOLS.has(tool)) {
    // Accept both `filePath` (current read/edit/write schemas) and `path` so a
    // future schema rename cannot silently disable protection.
    const record = args as { filePath?: unknown; path?: unknown } | undefined
    const candidate = record?.filePath ?? record?.path
    const filePath = typeof candidate === "string" ? candidate : undefined
    if (filePath === undefined || filePath.length === 0) return undefined
    const trimmed = filePath.trim()
    if (isProtectedPath(trimmed)) return { tool, filePath }
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
  // Every other tool: sweep string args for a protected basename.
  return sweepArgs(tool, args)
}

/** Message intentionally omits any file contents. `keyNames` are the secret
 *  KEY NAMES currently injected for the session (names only, never values) —
 *  they let the agent switch to `$NAME` indirection instead of dead-ending. */
export function denialMessage(denial: Denial, keyNames: readonly string[] = []): string {
  const base = `Secret Broker blocked ${denial.tool} of protected file "${denial.filePath}". Read .env.example for the required key names instead.`
  const contract =
    keyNames.length === 0
      ? ` Its real values are NOT readable, and no allowlisted secrets are injected for this session.`
      : ` Its real values are never visible to the model, but the allowlisted secrets ARE injected into shell child-process environments — reference them as $KEY_NAME in shell commands (e.g. $${keyNames[0]}). Injected key names: ${keyNames.join(", ")}.`
  return base + contract
}
