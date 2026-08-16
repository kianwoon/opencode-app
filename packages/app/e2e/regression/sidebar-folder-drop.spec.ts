import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { base64Encode } from "@opencode-ai/core/util/encode"

const directory = "C:/OpenCode/FolderDropProject"
const provider = [
  {
    id: "opencode",
    models: [{ id: "claude-opus-4-6" }],
  },
]
const project = {
  id: "proj_folder_drop",
  worktree: directory,
  vcs: "git",
}

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    provider,
    directory,
    project,
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: {
          local: [{ worktree: directory, expanded: true }],
        },
        lastProject: {
          local: directory,
        },
      }),
    )
  }, directory)
})

test("sidebar folder drop zone stays inert on web platform", async ({ page }) => {
  await page.goto(`/${base64Encode(directory)}/session`)

  const nav = page.locator('[data-component="sidebar-v2"], [data-component="sidebar-nav-desktop"]').first()
  await expect(nav).toBeAttached()

  // Web platform has no getPathForFile; an OS-file drag over the nav must not
  // surface the drop overlay. (document-level dragover may still be cancelled
  // by the composer's global attachment handler, which is unrelated.)
  await nav.evaluate((element) => {
    const dataTransfer = new DataTransfer()
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }))
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }))
  })
  await expect(page.locator('[data-component="sidebar-folder-drop-overlay"]')).toHaveCount(0)
})
