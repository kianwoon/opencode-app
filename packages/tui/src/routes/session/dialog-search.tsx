import { createMemo, onMount } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { Locale } from "../../util/locale"

function messageText(parts: readonly Part[]): string {
  return parts
    .map((part) => {
      if (part.type === "text" && !part.synthetic && !part.ignored) return part.text
      return null
    })
    .filter(Boolean)
    .join("\n\n")
}

export function DialogSearch(props: { sessionID: string; onMove: (messageID: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      const parts = sync.data.part[message.id] ?? []
      const text = messageText(parts)
      if (!text.trim()) continue
      result.push({
        title: text.replace(/\n/g, " "),
        value: message.id,
        description: message.role === "user" ? "user" : "assistant",
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => dialog.clear(),
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect
      onMove={(option) => props.onMove(option.value)}
      title="Search Messages"
      placeholder="Search messages..."
      options={options()}
    />
  )
}
