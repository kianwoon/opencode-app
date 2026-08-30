import { AppIcon } from "@opencode-ai/ui/app-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { showToast } from "@/utils/toast"
import { type Accessor, type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerProtocol } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { retry } from "@opencode-ai/core/util/retry"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { LocationReveal } from "./plugins"
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
  count: number
}

const builtinSkill = (skill: SkillItem) =>
  skill.location === "<built-in>" || skill.location.startsWith("/builtin/")

// The parent directory of a skill's SKILL.md folder: strip "<root>/<name>/SKILL.md"
// down to <root> with plain string math (no node:path in the renderer bundle).
const skillRoot = (location: string) => {
  const idx = location.lastIndexOf("/")
  if (idx <= 0) return undefined
  return location.slice(0, location.lastIndexOf("/", idx - 1)) || undefined
}

// skills.paths entries may use "~/"; expand for comparison against discovered
// directory paths. Remote servers and absolute entries pass through unchanged.
const expandConfigPath = (item: string, home: string | undefined) => {
  if (!item.startsWith("~/") || !home) return item
  return `${home}/${item.slice(2)}`
}

export const SettingsSkillsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const protocol = useServerProtocol()
  const serverSync = useServerSync()

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

  // Derive source directories from the already-loaded skill locations
  // (<root>/<skill-name>/SKILL.md) instead of a server endpoint, so the
  // toggles work against any server version. Enabled state comes from config.
  const configSkills = createMemo(() => (serverSync().data.config?.skills ?? {}) as Record<string, unknown>)
  const configPaths = createMemo(() => (configSkills().paths as string[] | undefined) ?? [])
  // Toggles write straight to config via updateConfig; while that request is in
  // flight the local state holds the optimistic values so switches respond
  // instantly.
  const [pending, setPending] = createStore({ directories: [] as string[], skills: [] as string[] })
  // The row list must survive remounts and server refetches: config's
  // `disabled_directories` / `disabled_skills` are the durable records of
  // known-but-off entries, `knownRoots` accumulates enabled ones seen locally.
  const [knownRoots, setKnownRoots] = createStore({ paths: [] as string[] })
  const disabledDirectoriesConfig = createMemo(
    () => (configSkills().disabled_directories as string[] | undefined) ?? [],
  )
  const disabledSkillsConfig = createMemo(() => (configSkills().disabled_skills as string[] | undefined) ?? [])
  const directories = createMemo<SkillDirectory[]>(() => {
    const disabledList = disabledDirectoriesConfig()
    const disabled = new Set(pending.directories.length > 0 ? pending.directories : disabledList)
    const counts = new Map<string, number>()
    const roots = new Set<string>([...disabledList, ...knownRoots.paths])
    for (const skill of skills.latest ?? []) {
      if (builtinSkill(skill)) continue
      if (!skill.location || skill.location === "<built-in>") continue
      const root = skillRoot(skill.location)
      if (!root) continue
      if (!roots.has(root)) setKnownRoots("paths", knownRoots.paths.length, root)
      roots.add(root)
      counts.set(root, (counts.get(root) ?? 0) + 1)
    }
    return [...roots]
      .sort((a, b) => a.localeCompare(b))
      .map((p) => ({ path: p, enabled: !disabled.has(p), count: counts.get(p) ?? 0 }))
  })
  const directoryEnabled = (skill: SkillItem) => {
    const root = builtinSkill(skill) ? undefined : skillRoot(skill.location)
    if (!root) return true
    const list = pending.directories.length > 0 ? pending.directories : disabledDirectoriesConfig()
    return !list.includes(root)
  }
  const disabledDirectories = createMemo<string[]>(() =>
    directories()
      .filter((dir) => !dir.enabled)
      .map((dir) => dir.path),
  )
  const skillDisabled = (skill: SkillItem) => {
    if (builtinSkill(skill)) return false
    if (!directoryEnabled(skill)) return true
    const list = pending.skills.length > 0 ? pending.skills : disabledSkillsConfig()
    return list.includes(skill.name)
  }
  // A directory is removable when it matches a skills.paths entry from config.
  // Discovered defaults (project dirs, ~/.claude, ~/.agents, URL pulls) only toggle.
  const isRemovableDirectory = (dirPath: string) =>
    configPaths().some((item) => {
      const expanded = expandConfigPath(item, serverSync().data.path?.home)
      return expanded === dirPath || item === dirPath
    })

  const saveSkillsConfig = async (next: Record<string, unknown>, errorKey: string) => {
    const before = serverSync().data.config?.skills ?? {}
    serverSync().set("config", "skills", next)
    await serverSync()
      .updateConfig({ ...serverSync().data.config, skills: next } as never)
      .catch((err: unknown) => {
        serverSync().set("config", "skills", before)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t(errorKey), description: message })
      })
  }

  const afterConfigWrite = async () => {
    // The config write disposes instances (global.disposed); the skills
    // refetch races that teardown. Best-effort only — a failure here must
    // not surface as an error since the write itself succeeded.
    try {
      await refetchSkills()
    } catch {
      // ignored: disposal race
    }
  }

  const toggleDirectory = async (dir: SkillDirectory) => {
    const next = dir.enabled
      ? [...disabledDirectoriesConfig(), dir.path]
      : disabledDirectoriesConfig().filter((item) => item !== dir.path)
    setPending("directories", next)
    try {
      await saveSkillsConfig(
        { ...configSkills(), disabled_directories: next },
        "settings.plugins.skills.directories.toggle.failed",
      )
      await afterConfigWrite()
    } finally {
      setPending("directories", [])
    }
  }

  const toggleSkill = async (skill: SkillItem) => {
    const enabled = !skillDisabled(skill)
    const next = enabled
      ? disabledSkillsConfig().filter((item) => item !== skill.name)
      : [...disabledSkillsConfig(), skill.name]
    setPending("skills", next)
    try {
      await saveSkillsConfig({ ...configSkills(), disabled_skills: next }, "settings.plugins.skills.toggle.failed")
    } finally {
      setPending("skills", [])
    }
  }

  const removeDirectory = async (dir: SkillDirectory) => {
    const nextPaths = configPaths().filter(
      (item) => expandConfigPath(item, serverSync().data.path?.home) !== dir.path && item !== dir.path,
    )
    const nextDisabled = disabledDirectoriesConfig().filter((item) => item !== dir.path)
    setPending("directories", nextDisabled)
    try {
      await saveSkillsConfig(
        { ...configSkills(), paths: nextPaths, disabled_directories: nextDisabled },
        "settings.plugins.skills.directories.remove.failed",
      )
      await afterConfigWrite()
    } finally {
      setPending("directories", [])
    }
  }

  const addSkills = async (spec: string) => {
    const value = spec.trim()
    if (!value) return
    const config = configSkills()
    const isUrl = /^https?:\/\//i.test(value)
    if (isUrl) {
      const urls = (config.urls as string[] | undefined) ?? []
      if (urls.includes(value)) return
      await saveSkillsConfig({ ...config, urls: [...urls, value] }, "settings.plugins.skills.add.failed")
      return
    }
    const paths = (config.paths as string[] | undefined) ?? []
    if (paths.includes(value) || paths.some((item) => expandConfigPath(item, serverSync().data.path?.home) === value))
      return
    await saveSkillsConfig({ ...config, paths: [...paths, value] }, "settings.plugins.skills.add.failed")
    await afterConfigWrite()
  }

  const count = createMemo(() => {
    const list = skills.latest
    return list ? list.length : undefined
  })

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.skills.title")}</h2>
      </div>
      <div class="settings-v2-tab-body settings-v2-plugins">
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
            <Show when={directories().length}>
              <div class="settings-v2-section" data-component="settings-skill-directories">
                <h3 class="settings-v2-section-title">{language.t("settings.plugins.skills.directories.title")}</h3>
                <SettingsListV2>
                  <For each={directories()}>
                    {(dir) => (
                      <SettingsRowV2
                        title={dir.path}
                        description={language.plural("settings.plugins.skills.count", dir.count)}
                      >
                        <div class="settings-v2-plugins-skill-actions">
                          <Show when={isRemovableDirectory(dir.path)}>
                            <div data-action="settings-skill-directory-remove">
                              <ButtonV2
                                size="small"
                                variant="neutral"
                                onClick={() => void removeDirectory(dir)}
                                title={language.t("settings.plugins.skills.directories.remove")}
                              >
                                {language.t("settings.plugins.skills.directories.remove")}
                              </ButtonV2>
                            </div>
                          </Show>
                          <Switch checked={dir.enabled} onChange={() => void toggleDirectory(dir)} hideLabel>
                            {language.t("settings.plugins.skills.directories.toggle", { directory: dir.path })}
                          </Switch>
                        </div>
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
              skillDisabled={skillDisabled}
              onToggle={(skill) => void toggleSkill(skill)}
            />
          </Show>
          <p class="settings-v2-plugins-hint">{language.t("settings.plugins.skills.hint")}</p>
        </div>
        <SkillsAdd onAdd={(spec) => void addSkills(spec)} />
      </div>
    </>
  )
}

const SkillsAdd: Component<{ onAdd: (spec: string) => void }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const [value, setValue] = createSignal("")

  const submit = () => {
    const spec = value().trim()
    if (!spec) return
    props.onAdd(spec)
    setValue("")
  }

  // Browse on desktop starts a native directory picker.
  const browse = async () => {
    if (platform.platform !== "desktop" || !platform.openDirectoryPickerDialog) return
    const picked = await platform.openDirectoryPickerDialog({
      title: language.t("settings.plugins.skills.add.title"),
    })
    if (!picked) return
    const dir = Array.isArray(picked) ? picked[0] : picked
    if (!dir) return
    props.onAdd(dir)
    setValue("")
  }

  return (
    <div class="settings-v2-plugins-add" data-action="settings-skill-add">
      <TextInputV2
        type="text"
        appearance="base"
        value={value()}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={language.t("settings.plugins.skills.add.placeholder")}
        aria-label={language.t("settings.plugins.skills.add.title")}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
      />
      <Show when={platform.platform === "desktop" && platform.openDirectoryPickerDialog}>
        <ButtonV2 size="small" variant="neutral" onClick={() => void browse()}>
          {language.t("settings.plugins.skills.add.browse")}
        </ButtonV2>
      </Show>
      <ButtonV2 size="small" variant="neutral" disabled={!value().trim()} onClick={submit}>
        {language.t("settings.plugins.skills.add.title")}
      </ButtonV2>
    </div>
  )
}

const SkillsList: Component<{
  skills: SkillItem[]
  skillDisabled: (skill: SkillItem) => boolean
  onToggle: (skill: SkillItem) => void
}> = (props) => {
  const language = useLanguage()
  const [filter, setFilter] = createStore({ value: "" })

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
            const disabled = props.skillDisabled(skill)
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
                    <Switch checked={!disabled} onChange={() => props.onToggle(skill)} hideLabel>
                      {language.t("settings.plugins.skills.toggle", { skill: skill.name })}
                    </Switch>
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
