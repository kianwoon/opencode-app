import { For, Show, createSignal } from "solid-js"
import { useMutation, useQuery } from "@tanstack/solid-query"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, type ServerConnection as ServerConnectionType } from "@/context/server"
import { DialogNewTask } from "@/components/dialog-new-task"
import { taskList, taskRemove, taskRun, taskUpdate, type TaskInfo } from "@/utils/task-api"

// Tasks section for the new-layout sidebar. Tasks are fetched from the
// instance-scoped /task endpoints via the shared raw-fetch helper (the
// vendored SDK does not ship them yet).

export function SidebarTasksV2(props: { server: ServerConnectionType.Any; directory: string }) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [open, setOpen] = createSignal(true)

  const fetch = () => platform.fetch ?? globalThis.fetch

  const query = useQuery(() => ({
    queryKey: ["tasks-v2", ServerConnection.key(props.server), props.directory],
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
    dialog.show(() => <DialogNewTask server={props.server} directory={props.directory} onCreated={invalidate} />)
  }

  // Hide the whole section while there are nothing to show — an empty
  // "No scheduled tasks" block just wastes sidebar space. Creation stays
  // available via the project 3-dots menu.
  const hasTasks = () => !!query.data?.length

  return (
    <Show when={hasTasks()}>
    <div class="flex flex-col" data-component="sidebar-v2-tasks">
      <div class="flex h-9 items-center gap-1 px-2">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1 px-1 text-v2-text-text-muted text-[13px] [font-weight:530] hover:text-v2-text-text-base"
          onClick={() => setOpen(!open())}
          aria-expanded={open()}
          data-component="sidebar-v2-tasks-trigger"
        >
          <IconV2
            name="chevron-down"
            class="shrink-0 transition-transform"
            style={{ transform: open() ? "rotate(0deg)" : "rotate(-90deg)" }}
          />
          <span class="truncate">{language.t("sidebar.tasks.title")}</span>
        </button>
        <TooltipV2 placement="bottom" value={language.t("sidebar.tasks.new")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="plus" />}
            aria-label={language.t("sidebar.tasks.new")}
            onClick={showNewTaskDialog}
          />
        </TooltipV2>
      </div>
      <Show when={open()}>
        <div class="flex min-w-0 flex-col gap-px px-2 pb-3" data-component="sidebar-v2-tasks-list">
          <Show
            when={!query.isPending}
            fallback={
              <div class="px-1 py-1 text-[13px] text-v2-text-text-muted [font-weight:440]">
                {language.t("sidebar.tasks.loading")}
              </div>
            }
          >
            <Show
              when={query.data?.length}
              fallback={
                <div class="px-1 py-1 text-[13px] text-v2-text-text-muted [font-weight:440]">
                  {language.t("sidebar.tasks.empty")}
                </div>
              }
            >
              <For each={query.data}>{(task) => <TaskRow task={task} />}</For>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
    </Show>
  )

  function TaskRow(props: { task: TaskInfo }) {
    return (
      <div
        class="group flex items-center gap-2 rounded-[6px] py-1 pl-2 pr-1 hover:bg-v2-surface-surface-raised-base-hover"
        data-component="sidebar-v2-tasks-row"
      >
        <IconV2
          name={props.task.enabled ? "status-active" : "status"}
          class={props.task.enabled ? "text-v2-icon-icon-success-base shrink-0" : "text-v2-icon-icon-weak-base shrink-0"}
        />
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] leading-4 text-v2-text-text-base [font-weight:440]">{props.task.title}</div>
          <div class="truncate text-[11px] leading-4 text-v2-text-text-muted [font-weight:440]">{props.task.cron}</div>
        </div>
        <div class="hidden items-center gap-0.5 group-hover:flex">
          <TooltipV2
            placement="top"
            value={props.task.enabled ? language.t("sidebar.tasks.pause") : language.t("sidebar.tasks.resume")}
          >
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name={props.task.enabled ? "collapse" : "expand"} />}
              aria-label={
                props.task.enabled ? language.t("sidebar.tasks.pause") : language.t("sidebar.tasks.resume")
              }
              onClick={() => toggle.mutate({ id: props.task.id, enabled: !props.task.enabled })}
            />
          </TooltipV2>
          <TooltipV2 placement="top" value={language.t("sidebar.tasks.runNow")}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name="outline-refresh" />}
              aria-label={language.t("sidebar.tasks.runNow")}
              onClick={() => run.mutate(props.task.id)}
            />
          </TooltipV2>
          <TooltipV2 placement="top" value={language.t("common.delete")}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name="outline-xmark" />}
              aria-label={language.t("common.delete")}
              onClick={() => remove.mutate(props.task.id)}
            />
          </TooltipV2>
        </div>
      </div>
    )
  }
}
