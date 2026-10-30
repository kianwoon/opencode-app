#!/usr/bin/env bun
// Production rebuild wrapper: builds the CLI and desktop app with the release channel and
// refuses to install or report an artifact whose channel is not `latest` (prod).
//
// `packages/script` treats only OPENCODE_CHANNEL=latest as production, and the desktop app maps
// `latest` to the prod app id. Passing anything else (or nothing) silently ships a preview build.
import { $ } from "bun"
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

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

if (!skipCli) {
  console.log(`rebuild-prod: cli build (channel=latest version=${version})`)
  await $`${bun} run --cwd packages/cli build`.cwd(root).env(env)
  installCli()
  await verifyCli()
  built.push(`cli=${installPath}`)
}

if (!skipDesktop) {
  console.log(`rebuild-prod: desktop pack (channel=latest version=${version})`)
  await $`${bun} ./script/copy-icons.ts prod`.cwd(desktopDir).env(env)
  await $`${bun} run --cwd packages/desktop pack`.cwd(root).env(env)
  const app = await verifyApp()
  built.push(`app=${app}`)
}

console.log([`channel=latest`, `version=${version}`, ...built].join(" "))

function fail(message: string): never {
  console.error(`rebuild-prod: ${message}`)
  process.exit(1)
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
