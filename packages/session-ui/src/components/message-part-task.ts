export type TaskSession = {
  id: string
  parentID?: string
  title: string
  time: {
    created?: number
    archived?: number
  }
}

export function resolveTaskSession(input: {
  metadata: Record<string, unknown> | undefined
  taskId?: unknown
  description: unknown
  agent: string | undefined
  parentID: string | undefined
  sessions: readonly TaskSession[] | undefined
}) {
  const value = input.metadata?.sessionId
  if (typeof value === "string" && value) return value
  // A task_id handoff names its target session in the tool INPUT, which is
  // written when the part is created — state.metadata.sessionId only lands at
  // completion, so without this the running card has no target to navigate to.
  const handoff = input.taskId
  if (typeof handoff === "string" && handoff) return handoff
  if (!input.parentID) return undefined
  // Core titles child sessions "<description> (@agent subagent)" with the raw
  // lowercase agent name, while the UI resolves display names capitalized —
  // compare case-insensitively or the fallback never matches.
  const description = typeof input.description === "string" ? input.description.toLowerCase() : ""
  const tag = input.agent ? `@${input.agent.toLowerCase()}` : ""
  return (input.sessions ?? [])
    .filter((session) => session.parentID === input.parentID && !session.time?.archived)
    .filter((session) => (description ? session.title.toLowerCase().startsWith(description) : true))
    .filter((session) => (tag ? session.title.toLowerCase().includes(tag) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}

export function navigateTaskSessionOnLeftClick(
  event: Pick<MouseEvent, "button" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "preventDefault">,
  navigate: () => void,
) {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  event.preventDefault()
  navigate()
}
