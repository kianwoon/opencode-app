import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { type Session, type SessionStatus } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import type { ServerConnection } from "@/context/server"
import type { HomeProjectSelection } from "@/context/layout"

type SessionStore = {
  session?: Session[]
  path: { directory: string }
}

export function compareSessionTime(a: Session, b: Session) {
  const updated = (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)
  if (updated !== 0) return updated
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const isRootVisibleSession = (session: Session, directory: string) =>
  pathKey(session.directory) === pathKey(directory) && !session.parentID && !session.time?.archived

export const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (store: SessionStore, _now: number) => roots(store).sort(compareSessionTime)

export const latestRootSession = (stores: SessionStore[], _now: number) =>
  stores.flatMap(roots).sort(compareSessionTime)[0]

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined> | undefined,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request ?? {}).some((list) => list?.some(include))
}

export const childSessions = (sessions: Session[] | undefined, rootID: string, limit?: number) => {
  const children = (sessions ?? [])
    .filter((session) => session.parentID === rootID && !session.time?.archived)
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))
  return limit === undefined ? children : children.slice(0, limit)
}

// Sessions eligible for "Unarchive": archived roots only, never the session the
// user currently has open. Guards against PATCHing a live session when the list
// response is stale or the server dropped the archived filter.
export const restorableSessions = (
  sessions: Session[] | undefined,
  directory: string,
  activeSessionID?: string,
  keep?: number,
) => {
  const restorable = (sessions ?? [])
    .filter(
      (session) =>
        pathKey(session.directory) === pathKey(directory) &&
        !session.parentID &&
        session.time?.archived != null &&
        session.id !== activeSessionID,
    )
    .sort(compareSessionTime)
  return keep === undefined ? restorable : restorable.slice(0, keep)
}

// Live statuses live on the server-scoped session store (server-session.ts
// `session_status`, seeded from the server-wide GET /session/status). The
// per-directory child store exposes a second, same-named `session_status` map
// that no production code writes, so reading it is always empty.
type SessionWorkData = {
  info: Record<string, Session | undefined>
  session_status: Record<string, SessionStatus | undefined>
}

// Matches session_working (server-session.ts): any non-idle status is work, so
// retrying children light the tree the same way busy ones do.
export const sessionWorking = (data: SessionWorkData, sessionID: string) =>
  (data.session_status[sessionID]?.type ?? "idle") !== "idle"

export const busyChildrenByParent = (data: SessionWorkData) => {
  const counts = new Map<string, number>()
  for (const session of Object.values(data.info)) {
    if (!session?.parentID) continue
    if (!sessionWorking(data, session.id)) continue
    counts.set(session.parentID, (counts.get(session.parentID) ?? 0) + 1)
  }
  return counts
}

// Directories holding at least one working session. Server-scoped, so a project
// the user has switched away from still reports its work.
export const busySessionDirectories = (data: SessionWorkData) =>
  new Set(
    Object.values(data.info)
      .filter((session): session is Session => !!session && sessionWorking(data, session.id))
      .map((session) => pathKey(session.directory)),
  )

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree) || project.worktree

// Two distinct projects can share a folder name (e.g. ~/.config/opencode and
// ~/Downloads/opencode); qualify duplicates with their parent folder so the
// sidebar never renders two visually identical entries.
export function uniqueDisplayNames(projects: Array<{ name?: string; worktree: string }>) {
  const base = new Map<string, number>()
  for (const project of projects) {
    const name = displayName(project)
    base.set(name, (base.get(name) ?? 0) + 1)
  }
  return projects.map((project) => {
    const name = displayName(project)
    if ((base.get(name) ?? 0) < 2) return name
    const parent = getFilename(getDirectory(project.worktree))
    return parent ? `${name} · ${parent}` : project.worktree
  })
}

export const displayNamesFor = (projects: Array<{ name?: string; worktree: string }>) => {
  const names = uniqueDisplayNames(projects)
  return new Map(projects.map((project, index) => [project.worktree, names[index]]))
}

export function toggleHomeProjectSelection(
  current: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  directory: string,
): HomeProjectSelection {
  if (current?.server === server && current.directory === directory) return { server }
  return { server, directory }
}

export function closeHomeProject(
  selected: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  projects: { close: (directory: string) => void },
  directory: string,
) {
  projects.close(directory)
  if (selected?.server === server && selected.directory === directory) return { server }
  return selected
}

export function homeProjectNavigation(active: ServerConnection.Key, server: ServerConnection.Key, href: string) {
  if (active === server) return { href }
  return { server, href }
}

export function homeProjectDirectories(result: string | string[] | null) {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

export function homeSessionServerStatus(active: boolean, status: () => { working: boolean; tint?: string }) {
  if (!active) return { working: false, tint: undefined }
  return status()
}

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"

export function getProjectAvatarSource(id?: string, icon?: { color?: string; url?: string; override?: string }) {
  if (id === OPENCODE_PROJECT_ID) return "https://opencode.ai/favicon.svg"
  if (icon?.override) return icon.override
  if (icon?.color) return undefined
  return icon?.url
}

export function projectForSession<T extends { id?: string; worktree: string; sandboxes?: string[] }>(
  session: Session,
  projects: T[],
  byID: Map<string, T> = new Map(projects.flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
) {
  const direct = byID.get(session.projectID)
  if (direct) return direct
  const directory = pathKey(session.directory)
  return projects.find(
    (project) =>
      pathKey(project.worktree) === directory || project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
  )
}

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = pathKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = pathKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = pathKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
