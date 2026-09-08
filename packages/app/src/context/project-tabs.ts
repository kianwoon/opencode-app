import type { ServerConnection } from "./server"
import type { Tab } from "./tabs"
import { pathKey } from "@/utils/path-key"

type ProjectTabInput = {
  server: ServerConnection.Key
  directories: string[]
  /** Resolves a session tab's directory; may be undefined for unloaded sessions. */
  sessionDirectory?: (sessionId: string) => string | undefined
  /** Project being closed; session tabs whose projectID matches are removed. */
  projectId?: string
  /** Resolves a session tab's projectID (from the session info cache or sync peek). */
  sessionProjectId?: (sessionId: string) => string | undefined
}

// Sessions belonging to the project being closed. A session tab matches when
// EITHER its directory is one of the project's directories OR its session
// projectID equals the project's id. The two checks are independent: the
// directory check alone misses sessions whose stored path diverges from the
// server-truth worktree (symlinks, sandbox metadata), and the projectID check
// alone misses projects without a known id.
export function projectSessionIDs(tabs: Tab[], input: ProjectTabInput) {
  const keys = new Set(input.directories.map(pathKey))
  return tabs.flatMap((tab) => {
    if (tab.type !== "session" || tab.server !== input.server) return []
    const directory = input.sessionDirectory?.(tab.sessionId)
    if (directory && keys.has(pathKey(directory))) return [tab.sessionId]
    const projectId = input.projectId ? input.sessionProjectId?.(tab.sessionId) : undefined
    return projectId !== undefined && projectId === input.projectId ? [tab.sessionId] : []
  })
}
