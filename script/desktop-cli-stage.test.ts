// baseline-guard:allow new test file created by this task; no prior baseline exists
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { STAGE_MARKER, refreshStagedClis, stageIdentity } from "./desktop-cli-stage"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "opencode-desktop-stage-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function setup() {
  const userData = path.join(root, "userData")
  const stage = path.join(userData, "cli", "2.2.5-arm64")
  mkdirSync(stage, { recursive: true })
  const destination = path.join(stage, "opencode-cli")
  writeFileSync(destination, "OLD CLI")

  const artifact = path.join(root, "artifact", "opencode-cli")
  mkdirSync(path.dirname(artifact), { recursive: true })
  writeFileSync(artifact, "NEW CLI")

  const bundled = path.join(root, "Resources", "opencode-cli")
  mkdirSync(path.dirname(bundled), { recursive: true })
  writeFileSync(bundled, "NEW CLI")

  return { userData, stage, destination, artifact, bundled }
}

describe("refreshStagedClis", () => {
  test("a changed bundled CLI refreshes the extracted copy, then an unchanged one skips it", () => {
    const files = setup()

    const first = refreshStagedClis({ ...files, platform: "darwin" })
    expect(first.stale).toBe(false)
    expect(first.refreshed).toEqual([files.destination])
    expect(readFileSync(files.destination, "utf8")).toBe("NEW CLI")
    expect(readFileSync(path.join(files.stage, STAGE_MARKER), "utf8")).toBe(
      stageIdentity(statSync(files.bundled)),
    )

    const second = refreshStagedClis({ ...files, platform: "darwin" })
    expect(second.stale).toBe(false)
    expect(second.refreshed).toEqual([])
    expect(second.skipped).toEqual([files.destination])
  })

  test("a rebuilt CLI whose mtime moved refreshes even when the bytes are identical", () => {
    const files = setup()
    refreshStagedClis({ ...files, platform: "darwin" })

    // A relinked bundle keeps the version string but is a new executable.
    writeFileSync(files.bundled, "NEW CLI")
    const later = new Date(Date.now() + 60_000)
    utimesSync(files.bundled, later, later)

    const again = refreshStagedClis({ ...files, platform: "darwin" })
    expect(again.refreshed).toEqual([files.destination])
  })

  test("a bundled CLI that differs from the build skips the refresh", () => {
    const files = setup()
    writeFileSync(files.bundled, "STALE!!")

    const result = refreshStagedClis({ ...files, platform: "darwin" })
    expect(result).toEqual({ stale: true, refreshed: [], skipped: [] })
    expect(readFileSync(files.destination, "utf8")).toBe("OLD CLI")
    expect(existsSync(path.join(files.stage, STAGE_MARKER))).toBe(false)
  })
})
