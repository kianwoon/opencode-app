import { For, Show, createMemo, createResource, createSignal, type Accessor, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import type { ModelKey } from "@/context/local"
import { useServerProtocol } from "@/context/server-sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { normalizeAgentList } from "@/context/global-sync/utils"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type Action = "allow" | "ask" | "deny"
type PermissionRule = Action | { [pattern: string]: Action }
type AgentBlock = {
  description?: string
  mode?: "subagent" | "primary" | "all"
  model?: string
  owned_tools?: string[]
  skills?: string[]
  permission?: { [tool: string]: PermissionRule }
  steps?: number
  temperature?: number
  top_p?: number
  hidden?: boolean
}

type BrainConfig = {
  model?: string
  hands_model?: string
  reviewer_model?: string
  guru_model?: string
  computer_aid_model?: string
}

// brain.* overwrites agent.<name>.model at config-expand time
// (packages/opencode/src/config/brain.ts), so a hand agent's model MUST be
// written to its brain key: an agent-block `model` there reads as live while
// being dead. `hands_model` drives both hands.
const BRAIN_MODEL_KEY: Record<string, "model" | "hands_model" | "reviewer_model" | "guru_model" | "computer_aid_model"> = {
  brain: "model",
  explorer: "hands_model",
  implementer: "hands_model",
  reviewer: "reviewer_model",
  guru: "guru_model",
  "computer-aid": "computer_aid_model",
}

// Defined locally rather than imported: the tool inventory must be able to
// diverge from the Permissions tab without coupling two settings panels.
const OWNS_GROUPS = [
  {
    label: "settings.subagent.owns.group.general",
    tools: ["read", "list", "glob", "grep", "edit", "write", "apply_patch", "bash", "external_directory"],
  },
  {
    label: "settings.subagent.owns.group.planning",
    tools: ["task", "plan", "plan_enter", "plan_exit", "question", "todowrite", "todoread", "workflow", "doom_loop"],
  },
  {
    label: "settings.subagent.owns.group.webDynamic",
    tools: ["webfetch", "websearch", "skill", "lsp", "tool_search", "cua_batch", "session_rename"],
  },
] as const

const ALL_TOOLS: readonly string[] = OWNS_GROUPS.flatMap((group) => [...group.tools])

// Only pattern-bearing tools get a pattern input; the rest stay canonical bare
// actions. Copy permissions.tsx — a shared map here would silently couple the
// two tabs' canonical form.
const PATTERN_TOOLS: readonly string[] = ["bash", "read", "edit", "external_directory"]

const actionOptions: Action[] = ["allow", "ask", "deny"]
const modeOptions = ["subagent", "primary", "all"] as const

export const SettingsSubagentV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const protocol = useServerProtocol()
  const serverSync = useServerSync()
  const models = useModels()

  const config = createMemo(() => serverSync().data.config ?? {})
  const agents = createMemo<Record<string, AgentBlock | undefined>>(
    () => (config().agent ?? {}) as Record<string, AgentBlock | undefined>,
  )
  const brain = createMemo<BrainConfig>(() => serverSync().data.config.brain ?? {})
  // Provider-free on purpose: this tab renders OUTSIDE the directory Sync
  // provider, so the directory-scoped sync hook throws at render. Same
  // dual-protocol resource shape as the skills fetch below.
  const [agentList] = createResource(
    () => ({ protocol: protocol(), directory: props.directory() }),
    async (input) => {
      if (input.protocol === undefined) return []
      if (input.protocol === "v1") return normalizeAgentList((await serverSdk().client.app.agents()).data ?? [])
      return normalizeAgentList((await serverSdk().api.agent.list({ location: { directory: input.directory } })).data)
    },
  )
  // Subagent panel only: the primary agent is the Orchestration tab's business,
  // and config-only entries are unioned in so a hand-written block never
  // disappears from the list.
  const agentOptions = createMemo(() => {
    const runtime = agentList.latest ?? []
    const names = [...new Set([...runtime.map((item) => item.name), ...Object.keys(agents())])].filter(
      (name) => !runtime.some((item) => item.name === name && item.mode === "primary"),
    )
    return names.sort((a, b) => a.localeCompare(b)).map((name) => ({ name }))
  })
  const [selected, setSelected] = createSignal<string>("")
  // Empty list is possible when the runtime has not published agents and config
  // has no agent block; the row read sites deref this, so keep it total.
  const active = createMemo(
    () => agentOptions().find((item) => item.name === selected()) ?? agentOptions()[0] ?? { name: "" },
  )

  const block = (key: string) => agents()[key] ?? {}

  const [skills, { refetch: refetchSkills }] = createResource(
    () => ({ protocol: protocol(), directory: props.directory() }),
    async (input) => {
      if (input.protocol === undefined) return []
      if (input.protocol === "v1") {
        const result = await serverSdk().client.app.skills({ directory: input.directory })
        return (result.data ?? []) as { name: string }[]
      }
      const result = await serverSdk().api.skill.list({ location: { directory: input.directory } })
      return (result.data ?? []) as { name: string }[]
    },
  )

  // THE single write path: every control funnels through here, so there is
  // exactly one updateConfig call shape for the tab.
  const commit = (name: string, patch: AgentBlock) => {
    // An empty list makes active() the {name:""} fallback; writing it would
    // create a malformed config key.
    if (name === "") return
    const next = { ...config() }
    const agent = { ...agents() }
    agent[name] = { ...block(name), ...patch }
    next.agent = agent
    void serverSync()
      .updateConfig(next)
      .then(() => refetchSkills())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("settings.subagent.toast.updateFailed.title"), description: message })
      })
  }

  // A brain-owned model field lives in its OWN config block, so it needs its own
  // writer rather than the agent-block patch path.
  const commitBrainModel = (field: keyof BrainConfig, value: string) => {
    if (active().name === "") return
    void serverSync()
      .updateConfig({ brain: { ...brain(), [field]: value } })
      .then(() => refetchSkills())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("settings.subagent.toast.updateFailed.title"), description: message })
      })
  }

  const modelField = createMemo(() => BRAIN_MODEL_KEY[active().name])
  const currentModel = createMemo(() => {
    const field = modelField()
    const value = field ? brain()[field] ?? "" : block(active().name).model ?? ""
    const [providerID, ...rest] = value.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return
    return models.find({ providerID, modelID })
  })
  const modelState = createMemo(() => ({
    ready: models.ready,
    list: models.list,
    current: currentModel,
    set(item: ModelKey | undefined) {
      const value = item ? `${item.providerID}/${item.modelID}` : ""
      const field = modelField()
      if (field) return commitBrainModel(field, value)
      commit(active().name, { model: value })
    },
    visible: (item: ModelKey) => models.visible(item),
    setVisibility: (item: ModelKey, visible: boolean) => models.setVisibility(item, visible),
    recent: models.recent,
  }))

  // An absent owned_tools means every tool, matching resolveTools in
  // packages/opencode/src/session/llm/request.ts.
  const owns = (tool: string) => block(active().name).owned_tools?.includes(tool) ?? true
  const toggleOwns = (tool: string, checked: boolean) => {
    const current = block(active().name).owned_tools
    const known = OWNS_GROUPS.flatMap((group) => group.tools)
    const owned_tools = checked
      ? [...new Set([...(current ?? known.filter((name) => owns(name))), tool])]
      : (current ?? known).filter((name) => name !== tool)
    commit(active().name, { owned_tools })
  }

  const selectedSkills = createMemo(() => block(active().name).skills ?? [])
  const toggleSkill = (skill: string) => {
    const current = selectedSkills()
    commit(active().name, { skills: current.includes(skill) ? current.filter((item) => item !== skill) : [...current, skill] })
  }

  const howEntry = (tool: string) => {
    const value = block(active().name).permission?.[tool]
    if (!value) return { action: "ask" as Action, pattern: "*" }
    if (typeof value === "string") return { action: value, pattern: "*" }
    const [pattern, action] = Object.entries(value)[0] ?? ["*", "ask" as Action]
    return { action, pattern }
  }
  const setHow = (tool: string, action: Action, pattern: string) => {
    const permission = { ...block(active().name).permission }
    // The bare-action form keeps the config canonical for the "*" pattern;
    // anything else needs the pattern map. Action-only keys (todowrite,
    // question, webfetch, websearch, doom_loop) MUST stay bare — the object
    // form fails the config decode with ConfigInvalidError.
    permission[tool] = pattern.trim() === "" || pattern === "*" ? action : { [pattern.trim()]: action }
    commit(active().name, { permission })
  }

  // Numeric budgets commit on `change` (blur/Enter), never per keystroke, so a
  // partially typed value never persists. A blank or non-finite blob is ignored
  // rather than written: Number("") === 0 is finite, so clearing the field would
  // otherwise persist a silent 0.
  const commitNumber = (field: "steps" | "temperature", raw: string) => {
    if (raw.trim() === "") return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    commit(active().name, { [field]: value })
  }

  const actionLabel = (action: Action) => language.t(`settings.permissions.action.${action}`)
  const current = createMemo(() => currentModel() as { provider?: { id: string }; name?: string } | undefined)

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.subagent.title")}</h2>
      </div>

      <div class="settings-v2-tab-body" data-action="settings-subagent">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.subagent.agent.title")}
              description={language.t("settings.subagent.agent.description")}
            >
              <div class="w-full sm:w-[220px]">
                <SelectV2
                  appearance="inline"
                  data-action="settings-subagent-agent"
                  options={agentOptions()}
                  current={active()}
                  placement="bottom-end"
                  gutter={6}
                  value={(option) => option.name}
                  label={(option) => option.name}
                  onSelect={(option) => option && setSelected(option.name)}
                />
              </div>
            </SettingsRowV2>
            <p class="settings-v2-plugins-hint" data-action="settings-subagent-summary">
              {language.t("settings.subagent.summary", {
                owned: ALL_TOOLS.filter((tool) => owns(tool)).length,
                total: ALL_TOOLS.length,
                skills: selectedSkills().length,
              })}
            </p>
          </SettingsListV2>
        </div>

        {/* No selectable agent means active() is the {name:""} fallback, so these
        controls have no real target; the write paths refuse it too. */}
        <Show when={agentOptions().length > 0}>
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.subagent.row.model.title")}
              description={language.t("settings.subagent.row.model.description")}
            >
              <div class="w-full sm:w-[260px]" data-action="settings-subagent-model">
                <ModelSelectorPopoverV2
                  model={modelState() as never}
                  trigger={(triggerProps) => (
                    <ButtonV2
                      {...triggerProps}
                      variant="ghost-muted"
                      size="normal"
                      style={{ height: "28px" }}
                      class="min-w-0 w-full justify-start ![font-weight:440] group"
                      data-control-type="popover"
                    >
                      <Show
                        when={current()}
                        fallback={<span class="truncate leading-4">{language.t("common.default")}</span>}
                      >
                        {(item) => (
                          <>
                            <Show when={item().provider}>
                              {(provider) => (
                                <ProviderIcon
                                  id={provider().id}
                                  class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                />
                              )}
                            </Show>
                            <span class="truncate leading-4">{item().name}</span>
                            <span class="-ml-0.5 -mr-1 flex shrink-0">
                              <Icon name="chevron-down" />
                            </span>
                          </>
                        )}
                      </Show>
                    </ButtonV2>
                  )}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.subagent.row.description.title")}
              description={language.t("settings.subagent.row.description.description")}
            >
              <div class="w-full sm:w-[320px]" data-action="settings-subagent-description">
                <TextInputV2
                  type="text"
                  appearance="base"
                  value={block(active().name).description ?? ""}
                  aria-label={language.t("settings.subagent.row.description.title")}
                  onChange={(event) => commit(active().name, { description: event.currentTarget.value })}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.subagent.row.mode.title")}
              description={language.t("settings.subagent.row.mode.description")}
            >
              <div class="w-full sm:w-[220px]">
                <SelectV2
                  appearance="inline"
                  data-action="settings-subagent-mode"
                  options={modeOptions.map((mode) => ({ mode }))}
                  current={{ mode: block(active().name).mode ?? "subagent" }}
                  placement="bottom-end"
                  gutter={6}
                  value={(option) => option.mode}
                  label={(option) => language.t(`settings.subagent.mode.${option.mode}`)}
                  onSelect={(option) => option && commit(active().name, { mode: option.mode })}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.subagent.row.hidden.title")}
              description={language.t("settings.subagent.row.hidden.description")}
            >
              <div data-action="settings-subagent-hidden">
                <Switch
                  checked={block(active().name).hidden ?? false}
                  onChange={(checked: boolean) => commit(active().name, { hidden: checked })}
                >
                  {language.t("settings.subagent.row.hidden.title")}
                </Switch>
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.subagent.row.steps.title")}
              description={language.t("settings.subagent.row.steps.description")}
            >
              <div class="w-full sm:w-[160px]" data-action="settings-subagent-steps">
                <TextInputV2
                  type="text"
                  appearance="base"
                  numeric
                  value={block(active().name).steps ?? ""}
                  aria-label={language.t("settings.subagent.row.steps.title")}
                  onChange={(event) => commitNumber("steps", event.currentTarget.value)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.subagent.row.temperature.title")}
              description={language.t("settings.subagent.row.temperature.description")}
            >
              <div class="w-full sm:w-[160px]" data-action="settings-subagent-temperature">
                <TextInputV2
                  type="text"
                  appearance="base"
                  numeric
                  value={block(active().name).temperature ?? ""}
                  aria-label={language.t("settings.subagent.row.temperature.title")}
                  onChange={(event) => commitNumber("temperature", event.currentTarget.value)}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.subagent.section.owns.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.subagent.section.owns.description")}</p>
          <For each={OWNS_GROUPS}>
            {(group) => (
              <div class="settings-v2-section" data-component="settings-subagent-owns-group">
                <h4 class="settings-v2-section-title">
                  {language.t(group.label)}{" "}
                  <span class="settings-v2-permissions-count">
                    {language.t("settings.subagent.owns.count", {
                      owned: group.tools.filter((tool) => owns(tool)).length,
                      total: group.tools.length,
                    })}
                  </span>
                </h4>
                <SettingsListV2>
                  <For each={group.tools}>
                    {(tool) => (
                      <SettingsRowV2
                        title={language.t(`settings.permissions.tool.${tool}.title`)}
                        description={language.t(`settings.permissions.tool.${tool}.description`)}
                      >
                        <div data-action={`settings-subagent-owns-${tool}`}>
                          <CheckboxV2
                            label={language.t("settings.subagent.owns.toggle")}
                            checked={owns(tool)}
                            onChange={(checked) => toggleOwns(tool, checked === true)}
                          />
                        </div>
                      </SettingsRowV2>
                    )}
                  </For>
                </SettingsListV2>
              </div>
            )}
          </For>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.subagent.section.skills.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.subagent.section.skills.description")}</p>
          <Show
            when={skills.latest?.length}
            fallback={<p class="settings-v2-plugins-hint">{language.t("settings.subagent.section.skills.empty")}</p>}
          >
            <SettingsListV2>
              <For each={skills.latest}>
                {(skill) => (
                  <SettingsRowV2 title={skill.name} description="">
                    <div data-action={`settings-subagent-skill-${skill.name}`}>
                      <CheckboxV2
                        label={language.t("settings.subagent.section.skills.row.toggle", { name: skill.name })}
                        checked={selectedSkills().includes(skill.name)}
                        onChange={() => toggleSkill(skill.name)}
                        hideLabel
                      />
                    </div>
                  </SettingsRowV2>
                )}
              </For>
            </SettingsListV2>
          </Show>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.subagent.section.how.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.subagent.section.how.description")}</p>
          <SettingsListV2>
            <For each={PATTERN_TOOLS}>
              {(tool) => (
                <SettingsRowV2
                  title={language.t(`settings.permissions.tool.${tool}.title`)}
                  description={language.t(`settings.permissions.tool.${tool}.description`)}
                >
                  <div class="settings-v2-permissions-row-controls">
                    <div data-action={`settings-subagent-how-${tool}`}>
                      <SelectV2
                        appearance="inline"
                        options={actionOptions}
                        current={howEntry(tool).action}
                        placement="bottom-end"
                        gutter={6}
                        value={(option) => option}
                        label={actionLabel}
                        onSelect={(option) => option && setHow(tool, option, howEntry(tool).pattern)}
                      />
                    </div>
                    <div data-action={`settings-subagent-pattern-${tool}`}>
                      <TextInputV2
                        type="text"
                        appearance="base"
                        value={howEntry(tool).pattern}
                        aria-label={language.t("settings.subagent.pattern.label")}
                        onChange={(event) => setHow(tool, howEntry(tool).action, event.currentTarget.value)}
                      />
                    </div>
                  </div>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
        </div>
        </Show>
      </div>
    </>
  )
}