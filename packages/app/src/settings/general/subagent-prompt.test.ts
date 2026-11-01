import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  promptBody,
  readFrontmatterValue,
  resolvePrompt,
  writeFrontmatterValue,
  writePromptBody,
} from "./subagent-prompt"

const agentMd = "---\ndescription: A hand\nmode: subagent\n---\nORIGINAL BODY\n"
const savedMd = "---\ndescription: A hand\nmode: subagent\n---\nSAVED BODY\n"

let dir: string
let path: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "subagent-prompt-"))
  path = join(dir, "agent.md")
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const bridge = {
  readFile: async (target: string) => await Bun.file(target).text(),
  writeFile: async (target: string, content: string) => {
    await Bun.write(target, content)
  },
}

describe("subagent prompt source", () => {
  test("promptBody strips the leading frontmatter and keeps the body", () => {
    expect(promptBody(agentMd)).toBe("ORIGINAL BODY\n")
    expect(promptBody("no frontmatter at all")).toBe("no frontmatter at all")
    expect(promptBody("---\r\ndescription: crlf\r\n---\r\nBODY")).toBe("BODY")
  })

  test("a save rewrites only the body, preserving frontmatter, and reads no config", async () => {
    await Bun.write(path, agentMd)
    const writes: string[] = []
    const watched = {
      readFile: bridge.readFile,
      writeFile: async (target: string, content: string) => {
        writes.push(target)
        await bridge.writeFile(target, content)
      },
    }

    const body = await writePromptBody(watched, path, "SAVED BODY\n")

    expect(body).toBe("SAVED BODY\n")
    expect(await Bun.file(path).text()).toBe(savedMd)
    expect(writes).toEqual([path])
  })

  test("the displayed prompt follows the override, then the file body, then the server value", async () => {
    await Bun.write(path, agentMd)
    await writePromptBody(bridge, path, "SAVED BODY\n")
    const file = promptBody(await bridge.readFile(path))

    // immediately after Save the retained body wins over the stale server value
    expect(resolvePrompt({ override: "SAVED BODY\n", file, server: "STALE" })).toBe("SAVED BODY\n")
    // re-selecting clears the override, and the file on disk still reads back saved
    expect(resolvePrompt({ file, server: "STALE" })).toBe("SAVED BODY\n")
    // a config or native agent has no file and keeps the server value
    expect(resolvePrompt({ file: undefined, server: "SERVER" })).toBe("SERVER")
  })
})

// Precedence for the keys a `.md` agent may also declare (effort): presence in
// the frontmatter, not truthiness, decides whether the config write is dead.
describe("subagent frontmatter keys", () => {
  test("reads a declared key, an empty declaration, and an absent one", () => {
    expect(readFrontmatterValue(agentMd, "effort")).toEqual({ declared: false })
    expect(readFrontmatterValue("---\neffort: high\n---\nBODY", "effort")).toEqual({ declared: true, value: "high" })
    expect(readFrontmatterValue('---\neffort: "max"\n---\nBODY', "effort")).toEqual({ declared: true, value: "max" })
    expect(readFrontmatterValue("---\neffort: low # keep\n---\nBODY", "effort")).toEqual({
      declared: true,
      value: "low",
    })
    // An empty declaration still owns the key: the loaded value is absent, but a
    // config write still loses to the md document.
    expect(readFrontmatterValue("---\neffort:\n---\nBODY", "effort")).toEqual({ declared: true })
    expect(readFrontmatterValue("no frontmatter at all", "effort")).toEqual({ declared: false })
  })

  test("sets, replaces, and removes one key while the body and other keys stay intact", async () => {
    await Bun.write(path, agentMd)

    await writeFrontmatterValue(bridge, path, "effort", "high")
    expect(await Bun.file(path).text()).toBe("---\ndescription: A hand\nmode: subagent\neffort: high\n---\nORIGINAL BODY\n")

    await writeFrontmatterValue(bridge, path, "effort", "max")
    expect(await Bun.file(path).text()).toBe("---\ndescription: A hand\nmode: subagent\neffort: max\n---\nORIGINAL BODY\n")

    await writeFrontmatterValue(bridge, path, "effort", undefined)
    expect(await Bun.file(path).text()).toBe(agentMd)
  })

  test("creates the frontmatter block when the file has none", async () => {
    await Bun.write(path, "BODY ONLY\n")
    await writeFrontmatterValue(bridge, path, "effort", "low")
    expect(await Bun.file(path).text()).toBe("---\neffort: low\n---\nBODY ONLY\n")
  })
})
