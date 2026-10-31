import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyBuiltCliToResources, getCurrentCli } from "./utils"

const channel = process.env.OPENCODE_CHANNEL

afterEach(() => {
  if (channel === undefined) delete process.env.OPENCODE_CHANNEL
  if (channel !== undefined) process.env.OPENCODE_CHANNEL = channel
})

test.each(["prod", "latest"])("%s packaging rejects a branch CLI before replacing resources", async (channel) => {
  process.env.OPENCODE_CHANNEL = channel
  const root = await mkdtemp(join(tmpdir(), "opencode-cli-channel-"))
  try {
    await Bun.write(
      join(root, getCurrentCli().package.replace("@opencode/", ""), "package.json"),
      JSON.stringify({ version: "0.0.0-main-202610311338" }),
    )
    await Bun.write(join(root, "opencode-cli"), "existing executable")
    await expect(copyBuiltCliToResources(root, join(root, "opencode-cli"))).rejects.toThrow(
      "Production desktop cannot bundle preview CLI 0.0.0-main-202610311338",
    )
    expect(await Bun.file(join(root, "opencode-cli")).text()).toBe("existing executable")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
