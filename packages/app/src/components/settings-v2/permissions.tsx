import { For, Show, createMemo, createResource, createSignal, type Accessor, type Component } from "solid-js"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { useLanguage } from "@/context/language"
import { useServerProtocol } from "@/context/server-sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { normalizeAgentList } from "@/context/global-sync/utils"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { fetchToolInventory } from "./tool-inventory"
import "./settings-v2.css"

type Action = "allow" | "ask" | "deny"
type PermissionRule = Action | { [pattern: string]: Action }
type AgentBlock = {
  mode?: "subagent" | "primary" | "all"
  owned_tools?: string[]
  skills?: string[]
  permission?: { [tool: string]: PermissionRule }
}

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
    tools: ["webfetch", "websearch", "skill", "lsp", "tool_search", "cua_batch", "ui_run", "session_rename"],
  },
  {
    label: "settings.permissions.section.owns.group.jev",
    tools: ["jev_accept", "jev_label", "jev_rank", "jev_decide"],
  },
] as const

const ALL_TOOLS: readonly string[] = OWNS_GROUPS.flatMap((group) => [...group.tools])

// Only pattern-bearing tools get a pattern input. The evaluator matches every
// rule against a pattern, so a bare action is the canonical form for the rest
// and a visible "*" input for all of them was pure noise.
const PATTERN_TOOLS: readonly string[] = ["bash", "read", "edit", "external_directory"]

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
  // Every PRIMARY (or mode-less) agent the runtime publishes is individually
  // editable. Config-only entries (agent.<name> in config with no runtime match)
  // are unioned in so a hand-written block never disappears from the list. This
  // panel owns primary/all agents; `mode: subagent` belongs to the Subagent tab.
  const agentOptions = createMemo(() => {
    const runtime = agentList.latest ?? []
    const mode = new Map(runtime.map((item) => [item.name, item.mode]))
    const effectiveMode = (name: string) => mode.get(name) ?? agents()[name]?.mode
    const names = [...new Set([...runtime.map((item) => item.name), ...Object.keys(agents())])]
      .filter((name) => !runtime.some((item) => item.name === name && item.hidden))
      .filter((name) => effectiveMode(name) !== "subagent")
      .sort((a, b) => {
        if (a === "brain") return -1
        if (b === "brain") return 1
        return a.localeCompare(b)
      })
    return names.map((name) => ({ name }))
  })
  const [selected, setSelected] = createSignal<string>("")
  // Empty list is possible when the runtime has not published agents and config
  // has no agent block; the row read sites deref this, so keep it total.
  const active = createMemo(
    () =>
      agentOptions().find((item) => item.name === selected()) ??
      agentOptions().find((item) => item.name === "brain") ??
      agentOptions()[0] ?? { name: "" },
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

  // Assignable tools the curated OWNS_GROUPS do not cover, plus every MCP tool
  // grouped by its server. The endpoint lives on the experimental HttpApi, which
  // the generated client contract does not include, hence the plain fetch.
  const [inventory] = createResource(() => fetchToolInventory(serverSdk().server.http))
  const discoveredRegistry = createMemo(() =>
    (inventory.latest?.registry ?? []).filter((tool) => !ALL_TOOLS.includes(tool.id)),
  )
  const exposedIds = createMemo(() => new Set((inventory.latest?.registry ?? []).map((tool) => tool.id)))
  // Before the inventory resolves everything counts as exposed, so no row flickers.
  const isExposed = (tool: string) => inventory.latest === undefined || exposedIds().has(tool)

  // THE single write path: every control funnels through here, so there is
  // exactly one updateConfig call shape for the tab.
  const commit = (name: string, patch: AgentBlock) => {
    const next = { ...config() }
    const agent = { ...agents() }
    agent[name] = { ...block(name), ...patch }
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
  const owns = (tool: string) => block(active().name).owned_tools?.includes(tool) ?? true
  const toggleOwns = (tool: string, checked: boolean) => {
    const current = block(active().name).owned_tools
    // INVARIANT: unchecking must never materialize a tool id this build does not
    // expose, so `known` is filtered to the registry the server actually serves.
    const known = [
      ...OWNS_GROUPS.flatMap((group) => group.tools),
      ...(current ?? []),
      ...discoveredRegistry().map((tool) => tool.id),
    ].filter(isExposed)
    const owned_tools = checked
      ? [...new Set([...(current ?? known.filter((name) => owns(name))), tool])]
      : (current ?? known).filter((name) => name !== tool)
    commit(active().name, { owned_tools })
  }

  // One commit flips a whole group, reusing toggleOwns's owned_tools shape so
  // the write path cannot diverge. It always acts on the group's FULL tool
  // list: the search filter narrows what is rendered, never what is written.
  const toggleGroupOwns = (tools: readonly string[], checked: boolean) => {
    const current = block(active().name).owned_tools
    // INVARIANT: unchecking must never materialize a tool id this build does not
    // expose, so `known` is filtered to the registry the server actually serves.
    const known = [
      ...OWNS_GROUPS.flatMap((group) => group.tools),
      ...(current ?? []),
      ...discoveredRegistry().map((tool) => tool.id),
    ].filter(isExposed)
    const owned_tools = checked
      ? [...new Set([...(current ?? known.filter((name) => owns(name))), ...tools])]
      : (current ?? known).filter((name) => !tools.includes(name))
    commit(active().name, { owned_tools })
  }

  // Session-local catalog search, never persisted. An empty query renders every
  // group whole; a group whose rows all filter out drops out entirely.
  const [ownsQuery, setOwnsQuery] = createSignal("")
  const visibleOwnsGroups = createMemo(() => {
    const query = ownsQuery().trim().toLowerCase()
    return OWNS_GROUPS.map((group) => ({
      ...group,
      // The group master and the count badge read allTools, keeping their
      // owned/total meaning independent of the active search.
      allTools: group.tools,
      tools:
        query === ""
          ? [...group.tools]
          : group.tools.filter(
              (tool) =>
                `${language.t(`settings.permissions.tool.${tool}.title`)} ${
                  tool === "bash"
                    ? language.t("settings.permissions.tool.bash.hint")
                    : language.t(`settings.permissions.tool.${tool}.description`)
                }`
                  .toLowerCase()
                  .includes(query),
            ),
    })).filter((group) => group.tools.length > 0)
  })

  const selectedSkills = () => block(active().name).skills ?? []
  const toggleSkill = (skill: string) => {
    const current = selectedSkills()
    const next = current.includes(skill) ? current.filter((item) => item !== skill) : [...current, skill]
    commit(active().name, { skills: next })
  }

  // The evaluator flattens the agent block into ONE ruleset and findLast picks
  // the last match, so an earlier catch-all still governs every later key — the
  // UI must resolve rules the same way or it shows grants the agent never gets.
  const effectiveAction = (tool: string, fallback: Action) => {
    const ruleset = Object.entries(block(active().name).permission ?? {}).flatMap(([permission, value]) =>
      typeof value === "string"
        ? [{ permission, pattern: "*", action: value }]
        : Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action })),
    )
    return (
      ruleset.findLast((rule) => Wildcard.match(tool, rule.permission) && Wildcard.match(tool, rule.pattern))
        ?.action ?? fallback
    )
  }

  const howEntry = (tool: string) => {
    const value = block(active().name).permission?.[tool]
    if (!value) return { action: effectiveAction(tool, "ask"), pattern: "*" }
    if (typeof value === "string") return { action: value, pattern: "*" }
    const [pattern, action] = Object.entries(value)[0] ?? ["*", "ask" as Action]
    return { action, pattern }
  }
  const setHow = (tool: string, action: Action, pattern: string) => {
    const permission = { ...block(active().name).permission }
    // The bare-action form keeps the config canonical for the "*" pattern;
    // anything else needs the pattern map.
    permission[tool] = pattern.trim() === "" || pattern === "*" ? action : { [pattern.trim()]: action }
    commit(active().name, { permission })
  }

  // One commit flips every tool of a server, reusing the bare-action entry
  // shape setHow writes for the "*" pattern so evaluation is identical.
  const setAllForServer = (tools: { name: string }[], action: "allow" | "deny") => {
    const permission = {
      ...block(active().name).permission,
      ...Object.fromEntries(tools.map((tool) => [tool.name, action])),
    }
    commit(active().name, { permission })
  }

  // Unset means allowed, so the checkbox is inverted: checked = allowed.
  const denied = (tool: string) => effectiveAction(tool, "allow") === "deny"

  const manifest = createMemo(() => {
    const ruleset: { permission: string; pattern: string; action: Action }[] = []
    for (const [tool, value] of Object.entries(block(active().name).permission ?? {})) {
      ruleset.push(
        ...(typeof value === "string"
          ? [{ permission: tool, pattern: "*", action: value }]
          : Object.entries(value).map(([pattern, action]) => ({ permission: tool, pattern, action }))),
      )
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
                  value={(option) => option.name}
                  label={(option) => option.name}
                  onSelect={(option) => option && setSelected(option.name)}
                />
              </div>
            </SettingsRowV2>
            <p class="settings-v2-plugins-hint settings-v2-permissions-summary" data-action="settings-permissions-summary">
              {language.t("settings.permissions.agent.summary", {
                owned: ALL_TOOLS.filter(isExposed).filter((tool) => owns(tool)).length,
                total: ALL_TOOLS.filter(isExposed).length,
                skills: selectedSkills().length,
              })}
            </p>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.permissions.section.owns.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.owns.description")}</p>
          <div class="settings-v2-plugins-search">
            <TextInputV2
              type="search"
              appearance="base"
              value={ownsQuery()}
              onInput={(event) => setOwnsQuery(event.currentTarget.value)}
              placeholder={language.t("settings.permissions.owns.search")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.permissions.owns.search")}
            />
          </div>
          <For each={visibleOwnsGroups()}>
            {(group) => (
              <div class="settings-v2-section" data-component="settings-permissions-owns-group">
                <h4 class="settings-v2-section-title">
                  {language.t(group.label)}{" "}
                  <span class="settings-v2-permissions-count">
                    {language.t("settings.permissions.owns.count", {
                      owned: group.allTools.filter(isExposed).filter((tool) => owns(tool)).length,
                      total: group.allTools.filter(isExposed).length,
                    })}
                  </span>{" "}
                  <div
                    class="inline-flex align-middle"
                    data-action={`settings-permissions-owns-all-${group.label.split(".").pop()}`}
                  >
                    <CheckboxV2
                      label={language.t("settings.permissions.owns.groupToggle")}
                      checked={group.allTools.filter(isExposed).every((tool) => owns(tool))}
                      indeterminate={
                        group.allTools.filter(isExposed).some((tool) => owns(tool)) &&
                        !group.allTools.filter(isExposed).every((tool) => owns(tool))
                      }
                      onChange={(checked) => toggleGroupOwns(group.allTools.filter(isExposed), checked === true)}
                      hideLabel
                    />
                  </div>
                </h4>
                <SettingsListV2>
                  <For each={group.tools}>
                    {(tool) => (
                      <SettingsRowV2
                        title={language.t(`settings.permissions.tool.${tool}.title`)}
                        description={
                          (tool === "bash"
                            ? language.t("settings.permissions.tool.bash.hint")
                            : language.t(`settings.permissions.tool.${tool}.description`)) +
                          (isExposed(tool) ? "" : ` — ${language.t("settings.permissions.owns.notExposed")}`)
                        }
                      >
                        <div
                          class="settings-v2-permissions-row-controls"
                          classList={{ "settings-v2-permissions-row-dim": !isExposed(tool) }}
                        >
                          <div data-action={`settings-permissions-owns-${tool}`}>
                            <CheckboxV2
                              label={language.t("settings.permissions.owns.toggle")}
                              checked={owns(tool)}
                              // A stale owned entry stays checkable so it can be pruned.
                              disabled={!owns(tool) && !isExposed(tool)}
                              onChange={(checked) => toggleOwns(tool, checked === true)}
                            />
                          </div>
                          <div
                            class="settings-v2-permissions-row-actions"
                            classList={{ "settings-v2-permissions-row-dim": !owns(tool) }}
                            data-action={`settings-permissions-how-${tool}`}
                          >
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
                            <Show when={PATTERN_TOOLS.includes(tool)}>
                              <TextInputV2
                                type="text"
                                appearance="base"
                                value={howEntry(tool).pattern}
                                aria-label={language.t("settings.permissions.pattern.label")}
                                onChange={(event) => setHow(tool, howEntry(tool).action, event.currentTarget.value)}
                              />
                            </Show>
                          </div>
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
          <h3 class="settings-v2-section-title">{language.t("settings.permissions.section.tools.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.tools.description")}</p>
          <Show
            when={!inventory.loading && !inventory.error}
            fallback={
              <p class="settings-v2-plugins-hint">
                {language.t(
                  inventory.error ? "settings.permissions.section.tools.error" : "settings.permissions.section.tools.loading",
                )}
              </p>
            }
          >
            <For each={discoveredRegistry()}>
              {(tool) => (
                <SettingsListV2>
                  <SettingsRowV2 title={tool.id} description={tool.description ?? ""}>
                    <div data-action={`settings-permissions-tool-${tool.id}`}>
                      <CheckboxV2
                        label={language.t("settings.permissions.owns.toggle")}
                        checked={owns(tool.id)}
                        onChange={(checked) => toggleOwns(tool.id, checked === true)}
                      />
                    </div>
                  </SettingsRowV2>
                </SettingsListV2>
              )}
            </For>
            <For each={inventory.latest?.mcp ?? []}>
              {(server) => (
                <div class="settings-v2-section" data-component="settings-permissions-mcp-server">
                  <div class="flex items-center gap-2">
                    <h4 class="settings-v2-section-title settings-v2-permissions-row-dim">{server.server}</h4>
                    <div data-action={`settings-permissions-mcp-all-${server.server}`}>
                      <CheckboxV2
                        label={language.t("settings.permissions.owns.toggle")}
                        checked={server.tools.every((tool) => !denied(tool.name))}
                        indeterminate={
                          !server.tools.every((tool) => !denied(tool.name)) && server.tools.some((tool) => !denied(tool.name))
                        }
                        onChange={(checked) => setAllForServer(server.tools, checked === true ? "allow" : "deny")}
                        hideLabel
                      />
                    </div>
                  </div>
                  <SettingsListV2>
                    <For each={server.tools}>
                      {(tool) => (
                        <SettingsRowV2 title={tool.name} description={tool.description ?? ""}>
                          <div data-action={`settings-permissions-mcp-${tool.name}`}>
                            <CheckboxV2
                              label={language.t("settings.permissions.owns.toggle")}
                              checked={!denied(tool.name)}
                              onChange={(checked) => setHow(tool.name, checked === true ? "allow" : "deny", "*")}
                              hideLabel
                            />
                          </div>
                        </SettingsRowV2>
                      )}
                    </For>
                  </SettingsListV2>
                </div>
              )}
            </For>
          </Show>
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
                  <SettingsRowV2 title={skill.name} description="">
                    <div data-action={`settings-permissions-skill-${skill.name}`}>
                      <CheckboxV2
                        label={language.t("settings.permissions.section.skills.row.toggle", { name: skill.name })}
                        checked={selectedSkills().includes(skill.name)}
                        onChange={(checked) => toggleSkill(skill.name)}
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