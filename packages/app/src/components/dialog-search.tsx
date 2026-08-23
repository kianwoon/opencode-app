import { Component, createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"

export interface SessionSearchItem {
  id: string
  text: string
  role: "user" | "assistant"
  time: string
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

function isSearchableText(part: Part): part is TextPart {
  return part.type === "text" && !part.synthetic && !part.ignored
}

export const DialogSearch: Component<{
  onSelect: (item: SessionSearchItem) => void
}> = (props) => {
  const params = useParams()
  const sync = useSync()
  const language = useLanguage()
  const dialog = useDialog()

  const items = createMemo((): SessionSearchItem[] => {
    const sessionID = params.id
    if (!sessionID) return []

    const messages = sync().data.message[sessionID] ?? []
    const result: SessionSearchItem[] = []

    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue
      const parts = sync().data.part[message.id] ?? []
      const text = parts
        .filter(isSearchableText)
        .map((part) => part.text)
        .filter((value) => !!value?.trim())
        .join("\n\n")
      if (!text.trim()) continue
      result.push({
        id: message.id,
        text: text.replace(/\n/g, " "),
        role: message.role,
        time: formatTime(new Date(message.time.created)),
      })
    }

    return result.reverse()
  })

  return (
    <Dialog title={language.t("command.session.search")}>
      <List
        class="flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.search.empty")}
        key={(x) => x.id}
        items={items}
        filterKeys={["text", "role"]}
        onSelect={(item) => {
          if (!item) return
          dialog.close()
          props.onSelect(item)
        }}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span
              classList={{
                "shrink-0 text-[11px] font-medium uppercase": true,
                "text-text-weak": true,
              }}
            >
              {item.role === "user" ? language.t("context.breakdown.user") : language.t("context.breakdown.assistant")}
            </span>
            <span class="truncate flex-1 min-w-0 text-left font-normal">{item.text}</span>
            <span class="text-text-weak shrink-0 font-normal">{item.time}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
