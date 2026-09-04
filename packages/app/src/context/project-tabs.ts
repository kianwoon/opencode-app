import type { ServerConnection } from "./server"
import type { Tab } from "./tabs"
import { pathKey } from "@/utils/path-key"

// Sessions whose tab directory (via the persisted info cache or a fallback
// lookup) belongs to one of the given project directories.
export function projectSessionIDs(
  tabs: Tab[],
  server: ServerConnection.Key,
  directories: string[],
  sessionDirectory: (sessionId: string) => string | undefined,
) {
  const keys = new Set(directories.map(pathKey))
  return tabs.flatMap((tab) => {
    if (tab.type !== "session" || tab.server !== server) return []
    const directory = sessionDirectory(tab.sessionId)
    return directory && keys.has(pathKey(directory)) ? [tab.sessionId] : []
  })
}
