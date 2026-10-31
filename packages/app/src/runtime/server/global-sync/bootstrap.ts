import type { Config, Path, Project, ProviderAuthResponse } from "@/runtime/server/types"
import {
  isServiceUnavailableError,
  type ConfigGetOutput,
  type LocationGetInput,
  type LocationGetOutput,
  type ProjectListOutput,
} from "@opencode/client/promise"
import { showToast } from "@/shell/notifications/toast"
import { getFilename } from "@opencode/util/path"
import { retry } from "@opencode/util/retry"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State } from "./types"
import { normalizeProjectInfo } from "./utils"
import { formatServerError } from "@/runtime/server/errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import type { ServerScope } from "@/runtime/server/scope"
import { withWorktreeInventory, worktreeInventoryKey } from "@/workspaces/inventory"

type GlobalStore = {
  path: Path
  project: Project[]
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false

    const finish = () => {
      if (done) return
      done = true
      resolve()
    }

    const timer = setTimeout(finish, 50)

    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

// The merged global document, highest priority last. Shared with the settings panels' availability probe so
// "the server has agents" is read exactly the way the store reads them.
export const readConfigDocuments = (entries: ConfigGetOutput): Config =>
  Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : []))) as Config

export type ConfigRetryBudget = {
  /** Consumes one retry, returning false once the budget is spent. */
  readonly spend: () => boolean
  readonly reset: () => void
}

/**
 * One budget for the query's own retries and the store's connection recovery. A recovery `refetch()` restarts
 * TanStack's failureCount, so independent budgets multiplied (12 retries per refetch, per mechanism); sharing
 * one cap keeps a broken server at a single bounded set of requests per connection.
 */
export const createConfigRetryBudget = (max = 12): ConfigRetryBudget => {
  let used = 0

  return {
    spend() {
      if (used >= max) return false
      used += 1
      return true
    },
    reset() {
      used = 0
    },
  }
}

// A cold server refuses config while its instances activate, the same window the provider catalog retries
// (providers.ts syncWhileBooting). Retrying here keeps a transient refusal out of the cache: an error stored
// once would outlive every later handshake, because nothing re-runs a query that already failed.
export const retryConfigQuery = (budget: ConfigRetryBudget) => (failureCount: number, error: Error) =>
  (isServiceUnavailableError(error) || failureCount < 3) && budget.spend()

export const loadGlobalConfigQuery = (
  scope: ServerScope,
  config: { readonly get: () => Promise<ConfigGetOutput> },
  budget: ConfigRetryBudget = createConfigRetryBudget(),
) =>
  queryOptions({
    queryKey: [scope, "config"],
    // Settings writes are read-modify-write. Panels edit from the live documents, highest priority
    // last, so an edit starts from real state instead of a possibly-empty cache.
    queryFn: async (): Promise<Config> => readConfigDocuments(await config.get()),
    retry: retryConfigQuery(budget),
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  })

type ProjectApi = {
  readonly list: () => Promise<ProjectListOutput>
}

type LocationApi = { readonly get: (input?: LocationGetInput) => Promise<LocationGetOutput> }

// Metadata only, in the server's order (most recently active first). Worktree inventories load per project when a
// view shows it (see workspaces/inventory).
export const loadProjectsQuery = (scope: ServerScope, projects: ProjectApi) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        projects
          .list()
          .then((items) => items.flatMap((project) => (project?.id ? [normalizeProjectInfo(project)] : []))),
      ),
  })

export function loadProjects(input: {
  scope: ServerScope
  project: ProjectApi
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  return input.queryClient.fetchQuery(loadProjectsQuery(input.scope, input.project)).then((data) =>
    input.setGlobalStore(
      "project",
      data.map((project) =>
        withWorktreeInventory(project, input.queryClient.getQueryData(worktreeInventoryKey(input.scope, project.id))),
      ),
    ),
  )
}

export async function bootstrapGlobal(input: {
  serverAPI: {
    readonly location: LocationApi
    readonly project: ProjectApi
    readonly config: { readonly get: () => Promise<ConfigGetOutput> }
  }
  scope: ServerScope
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverAPI.config)),
    () =>
      input.queryClient
        .fetchQuery(loadPathQuery(input.scope, null, input.serverAPI.location))
        .then((data) => input.setGlobalStore("path", data)),
    () =>
      loadProjects({
        scope: input.scope,
        project: input.serverAPI.project,
        setGlobalStore: input.setGlobalStore,
        queryClient: input.queryClient,
      }),
  ]

  await runAll(slow)
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

export function inferHomeDirectory(path: string) {
  const normalized = path.replaceAll("\\", "/")
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/.exec(normalized)

  if (!match) return ""

  return path.includes("\\") ? match[1]!.replaceAll("/", "\\") : match[1]!
}

export const loadPathQuery = (scope: ServerScope, directory: string | null, api: LocationApi) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () =>
      api.get(directory ? { location: { directory } } : undefined).then((location) => ({
        state: "",
        config: "",
        worktree: location.project.directory,
        directory: location.directory,
        home: inferHomeDirectory(location.directory) || inferHomeDirectory(location.project.directory),
      })),
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  api: {
    readonly project: ProjectApi
    readonly location: LocationApi
  }
  store: Store<State>
  setStore: SetStoreFunction<State>
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
  }
  queryClient: QueryClient
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)

  if (seededProject) input.setStore("project", seededProject)

  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }

  if (loading) input.setStore("status", "partial")

  const slow = [
    seededProject
      ? undefined
      : () =>
          retry(() => input.api.location.get({ location: { directory: input.directory } })).then((location) =>
            input.setStore("project", location.project.id),
          ),
  ].filter((task): task is () => Promise<void> => !!task)

  await waitForPaint()
  const slowErrs = errors(await runAll(slow))

  if (slowErrs.length > 0) {
    console.error("Failed to finish bootstrap instance", slowErrs[0])
    const project = getFilename(input.directory)
    showToast({
      variant: "error",
      title: input.translate("toast.project.reloadFailed.title", { project }),
      description: formatServerError(slowErrs[0], input.translate),
    })
  }

  if (loading && slowErrs.length === 0) input.setStore("status", "complete")
}
