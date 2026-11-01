#!/usr/bin/env bun
// Production rebuild wrapper: builds the CLI and desktop app with the release channel and
// refuses to install or report an artifact whose channel is not `latest` (prod).
//
// `packages/script` treats only OPENCODE_CHANNEL=latest as production, and the desktop app maps
// `latest` to the prod app id. Passing anything else (or nothing) silently ships a preview build.
import { $ } from "bun"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { refreshStagedClis } from "./desktop-cli-stage"

const root = path.resolve(import.meta.dir, "..")
const desktopDir = path.join(root, "packages/desktop")
const cliArtifact = path.join(root, "packages/cli/dist/cli-darwin-arm64/bin/opencode")
const installDir = path.join(os.homedir(), ".opencode/bin")
const installPath = path.join(installDir, "opencode")
const appPlist = path.join(desktopDir, "dist/mac-arm64/OpenCode.app/Contents/Info.plist")
const prodAppId = "ai.opencode.desktop"

// The bun on PATH (1.3.14) fails the ^1.4.4 version guard in @opencode/script, so children run 1.4.4.
const bun = path.join(os.homedir(), ".bun/install/cache/@oven/bun-darwin-aarch64@1.4.4@@@1/bin/bun")

const args = new Set(process.argv.slice(2))
const skipCli = args.has("--skip-cli")
const skipDesktop = args.has("--skip-desktop")

const pkg = await Bun.file(path.join(root, "package.json")).json()
const version: string = process.env.OPENCODE_VERSION ?? pkg.version

if (!existsSync(bun)) fail(`pinned bun not found at ${bun}`)
if (!version) fail("no version found in package.json and no OPENCODE_VERSION set")
if (version.startsWith("0.0.0-")) fail(`refusing to build preview version ${version}`)

// Never inherit an ambient channel or version: both are set explicitly for every child.
const env = {
  ...process.env,
  PATH: `${path.dirname(bun)}:${process.env["PATH"] ?? ""}`,
  OPENCODE_CHANNEL: "latest",
  OPENCODE_VERSION: version,
}

const built: Array<string> = []
let cliFreshMs: number | undefined
let outFreshMs: number | undefined

// Every source tree that lands in the packaged renderer/main bundles, and every tree the CLI binary is
// built from. A packaged artifact older than any of its inputs means the wrapper packed stale code.
const uiSourceDirs = ["packages/app/src", "packages/ui/src", "packages/session-ui/src", "packages/desktop/src"]
const cliSourceDirs = [
  "packages/cli/src",
  "packages/core/src",
  "packages/server/src",
  "packages/protocol/src",
  "packages/schema/src",
]

if (!skipCli) {
  console.log(`rebuild-prod: cli build (channel=latest version=${version})`)
  await $`${bun} run --cwd packages/cli build`.cwd(root).env(env)
  cliFreshMs = requireFresh("cli", cliSourceDirs, cliArtifact).mtimeMs
  installCli()
  await verifyCli()
  built.push(`cli=${installPath}`)
}

if (!skipDesktop) {
  // `pack` only packages the prebuilt out/ directory, so electron-vite must run first or the app ships
  // whatever renderer happened to be there.
  console.log(`rebuild-prod: desktop build (channel=latest version=${version})`)
  await $`${bun} run --cwd packages/desktop build`.cwd(root).env(env)
  outFreshMs = requireFresh("desktop", uiSourceDirs, path.join(desktopDir, "out")).mtimeMs
  console.log(`rebuild-prod: desktop pack (channel=latest version=${version})`)
  await $`${bun} ./script/copy-icons.ts prod`.cwd(desktopDir).env(env)
  await $`${bun} run --cwd packages/desktop pack`.cwd(root).env(env)
  const app = await verifyApp()
  built.push(`app=${app}`)
  refreshDesktopStages()
}

const fresh = [
  outFreshMs === undefined ? undefined : `out=${new Date(outFreshMs).toISOString()}`,
  cliFreshMs === undefined ? undefined : `cli=${new Date(cliFreshMs).toISOString()}`,
].filter((entry) => entry !== undefined)
if (fresh.length) console.log(`rebuild-prod: freshness ok (${fresh.join(" ")})`)

console.log([`channel=latest`, `version=${version}`, ...built].join(" "))

function fail(message: string): never {
  console.error(`rebuild-prod: ${message}`)
  process.exit(1)
}

// Fail closed on a build that is older than the sources it must contain.
function requireFresh(label: string, sourceDirs: Array<string>, artifact: string) {
  const newestSource = sourceDirs.reduce<{ path: string; mtimeMs: number } | undefined>((newest, dir) => {
    const candidate = newestFile(path.join(root, dir))
    if (!candidate) return newest
    if (newest && newest.mtimeMs >= candidate.mtimeMs) return newest
    return candidate
  }, undefined)
  if (!newestSource) fail(`${label}: no source files found under ${sourceDirs.join(", ")}`)
  const artifactFile = newestFile(artifact)
  if (!artifactFile) fail(`${label}: no build artifact at ${artifact}`)
  if (newestSource.mtimeMs > artifactFile.mtimeMs)
    fail(
      `${label}: stale build, ${path.relative(root, newestSource.path)} (${new Date(newestSource.mtimeMs).toISOString()}) is newer than ${path.relative(root, artifactFile.path)} (${new Date(artifactFile.mtimeMs).toISOString()})`,
    )
  return artifactFile
}

function newestFile(target: string): { path: string; mtimeMs: number } | undefined {
  if (!existsSync(target)) return undefined
  const stats = statSync(target)
  if (!stats.isDirectory()) return { path: target, mtimeMs: stats.mtimeMs }
  let newest: { path: string; mtimeMs: number } | undefined
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const candidate = newestFile(path.join(target, entry.name))
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) newest = candidate
  }
  return newest
}

// Copy next to the target, then rename over it so a failed copy never leaves a partial binary.
function installCli() {
  if (!existsSync(cliArtifact)) fail(`missing cli artifact ${cliArtifact}`)
  mkdirSync(installDir, { recursive: true })
  const tmp = path.join(installDir, `.opencode.tmp-${process.pid}`)
  copyFileSync(cliArtifact, tmp)
  chmodSync(tmp, 0o755)
  rmSync(`${installPath}.prev`, { force: true })
  if (existsSync(installPath)) renameSync(installPath, `${installPath}.prev`)
  renameSync(tmp, installPath)
  console.log(`rebuild-prod: installed ${installPath} (previous kept as ${installPath}.prev)`)
}

async function verifyCli() {
  const printed = (await $`${installPath} --version`.env(env).text()).trim()
  if (printed.includes("0.0.0-")) fail(`installed cli is a preview build: ${printed}`)
  if (!printed.endsWith(`v${version}`)) fail(`installed cli reports "${printed}", expected v${version}`)
  console.log(`rebuild-prod: cli --version => ${printed}`)
}

async function verifyApp() {
  if (!existsSync(appPlist)) fail(`missing app bundle info at ${appPlist}`)
  const appId = (await $`plutil -extract CFBundleIdentifier raw -o - ${appPlist}`.text()).trim()
  if (appId !== prodAppId) fail(`app id is ${appId}, expected ${prodAppId} (preview build?)`)
  console.log(`rebuild-prod: appId => ${appId}`)
  return appPlist
}

// The desktop app extracts its bundled CLI into userData/cli/<version>-<arch> once
// per VERSION string and reuses it, so a same-version rebuild would otherwise keep
// respawning the stale extraction. The app now checks the bundled executable's
// identity marker on launch; this refreshes the already-extracted copies so a
// running app picks up the new CLI immediately too.
function refreshDesktopStages() {
  if (process.platform !== "darwin") return
  const result = refreshStagedClis({
    artifact: cliArtifact,
    bundled: path.join(path.dirname(appPlist), "Resources", "opencode-cli"),
    userData: path.join(os.homedir(), "Library", "Application Support", prodAppId),
  })
  if (result.stale) {
    console.log(
      "rebuild-prod: app bundle cli differs from the built cli; skipped staged cli refresh (repack the desktop app)",
    )
    return
  }
  if (result.refreshed.length) console.log(`rebuild-prod: refreshed staged cli (${result.refreshed.join(", ")})`)
  else if (result.skipped.length) console.log("rebuild-prod: staged cli already current")
}
