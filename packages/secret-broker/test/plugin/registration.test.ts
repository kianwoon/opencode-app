// Registration path: the loader the CURRENT server uses accepts a plugin
// configured as an absolute DIRECTORY, never a file path.
//
// packages/core/src/config/plugin/source.ts:152 drops a configured entry that
// points at a file ("configured plugin path must be a directory"), then resolves
// a directory through `Host.resolve` to its `server` entrypoint
// (packages/plugin/src/host.ts:34). This suite pins both halves: the real
// package directory resolves to a server entry, and the module it points at
// decodes as a v2 `Plugin.define({ id, setup })` definition that the promise
// adapter can run.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Host } from "@opencode/plugin/host"

const packageRoot = path.resolve(import.meta.dir, "../..")

describe("loader-accepted registration shape", () => {
  test("the package directory resolves to its ./server entrypoint", () => {
    const entrypoints = Host.resolve({ directory: packageRoot })
    expect(entrypoints.server).toBeDefined()
    expect(entrypoints.server!.startsWith("file://")).toBe(true)
    // `exports["./server"]` of this package: the built entry the server imports.
    expect(entrypoints.server!.endsWith("/dist/server.js")).toBe(true)
  })

  test("a plain directory (no package name) resolves through server.ts", async () => {
    // Mirrors the accepted convention for a local directory: `server` then `index`.
    const dir = mkdtempSync(path.join(tmpdir(), "sb-registration-"))
    try {
      writeFileSync(
        path.join(dir, "server.ts"),
        `export { default } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, "src/server.ts")).href)}\n`,
      )
      const entrypoints = Host.resolve({ directory: dir })
      expect(entrypoints.server).toBeDefined()
      expect(realpathSync(fileURLToPath(entrypoints.server!))).toBe(realpathSync(path.join(dir, "server.ts")))
      expect(existsSync(fileURLToPath(entrypoints.server!))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the server module exports a v2 definition the loader decodes", async () => {
    const loaded = (await Host.load(pathToFileURL(path.join(packageRoot, "src/server.ts")).href)) as {
      default?: { id?: unknown; setup?: unknown }
    }
    const definition = loaded.default
    expect(definition?.id).toBe("opencode.secret-broker")
    expect(typeof definition?.setup).toBe("function")
    // A v1 hook-map function would decode as neither `effect` nor `setup`, and the
    // loader drops it as an invalid plugin source.
    expect(typeof definition).toBe("object")
  })
})
