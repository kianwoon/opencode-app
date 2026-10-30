import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

// Task endpoints are new and not part of the vendored SDK yet, so this module
// issues raw fetches against the instance HTTP API with Basic auth headers.

export interface TaskInfo {
  id: string
  title: string
  prompt: { text: string }
  cron: string
  enabled: boolean
  sessionID?: string
  directory: string
  next_run_at?: number
  last_run_at?: number
  missed_runs: number
  run_count: number
  time_created: number
  time_updated: number
}

export interface TaskRunInfo {
  id: string
  taskID: string
  sessionID: string
  status: "running" | "completed" | "failed" | "skipped"
  started_at: number
  ended_at?: number
  error?: string
}

function headers(server: ServerConnection.HttpBase) {
  if (!server.password) return
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

function taskUrl(server: ServerConnection.HttpBase, path: string, directory: string) {
  const url = new URL(path, server.url)
  url.searchParams.set("directory", directory)
  return url
}

async function request(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  path: string,
  directory: string,
  init?: RequestInit,
) {
  const response = await fetch(taskUrl(server, path, directory), {
    ...init,
    headers: { ...headers(server), "Content-Type": "application/json" },
  })
  if (!response.ok) throw new Error(`Task request failed: ${response.status} ${path}`)
  const value: unknown = await response.json().catch(() => undefined)
  return value
}

export function taskList(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  directory: string,
) {
  return request(server, fetch, "/task", directory).then((value) => (value ?? []) as TaskInfo[])
}

export function taskRuns(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  directory: string,
  taskID: string,
) {
  return request(server, fetch, `/task/${taskID}/runs`, directory).then(
    (value) => (value ?? []) as TaskRunInfo[],
  )
}

export interface TaskCreateInput {
  title: string
  prompt: { text: string }
  cron: string
  directory: string
  enabled?: boolean
  sessionID?: string
}

export function taskCreate(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  directory: string,
  input: TaskCreateInput,
) {
  return request(server, fetch, "/task", directory, {
    method: "POST",
    body: JSON.stringify(input),
  }).then((value) => value as TaskInfo)
}

export interface TaskUpdateInput {
  title?: string
  prompt?: { text: string }
  cron?: string
  enabled?: boolean
  directory?: string
}

export function taskUpdate(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  directory: string,
  taskID: string,
  input: TaskUpdateInput,
) {
  return request(server, fetch, `/task/${taskID}`, directory, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((value) => value as TaskInfo)
}

export function taskRemove(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  directory: string,
  taskID: string,
) {
  return request(server, fetch, `/task/${taskID}`, directory, { method: "DELETE" }).then(
    () => undefined,
  )
}

export function taskRun(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  directory: string,
  taskID: string,
) {
  return request(server, fetch, `/task/${taskID}/run`, directory, { method: "POST" }).then(
    () => undefined,
  )
}
