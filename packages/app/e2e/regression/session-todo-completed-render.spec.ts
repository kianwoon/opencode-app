import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TodoCompletedRender"
const projectID = "proj_todo_completed_render"
const sourceID = "ses_todo_completed_render"
const sourceTitle = "Completed render check"

const mk = (...statuses: string[]) =>
  statuses.map((status, i) => ({ id: `todo-${i}`, content: `Item ${i + 1}`, status, priority: "high" }))

type EventPayload = { directory: string; payload: Record<string, unknown> }

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" })

test("completed todo items render checked and stay readable before the dock closes", async ({ page }) => {
  test.setTimeout(90_000)
  const events: EventPayload[] = []
  const current: Record<string, ReturnType<typeof mk>> = { [sourceID]: [] }
  const sessionStatus: Record<string, { type: "busy" | "idle" }> = { [sourceID]: { type: "busy" } }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-completed-render",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sourceID,
        slug: sourceID,
        projectID,
        directory,
        title: sourceTitle,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    sessionStatus: () => sessionStatus,
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
    todos: (sessionID) => current[sessionID] ?? [],
  })
  await configurePage(page)

  await page.goto(sessionHref(sourceID))
  await expectSessionTitle(page, sourceTitle)
  const dock = page.locator('[data-component="session-todo-dock"]')
  await expect(dock).toHaveCount(0)

  sessionStatus[sourceID] = { type: "busy" }
  events.push(statusEvent(sourceID, "busy"))
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
  await page.waitForTimeout(700)

  // Working list with mixed states — all render.
  current[sourceID] = mk("completed", "in_progress", "pending")
  events.push(todoEvent(sourceID, current[sourceID]))
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-state="completed"]')).toHaveCount(1)
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)
  await expect(dock.locator('[data-state="pending"]')).toHaveCount(1)

  // All completed — the checked list must stay fully visible for the hold
  // window instead of instantly fading out.
  current[sourceID] = mk("completed", "completed", "completed")
  events.push(todoEvent(sourceID, current[sourceID]))
  await expect(dock.locator('[data-state="completed"]')).toHaveCount(3)

  const listOpacity = () =>
    page.locator('[data-slot="session-todo-list"]').evaluate((el) => Number(window.getComputedStyle(el).opacity))
  await expect.poll(listOpacity, { timeout: 500 }).toBeGreaterThan(0.98)
  await page.waitForTimeout(1_000)
  await expect.poll(listOpacity, { timeout: 100 }).toBeGreaterThan(0.98)

  // Eventually the dock closes on its own.
  await expect(dock).toHaveCount(0, { timeout: 10_000 })
})

test("todos stay visible when the session goes idle after completing mid-hold", async ({ page }) => {
  test.setTimeout(90_000)
  const events: EventPayload[] = []
  const current: Record<string, ReturnType<typeof mk>> = { [sourceID]: [] }
  const sessionStatus: Record<string, { type: "busy" | "idle" }> = { [sourceID]: { type: "busy" } }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-completed-render",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sourceID,
        slug: sourceID,
        projectID,
        directory,
        title: sourceTitle,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    sessionStatus: () => sessionStatus,
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
    todos: (sessionID) => current[sessionID] ?? [],
  })
  await configurePage(page)

  await page.goto(sessionHref(sourceID))
  await expectSessionTitle(page, sourceTitle)
  const dock = page.locator('[data-component="session-todo-dock"]')

  sessionStatus[sourceID] = { type: "busy" }
  events.push(statusEvent(sourceID, "busy"))
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
  await page.waitForTimeout(700)

  current[sourceID] = mk("completed")
  events.push(todoEvent(sourceID, current[sourceID]))
  await expect(dock.locator('[data-state="completed"]')).toHaveCount(1)

  // Session goes idle while the completed hold is still running. The client
  // keeps the todos in the store (only the dock closes); switching back to
  // this session must not resurrect a stale open dock, but the completed
  // state must have been perceivable before the close.
  await page.waitForTimeout(300)
  sessionStatus[sourceID] = { type: "idle" }
  events.push(statusEvent(sourceID, "idle"))
  await expect(dock).toHaveCount(0, { timeout: 10_000 })
})

function statusEvent(sessionID: string, type: "busy" | "idle"): EventPayload {
  return { directory, payload: { type: "session.status", properties: { sessionID, status: { type } } } }
}

function todoEvent(sessionID: string, next: ReturnType<typeof mk>): EventPayload {
  return { directory, payload: { type: "todo.updated", properties: { sessionID, todos: next } } }
}

async function configurePage(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionID: sourceID },
  )
}

function sessionHref(id: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${id}`
}
