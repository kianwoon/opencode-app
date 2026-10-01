import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promptBody, resolvePrompt, writePromptBody } from "./subagent-prompt"

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
