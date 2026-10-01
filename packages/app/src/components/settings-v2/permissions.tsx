import { For, Show, createMemo, createResource, createSignal, type Accessor, type Component } from "solid-js"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { useLanguage } from "@/context/language"
import { useServerProtocol } from "@/context/server-sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type Action = "allow" | "ask" | "deny"
type PermissionRule = Action | { [pattern: string]: Action }
type AgentBlock = {
  owned_tools?: string[]
  skills?: string[]
  permission?: { [tool: string]: PermissionRule }
}

// Config `agent.<name>` keys the tab edits. `hands` owns both hand agents: the
// brain expansion maps brain.hands_model onto explorer + implementer, so both
// entries are written in ONE updateConfig call (never a second write path).
const AGENT_TARGETS = [
  { id: "brain", keys: ["brain"] },
  { id: "hands", keys: ["explorer", "implementer"] },
  { id: "reviewer", keys: ["reviewer"] },
  { id: "guru", keys: ["guru"] },
  { id: "computer_aid", keys: ["computer-aid"] },
] as const

const OWNS_GROUPS = [
  {
    label: "settings.permissions.section.owns.group.general",
    tools: ["read", "list", "glob", "grep", "edit", "write", "apply_patch", "bash", "external_directory"],
  },
  {
    label: "settings.permissions.section.owns.group.planning",
    tools: ["task", "plan", "plan_enter", "plan_exit", "question", "todowrite", "todoread", "workflow", "doom_loop"],
  },
  {
    label: "settings.permissions.section.owns.group.webDynamic",
    tools: ["webfetch", "websearch", "skill", "lsp", "tool_search", "cua_batch", "session_rename"],
  },
] as const

// How-rows. Every one carries a single action plus a pattern, written as
// `agent.<name>.permission.<tool>`.
const HOW_ROWS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "skill",
  "doom_loop",
] as const

const actionOptions: Action[] = ["allow", "ask", "deny"]

// Mirrors fmtPermissions in packages/opencode/src/session/system.ts. The app
// bundle cannot import from the server package (same bundle-boundary reason as
// the JEV_DEFAULT_MODEL literal in orchestration.tsx), so the resolved-set rule
// is reimplemented here against the shared Wildcard matcher.
const effectiveManifest = (ruleset: { permission: string; pattern: string; action: Action }[]) => {
  // A rule is dead when a LATER rule matches everything it matches: the
  // evaluator's findLast can then never select it, for any input.
  const effective = ruleset.filter(
    (rule, i) =>
      !ruleset
        .slice(i + 1)
        .some(
          (later) => Wildcard.match(rule.permission, later.permission) && Wildcard.match(rule.pattern, later.pattern),
        ),
  )
  if (effective.length === 0) return undefined
  const MAX = 60
  return [
    "Effective tool permissions — generated from config; the config-derived lower bound, not a ceiling: runtime session approvals (approved) may additionally allow.",
    "Dead and duplicate layers are resolved away; where entries still overlap, the LAST matching rule wins.",
    ...effective.slice(0, MAX).map((rule) => `- ${rule.permission} "${rule.pattern}": ${rule.action}`),
    ...(effective.length > MAX ? [`... ${effective.length - MAX} more rules omitted (most-recent tail dropped)`] : []),
  ].join("\n")
}

export const SettingsPermissionsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const protocol = useServerProtocol()
  const serverSync = useServerSync()

  const config = createMemo(() => serverSync().data.config ?? {})
  const agents = createMemo<Record<string, AgentBlock | undefined>>(() =>
    (config().agent ?? {}) as Record<string, AgentBlock | undefined>,
  )
  const [selected, setSelected] = createSignal<string>(AGENT_TARGETS[0].id)
  const targets = createMemo<{ id: string; keys: readonly string[] }>(
    () => AGENT_TARGETS.find((item) => item.id === selected()) ?? AGENT_TARGETS[0],
  )
  // Custom agents are whatever else the server already knows about; the tab
  // never invents an agent name the runtime has not published.
  const customAgents = createMemo(() => {
    const owned = new Set<string>(AGENT_TARGETS.flatMap((item) => [...item.keys]))
    return Object.keys(agents())
      .filter((name) => !owned.has(name))
      .sort((a, b) => a.localeCompare(b))
  })
  const agentOptions = createMemo(() => [
    ...AGENT_TARGETS.map((item) => ({ id: item.id, keys: [...item.keys], label: item.id })),
    ...customAgents().map((name) => ({ id: name, keys: [name], label: name })),
  ])
  const active = createMemo(() => agentOptions().find((item) => item.id === selected()) ?? agentOptions()[0])

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
    const next = { ...config() }
    const agent = { ...agents() }
    for (const key of targets().keys) agent[key] = { ...block(key), ...patch }
    next.agent = agent
    void serverSync()
      .updateConfig(next)
      .then(() => refetchSkills())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("settings.permissions.toast.updateFailed.title"), description: message })
      })
  }

  // An absent owned_tools means every tool, matching resolveTools in
  // packages/opencode/src/session/llm/request.ts. The deprecated boolean `tools`
  // map is never read or written here — it would be a second, unconnected source.
  const owns = (tool: string) => block(active().keys[0]).owned_tools?.includes(tool) ?? true
  const toggleOwns = (tool: string, checked: boolean) => {
    const current = block(active().keys[0]).owned_tools
    const known = OWNS_GROUPS.flatMap((group) => group.tools)
    const owned_tools = checked
      ? [...new Set([...(current ?? known.filter((name) => owns(name))), tool])]
      : (current ?? known).filter((name) => name !== tool)
    commit(active().label, { owned_tools })
  }

  const selectedSkills = () => block(active().keys[0]).skills ?? []
  const toggleSkill = (skill: string) => {
    const current = selectedSkills()
    const next = current.includes(skill) ? current.filter((item) => item !== skill) : [...current, skill]
    commit(active().label, { skills: next })
  }

  const howEntry = (tool: string) => {
    const value = block(active().keys[0]).permission?.[tool]
    if (!value) return { action: "ask" as Action, pattern: "*" }
    if (typeof value === "string") return { action: value, pattern: "*" }
    const [pattern, action] = Object.entries(value)[0] ?? ["*", "ask" as Action]
    return { action, pattern }
  }
  const setHow = (tool: string, action: Action, pattern: string) => {
    const permission = { ...block(active().keys[0]).permission }
    // The bare-action form keeps the config canonical for the "*" pattern;
    // anything else needs the pattern map.
    permission[tool] = pattern.trim() === "" || pattern === "*" ? action : { [pattern.trim()]: action }
    commit(active().label, { permission })
  }

  const manifest = createMemo(() => {
    const ruleset: { permission: string; pattern: string; action: Action }[] = []
    for (const key of active().keys) {
      for (const [tool, value] of Object.entries(block(key).permission ?? {})) {
        ruleset.push(
          ...(typeof value === "string"
            ? [{ permission: tool, pattern: "*", action: value }]
            : Object.entries(value).map(([pattern, action]) => ({ permission: tool, pattern, action }))),
        )
      }
    }
    return effectiveManifest(ruleset)
  })

  const actionLabel = (action: Action) => language.t(`settings.permissions.action.${action}`)

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.permissions.title")}</h2>
      </div>

      <div class="settings-v2-tab-body" data-action="settings-permissions">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.permissions.agent.title")}
              description={language.t("settings.permissions.agent.description")}
            >
              <div class="w-full sm:w-[220px]">
                <SelectV2
                  appearance="inline"
                  data-action="settings-permissions-agent"
                  options={agentOptions()}
                  current={active()}
                  placement="bottom-end"
                  gutter={6}
                  value={(option) => option.id}
                  label={(option) => option.label}
                  onSelect={(option) => option && setSelected(option.id)}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.permissions.section.owns.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.owns.description")}</p>
          <For each={OWNS_GROUPS}>
            {(group) => (
              <div class="settings-v2-section" data-component="settings-permissions-owns-group">
                <h4 class="settings-v2-section-title">{language.t(group.label)}</h4>
                <div class="settings-v2-plugins-skill-actions">
                  <For each={group.tools}>
                    {(tool) => (
                      <div data-action={`settings-permissions-owns-${tool}`}>
                        <CheckboxV2
                          label={tool}
                          checked={owns(tool)}
                          onChange={(checked) => toggleOwns(tool, checked === true)}
                          hideLabel
                        />
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.permissions.section.skills.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.skills.description")}</p>
          <Show
            when={skills.latest?.length}
            fallback={<p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.skills.empty")}</p>}
          >
            <SettingsListV2>
              <For each={skills.latest}>
                {(skill) => (
                  <SettingsRowV2
                    title={skill.name}
                    description={language.t("settings.permissions.section.skills.row.description")}
                  >
                    <div data-action={`settings-permissions-skill-${skill.name}`}>
                      <CheckboxV2
                        label={language.t("settings.permissions.section.skills.row.toggle", { name: skill.name })}
                        checked={selectedSkills().includes(skill.name)}
                        onChange={(checked) => checked === true && toggleSkill(skill.name)}
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
          <h3 class="settings-v2-section-title">{language.t("settings.permissions.section.how.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.how.description")}</p>
          <SettingsListV2>
            <For each={HOW_ROWS}>
              {(tool) => (
                <SettingsRowV2
                  title={language.t(`settings.permissions.tool.${tool}.title`)}
                  description={
                    tool === "bash"
                      ? language.t("settings.permissions.tool.bash.hint")
                      : language.t(`settings.permissions.tool.${tool}.description`)
                  }
                >
                  <div class="settings-v2-plugins-skill-actions" data-action={`settings-permissions-how-${tool}`}>
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
                    <TextInputV2
                      type="text"
                      appearance="base"
                      value={howEntry(tool).pattern}
                      aria-label={language.t("settings.permissions.pattern.label")}
                      onChange={(event) => setHow(tool, howEntry(tool).action, event.currentTarget.value)}
                    />
                  </div>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.permissions.section.manifest.title")}</h3>
          <Show
            when={manifest()}
            fallback={<p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.manifest.empty")}</p>}
          >
            <pre class="settings-v2-plugins-hint" data-action="settings-permissions-manifest">
              {manifest()}
            </pre>
          </Show>
        </div>
      </div>
    </>
  )
}