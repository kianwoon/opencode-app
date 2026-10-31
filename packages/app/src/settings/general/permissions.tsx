import { For, Show, createMemo, createResource, createSignal, type Accessor, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Checkbox } from "@opencode/ui/checkbox"
import { Icon } from "@opencode/ui/icon"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { Wildcard } from "./wildcard"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import type { ExperimentalConfigUpdateInput } from "@opencode/client/promise"
import { useServer } from "@/runtime/server/current"
import { normalizeAgentList } from "@/runtime/server/global-sync/utils"
import { showToast } from "@/shell/notifications/toast"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { fetchToolInventory } from "./tool-inventory"
// The panels read the normalized config the server serves (`agents`, permissions
// as an ordered ruleset), never the legacy on-disk key; the write path stays legacy.
import { agentPatch, readAgents, type Action, type AgentBlock } from "./config-agent"
import "@/settings/settings.css"

/**
 * A group either lists its members or CLAIMS them by predicate. The JEV family is
 * claimed by prefix, so a tool added server-side (or a plugin registering a
 * `jev_*` id) appears in this group with zero edits to this file.
 */
const isJevTool = (id: string) => id.startsWith("jev_")

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
    tools: ["webfetch", "websearch", "skill", "lsp", "tool_search", "cua_batch", "ui_nav", "session_rename"],
  },
  {
    label: "settings.permissions.section.owns.group.jev",
    match: isJevTool,
  },
] as const

// Only pattern-bearing tools get a pattern input. The evaluator matches every
// rule against a pattern, so a bare action is the canonical form for the rest
// and a visible "*" input for all of them was pure noise.
const PATTERN_TOOLS: readonly string[] = ["bash", "read", "edit", "external_directory", "package_install"]

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
  const server = useServer()
  const updateConfig = (patch: ExperimentalConfigUpdateInput) => serverSdk.api.experimental.config.update(patch)

  const config = createMemo(() => server.ctx.sync.data.config ?? {})
  // The served Info is normalized (`agents`, permissions as a Permission.Ruleset
  // array); config-agent.ts maps it back onto the legacy block shape the rows and
  // commit() speak, so an on-disk rule is visible instead of a silent "ask".
  const agents = createMemo<Record<string, AgentBlock>>(() => readAgents(config()))
  // Provider-free on purpose: this tab renders OUTSIDE the directory Sync
  // provider, so the directory-scoped sync hook throws at render. Same
  // dual-protocol resource shape as the skills fetch below.
  const [agentList] = createResource(
    () => props.directory(),
    async (directory) =>
      normalizeAgentList((await serverSdk.api.agent.list({ location: { directory } })).data),
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
    () => props.directory(),
    async (directory) => {
      const result = await serverSdk.api.skill.list({ location: { directory } })
      return (result.data ?? []) as { name: string }[]
    },
  )

  // Assignable tools the curated OWNS_GROUPS do not cover, plus every MCP tool
  // grouped by its server. The endpoint lives on the experimental HttpApi, which
  // the generated client contract does not include, hence the plain fetch.
  const [inventory] = createResource(() => fetchToolInventory(serverSdk.server.http))
  const registryEntries = createMemo(() => inventory.latest?.registry ?? [])
  const groupTools = (group: (typeof OWNS_GROUPS)[number]) =>
    "tools" in group ? [...group.tools] : registryEntries().filter((tool) => group.match(tool.id)).map((tool) => tool.id)
  // Every member of every group, so "+ Tools" can offer only what no group
  // already claims and the section total counts the auto-discovered jev_* ids.
  const ownedGroupTools = createMemo(() => OWNS_GROUPS.flatMap(groupTools))
  const discoveredRegistry = createMemo(() => registryEntries().filter((tool) => !ownedGroupTools().includes(tool.id)))
  const registryDescription = (tool: string) => registryEntries().find((entry) => entry.id === tool)?.description
  // A jev_* row is described by the registry the server actually serves, so a
  // new tool needs no i18n entry; the curated keys stay as the fallback and the
  // bare id is the last resort. Non-jev groups keep their i18n copy verbatim.
  const rowTitle = (tool: string) => (isJevTool(tool) ? tool : (language.t(`settings.permissions.tool.${tool}.title`) ?? tool))
  const rowDescription = (tool: string) => {
    if (tool === "bash") return language.t("settings.permissions.tool.bash.hint")
    if (isJevTool(tool)) return registryDescription(tool) ?? language.t(`settings.permissions.tool.${tool}.description`) ?? tool
    return language.t(`settings.permissions.tool.${tool}.description`)
  }
  const exposedIds = createMemo(() => new Set((inventory.latest?.registry ?? []).map((tool) => tool.id)))
  // Before the inventory resolves everything counts as exposed, so no row flickers.
  const isExposed = (tool: string) => inventory.latest === undefined || exposedIds().has(tool)

  // THE single write path: every control funnels through here, so there is
  // exactly one updateConfig call shape for the tab. The patch stays on the
  // legacy `agent` key and carries ONLY the keys the control changed: the served
  // block cannot reconstruct prompt/variant/color, so restating it would erase
  // them, and the server merges the named keys into the on-disk block.
  const commit = (name: string, patch: AgentBlock) => {
    void updateConfig(agentPatch(name, patch))
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
      ...ownedGroupTools(),
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
      ...ownedGroupTools(),
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
    return OWNS_GROUPS.map((group) => {
      const members = groupTools(group)
      return {
        ...group,
        // The group master and the count badge read allTools, keeping their
        // owned/total meaning independent of the active search.
        allTools: members,
        tools:
          query === "" ? members : members.filter((tool) => `${rowTitle(tool)} ${rowDescription(tool)}`.toLowerCase().includes(query)),
      }
    }).filter((group) => group.tools.length > 0)
  })

  // Every section starts COLLAPSED: the store records only the sections the
  // user explicitly expanded; an absent key stays folded. A non-empty search
  // forces the curated groups open so results stay visible. The guard section is
  // the one exception — it holds a single row whose findability is the point.
  const [expanded, setExpanded] = createStore({
    groups: {} as Record<string, boolean>,
    servers: {} as Record<string, boolean>,
    sections: { guard: true } as Record<string, boolean>,
  })
  const ownsExpanded = (group: string) => ownsQuery().trim() !== "" || expanded.groups[group] === true
  const serverExpanded = (server: string) => expanded.servers[server] === true
  const sectionExpanded = (key: string) => expanded.sections[key] === true

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
          <SettingsList>
            <SettingsRow
              title={language.t("settings.permissions.agent.title")}
              description={language.t("settings.permissions.agent.description")}
            >
              <div class="w-full sm:w-[220px]">
                <Select
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
            </SettingsRow>
            <p class="settings-v2-plugins-hint settings-v2-permissions-summary" data-action="settings-permissions-summary">
              {language.t("settings.permissions.agent.summary", {
                owned: ownedGroupTools().filter(isExposed).filter((tool) => owns(tool)).length,
                total: ownedGroupTools().filter(isExposed).length,
                skills: selectedSkills().length,
              })}
            </p>
          </SettingsList>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.permissions.section.owns.title")}</h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.owns.description")}</p>
          <div class="settings-v2-plugins-search">
            <TextInput
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
              <div
                class="settings-v2-section"
                data-component="settings-permissions-owns-group"
                data-expanded={ownsExpanded(group.label) ? "" : undefined}
              >
                <h4 class="settings-v2-section-title">
                  <button
                    type="button"
                    class="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:bg-surface-raised-base-hover"
                    data-action={`settings-permissions-owns-group-toggle-${group.label.split(".").pop()}`}
                    aria-expanded={ownsExpanded(group.label)}
                    onClick={() => setExpanded("groups", group.label, !ownsExpanded(group.label))}
                  >
                    <Icon name={ownsExpanded(group.label) ? "chevron-down" : "chevron-right"} size="small" />
                    {language.t(group.label)}
                  </button>{" "}
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
                    <Checkbox
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
                <Show when={ownsExpanded(group.label)}>
                <SettingsList>
                  <For each={group.tools}>
                    {(tool) => (
                      <SettingsRow
                        title={rowTitle(tool)}
                        description={
                          rowDescription(tool) + (isExposed(tool) ? "" : ` — ${language.t("settings.permissions.owns.notExposed")}`)
                        }
                      >
                        <div
                          class="settings-v2-permissions-row-controls"
                          classList={{ "settings-v2-permissions-row-dim": !isExposed(tool) }}
                        >
                          <div data-action={`settings-permissions-owns-${tool}`}>
                            <Checkbox
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
                            <Select
                                          options={actionOptions}
                              current={howEntry(tool).action}
                              placement="bottom-end"
                              gutter={6}
                              value={(option) => option}
                              label={actionLabel}
                              onSelect={(option) => option && setHow(tool, option, howEntry(tool).pattern)}
                            />
                            <Show when={PATTERN_TOOLS.includes(tool)}>
                              <TextInput
                                type="text"
                                appearance="base"
                                value={howEntry(tool).pattern}
                                aria-label={language.t("settings.permissions.pattern.label")}
                                onChange={(event) => setHow(tool, howEntry(tool).action, event.currentTarget.value)}
                              />
                            </Show>
                          </div>
                        </div>
                      </SettingsRow>
                    )}
                  </For>
                </SettingsList>
                </Show>
              </div>
            )}
          </For>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:bg-surface-raised-base-hover"
              data-action="settings-permissions-section-tools-toggle"
              aria-expanded={sectionExpanded("tools")}
              onClick={() => setExpanded("sections", "tools", !sectionExpanded("tools"))}
            >
              <Icon name={sectionExpanded("tools") ? "chevron-down" : "chevron-right"} size="small" />
              {language.t("settings.permissions.section.tools.title")}
            </button>
          </h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.tools.description")}</p>
          <Show when={sectionExpanded("tools")}>
          <Show
            when={!inventory.loading && !inventory.error && inventory.latest !== undefined}
            fallback={
              <p class="settings-v2-plugins-hint">
                {language.t(
                  inventory.error || (!inventory.loading && inventory.latest === undefined)
                    ? "settings.permissions.section.tools.error"
                    : "settings.permissions.section.tools.loading",
                )}
              </p>
            }
          >
            <Show when={discoveredRegistry().length > 0}>
              <h4 class="settings-v2-section-title">
                <button
                  type="button"
                  class="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:bg-surface-raised-base-hover"
                  data-action="settings-permissions-section-discovered-toggle"
                  aria-expanded={sectionExpanded("discovered")}
                  onClick={() => setExpanded("sections", "discovered", !sectionExpanded("discovered"))}
                >
                  <Icon name={sectionExpanded("discovered") ? "chevron-down" : "chevron-right"} size="small" />
                  {language.t("settings.permissions.section.discovered.title")}
                  <span class="settings-v2-permissions-count">{discoveredRegistry().length}</span>
                </button>
              </h4>
              <Show when={sectionExpanded("discovered")}>
                <For each={discoveredRegistry()}>
                  {(tool) => (
                    <SettingsList>
                      <SettingsRow title={tool.id} description={tool.description ?? ""}>
                        <div data-action={`settings-permissions-tool-${tool.id}`}>
                          <Checkbox
                            label={language.t("settings.permissions.owns.toggle")}
                            checked={owns(tool.id)}
                            onChange={(checked) => toggleOwns(tool.id, checked === true)}
                          />
                        </div>
                      </SettingsRow>
                    </SettingsList>
                  )}
                </For>
              </Show>
            </Show>
            <For each={inventory.latest?.mcp ?? []}>
              {(server) => (
                <div
                  class="settings-v2-section"
                  data-component="settings-permissions-mcp-server"
                  data-expanded={serverExpanded(server.server) ? "" : undefined}
                >
                  <div class="flex items-center gap-2">
                    <h4 class="settings-v2-section-title settings-v2-permissions-row-dim">
                      <button
                        type="button"
                        class="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:bg-surface-raised-base-hover"
                        data-action={`settings-permissions-mcp-toggle-${server.server}`}
                        aria-expanded={serverExpanded(server.server)}
                        onClick={() => setExpanded("servers", server.server, !serverExpanded(server.server))}
                      >
                        <Icon name={serverExpanded(server.server) ? "chevron-down" : "chevron-right"} size="small" />
                        {server.server}
                      </button>
                    </h4>
                    <div data-action={`settings-permissions-mcp-all-${server.server}`}>
                      <Checkbox
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
                  <Show when={serverExpanded(server.server)}>
                  <SettingsList>
                    <For each={server.tools}>
                      {(tool) => (
                        <SettingsRow title={tool.name} description={tool.description ?? ""}>
                          <div data-action={`settings-permissions-mcp-${tool.name}`}>
                            <Checkbox
                              label={language.t("settings.permissions.owns.toggle")}
                              checked={!denied(tool.name)}
                              onChange={(checked) => setHow(tool.name, checked === true ? "allow" : "deny", "*")}
                              hideLabel
                            />
                          </div>
                        </SettingsRow>
                      )}
                    </For>
                  </SettingsList>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          </Show>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:bg-surface-raised-base-hover"
              data-action="settings-permissions-section-guard-toggle"
              aria-expanded={sectionExpanded("guard")}
              onClick={() => setExpanded("sections", "guard", !sectionExpanded("guard"))}
            >
              <Icon name={sectionExpanded("guard") ? "chevron-down" : "chevron-right"} size="small" />
              {language.t("settings.permissions.section.guard.title")}
            </button>
          </h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.guard.description")}</p>
          <Show when={sectionExpanded("guard")}>
            <SettingsList>
              <For each={["package_install"]}>
                {(tool) => (
                  <SettingsRow
                    title={language.t(`settings.permissions.tool.${tool}.title`)}
                    description={language.t(`settings.permissions.tool.${tool}.description`)}
                  >
                    <div class="settings-v2-permissions-row-controls" data-action={`settings-permissions-how-${tool}`}>
                      <Select
                              options={actionOptions}
                        current={howEntry(tool).action}
                        placement="bottom-end"
                        gutter={6}
                        value={(option) => option}
                        label={actionLabel}
                        onSelect={(option) => option && setHow(tool, option, howEntry(tool).pattern)}
                      />
                      <TextInput
                        type="text"
                        appearance="base"
                        value={howEntry(tool).pattern}
                        aria-label={language.t("settings.permissions.pattern.label")}
                        onChange={(event) => setHow(tool, howEntry(tool).action, event.currentTarget.value)}
                      />
                    </div>
                  </SettingsRow>
                )}
              </For>
            </SettingsList>
          </Show>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:bg-surface-raised-base-hover"
              data-action="settings-permissions-section-skills-toggle"
              aria-expanded={sectionExpanded("skills")}
              onClick={() => setExpanded("sections", "skills", !sectionExpanded("skills"))}
            >
              <Icon name={sectionExpanded("skills") ? "chevron-down" : "chevron-right"} size="small" />
              {language.t("settings.permissions.section.skills.title")}
              <span class="settings-v2-permissions-count">{skills.latest?.length ?? 0}</span>
            </button>
          </h3>
          <p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.skills.description")}</p>
          <Show when={sectionExpanded("skills")}>
            <Show
              when={skills.latest?.length}
              fallback={<p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.skills.empty")}</p>}
            >
              <SettingsList>
                <For each={skills.latest}>
                  {(skill) => (
                    <SettingsRow title={skill.name} description="">
                      <div data-action={`settings-permissions-skill-${skill.name}`}>
                        <Checkbox
                          label={language.t("settings.permissions.section.skills.row.toggle", { name: skill.name })}
                          checked={selectedSkills().includes(skill.name)}
                          onChange={(checked) => toggleSkill(skill.name)}
                          hideLabel
                        />
                      </div>
                    </SettingsRow>
                  )}
                </For>
              </SettingsList>
            </Show>
          </Show>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:bg-surface-raised-base-hover"
              data-action="settings-permissions-section-manifest-toggle"
              aria-expanded={sectionExpanded("manifest")}
              onClick={() => setExpanded("sections", "manifest", !sectionExpanded("manifest"))}
            >
              <Icon name={sectionExpanded("manifest") ? "chevron-down" : "chevron-right"} size="small" />
              {language.t("settings.permissions.section.manifest.title")}
            </button>
          </h3>
          <Show when={sectionExpanded("manifest")}>
            <Show
              when={manifest()}
              fallback={<p class="settings-v2-plugins-hint">{language.t("settings.permissions.section.manifest.empty")}</p>}
            >
              <pre class="settings-v2-plugins-hint" data-action="settings-permissions-manifest">
                {manifest()}
              </pre>
            </Show>
          </Show>
        </div>
      </div>
    </>
  )
}