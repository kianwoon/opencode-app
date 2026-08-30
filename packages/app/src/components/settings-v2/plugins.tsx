import { AppIcon } from "@opencode-ai/ui/app-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { showToast } from "@/utils/toast"
import { type Accessor, type Component, For, Show, createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerProtocol, useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { fileManagerApp } from "@/utils/file-manager"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type PluginSpec = string | [string, Record<string, unknown>]

// Plugin specs are npm package names, file:// paths, or [name, options] tuples.
const pluginName = (spec: PluginSpec) => (typeof spec === "string" ? spec : spec[0])

const pluginEqual = (spec: PluginSpec, name: string) => pluginName(spec) === name

// Local plugin specs are normalized to file:// URLs by the server when the config is loaded.
const pluginFilePath = (spec: PluginSpec) => {
  const name = pluginName(spec)
  if (!name.startsWith("file://")) return undefined
  return decodeURIComponent(name.slice("file://".length).split("?")[0]!)
}

// File plugins show their file name as the title; the full path sits right below it.
const pluginTitle = (spec: PluginSpec) => pluginFilePath(spec)?.split("/").pop() ?? pluginName(spec)

export const SettingsPluginsV2: Component = () => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const protocol = useServerProtocol()
  const serverSync = useServerSync()

  // Plugin editing is config-driven and only available on v1 servers; v2 has no
  // local plugin write API yet.
  const editable = createMemo(() => protocol() === "v1")
  const plugins = createMemo(() => (serverSync().data.config.plugin ?? []) as PluginSpec[])

  const savePlugins = async (next: PluginSpec[], errorKey: string) => {
    const before = plugins()
    serverSync().set("config", "plugin", next)
    await serverSync()
      .updateConfig({ plugin: next })
      .catch((err: unknown) => {
        serverSync().set("config", "plugin", before)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t(errorKey), description: message })
      })
  }

  const removePlugin = (name: string) => {
    void savePlugins(plugins().filter((spec) => !pluginEqual(spec, name)), "settings.plugins.plugins.remove.failed")
  }

  const addPlugin = async (spec: string) => {
    const name = spec.trim()
    if (!name) return
    if (plugins().some((item) => pluginEqual(item, name))) return
    await savePlugins([...plugins(), name], "settings.plugins.plugins.add.failed")
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.plugins.title")}</h2>
      </div>
      <div class="settings-v2-tab-body settings-v2-plugins">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">
            {language.t("settings.plugins.section.plugins")}
            <Show when={plugins().length > 0}>
              <span class="settings-v2-plugins-count">
                {language.plural("settings.plugins.plugins.count", plugins().length)}
              </span>
            </Show>
          </h3>
          <SettingsListV2>
            <Show
              when={plugins().length > 0}
              fallback={
                <div class="settings-v2-plugins-status">
                  <span>{language.t("settings.plugins.plugins.empty")}</span>
                </div>
              }
            >
              <For each={plugins()}>
                {(spec) => {
                  const name = pluginName(spec)
                  return (
                    <SettingsRowV2
                      title={pluginTitle(spec)}
                      description={
                        <Show when={pluginFilePath(spec)}>
                          {(path) => <LocationReveal path={path()} action="settings-plugin-reveal" />}
                        </Show>
                      }
                    >
                      <Show when={editable()}>
                        <div data-action="settings-plugin-remove">
                          <ButtonV2
                            size="small"
                            variant="neutral"
                            onClick={() => removePlugin(name)}
                            title={language.t("settings.plugins.plugins.remove")}
                          >
                            {language.t("settings.plugins.plugins.remove")}
                          </ButtonV2>
                        </div>
                      </Show>
                    </SettingsRowV2>
                  )
                }}
              </For>
            </Show>
            <Show when={editable()}>
              <PluginAdd onAdd={addPlugin} />
            </Show>
          </SettingsListV2>
          <p class="settings-v2-plugins-hint">{language.t("settings.plugins.plugins.hint")}</p>
        </div>
      </div>
    </>
  )
}

const PluginAdd: Component<{ onAdd: (spec: string) => Promise<void> }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSdk = useServerSDK()
  const [value, setValue] = createSignal("")

  const submit = async () => {
    const spec = value().trim()
    if (!spec) return
    await props.onAdd(spec)
    setValue("")
  }

  // Start the native file picker in the server's global plugin folder when available.
  const defaultPluginDir = async () => {
    try {
      const paths = await serverSdk().client.path.get().then((result) => result.data)
      return paths?.config ? `${paths.config}/plugin` : undefined
    } catch {
      return undefined
    }
  }

  const browse = async () => {
    if (!platform.openFilePickerDialog) return
    const picked = await platform.openFilePickerDialog({
      title: language.t("settings.plugins.plugins.add.title"),
      defaultPath: await defaultPluginDir(),
      extensions: ["js", "ts", "mjs", "cjs"],
    })
    if (!picked) return
    const spec = picked.startsWith("file://") ? picked : `file://${picked}`
    await props.onAdd(spec)
    setValue("")
  }

  return (
    <div class="settings-v2-plugins-add" data-action="settings-plugin-add">
      <TextInputV2
        type="text"
        appearance="base"
        value={value()}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
        placeholder={language.t("settings.plugins.plugins.add.placeholder")}
        aria-label={language.t("settings.plugins.plugins.add.title")}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
      />
      <Show when={platform.openFilePickerDialog}>
        <ButtonV2 size="small" variant="neutral" onClick={() => void browse()}>
          {language.t("settings.plugins.plugins.add.browse")}
        </ButtonV2>
      </Show>
      <ButtonV2 size="small" variant="neutral" disabled={!value().trim()} onClick={() => void submit()}>
        {language.t("settings.plugins.plugins.add.title")}
      </ButtonV2>
    </div>
  )
}

// Shows where a skill or plugin lives on disk. On desktop connected to a local
// server, clicking reveals the file in the system file manager.
export const LocationReveal: Component<{ path: string; action: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()

  const fileManager = createMemo(() =>
    fileManagerApp(platform.platform === "desktop" ? (platform.os ?? "unknown") : "unknown"),
  )
  const canReveal = createMemo(() => platform.platform === "desktop" && !!platform.revealPath && server.isLocal())

  return (
    <Show
      when={canReveal()}
      fallback={
        <span class="settings-v2-plugins-location" title={props.path}>
          {props.path}
        </span>
      }
    >
      <button
        type="button"
        class="settings-v2-plugins-location"
        data-action={props.action}
        title={language.t(fileManager().actionLabel)}
        aria-label={language.t(fileManager().actionLabel)}
        onClick={() => void platform.revealPath?.(props.path)}
      >
        <AppIcon id={fileManager().icon} class="settings-v2-plugins-location-icon" alt="" draggable={false} />
        <span class="settings-v2-plugins-location-path">{props.path}</span>
      </button>
    </Show>
  )
}
