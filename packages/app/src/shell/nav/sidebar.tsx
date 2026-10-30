import { For, Show, createMemo, createEffect, on, startTransition, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import {
  ProjectAvatar,
  displayName,
  getProjectAvatarSource,
  getProjectAvatarVariant,
} from "@opencode/ui/project-avatar"
import { ScrollView } from "@opencode/ui/scroll-view"
import { useDialog } from "@opencode/ui/context/dialog"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useTabs, type SessionTab } from "@/shell/tabs/tabs"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { useSettingsCommand } from "@/settings/command"
import { useSettingsSurface } from "@/settings/surface"
import { useSettings } from "@/settings/model"
import { useLayout } from "@/shell/state/layout"
import { useCommand } from "@/shell/commands/command"
import { useSessionTabAvatarState, sessionBusy } from "@/shell/layout/project-avatar-state"
import { compareSessionTime } from "@/shell/layout/helpers"
import { sessionTitle } from "@/session/title"
import { pathKey } from "@/workspaces/path-key"
import { shouldOpenSessionInBackground } from "@/home/sessions/open"
import { addProjects } from "@/home/projects/add"
import { mergeHomeSessionIndex } from "@/home/sessions/index"
import { homeSessionsQuery } from "@/home/sessions/queries"
import type { ComposerState } from "@/composer/state"
import type { LocalProject } from "@/shell/state/layout"
import type { SessionInfo } from "@opencode/client/promise"
import { SidebarTasks } from "./sidebar-tasks"
import { DialogNewTask } from "./dialog-new-task"

// Number of sessions shown in a project before the user expands. The fetched
// index keeps more, so "View all" is a local slice rather than another load.
const DEFAULT_SESSION_LIMIT = 5
// Number of most recent child sessions shown beneath the active root.
const CHILD_SESSION_LIMIT = 3

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

/**
 * The fork's left navigation: project grouping, each project's root sessions,
 * their subagents under the active one, and every project action.
 *
 * One panel is shown at a time; the shell owns the dock/collapse motion around
 * it. Server and project selection follow the route first, then Home's
 * selection, so the panel always describes what the main area shows.
 */
export function NavSidebar(props: { expanded?: Accessor<boolean> }) {
  const servers = useServers()
  const global = useGlobal()
  const layout = useLayout()
  const tabs = useTabs()
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const command = useCommand()
  const pickDirectory = useDirectoryPicker()
  const openSettings = useSettingsCommand()
  const settings = useSettingsSurface()
  const preferences = useSettings()

  const currentServer = createMemo<ServerConnection.Any | undefined>(() => {
    const route = layout.route()
    const key = route.type === "session" ? route.server : layout.home.selection().server
    return servers.list.find((item) => ServerConnection.key(item) === key) ?? servers.visible[0]
  })

  const ctx = createMemo(() => {
    const conn = currentServer()
    return conn ? global.ensureServerCtx(conn) : undefined
  })

  const sessionQuery = useQuery(() => {
    const conn = currentServer()
    const context = ctx()

    return {
      ...homeSessionsQuery(conn, context),
      enabled: !!conn && !!context && context.sdk.connection.status() === "connected",
    }
  })

  // Fetched index first, then everything the event stream has already taught
  // us, so a freshly opened session shows before the query refreshes.
  const sessions = createMemo(() =>
    mergeHomeSessionIndex(
      sessionQuery.isPending ? [] : (sessionQuery.data?.() ?? []),
      ctx()?.data.session.list() ?? [],
    ).toSorted(compareSessionTime),
  )

  const projects = createMemo(() => ctx()?.projects.used() ?? [])

  const serverKey = createMemo(() => {
    const conn = currentServer()
    return conn ? ServerConnection.key(conn) : undefined
  })

  const activeDirectory = createMemo(() => {
    const route = layout.route()
    if (route.type !== "session") return undefined
    return ctx()?.data.session.get(route.sessionId)?.location.directory
  })

  const directories = (project: LocalProject) => [project.worktree, ...(project.sandboxes ?? [])]

  const projectSessions = (project: LocalProject) => {
    const keys = new Set(directories(project).map(pathKey))
    return sessions().filter((session) => keys.has(pathKey(session.location.directory)))
  }

  const childSessions = (rootId: string) => {
    const data = ctx()?.data
    if (!data) return []
    return data.session
      .list()
      .filter((session) => session.parentID === rootId && data.session.root(session.id) === rootId)
      .toSorted(compareSessionTime)
      .slice(0, CHILD_SESSION_LIMIT)
  }

  const projectBusy = (project: LocalProject) => {
    const data = ctx()?.data
    if (!data) return false
    return projectSessions(project).some((session) =>
      [session.id, ...data.session.family(session.id)].some((id) => sessionBusy(data, id)),
    )
  }

  const projectUnread = (project: LocalProject) => {
    const notification = ctx()?.notification
    if (!notification) return false
    return directories(project).some((directory) => notification.project.hasUnread(directory))
  }

  const markProjectViewed = (project: LocalProject) => {
    const notification = ctx()?.notification
    if (!notification) return
    for (const directory of directories(project)) notification.project.markViewed(directory)
  }

  const expanded = () => props.expanded?.() ?? true

  const [projectExpanded, setProjectExpanded] = createStore({} as Record<string, boolean>)
  const expandedFor = (project: LocalProject) => projectExpanded[project.worktree] ?? true
  const toggleExpanded = (worktree: string) =>
    setProjectExpanded(worktree, !(projectExpanded[worktree] ?? true))

  function openProjectNewSession(project: LocalProject) {
    const conn = currentServer()
    if (!conn) return
    global.ensureServerCtx(conn).projects.touch(project.worktree)
    void tabs.newDraft({ server: ServerConnection.key(conn), directory: project.worktree })
  }

  function openSession(session: SessionInfo, options?: { background?: boolean }) {
    const conn = currentServer()
    if (!conn) return
    const key = ServerConnection.key(conn)
    const serverCtx = global.ensureServerCtx(conn)
    const directory = session.location.directory
    serverCtx.projects.touch(directory)
    const open = () => {
      const tab = tabs.addSessionTab({ server: key, sessionId: session.id })
      if (!options?.background) tabs.select(tab)
    }
    if (options?.background) {
      open()
      return
    }
    void startTransition(open)
  }

  function addProject() {
    const conn = currentServer()
    if (!conn) return
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        if (!result) return
        const list = Array.isArray(result) ? result : [result]
        void addProjects(global.ensureServerCtx(conn), list)
      },
    })
  }

  function editProject(project: LocalProject) {
    const conn = currentServer()
    if (!conn) return
    settings.openProject({ server: ServerConnection.key(conn), project: project.worktree })
  }

  function hideProject(project: LocalProject) {
    const conn = currentServer()
    if (!conn) return
    global.ensureServerCtx(conn).projects.hide(project)
  }

  function housekeep() {
    command.trigger("session.housekeep")
  }

  function newTask(project: LocalProject) {
    const conn = currentServer()
    if (!conn) return
    void dialog.show(() => <DialogNewTask server={conn} directory={project.worktree} />)
  }

  function togglePanel() {
    preferences.appearance.setSidebarOpen(!preferences.appearance.sidebarOpen())
  }

  // Opening a project marks its notifications read, as the fork's sidebar did.
  createEffect(
    on(activeDirectory, (directory) => {
      if (!directory) return
      const project = projects().find((item) =>
        directories(item).some((candidate) => pathKey(candidate) === pathKey(directory)),
      )
      if (!project) return
      markProjectViewed(project)
    }),
  )

  return (
    <nav
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
      data-component="sidebar-v2"
      class="relative flex h-full min-h-0 min-w-0 flex-col shrink-0 bg-v2-background-bg-deep"
    >
      <div class="shrink-0 flex h-9 items-center gap-1 px-2">
        <div class="min-w-0 flex-1 px-1 text-v2-text-text-muted text-[13px] [font-weight:530] truncate">
          {language.t("home.projects")}
        </div>
        <Tooltip placement="bottom" value={language.t("home.project.add")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="folder-add-left" />}
            aria-label={language.t("home.project.add")}
            onClick={addProject}
          />
        </Tooltip>
      </div>
      <div class="flex-1 min-h-0 min-w-0">
        <ScrollView class="h-full">
          <div class="flex min-w-0 flex-col gap-px px-2 pb-3">
            <Show
              when={projects().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-3 px-3 pt-8 text-center">
                  <div class="text-v2-text-text-base [font-weight:530]">{language.t("sidebar.empty.title")}</div>
                  <p class="text-[13px] leading-5 text-v2-text-text-muted [font-weight:440]">
                    {language.t("sidebar.empty.description")}
                  </p>
                  <IconButton
                    type="button"
                    variant="neutral"
                    size="normal"
                    icon={<Icon name="folder-add-left" />}
                    onClick={addProject}
                  >
                    {language.t("command.project.open")}
                  </IconButton>
                </div>
              }
            >
              <For each={projects()}>
                {(project) => (
                  <ProjectSection
                    project={project}
                    name={displayName(project)}
                    expanded={expandedFor(project)}
                    onToggle={() => toggleExpanded(project.worktree)}
                    sessions={projectSessions(project)}
                    activeDirectory={activeDirectory()}
                    server={serverKey()}
                    connection={currentServer()}
                    busy={projectBusy(project)}
                    unread={projectUnread(project)}
                    childSessions={childSessions}
                    onOpenSession={openSession}
                    onNewSession={() => openProjectNewSession(project)}
                    onNewTask={() => newTask(project)}
                    onEdit={() => editProject(project)}
                    onHide={() => hideProject(project)}
                  />
                )}
              </For>
            </Show>
          </div>
        </ScrollView>
      </div>
      <div class="shrink-0 flex items-center gap-1 px-2 py-1.5 border-t border-v2-border-border-base">
        <Tooltip placement="top" value={language.t("sidebar.housekeep")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="outline-trash" />}
            aria-label={language.t("sidebar.housekeep")}
            onClick={housekeep}
          />
        </Tooltip>
        <Tooltip placement="top" value={language.t("sidebar.settings")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="settings-gear" />}
            aria-label={language.t("sidebar.settings")}
            onClick={openSettings}
          />
        </Tooltip>
        <div class="flex-1" />
        <Tooltip placement="top" value={language.t("sidebar.help")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name="outline-arrow-up-right" />}
            aria-label={language.t("sidebar.help")}
            onClick={() => platform.openExternal("https://opencode.ai/desktop-feedback")}
          />
        </Tooltip>
        <Tooltip placement="top" value={language.t("command.sidebar.toggle")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<Icon name={expanded() ? "outline-arrow-left" : "outline-arrow-right"} />}
            aria-label={language.t("command.sidebar.toggle")}
            onClick={togglePanel}
          />
        </Tooltip>
      </div>
    </nav>
  )
}

function ProjectSection(props: {
  project: LocalProject
  name: string
  expanded: boolean
  onToggle: () => void
  sessions: SessionInfo[]
  activeDirectory: string | undefined
  server: ServerConnection.Key | undefined
  connection: ServerConnection.Any | undefined
  busy: boolean
  unread: boolean
  childSessions: (rootId: string) => SessionInfo[]
  onOpenSession: (session: SessionInfo, options?: { background?: boolean }) => void
  onNewSession: () => void
  onNewTask: () => void
  onEdit: () => void
  onHide: () => void
}) {
  const language = useLanguage()
  const layout = useLayout()
  const [menuOpen, setMenuOpen] = createStore({ open: false })
  const [showAll, setShowAll] = createStore({ value: false })

  const active = () => pathKey(props.activeDirectory ?? "") === pathKey(props.project.worktree)
  const visibleSessions = () =>
    showAll.value ? props.sessions : props.sessions.slice(0, DEFAULT_SESSION_LIMIT)
  const hasMore = () => props.sessions.length > visibleSessions().length
  const activeSessionId = createMemo(() => {
    const route = layout.route()
    return route.type === "session" ? route.sessionId : undefined
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
            <Icon
              name="chevron-down"
              size="small"
              class="transition-transform duration-150"
              style={{ transform: props.expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
            />
          </span>
          <span class="relative flex size-4 shrink-0 items-center justify-center">
            <ProjectAvatar
              fallback={props.name}
              src={getProjectAvatarSource(props.project.id, props.project.icon)}
              variant={getProjectAvatarVariant(props.project.icon?.color)}
              unread={props.unread}
            />
            <Show when={props.busy}>
              <span
                data-slot="project-avatar-busy-dot"
                aria-hidden="true"
                class="pointer-events-none absolute -top-0.5 -left-0.5 size-1.5 rounded-full bg-[var(--v2-red-600)] animate-status-blink"
              />
            </Show>
          </span>
          <span class="min-w-0 flex-1 truncate text-v2-text-text-base [font-weight:530]">{props.name}</span>
        </button>
        <div class="hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 group-hover/project:opacity-100">
          <Menu
            gutter={6}
            modal={false}
            placement="bottom-end"
            open={menuOpen.open}
            onOpenChange={(open) => setMenuOpen("open", open)}
          >
            <Menu.Trigger
              as={IconButton}
              data-action="sidebar-v2-project-menu"
              variant="ghost-muted"
              size="small"
              icon={<Icon name="outline-dots" />}
              aria-label={language.t("common.moreOptions")}
            />
            <Menu.Portal>
              <Menu.Content>
                <Menu.Item onSelect={props.onNewSession}>{language.t("command.session.new")}</Menu.Item>
                <Menu.Item onSelect={props.onNewTask}>{language.t("sidebar.tasks.new")}</Menu.Item>
                <Menu.Item onSelect={props.onEdit}>{language.t("dialog.project.edit.title")}</Menu.Item>
                <Menu.Separator />
                <Menu.Item onSelect={props.onHide}>{language.t("sidebar.project.hide")}</Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </div>
      </div>
      <Show when={props.expanded}>
        <div class="flex min-w-0 flex-col gap-px pl-4">
          <Show when={props.connection}>
            {(connection) => <SidebarTasks server={connection()} directory={props.project.worktree} />}
          </Show>
          <Show when={visibleSessions().length > 0 && props.server}>
            {(server) => (
              <For each={visibleSessions()}>
                {(session) => (
                  <>
                    <SessionRow
                      session={session}
                      server={server()}
                      active={session.id === activeSessionId()}
                      onOpen={(event) => props.onOpenSession(session, { background: isBackgroundOpen(event) })}
                    />
                    <Show when={session.id === activeSessionId()}>
                      <div class="flex min-w-0 flex-col gap-px pl-4">
                        <For each={props.childSessions(session.id)}>
                          {(child) => (
                            <SessionRow
                              session={child}
                              server={server()}
                              active={child.id === activeSessionId()}
                              onOpen={(event) =>
                                props.onOpenSession(child, { background: isBackgroundOpen(event) })
                              }
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                  </>
                )}
              </For>
            )}
          </Show>
          <Show when={!showAll.value && hasMore()}>
            <ShowAllSessionsRow
              onClick={() => setShowAll("value", true)}
              label={language.t("sidebar.project.viewAllSessions")}
            />
          </Show>
          <Show when={showAll.value}>
            <ShowFewerSessionsRow
              onClick={() => setShowAll("value", false)}
              label={language.t("sidebar.project.showFewerSessions")}
            />
          </Show>
        </div>
      </Show>
    </div>
  )
}

function SessionRow(props: {
  session: SessionInfo
  server: ServerConnection.Key
  active: boolean
  onOpen: (event: MouseEvent) => void
}) {
  const tabs = useTabs()
  const avatar = useSessionTabAvatarState(
    () => props.server,
    () => props.session.id,
    () => true,
    () => props.session,
  )
  const title = createMemo(() => sessionTitle(props.session.title) || props.session.id)
  // Unsent message: read the session tab's prompt memory. The prompt state is
  // created lazily when the tab is opened, so this only reflects tabs opened
  // during this app run; reading tabs.store keeps it reactive to open/close.
  const unsent = createMemo(() => {
    void tabs.store
    const tab: SessionTab = { type: "session", server: props.server, sessionId: props.session.id }
    const prompt = tabs.stateValue<ComposerState>(tab, "prompt")?.current()
    if (!prompt?.length) return false
    return prompt.some((part) => (part.type === "text" ? part.content.trim().length > 0 : true))
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
        "bg-v2-background-bg-layer-03 text-v2-text-text-base": props.active,
      }}
      aria-current={props.active ? "page" : undefined}
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
          running={avatar.loading()}
          pending={avatar.attention()}
          unsent={unsent()}
          active={props.active}
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
  // Running wins over the unsent draft marker: the session holding a half-typed
  // message is exactly the one the user is watching, so it must still show that
  // work is in flight.
  return (
    <Show
      when={!props.running}
      fallback={
        <span class="flex size-4 items-center justify-center">
          <span class="size-3 rounded-full bg-[var(--v2-red-600)] animate-status-blink" />
        </span>
      }
    >
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
            <Icon name="outline-text" size="small" />
          </span>
        }
      >
        <Show
          when={!props.pending}
          fallback={
            <span class="flex size-4 items-center justify-center">
              <span class="size-3 rounded-full bg-[var(--v2-blue-600)] animate-status-blink" />
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
        <Icon name="chevron-down" size="small" />
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
        <Icon name="chevron-down" size="small" style={{ transform: "rotate(180deg)" }} />
      </span>
      <span class="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
  )
}
