import { AppIcon } from "@opencode-ai/ui/app-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { showToast } from "@/utils/toast"
import {
  type Accessor,
  type Component,
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerProtocol, useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { fileManagerApp } from "@/utils/file-manager"
import { retry } from "@opencode-ai/core/util/retry"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type SkillItem = {
  name: string
  description?: string
  slash?: boolean
  location: string
}

type SkillDirectory = {
  path: string
  enabled: boolean
}

type PluginSpec = string | [string, Record<string, unknown>]

// Plugin specs are npm package names, file:// paths, or [name, options] tuples.
const pluginName = (spec: PluginSpec) => (typeof spec === "string" ? spec : spec[0])

const pluginEqual = (spec: PluginSpec, name: string) => pluginName(spec) === name

const builtinSkill = (skill: SkillItem) =>
  skill.location === "<built-in>" || skill.location.startsWith("/builtin/")

// Local plugin specs are normalized to file:// URLs by the server when the config is loaded.
const pluginFilePath = (spec: PluginSpec) => {
  const name = pluginName(spec)
  if (!name.startsWith("file://")) return undefined
  return decodeURIComponent(name.slice("file://".length).split("?")[0]!)
}

// File plugins show their file name as the title; the full path sits right below it.
const pluginTitle = (spec: PluginSpec) => pluginFilePath(spec)?.split("/").pop() ?? pluginName(spec)

export const SettingsPluginsSkillsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const protocol = useServerProtocol()
  const serverSync = useServerSync()

  // Plugin editing is config-driven and only available on v1 servers; v2 has no
  // local plugin write API yet.
  const editable = createMemo(() => protocol() === "v1")
  const plugins = createMemo(() => (serverSync().data.config.plugin ?? []) as PluginSpec[])

  const [skills, { refetch: refetchSkills }] = createResource(
    () => ({ protocol: protocol(), directory: props.directory() }),
    async (input) => {
      if (input.protocol === undefined) return []
      return retry(async () => {
        if (input.protocol === "v1") {
          const result = await serverSdk().client.app.skills({ directory: input.directory })
          return ((result.data ?? []) as SkillItem[]).map((skill) => ({ ...skill, slash: undefined }))
        }
        const result = await serverSdk().api.skill.list({ location: { directory: input.directory } })
        return (result.data ?? []) as SkillItem[]
      })
    },
  )

  const removeSkill = async (name: string) => {
    try {
      if (protocol() === "v1") {
        await serverSdk().client.app.skill.remove({ name, directory: props.directory() })
      } else {
        await serverSdk().client.v2.skill.remove({ name, location: { directory: props.directory() } })
      }
      await refetchSkills()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.plugins.skills.remove.failed"), description: message })
    }
  }

  const [directories, { refetch: refetchDirectories }] = createResource(
    () => ({ protocol: protocol(), directory: props.directory() }),
    async (input) => {
      if (input.protocol !== "v2") return []
      return retry(async () => {
        // `client.v2` (workspace SDK) is used here because the vendored
        // `api` compat surface does not gain new endpoints between tarballs.
        const result = await serverSdk().client.v2.skill.directories({ location: { directory: input.directory } })
        return ((result.data ?? []) as SkillDirectory[]).map((dir) => ({ ...dir }))
        return (result.data ?? []) as SkillDirectory[]
      })
    },
  )

  const configSkills = createMemo(() => (serverSync().data.config.skills ?? {}) as Record<string, unknown>)

  const toggleDirectory = async (dir: SkillDirectory) => {
    const before = [...((configSkills().disabled_directories as string[]) ?? [])]
    const next = dir.enabled ? [...before, dir.path] : before.filter((item) => item !== dir.path)
    // Optimistic flip; rolled back if the config write fails. Discovery picks
    // up the new list on the server side when the config write lands.
    serverSync().set("config", "skills", "disabled_directories", next as never)
    try {
      await serverSync().updateConfig({
        ...serverSync().data.config,
        skills: { ...configSkills(), disabled_directories: next },
      } as never)
      await refetchDirectories()
      await refetchSkills()
    } catch (err) {
      serverSync().set("config", "skills", "disabled_directories", before as never)
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.plugins.skills.directories.toggle.failed"), description: message })
    }
  }

  const count = createMemo(() => {
    const list = skills.latest
    return list ? list.length : undefined
  })

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

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">
            {language.t("settings.plugins.section.skills")}
            <Show when={count() !== undefined}>
              <span class="settings-v2-plugins-count">{language.plural("settings.plugins.skills.count", count()!)}</span>
            </Show>
          </h3>
          <Show
            when={!skills.loading}
            fallback={
              <div class="settings-v2-plugins-status">
                {language.t("common.loading")}
                {language.t("common.loading.ellipsis")}
              </div>
            }
          >
            <Show when={directories.latest?.length}>
              <div class="settings-v2-section" data-component="settings-skill-directories">
                <h3 class="settings-v2-section-title">{language.t("settings.plugins.skills.directories.title")}</h3>
                <SettingsListV2>
                  <For each={[...(directories.latest ?? [])].sort((a, b) => a.path.localeCompare(b.path))}>
                    {(dir) => (
                      <SettingsRowV2
                        title={dir.path}
                        description={
                          <span class={dir.enabled ? undefined : "settings-v2-plugins-skill-disabled"}>
                            {dir.enabled
                              ? undefined
                              : language.t("settings.plugins.skills.directories.disabled")}
                          </span>
                        }
                      >
                        <Switch
                          checked={dir.enabled}
                          onChange={() => void toggleDirectory(dir)}
                          hideLabel
                        >
                          {language.t("settings.plugins.skills.directories.toggle", { directory: dir.path })}
                        </Switch>
                      </SettingsRowV2>
                    )}
                  </For>
                </SettingsListV2>
                <p class="settings-v2-plugins-hint">
                  {language.t("settings.plugins.skills.directories.hint")}
                </p>
              </div>
            </Show>
            <SkillsList
              skills={skills.latest ?? []}
              disabledDirectories={(directories.latest ?? []).filter((dir) => !dir.enabled).map((dir) => dir.path)}
              onRemove={removeSkill}
            />
          </Show>
          <p class="settings-v2-plugins-hint">{language.t("settings.plugins.skills.hint")}</p>
        </div>
      </div>
    </>
  )
}

const PluginAdd: Component<{ onAdd: (spec: string) => Promise<void> }> = (props) => {
  const language = useLanguage()
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const submit = async () => {
    const spec = value().trim()
    if (!spec || busy()) return
    setBusy(true)
    try {
      await props.onAdd(spec)
      setValue("")
    } finally {
      setBusy(false)
    }
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
      <ButtonV2 size="small" variant="neutral" disabled={!value().trim() || busy()} onClick={() => void submit()}>
        {language.t("settings.plugins.plugins.add.title")}
      </ButtonV2>
    </div>
  )
}

// Shows where a skill or plugin lives on disk. On desktop connected to a local
// server, clicking reveals the file in the system file manager.
const LocationReveal: Component<{ path: string; action: string }> = (props) => {
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

const SkillsList: Component<{
  skills: SkillItem[]
  disabledDirectories: string[]
  onRemove: (name: string) => Promise<void>
}> = (props) => {
  const language = useLanguage()
  const [filter, setFilter] = createStore({ value: "" })

  const isDisabled = (skill: SkillItem) =>
    props.disabledDirectories.some((dir) => skill.location === dir || skill.location.startsWith(`${dir}/`))

  const filtered = createMemo(() => {
    const query = filter.value.trim().toLowerCase()
    const items = [...props.skills].sort((a, b) => a.name.localeCompare(b.name))
    if (!query) return items
    return items.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) || (skill.description ?? "").toLowerCase().includes(query),
    )
  })

  return (
    <Show
      when={props.skills.length > 0}
      fallback={
        <div class="settings-v2-plugins-status">
          <span>{language.t("settings.plugins.skills.empty")}</span>
        </div>
      }
    >
      <div class="settings-v2-tab-search settings-v2-plugins-search">
        <TextInputV2
          type="search"
          appearance="base"
          value={filter.value}
          onInput={(event) => setFilter("value", event.currentTarget.value)}
          placeholder={language.t("settings.plugins.skills.search.placeholder")}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t("settings.plugins.skills.search.placeholder")}
        />
        <Show when={filter.value}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            class="settings-v2-tab-search-clear"
            icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
            onClick={() => setFilter("value", "")}
          />
        </Show>
      </div>
      <SettingsListV2>
        <For each={filtered()}>
          {(skill) => {
            const builtin = builtinSkill(skill)
            const disabled = !builtin && isDisabled(skill)
            return (
              <SettingsRowV2
                title={skill.name}
                description={
                  <>
                    <Show when={builtin ? skill.location : skill.description}>
                      <div class={disabled ? "settings-v2-plugins-skill-disabled" : undefined}>
                        {builtin ? skill.location : skill.description}
                      </div>
                    </Show>
                    <Show when={!builtin}>
                      <LocationReveal path={skill.location} action="settings-skill-reveal" />
                    </Show>
                  </>
                }
              >
                <div class="settings-v2-plugins-skill-actions">
                  <Show when={disabled}>
                    <Tag>{language.t("settings.plugins.skills.directories.disabled")}</Tag>
                  </Show>
                  <Show when={skill.slash}>
                    <Tag>{language.t("settings.plugins.skills.slash")}</Tag>
                  </Show>
                  <Show when={!builtin}>
                    <div data-action="settings-skill-remove">
                      <ButtonV2
                        size="small"
                        variant="neutral"
                        onClick={() => void props.onRemove(skill.name)}
                        title={language.t("settings.plugins.skills.remove")}
                      >
                        {language.t("settings.plugins.skills.remove")}
                      </ButtonV2>
                    </div>
                  </Show>
                </div>
              </SettingsRowV2>
            )
          }}
        </For>
        <Show when={filtered().length === 0}>
          <div class="settings-v2-plugins-status">
            <span>{language.t("palette.empty")}</span>
          </div>
        </Show>
      </SettingsListV2>
    </Show>
  )
}
