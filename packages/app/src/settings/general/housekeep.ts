import type { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"

type Translator = ReturnType<typeof useLanguage>["t"]

type Housekeep = (days: number) => Promise<{ before: number; after: number; pruned: number }>

// Time-based retention: delete sessions older than the requested window
// (messages/parts cascade) then compact. Desktop-only capability.
export async function pruneSessions(t: Translator, housekeep: Housekeep, days: number) {
  try {
    showToast({ title: t("sidebar.housekeep.started") })
    const { pruned, before, after } = await housekeep(days)
    if (pruned === 0) {
      showToast({ title: t("sidebar.housekeep.none", { days }) })
      return
    }
    const saved = Math.max(0, before - after)
    const savedLabel =
      saved >= 1_073_741_824
        ? `${(saved / 1_073_741_824).toFixed(1)} GB`
        : saved >= 1_048_576
          ? `${(saved / 1_048_576).toFixed(1)} MB`
          : `${(saved / 1024).toFixed(0)} KB`
    showToast({
      title: t("sidebar.housekeep.done"),
      description: t("sidebar.housekeep.result", { count: pruned, saved: savedLabel }),
    })
  } catch {
    showToast({ title: t("sidebar.housekeep.error") })
  }
}
