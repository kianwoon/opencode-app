import { useDialog } from "@opencode/ui/context/dialog"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { DialogHousekeep } from "@/components/dialog-housekeep"
import { pruneSessions } from "@/settings/general/housekeep"
import { useCommand } from "./command"

export const housekeepCommand = { id: "session.housekeep" }

export function HousekeepCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()

  command.register("housekeep", () => {
    const housekeep = platform.housekeepDatabase
    if (!housekeep) return []

    return [
      {
        ...housekeepCommand,
        title: language.t("sidebar.housekeep"),
        category: language.t("command.category.session"),
        onSelect: () =>
          void dialog.show(() => (
            <DialogHousekeep
              onConfirm={async (days) => {
                await pruneSessions(language.t, (value) => housekeep(value), days)
              }}
            />
          )),
      },
    ]
  })

  return null
}
