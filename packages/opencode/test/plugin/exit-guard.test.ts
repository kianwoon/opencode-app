import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { PluginLoader } from "../../src/plugin/loader"
import { PluginExitAttemptError } from "../../src/plugin/exit-guard"
import { ConfigPlugin } from "@/config/plugin"

const dirs: string[] = []

async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-exit-guard-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function resolved(file: string): PluginLoader.Resolved {
  return {
    spec: pathToFileURL(file).href,
    options: undefined,
    deprecated: false,
    source: "file",
    target: file,
    entry: pathToFileURL(file).href,
  }
}

describe("plugin.exit-guard", () => {
  test("traps a module-scope process.exit, reports it, and restores process.exit", async () => {
    const dir = await tmp()
    const file = path.join(dir, "kill.test.ts")
    await fs.writeFile(file, "process.exit(0)\n")

    const before = process.exit
    const result = await PluginLoader.load(resolved(file))

    expect(result.ok).toBe(false)
    if (result.ok === false) {
      expect(result.error).toBeInstanceOf(PluginExitAttemptError)
      expect(String(result.error)).toContain("process.exit")
    }
    // The host is still alive and trusted code keeps the real exit.
    expect(process.exit).toBe(before)
    expect(typeof process.exit).toBe("function")
  })

  test("directory discovery never auto-loads test/spec plugin files", async () => {
    const dir = await tmp()
    const plugins = path.join(dir, "plugins")
    await fs.mkdir(plugins, { recursive: true })
    await fs.writeFile(path.join(plugins, "keep.ts"), "export default {}\n")
    await fs.writeFile(path.join(plugins, "kill.test.ts"), "process.exit(0)\n")
    await fs.writeFile(path.join(plugins, "kill.spec.js"), "process.exit(0)\n")

    const specs = await ConfigPlugin.load(dir)
    expect(specs.map((spec) => path.basename(ConfigPlugin.pluginSpecifier(spec)))).toEqual(["keep.ts"])
  })

  test("a second module-scope exit from a different plugin still traps after the first", async () => {
    const dir = await tmp()
    const first = path.join(dir, "first.test.ts")
    const second = path.join(dir, "second.test.ts")
    await fs.writeFile(first, "process.exit(3)\n")
    await fs.writeFile(second, "process.exit(4)\n")

    const before = process.exit
    const a = await PluginLoader.load(resolved(first))
    const b = await PluginLoader.load(resolved(second))

    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    if (a.ok === false) expect(a.error).toBeInstanceOf(PluginExitAttemptError)
    if (b.ok === false) expect(b.error).toBeInstanceOf(PluginExitAttemptError)
    expect(process.exit).toBe(before)
  })

  test("an explicitly loaded *.test.ts plugin still evaluates (discovery filter is glob-only)", async () => {
    const dir = await tmp()
    const file = path.join(dir, "explicit.test.ts")
    await fs.writeFile(file, "export default {}\n")

    const result = await PluginLoader.load(resolved(file))
    expect(result.ok).toBe(true)
  })
})
