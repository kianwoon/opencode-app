// Execution Guard — command classification (pure, no Effect).
//
// A bash command may be a CHAIN (`a && b; c | d`). Each segment is classified
// independently and the STRICTEST class wins, so `npm install x && npm run
// deploy` classifies as an install and receives zero project secrets.
//
// Splitting is a lightweight SYNCHRONOUS scan (not tree-sitter) so
// classification stays pure and callable from the plugin hook. It can only
// OVER-split (treat a quoted separator as a boundary); because every segment is
// classified independently and the strictest (lowest rank) wins, over-splitting
// never relaxes the winning class — the result is fail-safe.
//
// FAIL-CLOSED: a segment that cannot be tokenized or understood — empty input,
// garbage, or a shell wrapper whose inner command is opaque — yields
// `package_install` (zero secrets), never `other`. A false `package_install`
// only withholds secrets; a false `other` would LEAK them.

export const CLASSES = [
  "package_install",
  "build",
  "unit_test",
  "integration_test",
  "development",
  "migration",
  "deploy",
  "other",
] as const

export type Class = (typeof CLASSES)[number]

/** Lower rank = stricter. Plan §5 precedence: `install > other > rest`. */
const RANK: Record<Class, number> = {
  package_install: 0,
  other: 1,
  build: 2,
  unit_test: 3,
  integration_test: 4,
  development: 5,
  migration: 6,
  deploy: 7,
}

const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"])
const INSTALL_VERBS = new Set(["install", "add", "i", "ci", "dlx", "x"])
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "exec"])
const TEST_RUNNERS = new Set(["jest", "vitest", "mocha", "pytest", "rspec", "ava", "tap"])
const INTEGRATION_RUNNERS = new Set(["playwright", "cypress", "codeceptjs"])
const DEV_RUNNERS = new Set(["nodemon", "vite", "next", "nuxt", "astro", "remix", "webpack-dev-server"])
const MIGRATE_TOOL = new Set(["prisma", "alembic", "flyway", "knex", "sequelize", "drizzle-kit"])
const DEPLOY_TOOL = new Set([
  "vercel",
  "netlify",
  "fly",
  "flyctl",
  "heroku",
  "serverless",
  "sls",
  "sst",
  "pulumi",
  "terraform",
  "kubectl",
  "helm",
  "cdk",
  "gcloud",
  "aws",
  "firebase",
  "wrangler",
  "railway",
])

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Manager tokens whose install verb may follow arbitrary flags (e.g.
 *  `npm --prefix . install x`), so ALL following tokens are scanned. */
const MANAGER_INSTALL: Record<string, Set<string>> = {
  npm: INSTALL_VERBS,
  pnpm: INSTALL_VERBS,
  yarn: INSTALL_VERBS,
  bun: INSTALL_VERBS,
  pip: new Set(["install"]),
  pip3: new Set(["install"]),
  brew: new Set(["install"]),
  gem: new Set(["install"]),
  composer: new Set(["require"]),
  cargo: new Set(["add", "install"]),
  go: new Set(["install", "get"]),
}

const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"])

/** A plausible command name: letters/digits/_/./-, no shell metacharacters or
 *  substitution syntax. Anything else is unparseable garbage -> fail closed. */
const COMMAND_NAME = /^[A-Za-z0-9_.-]+$/

/** `bash -c "…"` / `sh -c '…'` -> the inner command string, else undefined. */
function innerShellString(tokens: string[]): string | undefined {
  if (tokens.length < 3) return undefined
  const head = tokens[0]
  if (head === undefined || !SHELL_WRAPPERS.has(head)) return undefined
  const flagIndex = tokens.findIndex((token) => token === "-c")
  if (flagIndex === -1) return undefined
  const inner = tokens[flagIndex + 1]
  if (inner === undefined || inner.length === 0) return undefined
  return inner
}

/** Strips ONE layer of wrapping parentheses: `(npm install x)`. */
function stripParens(segment: string): string {
  const trimmed = segment.trim()
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) return trimmed.slice(1, -1).trim()
  return trimmed
}

/** Splits a shell command into segments on unquoted-looking separators. */
export function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function tokenize(segment: string): string[] {
  return (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ""))
}

function stripWrappers(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined || !(ENV_ASSIGN.test(token) || WRAPPERS.has(token))) break
    index++
  }
  return tokens.slice(index)
}

function hasArg(tokens: string[], word: string): boolean {
  return tokens.some((token) => token === word)
}

/** Basename of a token so `/usr/local/bin/npm` is recognised as npm. */
function basename(token: string): string {
  return token.split("/").pop() ?? token
}

function runScript(rest: string[]): Class {
  const script = rest[0] ?? ""
  if (script.includes("build")) return "build"
  if (script.includes("integration") || script.includes("e2e")) return "integration_test"
  if (script.includes("test")) return "unit_test"
  if (script.includes("migrat")) return "migration"
  if (script.includes("deploy")) return "deploy"
  if (script === "dev" || script === "start" || script === "serve" || script === "watch") return "development"
  return "other"
}

/** Manager token whose install verb may be separated by flags (`npm --prefix
 *  . install x`), so every following token is scanned for an install verb. */
function managerInstall(manager: string, rest: string[]): Class | undefined {
  const verbs = MANAGER_INSTALL[manager]
  if (verbs === undefined) return undefined
  return rest.some((token) => verbs.has(token)) ? "package_install" : undefined
}

function classifyTokens(tokens: string[]): Class {
  const rawHead = tokens[0]
  if (!rawHead) return "package_install"
  // Strip a directory prefix so `/usr/local/bin/npm install x` is still npm.
  const head = rawHead.split("/").pop() ?? rawHead
  const sub = tokens[1]

  if (head === "npx" || head === "bunx") return "package_install"

  if (RUNNERS.has(head)) {
    const scan = managerInstall(head, tokens.slice(1))
    if (scan !== undefined) return scan
    if (sub === "test") return "unit_test"
    if (sub === "run") return runScript(tokens.slice(2))
    return "other"
  }

  const managed = managerInstall(head, tokens.slice(1))
  if (managed !== undefined) return managed

  if (head === "cargo") {
    if (sub === "build") return "build"
    if (sub === "test") return "unit_test"
    return "other"
  }
  if (head === "go") {
    if (sub === "build") return "build"
    if (sub === "test") return "unit_test"
    return "other"
  }
  if (head === "dotnet") {
    if (sub === "add" && tokens[2] === "package") return "package_install"
    if (sub === "build") return "build"
    if (sub === "test") return "unit_test"
    return "other"
  }
  if (head === "apt" || head === "apt-get" || head === "apk" || head === "yum" || head === "dnf") {
    if (sub === "install" || sub === "add") return "package_install"
    return "other"
  }
  if (head === "pacman") return sub === "-S" || sub === "-Sy" || sub === "-Syu" ? "package_install" : "other"
  if (head === "wp") return sub === "plugin" && tokens[2] === "install" ? "package_install" : "other"

  if (head === "make" || head === "cmake" || head === "bazel" || head === "gradle" || head === "mvn" || head === "tsc")
    return "build"
  if (head === "docker") return sub === "build" ? "build" : "other"
  if (head === "nx") return sub === "build" || sub === "run-many" ? "build" : "other"
  if (head === "xcodebuild" || head === "webpack" || head === "esbuild" || head === "rollup") return "build"

  if (TEST_RUNNERS.has(head)) return "unit_test"
  if (INTEGRATION_RUNNERS.has(head)) return "integration_test"
  if (DEV_RUNNERS.has(head)) return sub === "build" ? "build" : "development"
  if (MIGRATE_TOOL.has(head)) return sub === "migrate" || sub === "deploy" ? "migration" : "other"
  if (DEPLOY_TOOL.has(head)) {
    if (sub === "deploy" || sub === "apply" || sub === "up" || sub === "push" || sub === "publish") return "deploy"
    return "other"
  }
  if (head === "rake" && sub === "db:migrate") return "migration"
  if (head === "rails" && sub === "server") return "development"
  if ((head === "flask" && sub === "run") || head === "uvicorn" || head === "gunicorn") return "development"
  if (head === "python" || head === "python3") {
    if (hasArg(tokens, "manage.py") && hasArg(tokens, "runserver")) return "development"
    if (hasArg(tokens, "manage.py") && hasArg(tokens, "migrate")) return "migration"
  }

  return "other"
}

/** Classifies a single shell segment. FAIL-CLOSED: a segment that cannot be
 *  tokenized/understood yields `package_install` (zero secrets), never `other`. */
export function classifySegment(segment: string): Class {
  const unwrapped = stripParens(segment)
  const tokens = stripWrappers(tokenize(unwrapped))
  const inner = innerShellString(tokens)
  if (inner !== undefined) return classify(inner)
  if (tokens.length === 0) return "package_install"
  const head = tokens[0]
  if (head === undefined) return "package_install"
  // A head token that is not a plausible command name (e.g. `@#$%` or `$()`) is
  // unparseable: fail CLOSED rather than guess a class.
  if (!COMMAND_NAME.test(basename(head))) return "package_install"
  return classifyTokens(tokens)
}

/** Classifies a full command chain; the STRICTEST (lowest-rank) class wins. */
export function classify(command: string): Class {
  const parts = segments(command)
  const first = parts[0]
  if (first === undefined) return "package_install"
  let winner = classifySegment(first)
  let winnerRank = RANK[winner]
  for (const part of parts.slice(1)) {
    const cls = classifySegment(part)
    if (RANK[cls] < winnerRank) {
      winner = cls
      winnerRank = RANK[cls]
    }
  }
  return winner
}

export * as Classify from "./classify"
