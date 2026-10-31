#!/usr/bin/env bun
/**
 * Verifies the packaged desktop app ships the requested channel's server sidecar
 * and a real renderer payload — failing LOUDLY when it doesn't.
 *
 * The server ships as the bundled sidecar CLI: Contents/Resources/opencode-cli
 * with its version in opencode-cli.version. A preview CLI (0.0.0-*) in a prod
 * bundle is the incident this script guards against: the app would run preview
 * behaviour and open the wrong database while calling itself a release.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const channel = process.env.OPENCODE_CHANNEL
if (!channel || !["dev", "beta", "prod"].includes(channel)) {
  throw new Error(`OPENCODE_CHANNEL must be dev|beta|prod (got ${channel ?? "unset"})`)
}

const appDir = process.env.APP_DIR
if (!appDir) throw new Error("APP_DIR is required")

const resourcesDir = join(appDir, "Contents", "Resources")

// 1. The bundled server sidecar CLI and its release version.
const versionPath = join(resourcesDir, "opencode-cli.version")
if (!existsSync(versionPath))
  throw new Error(`MISSING CLI: ${versionPath} not found. The app does not ship the bundled server CLI.`)

const version = readFileSync(versionPath, "utf8").trim()
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error(`INVALID CLI VERSION: ${versionPath} contains "${version}", which is not a version.`)

if (version.startsWith("0.0.0-")) {
  if (channel === "prod") {
    throw new Error(
      `CHANNEL MISMATCH: packaged server CLI is preview version "${version}" in a prod build. ` +
        `Rebuild the CLI with OPENCODE_CHANNEL=latest and OPENCODE_VERSION set to the release version.`,
    )
  }
  console.warn(`⚠️  ${channel} build bundles preview CLI "${version}" (allowed outside prod)`)
}

const cliPath = ["opencode-cli", "opencode-cli.exe"].map((file) => join(resourcesDir, file)).find(existsSync)
if (!cliPath) throw new Error(`MISSING CLI: no opencode-cli next to ${versionPath}.`)

// 2. The asar is a real renderer payload: index.html points at the built entry.
const asarPath = join(resourcesDir, "app.asar")
if (!existsSync(asarPath)) throw new Error(`app.asar not found at ${asarPath}`)

const archive = readFileSync(asarPath)
if (archive.length < 16) throw new Error(`NOT AN ASAR: ${asarPath} is too small to hold an asar header.`)

const headerSize = archive.readUInt32LE(4)
const jsonSize = archive.readUInt32LE(12)
const header = JSON.parse(archive.subarray(16, 16 + jsonSize).toString("utf8")) as AsarEntry
const dataStart = 8 + headerSize

const indexHtml = readAsarFile(header, dataStart, archive, ["out", "renderer", "index.html"])
if (indexHtml === undefined) throw new Error(`MISSING RENDERER: out/renderer/index.html not found in ${asarPath}.`)
if (!indexHtml.includes('id="root"'))
  throw new Error(`BROKEN RENDERER: out/renderer/index.html in ${asarPath} has no #root mount point.`)

const entryScript = [...indexHtml.matchAll(/<script\b[^>]*>/g)]
  .map((match) => match[0])
  .find((tag) => tag.includes('type="module"') && tag.includes("assets/"))
const entry = entryScript?.match(/src="\.\/assets\/([^"]+\.js)"/)?.[1]
if (!entry)
  throw new Error(`BROKEN RENDERER: out/renderer/index.html in ${asarPath} references no ./assets/*.js module entry.`)

const entryPath = ["out", "renderer", "assets", entry]
if (readAsarFile(header, dataStart, archive, entryPath) === undefined)
  throw new Error(`BROKEN RENDERER: referenced entry ${entryPath.join("/")} is missing from ${asarPath}.`)

console.log(`✅ Verified ${channel} build: CLI ${version} + renderer entry ${entry}`)

type AsarEntry = { files?: Record<string, AsarEntry>; offset?: string; size?: number }

function readAsarFile(header: AsarEntry, dataStart: number, archive: Buffer, segments: string[]) {
  const entry = segments.reduce<AsarEntry | undefined>((node, segment) => node?.files?.[segment], header)
  if (entry?.offset === undefined || entry.size === undefined) return
  const start = dataStart + Number(entry.offset)
  return archive.subarray(start, start + entry.size).toString("utf8")
}
