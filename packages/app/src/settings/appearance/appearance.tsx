import { type Accessor, Component, Show } from "solid-js"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { ExternalLink } from "@/runtime/platform/external-link"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { createAppearanceSettingsController, type AppearanceSettingsController } from "@/settings/general/controllers"
import "@/settings/settings.css"

const schemeOptions: ("system" | "light" | "dark")[] = ["system", "light", "dark"]

const fontWeightOptions: { value: string; label: string }[] = [
  { value: "100", label: "settings.general.row.fontWeight.thin" },
  { value: "200", label: "settings.general.row.fontWeight.extraLight" },
  { value: "300", label: "settings.general.row.fontWeight.light" },
  { value: "400", label: "settings.general.row.fontWeight.regular" },
  { value: "500", label: "settings.general.row.fontWeight.medium" },
  { value: "600", label: "settings.general.row.fontWeight.semibold" },
  { value: "700", label: "settings.general.row.fontWeight.bold" },
]

const messageWidthOptions: { value: string; label: string }[] = [
  // 0 is the default: the message fills its lane, which the session view sizes. The ch options
  // are explicit narrower caps that still bind when selected.
  { value: "0", label: "settings.general.row.messageWidth.option.default" },
  { value: "64", label: "settings.general.row.messageWidth.option.wide" },
  { value: "76", label: "settings.general.row.messageWidth.option.wider" },
  { value: "88", label: "settings.general.row.messageWidth.option.full" },
  { value: "102", label: "settings.general.row.messageWidth.option.max" },
  { value: "128", label: "settings.general.row.messageWidth.option.maxPlus" },
  { value: "160", label: "settings.general.row.messageWidth.option.widest" },
]

const messageAlignOptions: { value: "left" | "center" | "right"; label: string }[] = [
  { value: "left", label: "settings.general.row.messageAlign.option.left" },
  { value: "center", label: "settings.general.row.messageAlign.option.center" },
  { value: "right", label: "settings.general.row.messageAlign.option.right" },
]

const messageBorderWidthOptions: { value: string; label: string }[] = [
  { value: "0", label: "settings.general.row.messageBorder.width.none" },
  { value: "0.5", label: "0.5px" },
  { value: "1", label: "1px" },
  { value: "2", label: "2px" },
]

const reduceMotionOptions = [
  { value: "system" as const, label: "settings.appearance.row.reduceMotion.system" as const },
  { value: "on" as const, label: "settings.appearance.row.reduceMotion.on" as const },
  { value: "off" as const, label: "settings.appearance.row.reduceMotion.off" as const },
]

const fontSettings = {
  ui: {
    action: "settings-ui-font",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    font: "ui",
    input: "setUI",
    weight: "setUIWeight",
  },
  code: {
    action: "settings-code-font",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    font: "code",
    input: "setCode",
    weight: "setCodeWeight",
  },
  terminal: {
    action: "settings-terminal-font",
    title: "settings.general.row.terminalFont.title",
    description: "settings.general.row.terminalFont.description",
    font: "terminal",
    input: "setTerminal",
  },
  message: {
    action: "settings-message-font",
    title: "settings.general.row.messageFont.title",
    description: "settings.general.row.messageFont.description",
    font: "message",
    input: "setMessage",
    weight: "setMessageWeight",
  },
  userMessage: {
    action: "settings-user-message-font",
    title: "settings.general.row.userMessageFont.title",
    description: "settings.general.row.userMessageFont.description",
    font: "userMessage",
    input: "setUserMessage",
    weight: "setUserMessageWeight",
  },
} as const

type FontKind = keyof typeof fontSettings

type FontWeightSetter = "setUIWeight" | "setCodeWeight" | "setMessageWeight" | "setUserMessageWeight"

const FontSetting: Component<{
  kind: FontKind
  fonts: AppearanceSettingsController["fonts"]
  weight?: FontWeightSetter
}> = (props) => {
  const language = useLanguage()
  const config = () => fontSettings[props.kind]
  const current = () => props.fonts[config().font]()

  return (
    <SettingsRow title={language.t(config().title)} description={language.t(config().description)}>
      <div class="flex w-full flex-col gap-2 sm:w-[220px]">
        <TextInput
          data-action={config().action}
          type="text"
          appearance="base"
          value={current().value}
          onInput={(event) => props.fonts[config().input](event.currentTarget.value)}
          placeholder={current().placeholder}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t(config().title)}
          style={{ "font-family": current().family }}
        />
        <Show when={props.weight}>
          <Select
            data-action={`${config().action}-weight`}
            options={fontWeightOptions}
            current={
              fontWeightOptions.find((option) => option.value === String(current().weight)) ?? fontWeightOptions[3]
            }
            placement="bottom-end"
            gutter={6}
            value={(option) => option.value}
            label={(option) => language.t(option.label)}
            onSelect={(option) => option && props.fonts[props.weight!](Number(option.value))}
          />
        </Show>
      </div>
    </SettingsRow>
  )
}

const ColorPair: Component<{
  action: string
  light: Accessor<string>
  dark: Accessor<string>
  setLight: (value: string) => void
  setDark: (value: string) => void
}> = (props) => {
  const language = useLanguage()

  return (
    <div class="flex items-center gap-2" data-action={props.action}>
      <label class="flex items-center gap-1.5 text-[12px] text-v2-text-text-muted">
        <span aria-hidden="true">☀</span>
        <input
          type="color"
          value={props.light() || "#000000"}
          onInput={(event) => props.setLight(event.currentTarget.value)}
          class="size-5 cursor-pointer appearance-none rounded border border-v2-border-border-base bg-transparent p-0"
        />
      </label>
      <label class="flex items-center gap-1.5 text-[12px] text-v2-text-text-muted">
        <span aria-hidden="true">☾</span>
        <input
          type="color"
          value={props.dark() || "#000000"}
          onInput={(event) => props.setDark(event.currentTarget.value)}
          class="size-5 cursor-pointer appearance-none rounded border border-v2-border-border-base bg-transparent p-0"
        />
      </label>
      <span class="ml-auto text-[12px] text-v2-text-text-faint">{language.t("settings.general.row.fontColor.help")}</span>
    </div>
  )
}

export const SettingsAppearance: Component = () => {
  const language = useLanguage()
  const appearance = createAppearanceSettingsController()

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.general.section.appearance")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.appearance.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body">
        <div class="settings-section">
          <SettingsList>
            <SettingsRow
              title={language.t("settings.general.row.colorScheme.title")}
              description={language.t("settings.general.row.colorScheme.description")}
            >
              <Select
                data-action="settings-color-scheme"
                options={schemeOptions}
                current={schemeOptions.find((option) => option === appearance.scheme.current())}
                placement="bottom-end"
                gutter={6}
                label={(option) => {
                  if (option === "system") return language.t("theme.scheme.system")

                  if (option === "light") return language.t("theme.scheme.light")

                  return language.t("theme.scheme.dark")
                }}
                onSelect={(option) => option && appearance.scheme.select(option)}
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.theme.title")}
              description={
                <>
                  {language.t("settings.general.row.theme.description")}{" "}
                  <ExternalLink class="settings-link" href="https://opencode.ai/v2/docs/themes">
                    {language.t("common.learnMore")}
                  </ExternalLink>
                </>
              }
            >
              <Select
                data-action="settings-theme"
                options={appearance.theme.options()}
                current={appearance.theme.current()}
                placement="bottom-end"
                gutter={6}
                value={(option) => option.id}
                label={(option) => option.name}
                onSelect={appearance.theme.select}
              />
            </SettingsRow>

            <FontSetting kind="ui" fonts={appearance.fonts} weight="setUIWeight" />
            <FontSetting kind="code" fonts={appearance.fonts} weight="setCodeWeight" />
            <FontSetting kind="terminal" fonts={appearance.fonts} />
            <FontSetting kind="message" fonts={appearance.fonts} weight="setMessageWeight" />
            <FontSetting kind="userMessage" fonts={appearance.fonts} weight="setUserMessageWeight" />

            <SettingsRow
              title={language.t("settings.general.row.messageWidth.title")}
              description={language.t("settings.general.row.messageWidth.description")}
            >
              <Select
                data-action="settings-message-width"
                options={messageWidthOptions}
                current={
                  messageWidthOptions.find((option) => option.value === appearance.messageWidth.current()) ??
                  messageWidthOptions[0]
                }
                placement="bottom-end"
                gutter={6}
                value={(option) => option.value}
                label={(option) =>
                  option.value === "0"
                    ? language.t(option.label)
                    : `${language.t(option.label)} (${option.value}ch)`
                }
                onSelect={(option) => option && appearance.messageWidth.select(option.value)}
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.messageAlign.title")}
              description={language.t("settings.general.row.messageAlign.description")}
            >
              <Select
                data-action="settings-message-align"
                options={messageAlignOptions}
                current={messageAlignOptions.find((option) => option.value === appearance.messageAlign.current())}
                placement="bottom-end"
                gutter={6}
                value={(option) => option.value}
                label={(option) => language.t(option.label)}
                onSelect={(option) => option && appearance.messageAlign.select(option.value)}
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.messageBorder.title")}
              description={language.t("settings.general.row.messageBorder.description")}
            >
              <div class="flex w-full flex-col gap-2 sm:w-[220px]">
                <Select
                  data-action="settings-message-border-width"
                  options={messageBorderWidthOptions}
                  current={
                    messageBorderWidthOptions.find(
                      (option) => option.value === appearance.messageBorderWidth.current(),
                    ) ?? messageBorderWidthOptions[0]
                  }
                  placement="bottom-end"
                  gutter={6}
                  value={(option) => option.value}
                  label={(option) => (option.value === "0" ? language.t(option.label) : option.label)}
                  onSelect={(option) => option && appearance.messageBorderWidth.select(option.value)}
                />
                <ColorPair
                  action="settings-message-border-color"
                  light={appearance.messageBorderColors.light}
                  dark={appearance.messageBorderColors.dark}
                  setLight={appearance.messageBorderColors.setLight}
                  setDark={appearance.messageBorderColors.setDark}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.messageBackground.title")}
              description={language.t("settings.general.row.messageBackground.description")}
            >
              <ColorPair
                action="settings-message-background-color"
                light={appearance.messageBackgroundColors.light}
                dark={appearance.messageBackgroundColors.dark}
                setLight={appearance.messageBackgroundColors.setLight}
                setDark={appearance.messageBackgroundColors.setDark}
              />
            </SettingsRow>

            <Show when={appearance.zoom.available()}>
              <SettingsRow
                title={language.t("settings.appearance.row.zoom.title")}
                description={language.t("settings.appearance.row.zoom.description")}
              >
                <Select
                  data-action="settings-zoom"
                  options={appearance.zoom.options}
                  current={appearance.zoom.current()}
                  placement="bottom-end"
                  gutter={6}
                  value={(level) => String(level)}
                  label={appearance.zoom.label}
                  onSelect={(level) => level && appearance.zoom.select(level)}
                />
              </SettingsRow>
            </Show>

            <SettingsRow
              title={language.t("settings.appearance.row.reduceMotion.title")}
              description={language.t("settings.appearance.row.reduceMotion.description")}
            >
              <Select
                data-action="settings-reduce-motion"
                options={reduceMotionOptions}
                current={reduceMotionOptions.find((option) => option.value === appearance.reduceMotion.current())}
                placement="bottom-end"
                gutter={6}
                value={(option) => option.value}
                label={(option) => language.t(option.label)}
                onSelect={(option) => option && appearance.reduceMotion.select(option.value)}
              />
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
    </>
  )
}
