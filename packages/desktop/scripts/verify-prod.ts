#!/usr/bin/env bun
/**
 * Verifies the packaged desktop app actually embeds the requested channel in
 * its opencode server bundle — failing LOUDLY if it doesn't.
 *
 * Prevents the silent-wrong-DB bug: build-node.ts falls back to the git branch
 * when OPENCODE_CHANNEL is unset, which would make the app open a per-branch DB
 * (e.g. opencode-main.db) instead of the channel DB (e.g. opencode.db for
 * prod). This script inspects the packed app.asar server chunk and aborts the
 * build when the embedded channel doesn't match the requested channel.
 */
import { $ } from "bun"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const channel = process.env.OPENCODE_CHANNEL
if (!channel || !["dev", "beta", "prod"].includes(channel)) {
  throw new Error(`OPENCODE_CHANNEL must be dev|beta|prod (got ${channel ?? "unset"})`)
}

const appDir = process.env.APP_DIR
if (!appDir) throw new Error("APP_DIR is required")

// Locate the server chunk inside the packed app.asar.
const asar = join(appDir, "Contents", "Resources", "app.asar")
if (!existsSync(asar)) throw new Error(`app.asar not found at ${asar}`)

const tmp = mkdtempSync(join(tmpdir(), "opencode-verify-"))
try {
  await $`bunx asar extract ${asar} ${tmp}`
  const chunksDir = join(tmp, "out", "main", "chunks")
  const serverChunk = readdirSync(chunksDir).find((f) => f.startsWith("node-") && f.endsWith(".js"))
  if (!serverChunk) throw new Error(`No server chunk (node-*.js) found in ${chunksDir}`)

  const content = readFileSync(join(chunksDir, serverChunk), "utf8")
  const match = content.match(/InstallationChannel\s*=\s*"([a-z]+)"/)
  const embedded = match?.[1]
  if (!embedded) throw new Error(`Could not find InstallationChannel literal in ${serverChunk}`)

  // prod uses the canonical opencode.db; other channels use opencode-<channel>.db.
  const expectedDb = channel === "prod" ? "opencode.db" : `opencode-${channel}.db`
  const usesChannelDb = content.includes(expectedDb)

  if (embedded !== channel) {
    throw new Error(
      `CHANNEL MISMATCH: packaged server embeds "${embedded}" but requested "${channel}". ` +
        `The app would open the wrong database. Rebuild with OPENCODE_CHANNEL=${channel} propagated ` +
        `through prebuild (scripts/prebuild.ts).`,
    )
  }
  if (!usesChannelDb) {
    throw new Error(
      `DB MISMATCH: server chunk does not reference "${expectedDb}". The app would not use the ${channel} database.`,
    )
  }

  console.log(`✅ Verified ${channel} build: ${serverChunk} embeds channel "${embedded}" and uses ${expectedDb}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
