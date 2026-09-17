import { sessionHref } from "@/utils/session-route"

export type ServerKey = string & { _brand: "Key" }

export type SessionTab = {
  type: "session"
  server: ServerKey
  sessionId: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerKey
  directory: string
  worktree?: string
}

export type Tab = SessionTab | DraftTab

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) =>
  tab.type === "draft" ? draftHref(tab.draftID) : sessionHref(tab.server, tab.sessionId)

export const tabKey = (tab: Tab) => (tab.type === "draft" ? `draft:${tab.draftID}` : `${tab.server}\n${tabHref(tab)}`)

// Resolves the persisted last-active tab key against the open tab store. Used
// at boot to restore the last-active tab when the persisted URL no longer
// resolves to a tab (stale window id, pruned session, …), which would otherwise
// leave no tab selected and render the strip at index 0 (the leftmost tab).
export function recentTab(store: Tab[], recentKey: string | undefined): Tab | undefined {
  if (!recentKey) return undefined
  return store.find((tab) => tabKey(tab) === recentKey)
}
