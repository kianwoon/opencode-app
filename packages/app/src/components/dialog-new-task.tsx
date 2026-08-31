import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { createNewTaskModel, CRON_PRESETS } from "./new-task"

export function DialogNewTask(props: { server: Parameters<typeof createNewTaskModel>[0]["server"]; directory: string; onCreated?: Parameters<typeof createNewTaskModel>[0]["onCreated"] }) {
  const language = useLanguage()
  const model = createNewTaskModel(props)

  return (
    <Dialog title={language.t("dialog.task.new.title")} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={model.submit} class="flex flex-col gap-4 p-6 pt-0">
        <TextField
          autofocus
          type="text"
          label={language.t("dialog.task.title")}
          placeholder={language.t("dialog.task.title.placeholder")}
          value={model.store.title}
          onChange={(v) => model.setStore("title", v)}
        />

        <TextField
          type="text"
          multiline
          label={language.t("dialog.task.prompt")}
          placeholder={language.t("dialog.task.prompt.placeholder")}
          value={model.store.prompt}
          onChange={(v) => model.setStore("prompt", v)}
        />

        <div class="flex flex-col gap-2">
          <label class="text-12-medium text-text-weak">{language.t("dialog.task.cron")}</label>
          <div class="flex flex-wrap gap-1">
            <For each={[...CRON_PRESETS]}>
              {(preset) => (
                <Button
                  type="button"
                  variant={model.store.preset === preset.value ? "secondary" : "ghost"}
                  size="small"
                  onClick={() => model.setStore("preset", preset.value)}
                >
                  {language.t(preset.labelKey)}
                </Button>
              )}
            </For>
          </div>
          <Show when={model.store.preset === "custom"}>
            <TextField
              type="text"
              label={language.t("dialog.task.cron.expression")}
              placeholder="0 9 * * *"
              value={model.store.cron}
              onChange={(v) => model.setStore("cron", v)}
            />
          </Show>
        </div>

        <Show when={model.store.error}>
          <div class="text-12-regular text-text-error">{model.store.error}</div>
        </Show>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={model.close}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={model.save.isPending}>
            {model.save.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
