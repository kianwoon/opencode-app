import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { taskCreate, type TaskInfo } from "@/utils/task-api"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"

export const CRON_PRESETS = [
  { value: "hourly", labelKey: "dialog.task.cron.preset.hourly" },
  { value: "daily", labelKey: "dialog.task.cron.preset.daily" },
  { value: "weekly", labelKey: "dialog.task.cron.preset.weekly" },
  { value: "monthly", labelKey: "dialog.task.cron.preset.monthly" },
  { value: "custom", labelKey: "dialog.task.cron.preset.custom" },
] as const

export function createNewTaskModel(props: { server: ServerConnection.Any; directory: string; onCreated?: (task: TaskInfo) => void }) {
  const dialog = useDialog()
  const platform = usePlatform()

  const [store, setStore] = createStore({
    title: "",
    prompt: "",
    preset: "daily" as (typeof CRON_PRESETS)[number]["value"],
    cron: "0 9 * * *",
    error: "",
  })

  const cron = createMemo(() => (store.preset === "custom" ? store.cron.trim() : store.preset))

  const save = useMutation(() => ({
    mutationFn: async () => {
      const conn = props.server.http
      const fetch = platform.fetch ?? globalThis.fetch
      setStore("error", "")
      return taskCreate(conn, fetch, props.directory, {
        title: store.title.trim(),
        prompt: { text: store.prompt.trim() },
        cron: cron(),
        directory: props.directory,
      })
    },
    onSuccess: (task) => {
      dialog.close()
      props.onCreated?.(task)
    },
    onError: (error) => setStore("error", error instanceof Error ? error.message : String(error)),
  }))

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (save.isPending) return
    if (!store.title.trim() || !store.prompt.trim()) return
    save.mutate()
  }

  function close() {
    dialog.close()
  }

  return { store, setStore, save, submit, close }
}
