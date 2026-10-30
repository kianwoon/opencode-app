import { createMemo, createResource, onMount, type Accessor } from "solid-js"
import type { ColorScheme } from "@opencode/ui/theme/context"
import { useTheme } from "@opencode/ui/theme/context"
import {
  messageDefault,
  messageFontFamily,
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  type ReduceMotion,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/settings/model"
import { usePlatform } from "@/runtime/platform/platform"
import { desktopZoomLevels, type DesktopZoomLevel } from "@/shell/commands/desktop-menu"
import { playSoundById, SOUND_OPTIONS } from "@/shell/notifications/sound"
import { createSoundPreviewController } from "./behavior"
import { ServerConnection } from "@/runtime/server/registry"
import { useServerCtx } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"

export function createServerShellController(server: Accessor<ServerConnection.Any>) {
  const language = useLanguage()
  const serverCtx = useServerCtx(server)
  const source = () => ServerConnection.key(server())

  const [state, actions] = createResource(
    source,
    async () => {
      const context = serverCtx()

      const [entries, shells] = await Promise.all([
        context.sdk.api.config.get().catch(() => []),
        context.sdk.api.config.shells().catch(() => []),
      ])

      const boundary = entries.findIndex((entry) => entry.type === "directory")
      const global = boundary === -1 ? entries : entries.slice(0, boundary)

      return {
        shells,
        shell: global
          .flatMap((entry) => (entry.type === "document" && entry.info.shell !== undefined ? [entry.info.shell] : []))
          .at(-1),
      }
    },
    { initialValue: { shells: [], shell: undefined } },
  )

  return {
    shells: () => state.latest.shells,
    current: () => state.latest.shell ?? "",
    select: (value: string) => {
      if (value === (state.latest.shell ?? "")) return
      const previous = state.latest
      actions.mutate({ ...previous, shell: value || undefined })
      void serverCtx()
        .sdk.api.experimental.config.update({ shell: value || null })
        .catch((error) => {
          actions.mutate(previous)
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: error instanceof Error ? error.message : language.t("common.requestFailed"),
          })
        })
    },
  }
}

export function createAppearanceSettingsController() {
  const settings = useSettings()
  const platform = usePlatform()
  const language = useLanguage()
  const theme = useTheme()
  const themes = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  onMount(() => void theme.loadThemes())

  return {
    scheme: {
      current: theme.colorScheme,
      select: (value: ColorScheme) => theme.setColorScheme(value),
    },
    theme: {
      options: themes,
      current: createMemo(() => themes().find((option) => option.id === theme.themeId())),
      select: (option: { id: string } | null) => option && theme.setTheme(option.id),
    },
    zoom: {
      available: () => platform.zoomLevel !== undefined,
      options: [...desktopZoomLevels],
      current: () => platform.zoomLevel?.() ?? 1,
      label: (level: DesktopZoomLevel) => new Intl.NumberFormat(language.intl(), { style: "percent" }).format(level),
      select: (level: DesktopZoomLevel) => void platform.setZoomLevel?.(level),
    },
    reduceMotion: {
      current: settings.appearance.reduceMotion,
      select: (value: ReduceMotion) => settings.appearance.setReduceMotion(value),
    },
    fonts: {
      ui: createMemo(() => ({
        value: sansInput(settings.appearance.uiFont()),
        family: sansFontFamily(settings.appearance.uiFont(), settings.appearance.uiFontWeight()),
        placeholder: sansDefault,
        weight: settings.appearance.uiFontWeight(),
        colorLight: settings.appearance.uiFontColorLight(),
        colorDark: settings.appearance.uiFontColorDark(),
      })),
      code: createMemo(() => ({
        value: monoInput(settings.appearance.font()),
        family: monoFontFamily(settings.appearance.font(), settings.appearance.codeFontWeight()),
        placeholder: monoDefault,
        weight: settings.appearance.codeFontWeight(),
        colorLight: settings.appearance.codeFontColorLight(),
        colorDark: settings.appearance.codeFontColorDark(),
      })),
      terminal: createMemo(() => ({
        value: terminalInput(settings.appearance.terminalFont()),
        family: terminalFontFamily(settings.appearance.terminalFont(), settings.appearance.terminalFontWeight()),
        placeholder: terminalDefault,
        weight: settings.appearance.terminalFontWeight(),
        colorLight: settings.appearance.terminalFontColorLight(),
        colorDark: settings.appearance.terminalFontColorDark(),
      })),
      message: createMemo(() => ({
        value: settings.appearance.messageFont(),
        family: messageFontFamily(settings.appearance.messageFont(), settings.appearance.messageFontWeight()),
        placeholder: messageDefault,
        weight: settings.appearance.messageFontWeight(),
        colorLight: settings.appearance.messageFontColorLight(),
        colorDark: settings.appearance.messageFontColorDark(),
      })),
      setUI: (value: string) => settings.appearance.setUIFont(value),
      setCode: (value: string) => settings.appearance.setFont(value),
      setTerminal: (value: string) => settings.appearance.setTerminalFont(value),
      setUIWeight: (value: number) => settings.appearance.setUIFontWeight(value),
      setCodeWeight: (value: number) => settings.appearance.setCodeFontWeight(value),
      setTerminalWeight: (value: number) => settings.appearance.setTerminalFontWeight(value),
      setUIColorLight: (value: string) => settings.appearance.setUIFontColorLight(value),
      setUIColorDark: (value: string) => settings.appearance.setUIFontColorDark(value),
      setCodeColorLight: (value: string) => settings.appearance.setCodeFontColorLight(value),
      setCodeColorDark: (value: string) => settings.appearance.setCodeFontColorDark(value),
      setTerminalColorLight: (value: string) => settings.appearance.setTerminalFontColorLight(value),
      setTerminalColorDark: (value: string) => settings.appearance.setTerminalFontColorDark(value),
      setMessage: (value: string) => settings.appearance.setMessageFont(value),
      setMessageWeight: (value: number) => settings.appearance.setMessageFontWeight(value),
      setMessageColorLight: (value: string) => settings.appearance.setMessageFontColorLight(value),
      setMessageColorDark: (value: string) => settings.appearance.setMessageFontColorDark(value),
    },
    messageWidth: {
      current: createMemo(() => String(settings.appearance.messageWidth())),
      select: (value: string) => settings.appearance.setMessageWidth(Number(value)),
    },
    messageAlign: {
      current: settings.appearance.messageAlign,
      select: (value: "left" | "center" | "right") => settings.appearance.setMessageAlign(value),
    },
    messageBorderWidth: {
      current: createMemo(() => String(settings.appearance.messageBorderWidth())),
      select: (value: string) => settings.appearance.setMessageBorderWidth(Number(value)),
    },
    messageBorderColors: {
      light: () => settings.appearance.messageBorderColorLight(),
      dark: () => settings.appearance.messageBorderColorDark(),
      setLight: (value: string) => settings.appearance.setMessageBorderColorLight(value),
      setDark: (value: string) => settings.appearance.setMessageBorderColorDark(value),
    },
    messageBackgroundColors: {
      light: () => settings.appearance.messageBackgroundLight(),
      dark: () => settings.appearance.messageBackgroundDark(),
      setLight: (value: string) => settings.appearance.setMessageBackgroundLight(value),
      setDark: (value: string) => settings.appearance.setMessageBackgroundDark(value),
    },
    userMessageFont: createMemo(() => ({
      value: settings.appearance.userMessageFont(),
      family: messageFontFamily(settings.appearance.userMessageFont(), settings.appearance.userMessageFontWeight()),
      placeholder: messageDefault,
      weight: settings.appearance.userMessageFontWeight(),
    })),
    setUserMessageFont: (value: string) => settings.appearance.setUserMessageFont(value),
    setUserMessageFontWeight: (value: number) => settings.appearance.setUserMessageFontWeight(value),
    userMessageTextColors: {
      light: () => settings.appearance.userMessageTextColorLight(),
      dark: () => settings.appearance.userMessageTextColorDark(),
      setLight: (value: string) => settings.appearance.setUserMessageTextColorLight(value),
      setDark: (value: string) => settings.appearance.setUserMessageTextColorDark(value),
    },
  }
}

const noneSound = { id: "none", label: "sound.option.none" } as const

export const soundOptions = [noneSound, ...SOUND_OPTIONS]

export type SoundSelectOption = (typeof soundOptions)[number]

export function createSoundSettingsController() {
  const settings = useSettings()
  const preview = createSoundPreviewController(playSoundById)

  const channel = (
    enabled: Accessor<boolean>,
    current: Accessor<string>,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    current: createMemo(() =>
      enabled() ? (soundOptions.find((option) => option.id === current()) ?? noneSound) : noneSound,
    ),
    highlight: (option: SoundSelectOption | undefined) => {
      if (!option) return
      preview.play(option.id === "none" ? undefined : option.id)
    },
    select: (option: SoundSelectOption | null) => {
      if (!option) return

      if (option.id === "none") {
        setEnabled(false)
        preview.stop()

        return
      }

      setEnabled(true)
      set(option.id)
      preview.play(option.id)
    },
  })

  return {
    agent: channel(
      settings.sounds.agentEnabled,
      settings.sounds.agent,
      (value) => settings.sounds.setAgentEnabled(value),
      (id) => settings.sounds.setAgent(id),
    ),
    permissions: channel(
      settings.sounds.permissionsEnabled,
      settings.sounds.permissions,
      (value) => settings.sounds.setPermissionsEnabled(value),
      (id) => settings.sounds.setPermissions(id),
    ),
    questions: channel(
      settings.sounds.questionsEnabled,
      settings.sounds.questions,
      (value) => settings.sounds.setQuestionsEnabled(value),
      (id) => settings.sounds.setQuestions(id),
    ),
    errors: channel(
      settings.sounds.errorsEnabled,
      settings.sounds.errors,
      (value) => settings.sounds.setErrorsEnabled(value),
      (id) => settings.sounds.setErrors(id),
    ),
  }
}

export type ShellSettingsController = ReturnType<typeof createServerShellController>

export type AppearanceSettingsController = ReturnType<typeof createAppearanceSettingsController>

export type SoundSettingsController = ReturnType<typeof createSoundSettingsController>
