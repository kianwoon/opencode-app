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
  description: unknown
  agent: string | undefined
  parentID: string | undefined
  sessions: readonly TaskSession[] | undefined
}) {
  const value = input.metadata?.sessionId
  if (typeof value === "string" && value) return value
  if (!input.parentID) return undefined
  const description = typeof input.description === "string" ? input.description : ""
  return (input.sessions ?? [])
    .filter((session) => session.parentID === input.parentID && !session.time?.archived)
    .filter((session) => (description ? session.title.startsWith(description) : true))
    .filter((session) => (input.agent ? session.title.includes(`@${input.agent}`) : true))
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
