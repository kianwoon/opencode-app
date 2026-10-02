import { For, Show, createEffect, createMemo, createResource, createSignal, on, type Accessor, type Component } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import type { ModelKey } from "@/context/local"
import { useServerProtocol } from "@/context/server-sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { normalizeAgentList } from "@/context/global-sync/utils"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { promptBody, resolvePrompt, writePromptBody } from "./subagent-prompt"
import { fetchToolInventory } from "./tool-inventory"
import "./settings-v2.css"

type Action = "allow" | "ask" | "deny"
type PermissionRule = Action | { [pattern: string]: Action }
type AgentBlock = {
  description?: string
  mode?: "subagent" | "primary" | "all"
  model?: string
  owned_tools?: string[]
  skills?: string[]
  capabilities?: string[]
  permission?: { [tool: string]: PermissionRule }
  steps?: number
  temperature?: number
  top_p?: number
  hidden?: boolean
  // A rename copies the RESOLVED prompt/description/mode onto the new key, so
  // the moved block must carry them; `disable` is the tombstone left behind on
  // the old key (updateConfig deep-merges and cannot delete).
  prompt?: string
  disable?: boolean
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
  {
    label: "settings.subagent.owns.group.jev",
    tools: ["jev_accept", "jev_label", "jev_rank", "jev_decide"],
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
  // Provider-free on purpose: this tab renders OUTSIDE the directory Sync
  // provider, so the directory-scoped sync hook throws at render. Same
  // dual-protocol resource shape as the skills fetch below.
  const [agentList, { refetch: refetchAgents }] = createResource(
    () => ({ protocol: protocol(), directory: props.directory() }),
    async (input) => {
      if (input.protocol === undefined) return []
      if (input.protocol === "v1") return normalizeAgentList((await serverSdk().client.app.agents()).data ?? [])
      return normalizeAgentList((await serverSdk().api.agent.list({ location: { directory: input.directory } })).data)
    },
  )
  // Subagent panel only: the primary agent is the Orchestration tab's business,
  // and config-only entries are unioned in so a hand-written block never
  // disappears from the list. A `disable: true` tombstone (left behind by a
  // rename, since updateConfig cannot delete a key) is not selectable.
  const agentOptions = createMemo(() => {
    const runtime = agentList.latest ?? []
    const names = [...new Set([...runtime.map((item) => item.name), ...Object.keys(agents())])].filter(
      (name) =>
        !runtime.some((item) => item.name === name && item.mode === "primary") && agents()[name]?.disable !== true,
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

  // Assignable tools the curated OWNS_GROUPS do not cover, plus every MCP tool
  // grouped by its server. The endpoint lives on the experimental HttpApi, which
  // the generated client contract does not include, hence the plain fetch.
  const [inventory] = createResource(() => fetchToolInventory(serverSdk().server.http))
  const discoveredRegistry = createMemo(() =>
    (inventory.latest?.registry ?? []).filter((tool) => !ALL_TOOLS.includes(tool.id)),
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

  const currentModel = createMemo(() => {
    const value = block(active().name).model ?? ""
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
      commit(active().name, { model: item ? `${item.providerID}/${item.modelID}` : "" })
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
    const known = [
      ...OWNS_GROUPS.flatMap((group) => group.tools),
      ...(current ?? []),
      ...discoveredRegistry().map((tool) => tool.id),
    ]
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

  const capabilities = createMemo(() => block(active().name).capabilities ?? [])

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

  // One commit flips every tool of a server, reusing the bare-action entry
  // shape setHow writes for the "*" pattern so evaluation is identical.
  const setAllForServer = (tools: { name: string }[], action: "allow" | "deny") => {
    const permission = {
      ...block(active().name).permission,
      ...Object.fromEntries(tools.map((tool) => [tool.name, action])),
    }
    commit(active().name, { permission })
  }

  // An MCP tool is denied when its rule resolves to "deny", whether stored bare
  // or as a pattern map whose "*" denies. Unset means allowed, so the checkbox
  // is inverted: checked = allowed.
  const denied = (tool: string) => {
    const value = block(active().name).permission?.[tool]
    if (typeof value === "string") return value === "deny"
    if (value && typeof value === "object") return value["*"] === "deny"
    return false
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

  // One inline editor serves both create and rename, so the draft name and its
  // error live in a single store rather than a signal per field.
  // The delete confirm joins the create/rename draft store rather than owning a
  // signal: it is the same two-step "open, then confirm or cancel" state, so
  // closeEditor resets all three at once.
  const [editor, setEditor] = createStore<{ kind: "" | "create" | "rename" | "delete"; name: string; error: string }>({
    kind: "",
    name: "",
    error: "",
  })
  const closeEditor = () => setEditor({ kind: "", name: "", error: "" })

  // agentOptions() deliberately hides primary agents, so it is the WRONG set for
  // a duplicate check: creating or renaming to build/plan/brain would otherwise
  // pass and clobber that agent's config block. Every existing name counts here,
  // primary and native included; only a disabled tombstone is free to reuse.
  const reservedNames = createMemo(
    () =>
      new Set(
        [...(agentList.latest ?? []).map((item) => item.name), ...Object.keys(agents())].filter(
          (name) => agents()[name]?.disable !== true,
        ),
      ),
  )

  // task.ts resolves a subagent by config KEY (agent.get(name)), so a rename has
  // to move the key itself; both flows share this one validator.
  const nameError = (raw: string) => {
    const name = raw.trim()
    if (name === "") return language.t("settings.subagent.name.error.empty")
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return language.t("settings.subagent.name.error.invalid")
    if (reservedNames().has(name)) return language.t("settings.subagent.name.error.duplicate")
    return ""
  }

  // Create and rename must move the selection only once the write lands, so they
  // await it; the row controls keep commit()'s fire-and-forget path. The agent
  // map is deep-merged, so a partial patch adds or overwrites without restating
  // untouched keys. Resolves false so the caller can skip setSelected.
  const commitAgentPatch = (patch: Record<string, AgentBlock>) =>
    serverSync()
      .updateConfig({ agent: patch })
      .then(
        () => true,
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          showToast({ title: language.t("settings.subagent.toast.updateFailed.title"), description: message })
          return false
        },
      )

  const confirmCreate = async () => {
    const error = nameError(editor.name)
    if (error !== "") return setEditor("error", error)
    const name = editor.name.trim()
    if (!(await commitAgentPatch({ [name]: { mode: "subagent" } }))) return
    setSelected(name)
    closeEditor()
  }

  const resolvedPrompt = createMemo(
    () => agentList.latest?.find((item) => item.name === active().name)?.prompt ?? "",
  )

  // `.md` frontmatter wins over opencode.json (config.ts merges md as the 2nd
  // arg), so a config write to a key the md declares is silently dead.
  const mdBacked = createMemo(
    () => agentList.latest?.find((item) => item.name === active().name)?.origin === "md",
  )

  // The md BODY is the prompt, so the panel can edit it in place -- but only
  // through the desktop bridge, whose main-process guard scopes writes to the
  // agent roots. Web (and config/native agents) keep the read-only view.
  const platform = usePlatform()
  const promptEditable = createMemo(() => mdBacked() && !!platform.readFile && !!platform.writeFile)
  const [promptEditor, setPromptEditor] = createSignal<{ name: string; body: string } | null>(null)
  // A file read is async, so a save can land before it returns. Retaining the
  // saved body keeps the row and the next Edit prefill correct immediately; the
  // file read is the source of truth and takes over again on a refetch.
  const [promptOverride, setPromptOverride] = createStore<Record<string, string>>({})
  createEffect(
    on(
      () => active().name,
      () => setPromptOverride(reconcile({})),
    ),
  )
  // For an md agent the `.md` body IS the prompt, so it is read from the file
  // rather than the server's cached copy -- the file is already correct the
  // moment a save lands. A config or native agent has no file, keeps the server
  // value, and never triggers a read.
  const [mdPrompt, { refetch: refetchMdPrompt }] = createResource(
    () => {
      const item = agentList.latest?.find((entry) => entry.name === active().name)
      return item?.origin === "md" ? item.originPath : undefined
    },
    async (path) => {
      const read = platform.readFile
      if (!path || !read) return undefined
      return promptBody(await read(path))
    },
  )
  const shownPrompt = createMemo(() =>
    resolvePrompt({
      override: promptOverride[active().name],
      file: mdBacked() ? mdPrompt() : undefined,
      server: resolvedPrompt(),
    }),
  )

  // The body is written through `writePromptBody`, which preserves the leading
  // frontmatter byte-for-byte. Deliberately no config write here: a
  // `PATCH /config` makes `Config.updateGlobal` fork
  // `disposeAllInstancesAndEmitGlobalDisposed`, disposing every instance and
  // killing the very run that clicked Save.
  const savePrompt = () => {
    const draft = promptEditor()
    const path = agentList.latest?.find((item) => item.name === draft?.name)?.originPath
    const read = platform.readFile
    const write = platform.writeFile
    if (!draft || !path || !read || !write) return
    return writePromptBody({ readFile: read, writeFile: write }, path, draft.body)
      .then(() => {
        // A save can land after the user moved on: only close the editor it
        // saved, and only retain that agent's body.
        if (promptEditor()?.name === draft.name) {
          setPromptOverride(draft.name, draft.body)
          setPromptEditor(null)
        }
        return Promise.all([refetchMdPrompt(), refetchAgents()])
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("settings.subagent.toast.updateFailed.title"), description: message })
      })
  }

  // A native agent is provided by the runtime and its key must not move. There is
  // no brain clause any more: brain dispatch is registry-driven and brain no
  // longer owns any other agent's model.
  const renameBlock = createMemo(() => {
    const runtime = agentList.latest?.find((item) => item.name === active().name)
    if (runtime?.native) return language.t("settings.subagent.rename.disabled.native")
    return ""
  })

  const confirmRename = async () => {
    const from = active().name
    if (from === "" || renameBlock() !== "") return
    const error = nameError(editor.name)
    if (error !== "") return setEditor("error", error)
    const to = editor.name.trim()
    const runtime = agentList.latest?.find((item) => item.name === from)
    // Carry the RESOLVED values onto the new key: once the old key is
    // tombstoned the runtime no longer resolves its prompt/description/mode.
    const moved: AgentBlock = { ...agents()[from] }
    if (moved.prompt === undefined) moved.prompt = runtime?.prompt
    if (moved.description === undefined) moved.description = runtime?.description
    if (moved.mode === undefined) moved.mode = runtime?.mode ?? "subagent"
    delete moved.disable
    // Selecting `to` before the write lands would leave the panel pointing at a
    // key that does not exist yet, so the selection waits on the tombstone.
    if (!(await commitAgentPatch({ [to]: moved, [from]: { disable: true } }))) return
    setSelected(to)
    closeEditor()
  }

  // Deleting a subagent is a tombstone write: the config API deep-merges and has
  // no delete, so the key survives with `disable: true`, the runtime drops it
  // (agent.ts honours the tombstone) and the list filters it out. No brain/native
  // guard: brain dispatch is registry-driven (`task: {"*":"allow"}`), so a brain
  // wired agent disappears from the runtime as a whole rather than half-existing.
  const confirmDelete = async () => {
    const name = active().name
    if (name === "") return
    if (!(await commitAgentPatch({ [name]: { disable: true } }))) return
    setSelected(agentOptions()[0]?.name ?? "")
    closeEditor()
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
              <div class="w-full sm:w-[220px] flex items-center gap-2">
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
                <ButtonV2
                  variant="ghost"
                  size="small"
                  data-action="settings-subagent-new"
                  onClick={() => setEditor({ kind: "create", name: "", error: "" })}
                >
                  {language.t("settings.subagent.create.title")}
                </ButtonV2>
              </div>
            </SettingsRowV2>
            <Show when={editor.kind === "create"}>
              <div class="w-full flex flex-col gap-2" data-action="settings-subagent-create">
                <div class="w-full sm:w-[320px] flex items-center gap-2">
                  <TextInputV2
                    type="text"
                    appearance="base"
                    value={editor.name}
                    invalid={editor.error !== ""}
                    aria-label={language.t("settings.subagent.create.title")}
                    onChange={(event) => setEditor({ name: event.currentTarget.value, error: "" })}
                  />
                  <ButtonV2
                    variant="ghost"
                    size="small"
                    data-action="settings-subagent-create-confirm"
                    onClick={confirmCreate}
                  >
                    {language.t("settings.subagent.create.confirm")}
                  </ButtonV2>
                  <ButtonV2
                    variant="ghost"
                    size="small"
                    data-action="settings-subagent-create-cancel"
                    onClick={closeEditor}
                  >
                    {language.t("settings.subagent.create.cancel")}
                  </ButtonV2>
                </div>
                <Show when={editor.error !== ""}>
                  <p class="settings-v2-plugins-hint" data-action="settings-subagent-create-error">
                    {editor.error}
                  </p>
                </Show>
              </div>
            </Show>
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
              title={language.t("settings.subagent.row.capabilities.title")}
              description={language.t("settings.subagent.row.capabilities.description")}
            >
              <div class="w-full sm:w-[320px]" data-action="settings-subagent-capabilities">
                <TextInputV2
                  type="text"
                  appearance="base"
                  value={capabilities().join(", ")}
                  aria-label={language.t("settings.subagent.row.capabilities.title")}
                  onChange={(event) =>
                    commit(active().name, {
                      capabilities: event.currentTarget.value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.subagent.row.description.title")}
              description={language.t("settings.subagent.row.description.description")}
            >
              <Show
                when={!mdBacked()}
                fallback={
                  <p class="settings-v2-plugins-hint" data-action="settings-subagent-description-md">
                    {language.t("settings.subagent.mdBacked", { file: `agent/${active().name}.md` })}
                  </p>
                }
              >
                <div class="w-full sm:w-[320px]" data-action="settings-subagent-description">
                  <TextareaV2
                    rows={3}
                    value={block(active().name).description ?? ""}
                    aria-label={language.t("settings.subagent.row.description.title")}
                    onChange={(event) => commit(active().name, { description: event.currentTarget.value })}
                  />
                </div>
              </Show>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.subagent.prompt.title")}
              description={language.t(
                promptEditable()
                  ? "settings.subagent.prompt.editableDescription"
                  : "settings.subagent.prompt.description",
              )}
            >
              <div class="w-full sm:w-[420px]">
                <Show
                  when={promptEditor()?.name === active().name ? promptEditor() : undefined}
                  fallback={
                    <>
                      <Show
                        when={shownPrompt()}
                        fallback={
                          <p class="settings-v2-plugins-hint" data-action="settings-subagent-prompt-empty">
                            {language.t("settings.subagent.prompt.empty")}
                          </p>
                        }
                      >
                        {(prompt) => (
                          <pre
                            class="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-12-regular"
                            data-action="settings-subagent-prompt"
                          >
                            {prompt()}
                          </pre>
                        )}
                      </Show>
                      <Show when={promptEditable()}>
                        <div class="mt-2">
                          <ButtonV2
                            variant="ghost"
                            size="small"
                            data-action="settings-subagent-prompt-edit"
                            onClick={() => setPromptEditor({ name: active().name, body: shownPrompt() })}
                          >
                            {language.t("settings.subagent.prompt.edit")}
                          </ButtonV2>
                        </div>
                      </Show>
                    </>
                  }
                >
                  {(draft) => (
                    <div class="w-full flex flex-col gap-2">
                      <TextareaV2
                        rows={8}
                        value={draft().body}
                        aria-label={language.t("settings.subagent.prompt.title")}
                        onChange={(event) => setPromptEditor({ name: active().name, body: event.currentTarget.value })}
                      />
                      <div class="flex items-center gap-2">
                        <ButtonV2 size="small" data-action="settings-subagent-prompt-save" onClick={() => savePrompt()}>
                          {language.t("settings.subagent.prompt.save")}
                        </ButtonV2>
                        <ButtonV2
                          variant="ghost"
                          size="small"
                          data-action="settings-subagent-prompt-cancel"
                          onClick={() => setPromptEditor(null)}
                        >
                          {language.t("settings.subagent.prompt.cancel")}
                        </ButtonV2>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.subagent.rename.title")}
              description={language.t("settings.subagent.rename.description")}
            >
              <Show
                when={renameBlock()}
                fallback={
                  <div class="w-full sm:w-[320px] flex items-center gap-2">
                    <ButtonV2
                      variant="ghost"
                      size="small"
                      data-action="settings-subagent-rename"
                      onClick={() => setEditor({ kind: "rename", name: active().name, error: "" })}
                    >
                      {language.t("settings.subagent.rename.action")}
                    </ButtonV2>
                    <Show when={editor.kind === "rename"}>
                      <TextInputV2
                        type="text"
                        appearance="base"
                        value={editor.name}
                        invalid={editor.error !== ""}
                        aria-label={language.t("settings.subagent.rename.title")}
                        onChange={(event) => setEditor({ name: event.currentTarget.value, error: "" })}
                      />
                      <ButtonV2
                        variant="ghost"
                        size="small"
                        data-action="settings-subagent-rename-confirm"
                        onClick={confirmRename}
                      >
                        {language.t("settings.subagent.rename.confirm")}
                      </ButtonV2>
                      <ButtonV2
                        variant="ghost"
                        size="small"
                        data-action="settings-subagent-rename-cancel"
                        onClick={closeEditor}
                      >
                        {language.t("settings.subagent.rename.cancel")}
                      </ButtonV2>
                    </Show>
                  </div>
                }
              >
                {(reason) => (
                  <p class="settings-v2-plugins-hint" data-action="settings-subagent-rename-blocked">
                    {reason()}
                  </p>
                )}
              </Show>
            </SettingsRowV2>
            <Show when={editor.kind === "rename"}>
              <div class="w-full flex flex-col gap-2">
                <Show when={editor.error !== ""}>
                  <p class="settings-v2-plugins-hint" data-action="settings-subagent-rename-error">
                    {editor.error}
                  </p>
                </Show>
                <p class="settings-v2-plugins-hint" data-action="settings-subagent-rename-tombstone">
                  {language.t("settings.subagent.rename.tombstone", { from: active().name })}
                </p>
              </div>
            </Show>
            <SettingsRowV2
              title={language.t("settings.subagent.delete.title")}
              description={language.t("settings.subagent.delete.description")}
            >
              <div class="w-full sm:w-[320px] flex items-center gap-2">
                <ButtonV2
                  variant="ghost"
                  size="small"
                  data-action="settings-subagent-delete"
                  onClick={() => setEditor({ kind: "delete", name: "", error: "" })}
                >
                  {language.t("settings.subagent.delete.action")}
                </ButtonV2>
                <Show when={editor.kind === "delete"}>
                  <ButtonV2
                    variant="ghost"
                    size="small"
                    data-action="settings-subagent-delete-confirm"
                    onClick={confirmDelete}
                  >
                    {language.t("settings.subagent.delete.confirm")}
                  </ButtonV2>
                  <ButtonV2
                    variant="ghost"
                    size="small"
                    data-action="settings-subagent-delete-cancel"
                    onClick={closeEditor}
                  >
                    {language.t("settings.subagent.delete.cancel")}
                  </ButtonV2>
                </Show>
              </div>
            </SettingsRowV2>
            <Show when={editor.kind === "delete"}>
              <div class="w-full flex flex-col gap-2">
                <p class="settings-v2-plugins-hint" data-action="settings-subagent-delete-hint">
                  {language.t("settings.subagent.delete.hint", { name: active().name })}
                </p>
              </div>
            </Show>
            <SettingsRowV2
              title={language.t("settings.subagent.row.mode.title")}
              description={language.t("settings.subagent.row.mode.description")}
            >
              <Show
                when={!mdBacked()}
                fallback={
                  <p class="settings-v2-plugins-hint" data-action="settings-subagent-mode-md">
                    {language.t("settings.subagent.mdBacked", { file: `agent/${active().name}.md` })}
                  </p>
                }
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
              </Show>
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
                    <div data-action={`settings-subagent-tool-${tool.id}`}>
                      <CheckboxV2
                        label={language.t("settings.subagent.owns.toggle")}
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
                <div class="settings-v2-section" data-component="settings-subagent-mcp-server">
                  <div class="flex items-center gap-2">
                    <h4 class="settings-v2-section-title settings-v2-permissions-row-dim">{server.server}</h4>
                    <div data-action={`settings-subagent-mcp-all-${server.server}`}>
                      <CheckboxV2
                        label={language.t("settings.subagent.owns.toggle")}
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
                          <div data-action={`settings-subagent-mcp-${tool.name}`}>
                            <CheckboxV2
                              label={language.t("settings.subagent.owns.toggle")}
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