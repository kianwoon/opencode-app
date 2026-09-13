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

function classifyTokens(tokens: string[]): Class {
  const head = tokens[0]
  if (!head) return "other"
  const sub = tokens[1]

  if (head === "npx" || head === "bunx") return "package_install"

  if (RUNNERS.has(head)) {
    if (sub !== undefined && INSTALL_VERBS.has(sub)) return "package_install"
    if (sub === "test") return "unit_test"
    if (sub === "run") return runScript(tokens.slice(2))
    return "other"
  }

  if (head === "pip" || head === "pip3") return sub === "install" ? "package_install" : "other"
  if (head === "pipenv") return sub === "install" ? "package_install" : "other"
  if (head === "poetry") return sub === "add" ? "package_install" : "other"
  if (head === "brew") return sub === "install" ? "package_install" : "other"
  if (head === "gem") return sub === "install" ? "package_install" : "other"
  if (head === "composer") return sub === "require" ? "package_install" : "other"
  if (head === "cargo") {
    if (sub === "add" || sub === "install") return "package_install"
    if (sub === "build") return "build"
    if (sub === "test") return "unit_test"
    return "other"
  }
  if (head === "go") {
    if (sub === "install" || sub === "get") return "package_install"
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

/** Classifies a single shell segment. */
export function classifySegment(segment: string): Class {
  return classifyTokens(stripWrappers(tokenize(segment)))
}

/** Classifies a full command chain; the STRICTEST (lowest-rank) class wins. */
export function classify(command: string): Class {
  const parts = segments(command)
  if (parts.length === 0) return "other"
  // Seed from the first segment so a single-segment command returns its OWN
  // class (`npm run build` -> build), not the chain floor (`other`). The
  // precedence only resolves competition BETWEEN segments.
  let winner = classifySegment(parts[0]!)
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
