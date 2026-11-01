// baseline-guard:allow new file created by this task; no prior baseline exists
import { createStore } from "solid-js/store"

/**
 * Write-through state for one select control whose display is derived from a
 * server resource: an independently mounted Select cannot show its own write
 * until the resource it reads round-trips, so the panel would read a stale value
 * (and re-render correctly only after a remount). The draft holds the optimistic
 * value per agent — "" is an explicit inherit — and is dropped if the write
 * rejects, so the control falls back to the resource's truth instead of lying.
 *
 * Keyed by agent name rather than cleared on selection: a draft for another agent
 * is never read, so switching agents cannot leak a value.
 */
export function createEffortSelection(input: {
  name: () => string
  value: () => string | undefined
  commit: (effort: string) => Promise<unknown>
}) {
  const [draft, setDraft] = createStore<Record<string, string | undefined>>({})
  return {
    value() {
      const current = draft[input.name()]
      if (current !== undefined) return current === "" ? undefined : current
      return input.value()
    },
    /** Apply the choice immediately, then write; a failed write reverts to the resource's value. */
    select(effort: string | undefined) {
      const name = input.name()
      if (name === "") return Promise.resolve()
      const written = effort ?? ""
      setDraft(name, written)
      return Promise.resolve(input.commit(written)).catch(() => {
        if (draft[name] === written) setDraft(name, undefined)
      })
    },
  }
}
