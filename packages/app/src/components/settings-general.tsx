import { Component, Show, createMemo, createResource, onMount, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { usePlatform, type DisplayBackend } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useUpdaterAction } from "./updater-action"
import {
  messageDefault,
  messageFontFamily,
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { ExternalLink } from "./external-link"
import { SettingsList } from "./settings-list"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ThemeOption = {
  id: string
  name: string
}

type FontWeightOption = {
  value: string
  label: string
}

type FontColorControlsProps = {
  colorLight: string
  colorDark: string
  setColorLight: (value: string) => void
  setColorDark: (value: string) => void
}

const FontColorControls: Component<FontColorControlsProps> = (props) => {
  const language = useLanguage()
  return (
    <div class="flex items-center gap-2" data-action="settings-font-color">
      <label class="flex items-center gap-1.5 text-12-regular text-text-muted">
        <span aria-hidden="true">☀</span>
        <input
          type="color"
          value={props.colorLight || "#000000"}
          onChange={(event) => props.setColorLight(event.currentTarget.value)}
          class="h-5 w-5 cursor-pointer appearance-none rounded border border-border-base bg-transparent p-0"
        />
      </label>
      <label class="flex items-center gap-1.5 text-12-regular text-text-muted">
        <span aria-hidden="true">☾</span>
        <input
          type="color"
          value={props.colorDark || "#000000"}
          onChange={(event) => props.setColorDark(event.currentTarget.value)}
          class="h-5 w-5 cursor-pointer appearance-none rounded border border-border-base bg-transparent p-0"
        />
      </label>
      <span class="ml-auto text-12-regular text-text-faint">{language.t("settings.general.row.fontColor.help")}</span>
    </div>
  )
}

type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

type ShellSelectOption = {
  id: string
  value: string
  label: string
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const permission = usePermission()
  const platform = usePlatform()
  const dialog = useDialog()
  const params = useParams()
  const settings = useSettings()

  const updater = useUpdaterAction()

  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const dir = createMemo(() => decode64(params.dir))
  const accepting = createMemo(() => {
    const value = dir()
    if (!value) return false
    if (!params.id) return permission.isAutoAcceptingDirectory(value)
    return permission.isAutoAccepting(params.id, value)
  })

  const toggleAccept = (checked: boolean) => {
    const value = dir()
    if (!value) return

    if (!params.id) {
      if (permission.isAutoAcceptingDirectory(value) === checked) return
      permission.toggleAutoAcceptDirectory(value)
      return
    }

    if (checked) {
      permission.enableAutoAccept(params.id, value)
      return
    }

    permission.disableAutoAccept(params.id, value)
  }
  const desktop = createMemo(() => platform.platform === "desktop")

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const serverSync = useServerSync()
  const serverSdk = useServerSDK()

  const [shells] = createResource(
    async () => {
      const sdk = serverSdk()
      if ((await sdk.protocol) === "v1") {
        return (await sdk.client.pty.shells()).data ?? []
      }
      // return (await sdk.api.pty.shells()).data
      return [] as ShellOption[]
    },
    { initialValue: [] as ShellOption[] },
  )

  const [displayBackend, { refetch: refetchDisplayBackend }] = createResource(
    () => (linux() && platform.getDisplayBackend ? true : false),
    () => Promise.resolve(platform.getDisplayBackend?.() ?? null).catch(() => null as DisplayBackend | null),
    { initialValue: null as DisplayBackend | null },
  )

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => (desktop() && platform.getPinchZoomEnabled ? true : false),
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  onMount(() => {
    void theme.loadThemes()
  })

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  const currentShell = createMemo(() => serverSync().data.config.shell ?? "")

  const shellOptions = createMemo<ShellSelectOption[]>(() => {
    const list = shells.latest
    const current = serverSync().data.config.shell

    const nameCounts = new Map<string, number>()
    for (const s of list) {
      nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1)
    }

    const options = [
      autoOption,
      ...list.map((s) => {
        const ambiguousName = (nameCounts.get(s.name) || 0) > 1
        const text = ambiguousName ? s.path : s.name
        const label = s.acceptable ? text : `${text} (${language.t("settings.general.row.shell.terminalOnly")})`
        return {
          id: s.path,
          // Prefer name over path - "bash" is much cleaner than the explicit full route even when it may change due to PATH.
          value: ambiguousName ? s.path : s.name,
          label,
        }
      }),
    ]

    if (current && !options.some((o) => o.value === current)) {
      options.push({ id: current, value: current, label: current })
    }

    return options
  })

  const onDisplayBackendChange = (checked: boolean) => {
    const update = platform.setDisplayBackend?.(checked ? "wayland" : "auto")
    if (!update) return
    void update.finally(() => {
      void refetchDisplayBackend()
    })
  }

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())
  const message = () => settings.appearance.messageFont()

  const fontWeightOptions = createMemo(() => [
    { value: "100", label: language.t("settings.general.row.fontWeight.thin") },
    { value: "200", label: language.t("settings.general.row.fontWeight.extraLight") },
    { value: "300", label: language.t("settings.general.row.fontWeight.light") },
    { value: "400", label: language.t("settings.general.row.fontWeight.regular") },
    { value: "500", label: language.t("settings.general.row.fontWeight.medium") },
    { value: "600", label: language.t("settings.general.row.fontWeight.semibold") },
    { value: "700", label: language.t("settings.general.row.fontWeight.bold") },
  ])

  const messageWidthOptions = createMemo(() =>
    [
      { value: "64", label: language.t("settings.general.row.messageWidth.option.default") },
      { value: "76", label: language.t("settings.general.row.messageWidth.option.wide") },
      { value: "88", label: language.t("settings.general.row.messageWidth.option.wider") },
      { value: "102", label: language.t("settings.general.row.messageWidth.option.full") },
      { value: "128", label: language.t("settings.general.row.messageWidth.option.max") },
    ].map((option) => ({
      ...option,
      label: `${option.label} (${option.value}ch)`,
    })),
  )

  const fontWeightSelectProps = (current: () => number, set: (value: number) => void) => ({
    options: fontWeightOptions(),
    current: fontWeightOptions().find((o) => o.value === String(current())) ?? fontWeightOptions()[1],
    value: (o: FontWeightOption) => o.value,
    label: (o: FontWeightOption) => o.label,
    onSelect: (option: FontWeightOption | undefined) => option && set(Number(option.value)),
    variant: "secondary" as const,
    size: "small" as const,
    triggerVariant: "settings" as const,
  })

  const messageAlignOptions = createMemo<
    { value: "left" | "center" | "right"; label: string }[]
  >(() => [
    { value: "left", label: language.t("settings.general.row.messageAlign.option.left") },
    { value: "center", label: language.t("settings.general.row.messageAlign.option.center") },
    { value: "right", label: language.t("settings.general.row.messageAlign.option.right") },
  ])

  const messageBorderWidthOptions = createMemo(() => [
    { value: "0", label: language.t("settings.general.row.messageBorder.width.none") },
    { value: "0.5", label: "0.5px" },
    { value: "1", label: "1px" },
    { value: "2", label: "2px" },
  ])

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
    variant: "secondary" as const,
    size: "small" as const,
    triggerVariant: "settings" as const,
  })

  const InterfaceSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={
            <span class="flex items-center gap-2">
              {language.t("settings.general.row.newInterface.title")}
              <Tag variant="accent">{language.t("settings.general.row.newInterface.badge")}</Tag>
            </span>
          }
          description={language.t("settings.general.row.newInterface.description")}
        >
          <div data-action="settings-new-layout-designs">
            <Switch
              checked={settings.general.newLayoutDesigns()}
              onChange={(checked) => {
                settings.general.setNewLayoutDesigns(checked)
                if (!checked) return
                void import("@/components/settings-v2").then((module) => {
                  void dialog.show(() => <module.DialogSettings />)
                })
              }}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const InterfaceNoticeSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.newInterfaceNotice.title")}
          description={language.t("settings.general.row.newInterfaceNotice.description")}
        >
          <Button size="small" variant="ghost" onClick={settings.general.dismissNewInterfaceNotice}>
            {language.t("settings.general.row.newInterfaceNotice.dismiss")}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const GeneralSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <Select
            data-action="settings-language"
            options={languageOptions()}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("command.permissions.autoaccept.enable")}
          description={language.t("toast.permissions.autoaccept.on.description")}
        >
          <div data-action="settings-auto-accept-permissions">
            <Switch checked={accepting()} disabled={!dir()} onChange={toggleAccept} />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.shell.title")}
          description={language.t("settings.general.row.shell.description")}
        >
          <Select
            data-action="settings-shell"
            options={shellOptions()}
            current={shellOptions().find((o) => o.value === currentShell()) ?? autoOption}
            value={(o) => o.id}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === currentShell()) return
              serverSync().updateConfig({ shell: option.value })
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AdvancedSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.advanced")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.showFileTree.title")}
          description={language.t("settings.general.row.showFileTree.description")}
        >
          <div data-action="settings-show-file-tree">
            <Switch
              checked={settings.general.showFileTree()}
              onChange={(checked) => settings.general.setShowFileTree(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showNavigation.title")}
          description={language.t("settings.general.row.showNavigation.description")}
        >
          <div data-action="settings-show-navigation">
            <Switch
              checked={settings.general.showNavigation()}
              onChange={(checked) => settings.general.setShowNavigation(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showSearch.title")}
          description={language.t("settings.general.row.showSearch.description")}
        >
          <div data-action="settings-show-search">
            <Switch
              checked={settings.general.showSearch()}
              onChange={(checked) => settings.general.setShowSearch(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showStatus.title")}
          description={language.t("settings.general.row.showStatus.description")}
        >
          <div data-action="settings-show-status">
            <Switch
              checked={settings.general.showStatus()}
              onChange={(checked) => settings.general.setShowStatus(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.showCustomAgents.title")}
          description={language.t("settings.general.row.showCustomAgents.description")}
        >
          <div data-action="settings-show-custom-agents">
            <Switch
              checked={settings.general.showCustomAgents()}
              onChange={(checked) => settings.general.setShowCustomAgents(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AppearanceSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <ExternalLink href="https://opencode.ai/docs/themes/">{language.t("common.learnMore")}</ExternalLink>
            </>
          }
        >
          <Select
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.uiFont.title")}
          description={language.t("settings.general.row.uiFont.description")}
        >
          <div class="flex w-full flex-col gap-2 sm:w-[220px]">
            <TextField
              data-action="settings-ui-font"
              label={language.t("settings.general.row.uiFont.title")}
              hideLabel
              type="text"
              value={sans()}
              onChange={(value) => settings.appearance.setUIFont(value)}
              placeholder={sansDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="text-12-regular"
              style={{
                "font-family": sansFontFamily(settings.appearance.uiFont(), settings.appearance.uiFontWeight()),
              }}
            />
            <Select
              data-action="settings-ui-font-weight"
              {...fontWeightSelectProps(
                () => settings.appearance.uiFontWeight(),
                (value) => settings.appearance.setUIFontWeight(value),
              )}
            />
            <FontColorControls
              colorLight={settings.appearance.uiFontColorLight()}
              colorDark={settings.appearance.uiFontColorDark()}
              setColorLight={settings.appearance.setUIFontColorLight}
              setColorDark={settings.appearance.setUIFontColorDark}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <div class="flex w-full flex-col gap-2 sm:w-[220px]">
            <TextField
              data-action="settings-code-font"
              label={language.t("settings.general.row.font.title")}
              hideLabel
              type="text"
              value={mono()}
              onChange={(value) => settings.appearance.setFont(value)}
              placeholder={monoDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="text-12-regular"
              style={{
                "font-family": monoFontFamily(settings.appearance.font(), settings.appearance.codeFontWeight()),
              }}
            />
            <Select
              data-action="settings-code-font-weight"
              {...fontWeightSelectProps(
                () => settings.appearance.codeFontWeight(),
                (value) => settings.appearance.setCodeFontWeight(value),
              )}
            />
            <FontColorControls
              colorLight={settings.appearance.codeFontColorLight()}
              colorDark={settings.appearance.codeFontColorDark()}
              setColorLight={settings.appearance.setCodeFontColorLight}
              setColorDark={settings.appearance.setCodeFontColorDark}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.terminalFont.title")}
          description={language.t("settings.general.row.terminalFont.description")}
        >
          <div class="flex w-full flex-col gap-2 sm:w-[220px]">
            <TextField
              data-action="settings-terminal-font"
              label={language.t("settings.general.row.terminalFont.title")}
              hideLabel
              type="text"
              value={terminal()}
              onChange={(value) => settings.appearance.setTerminalFont(value)}
              placeholder={terminalDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="text-12-regular"
              style={{
                "font-family": terminalFontFamily(
                  settings.appearance.terminalFont(),
                  settings.appearance.terminalFontWeight(),
                ),
              }}
            />
            <Select
              data-action="settings-terminal-font-weight"
              {...fontWeightSelectProps(
                () => settings.appearance.terminalFontWeight(),
                (value) => settings.appearance.setTerminalFontWeight(value),
              )}
            />
            <FontColorControls
              colorLight={settings.appearance.terminalFontColorLight()}
              colorDark={settings.appearance.terminalFontColorDark()}
              setColorLight={settings.appearance.setTerminalFontColorLight}
              setColorDark={settings.appearance.setTerminalFontColorDark}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.messageFont.title")}
          description={language.t("settings.general.row.messageFont.description")}
        >
          <div class="flex w-full flex-col gap-2 sm:w-[220px]">
            <TextField
              data-action="settings-message-font"
              label={language.t("settings.general.row.messageFont.title")}
              hideLabel
              type="text"
              value={message()}
              onChange={(value) => settings.appearance.setMessageFont(value)}
              placeholder={messageDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="text-12-regular"
              style={{
                "font-family": messageFontFamily(
                  settings.appearance.messageFont(),
                  settings.appearance.messageFontWeight(),
                ),
              }}
            />
            <Select
              data-action="settings-message-font-weight"
              {...fontWeightSelectProps(
                () => settings.appearance.messageFontWeight(),
                (value) => settings.appearance.setMessageFontWeight(value),
              )}
            />
            <FontColorControls
              colorLight={settings.appearance.messageFontColorLight()}
              colorDark={settings.appearance.messageFontColorDark()}
              setColorLight={settings.appearance.setMessageFontColorLight}
              setColorDark={settings.appearance.setMessageFontColorDark}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.messageWidth.title")}
          description={language.t("settings.general.row.messageWidth.description")}
        >
          <div class="w-full sm:w-[220px]">
            <Select
              data-action="settings-message-width"
              options={messageWidthOptions()}
              current={
                messageWidthOptions().find((o) => o.value === String(settings.appearance.messageWidth())) ??
                messageWidthOptions()[0]
              }
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && settings.appearance.setMessageWidth(Number(option.value))}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.messageAlign.title")}
          description={language.t("settings.general.row.messageAlign.description")}
        >
          <div class="w-full sm:w-[220px]">
            <Select
              data-action="settings-message-align"
              options={messageAlignOptions()}
              current={messageAlignOptions().find((o) => o.value === settings.appearance.messageAlign())}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && settings.appearance.setMessageAlign(option.value)}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.messageBorder.title")}
          description={language.t("settings.general.row.messageBorder.description")}
        >
          <div class="flex w-full flex-col gap-2 sm:w-[220px]">
            <Select
              data-action="settings-message-border-width"
              options={messageBorderWidthOptions()}
              current={messageBorderWidthOptions().find((o) => o.value === String(settings.appearance.messageBorderWidth()))}
              value={(o) => o.value}
              label={(o) => o.label}
              onSelect={(option) => option && settings.appearance.setMessageBorderWidth(Number(option.value))}
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
            <FontColorControls
              colorLight={settings.appearance.messageBorderColorLight()}
              colorDark={settings.appearance.messageBorderColorDark()}
              setColorLight={settings.appearance.setMessageBorderColorLight}
              setColorDark={settings.appearance.setMessageBorderColorDark}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.messageBackground.title")}
          description={language.t("settings.general.row.messageBackground.description")}
        >
          <div class="w-full sm:w-[220px]">
            <FontColorControls
              colorLight={settings.appearance.messageBackgroundLight()}
              colorDark={settings.appearance.messageBackgroundDark()}
              setColorLight={settings.appearance.setMessageBackgroundLight}
              setColorDark={settings.appearance.setMessageBackgroundDark}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.userMessageTextColor.title")}
          description={language.t("settings.general.row.userMessageTextColor.description")}
        >
          <div class="w-full sm:w-[220px]">
            <FontColorControls
              colorLight={settings.appearance.userMessageTextColorLight()}
              colorDark={settings.appearance.userMessageTextColorDark()}
              setColorLight={settings.appearance.setUserMessageTextColorLight}
              setColorDark={settings.appearance.setUserMessageTextColorDark}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const SoundsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <Select
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <Select
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <Select
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const UpdatesSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.updates")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <Button size="small" variant="secondary" disabled={!updater.action().run} onClick={updater.run}>
            {language.t(updater.action().label)}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const DisplaySection = () => (
    <Show when={desktop()}>
      <div class="flex flex-col gap-1">
        <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.display")}</h3>

        <SettingsList>
          <SettingsRow
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRow>

          <Show when={linux()}>
            <SettingsRow
              title={
                <div class="flex items-center gap-2">
                  <span>{language.t("settings.general.row.wayland.title")}</span>
                  <Tooltip value={language.t("settings.general.row.wayland.tooltip")} placement="top">
                    <span class="text-text-weak">
                      <Icon name="help" size="small" />
                    </span>
                  </Tooltip>
                </div>
              }
              description={language.t("settings.general.row.wayland.description")}
            >
              <div data-action="settings-wayland">
                <Switch checked={displayBackend.latest === "wayland"} onChange={onDisplayBackendChange} />
              </div>
            </SettingsRow>
          </Show>
        </SettingsList>
      </div>
    </Show>
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <Show when={settings.general.layoutTransitionAvailable()}>
          <InterfaceSection />
        </Show>

        <Show when={settings.general.newInterfaceNoticeVisible()}>
          <InterfaceNoticeSection />
        </Show>

        <GeneralSection />

        <AppearanceSection />

        <NotificationsSection />

        <SoundsSection />

        <UpdatesSection />

        <DisplaySection />

        <Show when={desktop()}>
          <AdvancedSection />
        </Show>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
