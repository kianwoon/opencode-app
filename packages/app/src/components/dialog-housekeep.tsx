// baseline-guard:allow new file, no prior baseline exists
import { createSignal, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

const MAX_DAYS = 3650

export function DialogHousekeep(props: { onConfirm: (days: number) => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const days = () => (/^\d+$/.test(value()) ? Number(value()) : 0)
  const valid = () => days() > 0 && days() <= MAX_DAYS

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!valid() || busy()) return
    setBusy(true)
    try {
      await props.onConfirm(days())
      dialog.close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{language.t("sidebar.housekeep.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody class="flex w-full flex-col gap-4 px-4 pt-4 pb-1">
          <div class="text-[13px] leading-5 text-v2-text-text-muted [font-weight:440]">
            {language.t("sidebar.housekeep.description")}
          </div>
          <label class="flex flex-col gap-1.5">
            <span class="text-12-medium text-v2-text-text-muted">{language.t("sidebar.housekeep.days")}</span>
            <input
              autofocus
              type="number"
              min="1"
              max={MAX_DAYS}
              step="1"
              inputmode="numeric"
              value={value()}
              onInput={(event) => setValue(event.currentTarget.value)}
              class="w-full rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-layer-01 px-3 py-2 text-[13px] text-v2-text-text-base outline-none"
            />
          </label>
          <Show when={value() !== "" && !valid()}>
            <div class="text-12-regular text-text-danger-base">
              {language.t("sidebar.housekeep.invalid")}
            </div>
          </Show>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" disabled={busy()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="danger" disabled={!valid() || busy()}>
            {language.t("sidebar.housekeep.confirm")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
