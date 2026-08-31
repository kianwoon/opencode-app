import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useMutation, useQuery } from "@tanstack/solid-query"
import { createSignal, For, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { DialogNewTask } from "@/components/dialog-new-task"
import { taskList, taskRemove, taskRun, taskUpdate } from "@/utils/task-api"

export function SidebarTasks(props: { server: ServerConnection.Any; directory: string }) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [open, setOpen] = createSignal(true)

  const fetch = () => platform.fetch ?? globalThis.fetch

  const query = useQuery(() => ({
    queryKey: ["tasks", ServerConnection.key(props.server), props.directory],
    queryFn: () => taskList(props.server.http, fetch(), props.directory),
    refetchInterval: 30_000,
  }))

  const invalidate = () => query.refetch()

  const toggle = useMutation(() => ({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      taskUpdate(props.server.http, fetch(), props.directory, input.id, { enabled: input.enabled }),
    onSuccess: invalidate,
  }))

  const run = useMutation(() => ({
    mutationFn: (id: string) => taskRun(props.server.http, fetch(), props.directory, id),
    onSuccess: invalidate,
  }))

  const remove = useMutation(() => ({
    mutationFn: (id: string) => taskRemove(props.server.http, fetch(), props.directory, id),
    onSuccess: invalidate,
  }))

  function showNewTaskDialog() {
    dialog.show(() => (
      <DialogNewTask server={props.server} directory={props.directory} onCreated={invalidate} />
    ))
  }

  return (
    <Collapsible variant="ghost" open={open()} onOpenChange={setOpen} class="shrink-0">
      <div class="flex items-center justify-between pl-1 pr-1 py-1">
        <Collapsible.Trigger
          class="flex items-center gap-1 text-12-medium text-text-weak hover:text-text-strong"
          data-component="sidebar-tasks-trigger"
        >
          <Icon name={open() ? "chevron-down" : "chevron-right"} size="small" />
          {language.t("sidebar.tasks.title")}
        </Collapsible.Trigger>
        <IconButton icon="plus" size="small" variant="ghost" onClick={showNewTaskDialog} aria-label={language.t("sidebar.tasks.new")} />
      </div>
      <Collapsible.Content>
        <div class="flex flex-col gap-0.5 pb-1" data-component="sidebar-tasks-list">
          <Show when={!query.isPending} fallback={<div class="py-1 pl-1 text-12-regular text-text-weak">{language.t("sidebar.tasks.loading")}</div>}>
            <Show when={query.data?.length} fallback={<div class="py-1 pl-1 text-12-regular text-text-weak">{language.t("sidebar.tasks.empty")}</div>}>
              <For each={query.data}>
                {(task) => (
                  <div
                    class="group flex items-center gap-2 py-1 px-1 rounded-md hover:bg-surface-raised-base-hover"
                    data-component="sidebar-tasks-row"
                  >
                    <Icon name={task.enabled ? "circle-check" : "circle-ban-sign"} size="small" class={task.enabled ? "text-icon-success-base" : "text-icon-weak-base"} />
                    <div class="flex-1 min-w-0">
                      <div class="text-14-regular text-text-strong truncate">{task.title}</div>
                      <div class="text-11-regular text-text-weak truncate">{task.cron}</div>
                    </div>
                    <div class="hidden group-hover:flex items-center gap-0.5">
                      <IconButton
                        icon={task.enabled ? "stop" : "arrow-right"}
                        size="small"
                        variant="ghost"
                        aria-label={task.enabled ? language.t("sidebar.tasks.pause") : language.t("sidebar.tasks.resume")}
                        onClick={() => toggle.mutate({ id: task.id, enabled: !task.enabled })}
                      />
                      <IconButton icon="arrow-right" size="small" variant="ghost" aria-label={language.t("sidebar.tasks.runNow")} onClick={() => run.mutate(task.id)} />
                      <IconButton icon="trash" size="small" variant="ghost" aria-label={language.t("common.delete")} onClick={() => remove.mutate(task.id)} />
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}
