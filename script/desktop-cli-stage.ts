// baseline-guard:allow new file created by this task; no prior baseline exists
// Refreshes the desktop app's already-extracted CLI copies after a rebuild.
//
// The app stages the bundled CLI into userData/cli/<version>-<arch>/ once per
// VERSION and reuses it, so a rebuild that keeps the version string used to leave
// the app respawning a stale extraction. The app now records the identity of the
// bundled executable it staged from in this marker and re-stages when it changes;
// this helper pre-applies the same refresh for an app that is already running and
// writes the same marker, so the next launch sees it as current.
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

/** Kept in sync with STAGED_CLI_IDENTITY in packages/desktop/src/main/service/desktop-cli.ts. */
export const STAGE_MARKER = "opencode-cli.identity"

/** The app's cheap identity for a staged copy: size and mtime, never a hash of a ~200 MB binary at launch. */
export const stageIdentity = (stat: { size: number; mtimeMs: number }) => `${stat.size}:${Math.floor(stat.mtimeMs)}`

export interface StageRefresh {
  /** The built CLI's content differs from the app's bundled executable; refreshing would be undone on launch. */
  readonly stale: boolean
  readonly refreshed: Array<string>
  readonly skipped: Array<string>
}

export function refreshStagedClis(input: {
  artifact: string
  bundled: string
  userData: string
  platform?: NodeJS.Platform
}): StageRefresh {
  const result: { stale: boolean; refreshed: Array<string>; skipped: Array<string> } = {
    stale: false,
    refreshed: [],
    skipped: [],
  }
  if (!existsSync(input.artifact) || !existsSync(input.bundled)) return result

  // The app re-stages from ITS bundled executable, so a stage refreshed from a
  // different binary would be overwritten on the next launch. Content is compared
  // by hash here (a build script can afford it; the app's launch path cannot).
  if (digest(input.artifact) !== digest(input.bundled)) {
    result.stale = true
    return result
  }

  const binary = input.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
  const identity = stageIdentity(statSync(input.bundled))
  const artifact = statSync(input.artifact)
  const root = path.join(input.userData, "cli")
  if (!existsSync(root)) return result

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(root, entry.name)
    const destination = path.join(directory, binary)
    const marker = path.join(directory, STAGE_MARKER)
    if (!existsSync(destination)) continue

    if (readMarker(marker) === identity && statSync(destination).size === artifact.size) {
      result.skipped.push(destination)
      continue
    }

    const temp = `${destination}.${process.pid}.stage`
    copyFileSync(input.artifact, temp)
    if ((input.platform ?? process.platform) !== "win32") chmodSync(temp, 0o755)
    try {
      renameSync(temp, destination)
    } catch {
      rmSync(destination, { force: true })
      renameSync(temp, destination)
    }
    writeFileSync(marker, identity)
    result.refreshed.push(destination)
  }

  return result
}

function digest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function readMarker(file: string) {
  try {
    return readFileSync(file, "utf8").trim()
  } catch {
    return ""
  }
}
