import { createMemo, onMount } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { Locale } from "../../util/locale"

/** Text a message contributes to search. Synthetic and non-conversational
 *  message types carry no searchable prose, so they contribute none. */
function messageText(message: ReturnType<ReturnType<typeof useData>["session"]["message"]["list"]>[number]): string {
  if (message.type === "user") return message.text
  if (message.type !== "assistant") return ""
  return message.content
    .map((part) => (part.type === "text" ? part.text : null))
    .filter((text) => text !== null)
    .join("\n\n")
}

export function DialogSearch(props: { sessionID: string; onMove: (messageID: string) => void }) {
  const data = useData()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = data.session.message.list(props.sessionID)
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      const text = messageText(message)
      if (!text.trim()) continue
      result.push({
        title: text.replace(/\n/g, " "),
        value: message.id,
        description: message.type === "user" ? "user" : "assistant",
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
