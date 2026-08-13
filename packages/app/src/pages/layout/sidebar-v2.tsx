import { For, Show, createMemo, createEffect, createResource, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { startTransition } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobal, type ServerCtx } from "@/context/global"
import { getProjectAvatarVariant, type LocalProject, useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs, type SessionTab } from "@/context/tabs"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useSettingsCommand } from "@/components/settings-dialog"
import { useCommand } from "@/context/command"
import { createPromptSession } from "@/context/prompt-state"
import { displayName, getProjectAvatarSource, sortedRootSessions } from "./helpers"
import { useSessionTabAvatarState } from "./project-avatar-state"
import { showToast } from "@/utils/toast"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { shouldOpenSessionInBackground } from "../home-session-open"
import { type Session } from "@opencode-ai/sdk/v2/client"

const SIDEBAR_RAIL_WIDTH = 44
const SIDEBAR_PANEL_WIDTH = 264
// Number of sessions shown in a project before the user expands. Matches the
// child store's default session limit so the collapsed list is consistent.
const DEFAULT_SESSION_LIMIT = 5
// Number of most recent sessions kept when the user cleans up a project.
const SESSION_CLEANUP_KEEP = 5

// Fetches all root sessions for a project directory, most recent first. Uses a
// large limit so the cleanup action can delete every session beyond the keep
// count, not just the ones currently loaded into the sidebar.
async function listProjectSessions(serverCtx: ServerCtx, directory: string) {
  const result = await serverCtx.sdk.api.session.list({
    directory,
    parentID: null,
    order: "desc",
    limit: 10000,
  })
  return (result.data ?? []).sort(
    (a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0),
  )
}

function isBackgroundOpen(event: MouseEvent) {
  return shouldOpenSessionInBackground({
    button: event.button,
    mac: typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  })
}

export function NewSidebar() {
  const layout = useLayout()
  const language = useLanguage()
  const server = useServer()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const openSettings = useSettingsCommand()
  const serverSDK = useServerSDK()
  // Reload global + project configs (AGENTS.md, opencode.json, etc.) without
  // restarting the app. The server invalidates its cached config and disposes
  // all instances so the next access re-bootstraps each project; the resulting
  // global.disposed event triggers the app to re-fetch everything.
  async function reloadConfigs() {
    try {
      showToast({ title: language.t("sidebar.reload.started") })
      await serverSDK().client.global.dispose()
      showToast({ title: language.t("sidebar.reload.done") })
    } catch (err) {
      showToast({
        title: language.t("sidebar.reload.error"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // Compact the opencode server database (VACUUM) to reclaim dead space from
  // deleted sessions/events. Non-destructive; shows a toast with the reclaimed
  // size. Desktop-only (requires the IPC handler in the main process).
  async function vacuumDatabase() {
    if (!window.api?.vacuumDatabase) return
    try {
      showToast({ title: language.t("sidebar.vacuum.started") })
      const { before, after } = await window.api.vacuumDatabase()
      if (before === 0) {
        showToast({ title: language.t("sidebar.vacuum.none") })
        return
      }
      const saved = Math.max(0, before - after)
      const savedLabel =
        saved >= 1_073_741_824
          ? `${(saved / 1_073_741_824).toFixed(1)} GB`
          : saved >= 1_048_576
            ? `${(saved / 1_048_576).toFixed(1)} MB`
            : `${(saved / 1024).toFixed(0)} KB`
      showToast({
        title: language.t("sidebar.vacuum.done"),
        description: language.t("sidebar.vacuum.saved", { saved: savedLabel }),
      })
    } catch {
      showToast({ title: language.t("sidebar.vacuum.error") })
    }
  }
  const serverSync = useServerSync()
  const platform = usePlatform()
  const command = useCommand()
  const dialog = useDialog()
  const [projectExpanded, setProjectExpanded] = createStore({} as Record<string, boolean>)
  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })

  // Register the shared sidebar toggle command id so the desktop menu (and
  // command palette) can toggle the new-layout sidebar. mod+b is claimed by
  // home.toggle in the new layout, so use mod+shift+b here to avoid a clash.
  command.register("sidebar", () => [
    {
      id: "sidebar.toggle",
      title: language.t("command.sidebar.toggle"),
      category: language.t("command.category.view"),
      keybind: "mod+shift+b",
      onSelect: () => layout.sidebar.toggle(),
    },
  ])

  const expanded = () => layout.sidebar.opened()
  const width = createMemo(() => (expanded() ? SIDEBAR_PANEL_WIDTH : SIDEBAR_RAIL_WIDTH))

  const currentServer = createMemo(() => {
    const route = layout.route()
    if (route.type === "session" || route.type === "draft") {
      const key = route.server ?? server.key
      return global.servers.list().find((item) => ServerConnection.key(item) === key) ?? server.current
    }
    return server.current
  })

  const ctx = createMemo(() => {
    const conn = currentServer()
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })

  const sync = createMemo(() => ctx()?.sync ?? serverSync())

  const projects = createMemo(() => {
    const conn = currentServer()
    if (!conn) return layout.projects.list()
    return global.ensureServerCtx(conn).projects.list()
  })

  const activeDirectory = createMemo(() => {
    const route = layout.route()
    if (route.type !== "session") return undefined
    return sync().session.lineage.peek(route.sessionId)?.session.directory
  })

  // Load sessions for open projects once the sidebar is visible. Keyed on
  // pathKey-normalized worktrees so icon/expand store mutations don't re-fetch.
  createEffect(
    on(
      () => {
        if (!expanded()) return ""
        return projects()
          .map((project) => pathKey(project.worktree))
          .join("\0")
      },
      (worktrees) => {
        if (!worktrees) return
        const conn = currentServer()
        if (!conn) return
        const serverCtx = global.ensureServerCtx(conn)
        for (const worktree of worktrees.split("\0")) {
          if (!worktree) continue
          void serverCtx.sync.project.loadSessions(worktree)
        }
      },
      { defer: true },
    ),
  )

  const openProjectNewSession = (directory: string) => {
    const conn = currentServer()
    if (!conn) return
    const serverCtx = global.ensureServerCtx(conn)
    serverCtx.projects.open(directory)
    serverCtx.projects.touch(directory)
    const project = serverCtx.projects.list().find((item) => item.worktree === directory)
    const dir = project?.worktree ?? directory
    void tabs.newDraft({ server: ServerConnection.key(conn), directory: dir })
  }

  const openSession = (session: Session, options?: { background?: boolean }) => {
    const conn = currentServer()
    if (!conn) return
    const key = ServerConnection.key(conn)
    const serverCtx = global.ensureServerCtx(conn)
    const directory = session.directory
    serverCtx.projects.open(directory)
    if (options?.background) {
      tabs.addSessionTab({ server: key, sessionId: session.id })
      return
    }
    serverCtx.projects.touch(directory)
    void startTransition(() => {
      const tab = tabs.addSessionTab({ server: key, sessionId: session.id })
      tabs.select(tab)
    })
  }

  const addProject = (conn: ServerConnection.Any) => {
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        const directories = Array.isArray(result) ? result : [result]
        const serverCtx = global.ensureServerCtx(conn)
        for (const directory of directories) {
          if (!directory) continue
          serverCtx.projects.open(directory)
        }
        if (directories[0]) serverCtx.projects.touch(directories[0])
      },
    })
  }

  const closeProject = (directory: string) => {
    const conn = currentServer()
    if (!conn) return
    global.ensureServerCtx(conn).projects.close(directory)
  }

  const editProject = (project: LocalProject) => {
    const conn = currentServer()
    if (!conn) return
    const run = ++dialogRun
    void import("@/components/dialog-edit-project-v2").then(({ DialogEditProjectV2 }) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <DialogEditProjectV2 server={conn} project={project} />)
    })
  }

  // Deletes all but the most recent SESSION_CLEANUP_KEEP sessions for a
  // project. Confirms first because this permanently removes session data.
  const cleanupProjectSessions = (project: LocalProject) => {
    const conn = currentServer()
    if (!conn) return
    const serverCtx = global.ensureServerCtx(conn)
    const run = ++dialogRun
    void dialog.show(() => (
      <DialogCleanupSessions
        project={project}
        staleCountAccessor={async () => {
          const sessions = await listProjectSessions(serverCtx, project.worktree)
          return Math.max(0, sessions.length - SESSION_CLEANUP_KEEP)
        }}
        onConfirm={async () => {
          if (dialogDead || dialogRun !== run) return
          const sessions = await listProjectSessions(serverCtx, project.worktree)
          const stale = sessions.slice(SESSION_CLEANUP_KEEP)
          const api = serverCtx.sdk.api.session
          for (const session of stale) {
            await api.remove({ sessionID: session.id }).catch(() => undefined)
          }
          await serverCtx.sync.project.loadSessions(project.worktree)
        }}
      />
    ))
  }

  const actions: SidebarActions = {
    projects,
    currentServer,
    activeDirectory,
    expandedFor: (project) => projectExpanded[project.worktree] ?? true,
    onToggleExpanded: (worktree) => setProjectExpanded(worktree, !(projectExpanded[worktree] ?? true)),
    onOpenProject: openProjectNewSession,
    onOpenSession: openSession,
    onAddProject: addProject,
    onCloseProject: closeProject,
    onEditProject: editProject,
    onCleanupSessions: cleanupProjectSessions,
    onNewSession: openProjectNewSession,
  }

  return (
    <nav
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
      data-component="sidebar-v2"
      class="relative flex h-full min-h-0 min-w-0 flex-col shrink-0 bg-v2-background-bg-deep"
      style={{ width: `${width()}px` }}
    >
      <div class="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Show
          when={expanded()}
          fallback={
            <RailSidebar
              projects={projects}
              activeDirectory={activeDirectory}
              currentServer={currentServer}
              onOpenProject={openProjectNewSession}
              onAddProject={addProject}
              onOpenSettings={openSettings}
              onVacuum={vacuumDatabase}
              onReloadConfigs={reloadConfigs}
              onOpenHelp={() => platform.openExternal("https://opencode.ai/desktop-feedback")}
            />
          }
        >
          <ExpandedSidebar {...actions} />
        </Show>
      </div>
    </nav>
  )
}

type SidebarActions = {
  projects: Accessor<LocalProject[]>
  currentServer: Accessor<ServerConnection.Any | undefined>
  activeDirectory: Accessor<string | undefined>
  expandedFor: (project: LocalProject) => boolean
  onToggleExpanded: (worktree: string) => void
  onOpenProject: (directory: string) => void
  onOpenSession: (session: Session, options?: { background?: boolean }) => void
  onAddProject: (conn: ServerConnection.Any) => void
  onCloseProject: (directory: string) => void
  onEditProject: (project: LocalProject) => void
  onCleanupSessions: (project: LocalProject) => void
  onNewSession: (directory: string) => void
}

function RailSidebar(props: {
  projects: Accessor<LocalProject[]>
  activeDirectory: Accessor<string | undefined>
  currentServer: Accessor<ServerConnection.Any | undefined>
  onOpenProject: (directory: string) => void
  onAddProject: (conn: ServerConnection.Any) => void
  onOpenSettings: () => void
  onVacuum: () => void
  onReloadConfigs: () => void
  onOpenHelp: () => void
}) {
  const language = useLanguage()
  const notification = useNotification()
  const serverKey = createMemo(() => {
    const conn = props.currentServer()
    return conn ? ServerConnection.key(conn) : undefined
  })
  const state = createMemo(() => {
    const key = serverKey()
    if (!key) return undefined
    return notification.ensureServerState(key)
  })
  const unseenFor = (project: LocalProject) =>
    [project.worktree, ...(project.sandboxes ?? [])].reduce(
      (total, directory) => total + (state()?.project.unseenCount(directory) ?? 0),
      0,
    )
  return (
    <div class="flex h-full flex-col items-center gap-1 overflow-y-auto no-scrollbar py-2">
      <For each={props.projects()}>
        {(project) => (
          <RailProjectIcon
            project={project}
            active={pathKey(props.activeDirectory() ?? "") === pathKey(project.worktree)}
            onOpen={() => props.onOpenProject(project.worktree)}
            unseen={unseenFor(project)}
          />
        )}
      </For>
      <RailAction
        icon="folder-add-left"
        label={language.t("home.project.add")}
        onClick={() => {
          const current = props.currentServer()
          if (current) props.onAddProject(current)
        }}
      />
      <div class="mt-auto flex flex-col items-center gap-1 pb-2">
        <RailAction icon="outline-refresh" label={language.t("sidebar.reload")} onClick={props.onReloadConfigs} />
        <RailAction icon="outline-reset" label={language.t("sidebar.vacuum")} onClick={props.onVacuum} />
        <RailAction icon="settings-gear" label={language.t("sidebar.settings")} onClick={props.onOpenSettings} />
        <RailAction icon="help" label={language.t("sidebar.help")} onClick={props.onOpenHelp} />
      </div>
    </div>
  )
}

function RailAction(props: { icon: string; label: string; onClick: () => void }) {
  return (
    <TooltipV2 placement="right" value={props.label}>
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="large"
        icon={<IconV2 name={props.icon} />}
        aria-label={props.label}
        onClick={props.onClick}
      />
    </TooltipV2>
  )
}

function RailProjectIcon(props: { project: LocalProject; active: boolean; unseen: number; onOpen: () => void }) {
  return (
    <TooltipV2 placement="right" value={displayName(props.project)}>
      <button
        type="button"
        data-component="sidebar-v2-project-rail"
        class="flex size-8 shrink-0 items-center justify-center rounded-[6px] transition-colors hover:bg-v2-background-bg-layer-01"
        classList={{ "bg-v2-background-bg-layer-02": props.active }}
        aria-label={displayName(props.project)}
        aria-current={props.active ? "page" : undefined}
        onClick={props.onOpen}
      >
        <ProjectAvatar
          fallback={displayName(props.project)}
          src={getProjectAvatarSource(props.project.id, props.project.icon)}
          variant={getProjectAvatarVariant(props.project.icon?.color)}
          unread={props.unseen > 0}
        />
      </button>
    </TooltipV2>
  )
}

function ExpandedSidebar(props: SidebarActions) {
  const layout = useLayout()
  const language = useLanguage()
  const openSettings = useSettingsCommand()
  const serverSDK = useServerSDK()
  async function reloadConfigs() {
    try {
      showToast({ title: language.t("sidebar.reload.started") })
      await serverSDK().client.global.dispose()
      showToast({ title: language.t("sidebar.reload.done") })
    } catch (err) {
      showToast({
        title: language.t("sidebar.reload.error"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }
  async function vacuumDatabase() {
    if (!window.api?.vacuumDatabase) return
    try {
      showToast({ title: language.t("sidebar.vacuum.started") })
      const { before, after } = await window.api.vacuumDatabase()
      if (before === 0) {
        showToast({ title: language.t("sidebar.vacuum.none") })
        return
      }
      const saved = Math.max(0, before - after)
      const savedLabel =
        saved >= 1_073_741_824
          ? `${(saved / 1_073_741_824).toFixed(1)} GB`
          : saved >= 1_048_576
            ? `${(saved / 1_048_576).toFixed(1)} MB`
            : `${(saved / 1024).toFixed(0)} KB`
      showToast({
        title: language.t("sidebar.vacuum.done"),
        description: language.t("sidebar.vacuum.saved", { saved: savedLabel }),
      })
    } catch {
      showToast({ title: language.t("sidebar.vacuum.error") })
    }
  }

  const expandedFor = (project: LocalProject) => props.expandedFor(project)
  const toggleExpanded = (worktree: string) => props.onToggleExpanded(worktree)

  return (
    <div class="flex h-full min-h-0 min-w-0 flex-col">
      <div class="shrink-0 flex h-9 items-center gap-1 px-2">
        <div class="min-w-0 flex-1 px-1 text-v2-text-text-muted text-[13px] [font-weight:530] truncate">
          {language.t("home.projects")}
        </div>
        <TooltipV2 placement="bottom" value={language.t("home.project.add")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="folder-add-left" />}
            aria-label={language.t("home.project.add")}
            onClick={() => {
              const conn = props.currentServer()
              if (conn) props.onAddProject(conn)
            }}
          />
        </TooltipV2>
      </div>
      <div class="flex-1 min-h-0 min-w-0">
        <ScrollView class="h-full">
          <div class="flex min-w-0 flex-col gap-px px-2 pb-3">
            <Show
              when={props.projects().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-3 px-3 pt-8 text-center">
                  <div class="text-v2-text-text-base [font-weight:530]">{language.t("sidebar.empty.title")}</div>
                  <p class="text-[13px] leading-5 text-v2-text-text-muted [font-weight:440]">
                    {language.t("sidebar.empty.description")}
                  </p>
                  <IconButtonV2
                    type="button"
                    variant="neutral"
                    size="normal"
                    icon={<IconV2 name="folder-add-left" />}
                    onClick={() => {
                      const conn = props.currentServer()
                      if (conn) props.onAddProject(conn)
                    }}
                  >
                    {language.t("command.project.open")}
                  </IconButtonV2>
                </div>
              }
            >
              <For each={props.projects()}>
                {(project) => (
                  <ProjectSection
                    project={project}
                    expanded={expandedFor(project)}
                    onToggle={() => toggleExpanded(project.worktree)}
                    {...props}
                  />
                )}
              </For>
            </Show>
          </div>
        </ScrollView>
      </div>
      <div class="shrink-0 flex items-center gap-1 px-2 py-1.5 border-t border-v2-border-border-base">
        <TooltipV2 placement="top" value={language.t("sidebar.reload")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="outline-refresh" />}
            aria-label={language.t("sidebar.reload")}
            onClick={reloadConfigs}
          />
        </TooltipV2>
        <TooltipV2 placement="top" value={language.t("sidebar.vacuum")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="outline-reset" />}
            aria-label={language.t("sidebar.vacuum")}
            onClick={vacuumDatabase}
          />
        </TooltipV2>
        <TooltipV2 placement="top" value={language.t("sidebar.settings")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="settings-gear" />}
            aria-label={language.t("sidebar.settings")}
            onClick={openSettings}
          />
        </TooltipV2>
        <div class="flex-1" />
        <TooltipV2 placement="top" value={language.t("command.sidebar.toggle")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="sidebar-right" />}
            aria-label={language.t("command.sidebar.toggle")}
            onClick={() => layout.sidebar.toggle()}
          />
        </TooltipV2>
      </div>
    </div>
  )
}

function ProjectSection(
  props: SidebarActions & {
    project: LocalProject
    expanded: boolean
    onToggle: () => void
  },
) {
  const language = useLanguage()
  const global = useGlobal()
  const serverSync = useServerSync()
  const notification = useNotification()
  const [menuOpen, setMenuOpen] = createStore({ open: false })
  const ctx = createMemo(() => {
    const conn = props.currentServer()
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })
  const sync = createMemo(() => ctx()?.sync ?? serverSync())
  const childStore = createMemo(() => sync().child(props.project.worktree, { bootstrap: false }))
  const allSessions = createMemo(() => sortedRootSessions(childStore()[0], Date.now()))
  const sessionTotal = createMemo(() => childStore()[0].sessionTotal)
  const [showAll, setShowAll] = createStore({ value: false })
  const visibleSessions = createMemo(() => (showAll.value ? allSessions() : allSessions().slice(0, DEFAULT_SESSION_LIMIT)))
  const hasMore = createMemo(() => sessionTotal() > visibleSessions().length)
  const showAllSessions = async () => {
    const [store, setStore] = childStore()
    setStore("limit", Math.max(store.limit, sessionTotal(), allSessions().length + 1))
    await sync().project.loadSessions(props.project.worktree)
    setShowAll("value", true)
  }
  const showFewerSessions = () => setShowAll("value", false)
  const serverKey = createMemo(() => {
    const conn = props.currentServer()
    return conn ? ServerConnection.key(conn) : undefined
  })
  const notificationState = createMemo(() => {
    const key = serverKey()
    if (!key) return undefined
    return notification.ensureServerState(key)
  })
  const unseen = createMemo(() =>
    [props.project.worktree, ...(props.project.sandboxes ?? [])].reduce(
      (total, directory) => total + (notificationState()?.project.unseenCount(directory) ?? 0),
      0,
    ),
  )
  const active = createMemo(() => {
    const directory = props.activeDirectory()
    return pathKey(directory ?? "") === pathKey(props.project.worktree)
  })

  return (
    <div data-component="sidebar-v2-project" class="flex min-w-0 flex-col">
      <div
        class="group/project relative flex h-8 min-w-0 items-center rounded-[6px] hover:bg-v2-background-bg-layer-01"
        classList={{ "bg-v2-background-bg-layer-01": active() }}
      >
        <button
          type="button"
          data-action="sidebar-v2-project-toggle"
          class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left"
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-muted">
            <IconV2
              name="chevron-down"
              size="small"
              class="transition-transform duration-150"
              style={{ transform: props.expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
            />
          </span>
          <ProjectAvatar
            fallback={displayName(props.project)}
            src={getProjectAvatarSource(props.project.id, props.project.icon)}
            variant={getProjectAvatarVariant(props.project.icon?.color)}
            unread={unseen() > 0}
          />
          <span class="min-w-0 flex-1 truncate text-v2-text-text-base [font-weight:530]">
            {displayName(props.project)}
          </span>
        </button>
        <div class="hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 group-hover/project:opacity-100">
          <MenuV2
            gutter={6}
            modal={false}
            placement="bottom-end"
            open={menuOpen.open}
            onOpenChange={(open) => setMenuOpen("open", open)}
          >
            <MenuV2.Trigger
              as={IconButtonV2}
              data-action="sidebar-v2-project-menu"
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name="outline-dots" />}
              aria-label={language.t("common.moreOptions")}
            />
            <MenuV2.Portal>
              <MenuV2.Content>
                <MenuV2.Item onSelect={() => props.onNewSession(props.project.worktree)}>
                  {language.t("command.session.new")}
                </MenuV2.Item>
                <MenuV2.Item onSelect={() => props.onEditProject(props.project)}>
                  {language.t("dialog.project.edit.title")}
                </MenuV2.Item>
                <MenuV2.Item onSelect={() => props.onCleanupSessions(props.project)}>
                  {language.t("sidebar.project.cleanupSessions")}
                </MenuV2.Item>
                <MenuV2.Separator />
                <MenuV2.Item onSelect={() => props.onCloseProject(props.project.worktree)}>
                  {language.t("common.close")}
                </MenuV2.Item>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
          <TooltipV2 class="flex shrink-0 items-center" placement="bottom" value={language.t("command.session.new")}>
            <IconButtonV2
              type="button"
              data-action="sidebar-v2-project-new-session"
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name="edit" />}
              aria-label={language.t("command.session.new")}
              onClick={() => props.onNewSession(props.project.worktree)}
            />
          </TooltipV2>
        </div>
      </div>
      <Show when={props.expanded}>
        <div class="flex min-w-0 flex-col gap-px pl-4">
          <NewSessionRow onClick={() => props.onNewSession(props.project.worktree)} label={language.t("command.session.new")} />
          <Show when={visibleSessions().length > 0 && serverKey()}>
            <For each={visibleSessions()}>
              {(session) => (
                <SessionRow
                  session={session}
                  project={props.project}
                  server={serverKey()!}
                  onOpen={(event) => props.onOpenSession(session, { background: isBackgroundOpen(event) })}
                />
              )}
            </For>
            <Show when={!showAll.value && hasMore()}>
              <ShowAllSessionsRow onClick={() => void showAllSessions()} label={language.t("sidebar.project.viewAllSessions")} />
            </Show>
            <Show when={showAll.value}>
              <ShowFewerSessionsRow onClick={showFewerSessions} label={language.t("sidebar.project.showFewerSessions")} />
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function NewSessionRow(props: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      data-component="sidebar-v2-session-row"
      data-action="sidebar-v2-new-session"
      class={`
        flex h-7 min-w-0 items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color] duration-[120ms] ease-in-out
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
      `}
      onClick={props.onClick}
    >
      <span class="shrink-0 flex size-4 items-center justify-center text-v2-icon-icon-muted">
        <IconV2 name="edit" size="small" />
      </span>
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
  )
}

function ShowAllSessionsRow(props: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      data-component="sidebar-v2-session-row"
      data-action="sidebar-v2-show-all-sessions"
      class={`
        flex h-7 min-w-0 items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color] duration-[120ms] ease-in-out
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
      `}
      onClick={props.onClick}
    >
      <span class="shrink-0 flex size-4 items-center justify-center text-v2-icon-icon-muted">
        <IconV2 name="chevron-down" size="small" />
      </span>
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
  )
}

function ShowFewerSessionsRow(props: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      data-component="sidebar-v2-session-row"
      data-action="sidebar-v2-show-fewer-sessions"
      class={`
        flex h-7 min-w-0 items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color] duration-[120ms] ease-in-out
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
      `}
      onClick={props.onClick}
    >
      <span class="shrink-0 flex size-4 items-center justify-center text-v2-icon-icon-muted">
        <IconV2 name="chevron-down" size="small" style={{ transform: "rotate(180deg)" }} />
      </span>
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
  )
}

function SessionRow(props: {
  session: Session
  project: LocalProject
  server: ServerConnection.Key
  onOpen: (event: MouseEvent) => void
}) {
  const layout = useLayout()
  const tabs = useTabs()
  const title = createMemo(() => sessionTitle(props.session.title) || props.session.id)
  const avatar = useSessionTabAvatarState(
    () => props.server,
    () => props.session.directory,
    () => props.session.id,
  )
  // Running sessions are reported by the server's session_working status.
  const running = avatar.loading
  const pending = avatar.pending
  // Unsent message: read the session tab's prompt memory. The prompt session is
  // created lazily when the tab is opened, so this only reflects tabs that have
  // been opened during this app run (in-memory tab memory). Reading tabs.store
  // keeps this reactive to tab open/close so the prompt is observed once the
  // tab exists.
  const unsent = createMemo(() => {
    void tabs.store
    const tab: SessionTab = { type: "session", server: props.server, sessionId: props.session.id }
    const prompt = tabs.stateValue<ReturnType<typeof createPromptSession>>(tab, "prompt")
    return prompt?.dirty() ?? false
  })
  const active = createMemo(() => {
    const route = layout.route()
    return route.type === "session" && route.sessionId === props.session.id
  })
  return (
    <button
      type="button"
      data-component="sidebar-v2-session-row"
      data-session-id={props.session.id}
      class={`
        flex h-7 min-w-0 items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left
        text-v2-text-text-muted [font-weight:440] transition-[background-color,color] duration-[120ms] ease-in-out
        hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base
      `}
      classList={{
        "bg-v2-background-bg-layer-03 text-v2-text-text-base": active(),
      }}
      aria-current={active() ? "page" : undefined}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onClick={(event) => props.onOpen(event)}
      onAuxClick={(event) => {
        if (!isBackgroundOpen(event)) return
        event.preventDefault()
        props.onOpen(event)
      }}
    >
      <span class="shrink-0 flex size-4 items-center justify-center">
        <SessionStatusIcon
          running={running()}
          pending={pending()}
          unsent={unsent()}
          active={active()}
          unread={avatar.unread()}
        />
      </span>
      <span class="min-w-0 flex-1 truncate">{title()}</span>
    </button>
  )
}

function SessionStatusIcon(props: {
  running: boolean
  pending: boolean
  unsent: boolean
  active: boolean
  unread: boolean
}) {
  // Unsent message takes precedence: show an edit icon so the user knows the
  // composer has text that hasn't been sent.
  return (
    <Show
      when={!props.unsent}
      fallback={
        <span
          class="flex size-4 items-center justify-center"
          classList={{
            "text-v2-icon-icon-muted": !props.active,
            "text-v2-icon-icon-base": props.active,
          }}
        >
          <IconV2 name="edit" size="small" />
        </span>
      }
    >
      <Show
        when={!props.running}
        fallback={
          // Running session: bright red blinking dot. Uses the fixed v2 red-600
          // token (theme-independent) so it stays vivid in both light and dark
          // mode instead of the theme's danger background (dark red / light pink).
          // The status-blink animation (fast opacity 0.15 -> 1) makes the dot
          // visibly blink so the user notices the session is running.
          <span class="flex size-4 items-center justify-center">
            <span class="size-1.5 rounded-full bg-[var(--v2-red-600)] animate-status-blink" />
          </span>
        }
      >
        <Show
          when={!props.pending}
          fallback={
            // Session is waiting for the user (permission request or question):
            // blue blinking dot so the user notices it needs their input.
            <span class="flex size-4 items-center justify-center">
              <span class="size-1.5 rounded-full bg-[var(--v2-blue-600)] animate-status-blink" />
            </span>
          }
        >
          <span
            class="flex size-4 items-center justify-center"
            classList={{
              "text-v2-icon-icon-muted": !props.active,
              "text-v2-icon-icon-base": props.active,
            }}
          >
            <span
              class="size-1.5 rounded-full"
              classList={{
                "bg-v2-icon-icon-muted": !props.unread && !props.active,
                "bg-v2-text-text-accent": props.unread || props.active,
              }}
            />
          </span>
        </Show>
      </Show>
    </Show>
  )
}

function DialogCleanupSessions(props: {
  project: LocalProject
  staleCountAccessor: () => Promise<number>
  onConfirm: () => Promise<void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ busy: false })
  const [staleCount] = createResource(() => props.staleCountAccessor())
  const count = () => staleCount() ?? 0
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("sidebar.project.cleanupSessions.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex w-full flex-col gap-4 px-4 pt-4 pb-1">
        <Show when={!staleCount.loading} fallback={<div class="h-5 w-24 rounded bg-v2-background-bg-layer-01 animate-pulse" />}>
          <div class="text-v2-text-text-base [font-weight:440]">
            {language.t("sidebar.project.cleanupSessions.confirm", { count: count() })}
          </div>
        </Show>
        <div class="text-[13px] leading-5 text-v2-text-text-muted [font-weight:440]">
          {language.t("sidebar.project.cleanupSessions.description")}
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" disabled={state.busy} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          type="button"
          variant="danger"
          disabled={state.busy || staleCount.loading || count() === 0}
          onClick={() => {
            setState("busy", true)
            void props.onConfirm().finally(() => {
              setState("busy", false)
              dialog.close()
            })
          }}
        >
          {language.t("sidebar.project.cleanupSessions.action")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
