import type { SessionApi } from "@opencode-ai/client/promise"
import { normalizeSessionInfo } from "@/utils/session"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"

export async function loadRootSessions(input: { api: Pick<SessionApi, "list">; directory: string; limit: number }) {
  const result = await input.api.list({
    directory: input.directory,
    limit: input.limit,
    order: "desc",
  })
  return {
    data: result.data.map(normalizeSessionInfo),
    limit: input.limit,
    limited: true,
  } as const
}

export async function loadRootSessionsV1(input: { client: OpencodeClient; directory: string; limit: number }) {
  try {
    const result = await input.client.session.list({ directory: input.directory, limit: input.limit })
    return { data: result.data, limit: input.limit, limited: true } as const
  } catch {
    const result = await input.client.session.list({ directory: input.directory })
    return { data: result.data, limit: input.limit, limited: false } as const
  }
}

// A v1 list includes children, so a child already in the store (delivered by
// session.created) arrives twice and the sidebar renders it once per refetch.
export function mergeFetchedSessions(fetched: Session[], stored: Session[]) {
  return [...new Map([...stored, ...fetched].map((session) => [session.id, session])).values()]
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}
