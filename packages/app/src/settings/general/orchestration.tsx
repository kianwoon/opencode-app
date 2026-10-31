import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import { Icon } from "@opencode/ui/icon"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { Badge } from "@opencode/ui/badge"
import { Show, type Component, createMemo, createResource, For } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useModels } from "@/providers/models/models"
import type { ModelKey } from "@/providers/models/selection"
import { useServerSDK } from "@/runtime/server/client"
import type { ExperimentalConfigUpdateInput } from "@opencode/client/promise"
import { useServer } from "@/runtime/server/current"
import { authTokenFromCredentials } from "@/runtime/server/api"
import { ModelSelectorDrawer } from "@/providers/models/select-dialog"
import { showToast } from "@/shell/notifications/toast"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"

type Enforcement = "strict" | "advisory"

const enforcementOptions: Enforcement[] = ["strict", "advisory"]

// Mirrors JEV_DEFAULT_MODEL in packages/opencode/src/jev/client.ts. The app
// bundle cannot import from the server package, so keep this literal in sync:
// the shared default is `provider/model-id`, resolved to the SystemOne path.
const JEV_DEFAULT_MODEL = "typesafe/jev-latest"

// Mirrors JEV_DEFAULT_THRESHOLD in packages/opencode/src/jev/client.ts — same
// bundle-boundary reason as the model literal above.
const JEV_DEFAULT_THRESHOLD = 0.7

type BrainConfig = {
  model?: string
  enforcement?: Enforcement
}

// Fork-only config blocks are not in the shared Config schema yet.
type OrchestrationConfig = {
  brain?: BrainConfig
  jev?: { enabled?: boolean; threshold?: number }
  governor?: { enabled?: boolean; model?: string }
  brainBooster?: { enabled?: boolean; model?: string }
  jevDefault?: { model?: string }
  // `config.get` returns the canonical compaction shape: `preserve_recent_tokens`
  // normalizes into `keep.tokens` and `reserved` into `buffer`. Writes speak those
  // canonical leaves too: a legacy-only leaf is not consumed by the v2 runtime.
  compaction?: { auto?: boolean; keep?: { tokens?: number }; buffer?: number; trigger_tokens?: number }
}

// Empty string means "unset": the brain agent expansion treats falsy models as
// absent, and the global config PATCH endpoint deep-merges, so cleared values
// must still be sent for the field to take effect.

type FieldState = {
  ready: unknown
  list: unknown
  current: () => unknown
  set: (item: ModelKey | undefined) => void
  visible: (item: ModelKey) => boolean
  setVisibility: (item: ModelKey, visible: boolean) => void
}

const ModelFieldControl: Component<{ field: string; state: FieldState }> = (props) => {
  const language = useLanguage()
  const current = createMemo(() => {
    const item = props.state.current() as { provider?: { id: string }; name?: string } | undefined
    return item
  })
  return (
    <ModelSelectorDrawer
      model={props.state as never}
      trigger={(triggerProps) => (
        <Button
          {...triggerProps}
          variant="ghost-muted"
          size="normal"
          style={{ height: "28px" }}
          class="min-w-0 w-full justify-start ![font-weight:440] group"
          data-action={`settings-orchestration-${props.field}`}
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
        </Button>
      )}
    />
  )
}
// Read-only rendering helpers for the effort-router status + Jev verdict tail.
// Verdict records are unknown-shaped (the server passes through whatever the
// plugin logged), so every field is coerced defensively.
const verdictTime = (ts: unknown) => {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "--:--:--"
  return new Date(ts).toLocaleTimeString()
}

const verdictDetail = (verdict: Record<string, unknown>) => {
  const parts: string[] = []
  if (verdict.tier !== undefined) parts.push(`tier ${String(verdict.tier)}`)
  if (verdict.strength !== undefined) parts.push(`strength ${String(verdict.strength)}`)
  if (verdict.action !== undefined) parts.push(`action ${String(verdict.action)}`)
  if (verdict.reason !== undefined) parts.push(String(verdict.reason))
  return parts.join(" · ") || String(verdict.sessionID ?? "")
}

type GateConfigState = { scopingEnabled?: boolean; summarizeEnabled?: boolean; triageEnabled?: boolean }
type EffortRouterState = { jev: { enabled?: boolean }; guardrail: { enabled?: boolean } }
type JevVerdict = Record<string, unknown>

export const SettingsOrchestrationV2: Component = () => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const server = useServer()

  // This panel writes the GLOBAL config document via `experimental.config.update`,
  // so it must read that same document: `config.get()` without a location returns
  // the whole document chain lowest→highest priority, and the later document wins.
  // Reading a location-scoped sync store instead makes every field show its
  // default while the file on disk holds a value.
  const [configResource, configActions] = createResource(
    async (): Promise<OrchestrationConfig> =>
      Object.assign(
        {},
        ...(await serverSdk.api.config.get()).flatMap((entry) => (entry.type === "document" ? [entry.info] : [])),
      ) as OrchestrationConfig,
  )
  // Never read `.latest` before the first value: it suspends. Show the sync-store
  // copy the app already has until the document chain lands.
  const configLoaded = () => configResource.state === "ready" || configResource.state === "refreshing"
  const config = (): OrchestrationConfig =>
    configLoaded() ? (configResource.latest ?? {}) : ((server.ctx.sync.data.config ?? {}) as OrchestrationConfig)

  const updateConfig = (patch: ExperimentalConfigUpdateInput) =>
    serverSdk.api.experimental.config.update(patch).then((result) => {
      // A commit must show immediately; do not wait for `config.updated` to sync.
      void Promise.resolve(configActions.refetch()).catch(() => undefined)
      return result
    })
  const unavailable = () => language.t("settings.orchestration.unavailable")

  // Fork-owned global endpoints are not part of the generated v2 client contract, so read them over plain fetch.
  const request = async (path: string, init?: RequestInit) => {
    const http = serverSdk.http
    const headers = http.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ password: http.password })}` }
      : undefined
    const response = await fetch(`${http.url}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) },
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    // 204 and empty bodies are successful no-content replies; only parse when
    // there is actually a body, so a server that answers 204 cannot crash the
    // panel with "Unexpected end of JSON input".
    if (response.status === 204) return undefined
    const body = await response.text()
    if (body.trim() === "") return undefined
    return JSON.parse(body) as unknown
  }

  // Reads must never reject: a server that does not serve a route (404) or an
  // empty reply is a legitimate "not available", rendered as such instead of
  // crashing the tab. Writes stay on `request` so they can report failure.
  const requestRead = async (path: string) => {
    try {
      return await request(path)
    } catch {
      return undefined
    }
  }

  const brain = createMemo<BrainConfig>(() => config().brain ?? {})
  const jev = createMemo(() => config().jev ?? {})
  const governor = createMemo(() => config().governor ?? {})
  const brainBooster = createMemo(() => config().brainBooster ?? {})
  const jevDefault = createMemo(() => config().jevDefault ?? {})
  const compaction = createMemo(() => config().compaction ?? {})
  const models = useModels()

  // Panel-mount reads of the server-owned effort-router state. Both resolve
  // `undefined` when the route is absent or the reply is empty, which renders
  // as "not available"; they never reject into the render path.
  const [effortRouter] = createResource(async () => {
    return (await requestRead("/global/effort-router")) as EffortRouterState | undefined
  })

  const [verdicts] = createResource(async () => {
    return (await requestRead("/global/jev-verdicts?limit=5")) as JevVerdict[] | undefined
  })

  // Context-gate config: server-owned file state, read at mount and after each
  // write. Read-only fields are displayed; only triage is writable here.
  const [gateConfig, gateConfigActions] = createResource(async () => {
    return (await requestRead("/global/gate-config")) as GateConfigState | undefined
  })

  const commitGateTriage = (value: boolean) => {
    void request("/global/gate-config", { method: "PATCH", body: JSON.stringify({ triageEnabled: value }) })
      .then(() => gateConfigActions.refetch())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const currentFor = (field: "model") => {
    const value = brain()[field] ?? ""
    const [providerID, ...rest] = value.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return
    return models.find({ providerID, modelID })
  }

  const commitField = (field: "model", item: ModelKey | undefined) => {
    commit({ [field]: item ? `${item.providerID}/${item.modelID}` : "" })
  }

  // Adapter exposing a brain field as the ModelState shape the composer
  // picker expects. Selection reads from server config; commit writes back.
  // The picker also uses `recent.push` when selecting; that only affects the
  // composer's recent list, which is harmless here.
  const stateFor = (field: "model") => ({
    ready: models.ready,
    list: models.list,
    current: () => currentFor(field),
    set(item: ModelKey | undefined) {
      commitField(field, item)
    },
    visible: (item: ModelKey) => models.visible(item),
    setVisibility: (item: ModelKey, visible: boolean) => models.setVisibility(item, visible),
    recent: models.recent,
  })

  // A jev/governor/brainBooster model field lives inside its OWN config block,
  // so it needs its own reader/writer rather than the brain `model` field.
  type FeatureSection = "jev" | "governor" | "brainBooster"

  const section = (name: FeatureSection | "jevDefault"): { model?: string; enabled?: boolean; threshold?: number } =>
    config()[name] ?? {}

  const currentSectionModel = (name: FeatureSection | "jevDefault") => {
    const value = section(name).model ?? ""
    const [providerID, ...rest] = value.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return
    return models.find({ providerID, modelID })
  }

  const commitSection = (name: FeatureSection | "jevDefault", model: string) => {
    const value = { ...section(name), model }
    const patch: ExperimentalConfigUpdateInput =
      name === "jev"
        ? { jev: value }
        : name === "governor"
          ? { governor: value }
          : name === "brainBooster"
            ? { brainBooster: value }
            : { jevDefault: value }
    void updateConfig(patch)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const sectionStateFor = (name: FeatureSection | "jevDefault") => ({
    ready: models.ready,
    list: models.list,
    current: () => currentSectionModel(name),
    set(item: ModelKey | undefined) {
      commitSection(name, item ? `${item.providerID}/${item.modelID}` : "")
    },
    visible: (item: ModelKey) => models.visible(item),
    setVisibility: (item: ModelKey, visible: boolean) => models.setVisibility(item, visible),
    recent: models.recent,
  })

  // Rendered description reflects the RESOLVED model: the feature's own model,
  // else the shared default, else the built-in literal. Never a hardcoded
  // literal that can drift from the runtime.
  const modelLabel = (name: FeatureSection) => section(name).model || jevDefault().model || JEV_DEFAULT_MODEL

  const modelRows = [
    {
      field: "model" as const,
      title: () => language.t("settings.orchestration.row.model.title"),
      description: () => language.t("settings.orchestration.row.model.description"),
    },
  ]

  const enforcementLabels: Record<Enforcement, () => string> = {
    strict: () => language.t("settings.orchestration.enforcement.option.strict"),
    advisory: () => language.t("settings.orchestration.enforcement.option.advisory"),
  }

  const commit = (patch: Partial<BrainConfig>) => {
    void updateConfig({ brain: { ...brain(), ...patch } })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const commitJev = (patch: { enabled?: boolean; threshold?: number }) => {
    void updateConfig({ jev: { ...jev(), ...patch } })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  // Threshold is a confidence floor, not a probability the user can reason
  // about continuously: commit on `change` (blur/Enter), never on every
  // keystroke, so a partially typed "0." never persists as a floor of 0.
  const commitThreshold = (raw: string) => {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > 1) return
    commitJev({ threshold: value })
  }

  // A token budget, not a probability: commit on `change` (blur/Enter), never per
  // keystroke, so a partially typed "8" never persists as an 8-token budget.
  const commitCompaction = (patch: { auto?: boolean; preserve_recent_tokens?: number; buffer?: number }) => {
    void updateConfig({ compaction: patch })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const commitPreserveRecentTokens = (raw: string) => {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return
    commitCompaction({ preserve_recent_tokens: value })
  }

  // The trigger row edits `compaction.buffer`: tokens kept free below the model's
  // usable window, so compaction fires at `window - buffer`. A positive count;
  // the runtime ignores a buffer that leaves no room at all.
  const commitTriggerTokens = (raw: string) => {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 1) return
    commitCompaction({ buffer: value })
  }

  const commitGovernor = (patch: { enabled?: boolean }) => {
    void updateConfig({ governor: { ...governor(), ...patch } })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const commitBrainBooster = (patch: { enabled?: boolean }) => {
    void updateConfig({ brainBooster: { ...brainBooster(), ...patch } })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.orchestration.title")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsList>
            <For each={modelRows}>
              {(row) => (
                <SettingsRow title={row.title()} description={row.description()}>
                  <div class="w-full sm:w-[220px]">
                    <ModelFieldControl field={row.field} state={stateFor(row.field)} />
                  </div>
                </SettingsRow>
              )}
            </For>

            <SettingsRow
              title={language.t("settings.orchestration.enforcement.title")}
              description={language.t("settings.orchestration.enforcement.description")}
            >
              <Select
                data-action="settings-orchestration-enforcement"
                aria-label={language.t("settings.orchestration.enforcement.title")}
                options={enforcementOptions}
                current={brain().enforcement ?? "advisory"}
                placement="bottom-end"
                gutter={6}
                value={(option) => option}
                label={(option) => enforcementLabels[option]()}
                onSelect={(option) => {
                  if (!option || option === brain().enforcement) return
                  commit({ enforcement: option })
                }}
              />
            </SettingsRow>

            <SettingsRow
              title="Default Jev model"
              description={`Fallback decision model for tool routing, governor and booster when their own model is unset (currently ${modelLabel("jev")}).`}
            >
              <div class="w-full sm:w-[220px]">
                <ModelFieldControl field="jev-default-model" state={sectionStateFor("jevDefault")} />
              </div>
            </SettingsRow>

            <SettingsRow title="Tool routing" description={`Route tools via ${modelLabel("jev")}. OFF keeps the full tool list.`}>
              <Switch checked={jev().enabled ?? false} onChange={() => commitJev({ enabled: !(jev().enabled ?? false) })} hideLabel>
                Toggle Jev tool routing
              </Switch>
            </SettingsRow>

            <SettingsRow title="Tool routing model" description="Decision model for Jev tool routing (any provider; typesafe routes to SystemOne).">
              <div class="w-full sm:w-[220px]">
                <ModelFieldControl field="jev-model" state={sectionStateFor("jev")} />
              </div>
            </SettingsRow>

            <SettingsRow
              title="Tool routing threshold"
              description="Confidence floor (0-1) a Jev row must reach to keep/drop a tool. Below it the row fails open and the tool stays. Default 0.7."
            >
              <div class="w-full sm:w-[220px]">
                <TextInput
                  data-action="settings-orchestration-jev-threshold"
                  type="number"
                  numeric
                  min={0}
                  max={1}
                  step={0.05}
                  value={String(jev().threshold ?? JEV_DEFAULT_THRESHOLD)}
                  onChange={(event) => commitThreshold(event.currentTarget.value)}
                  aria-label="Tool routing threshold"
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title="Context governor"
              description={`Drop-only relevance gating of conversation context via ${modelLabel("governor")}. OFF keeps all context.`}
            >
              <Switch
                checked={governor().enabled ?? false}
                onChange={() => commitGovernor({ enabled: !(governor().enabled ?? false) })}
                hideLabel
              >
                Toggle context governor
              </Switch>
            </SettingsRow>

            <SettingsRow title="Context governor model" description="Decision model for the context governor (any provider; typesafe routes to SystemOne).">
              <div class="w-full sm:w-[220px]">
                <ModelFieldControl field="governor-model" state={sectionStateFor("governor")} />
              </div>
            </SettingsRow>

            <SettingsRow
              title="Brain booster"
              description={`Advisory-only Jev reasoning judgement (switch/verify/contradiction/finish) via ${modelLabel("brainBooster")} injected per provider turn. OFF emits nothing.`}
            >
              <Switch
                checked={brainBooster().enabled ?? false}
                onChange={() => commitBrainBooster({ enabled: !(brainBooster().enabled ?? false) })}
                hideLabel
              >
                Toggle brain booster
              </Switch>
            </SettingsRow>

            <SettingsRow title="Brain booster model" description="Decision model for the brain booster (any provider; typesafe routes to SystemOne).">
              <div class="w-full sm:w-[220px]">
                <ModelFieldControl field="brainBooster-model" state={sectionStateFor("brainBooster")} />
              </div>
            </SettingsRow>

            <SettingsRow
              title="Context scoping"
              description="Withhold guide sections until session activity mentions them. Read-only; edit context-gate.json to change."
            >
              <Badge variant="neutral" data-action="settings-orchestration-gate-scoping-status">
                {gateConfig() === undefined
                  ? unavailable()
                  : gateConfig()?.scopingEnabled
                    ? "scoping on"
                    : "scoping off"}
              </Badge>
            </SettingsRow>

            <SettingsRow
              title="Automatic compaction"
              description="Master switch for compaction. While OFF, no threshold is consulted and the context grows unbounded — the other two settings below have no effect. Writes apply immediately."
            >
              <Switch
                checked={compaction().auto ?? false}
                onChange={() => commitCompaction({ auto: !(compaction().auto ?? false) })}
                data-action="settings-orchestration-compaction-auto"
                hideLabel
              >
                Toggle automatic compaction
              </Switch>
            </SettingsRow>

            <SettingsRow
              title="Preserve recent tokens"
              description="Tokens of recent turns kept verbatim after a compaction; the remainder is summarized. Unset uses the model-window default (25% of usable, clamped 2000-15000). Above the model's own max it has no effect."
            >
              <div class="w-full sm:w-[220px]">
                <TextInput
                  data-action="settings-orchestration-preserve-recent-tokens"
                  type="number"
                  numeric
                  min={0}
                  step={1000}
                  value={String(compaction().keep?.tokens ?? "")}
                  onChange={(event) => commitPreserveRecentTokens(event.currentTarget.value)}
                  aria-label="Preserve recent tokens"
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title="Context trigger tokens"
              description="Tokens kept free below the model's usable window: compaction fires at the window minus this value. Unset uses the model default (15% of the window, at least 16k). Fires at the next safe boundary; each event re-bills the prompt prefix once."
            >
              <div class="w-full sm:w-[220px]">
                <TextInput
                  data-action="settings-orchestration-compaction-trigger-tokens"
                  type="number"
                  numeric
                  min={1}
                  step={10000}
                  value={String(compaction().buffer ?? "")}
                  onChange={(event) => commitTriggerTokens(event.currentTarget.value)}
                  aria-label="Context trigger tokens"
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title="Section summarization"
              description="Compress oversize markdown sections before they enter context. Read-only; edit context-gate.json to change."
            >
              <Badge variant="neutral" data-action="settings-orchestration-gate-summarize-status">
                {gateConfig() === undefined
                  ? unavailable()
                  : gateConfig()?.summarizeEnabled
                    ? "summarize on"
                    : "summarize off"}
              </Badge>
            </SettingsRow>

            <SettingsRow
              title="Compaction triage"
              description={
                gateConfig()?.scopingEnabled === false
                  ? "Requires scoping: the gate early-returns when both scoping and summarization are off, so triage never runs."
                  : "Classify each oversize section before summarizing: only a decisive keep preserves it verbatim."
              }
            >
              <Switch
                checked={gateConfig()?.triageEnabled ?? false}
                onChange={() => commitGateTriage(!(gateConfig()?.triageEnabled ?? false))}
                disabled={gateConfig() === undefined || gateConfig()?.scopingEnabled === false}
                hideLabel
              >
                Toggle compaction triage
              </Switch>
            </SettingsRow>

            <SettingsRow
              title="Effort router status"
              description="Resolved from effort-router.json at panel mount. Read-only; edit the file to change the router itself."
            >
              <Badge variant="neutral" data-action="settings-orchestration-effort-router-status">
                {effortRouter() === undefined
                  ? unavailable()
                  : effortRouter()?.jev.enabled
                    ? "jev enabled"
                    : "jev disabled"}
              </Badge>
            </SettingsRow>

            <SettingsRow
              title="Guardrail status"
              description="Pre-execution Noul guardrail bands for risky tools. Read-only; OFF means risky tools run unchecked."
            >
              <Badge variant="neutral" data-action="settings-orchestration-guardrail-status">
                {effortRouter() === undefined
                  ? unavailable()
                  : effortRouter()?.guardrail.enabled
                    ? "guardrail enabled"
                    : "guardrail disabled"}
              </Badge>
            </SettingsRow>

            <SettingsRow
              title="Recent Jev verdicts"
              description="Newest effort-router decisions from effort-router.jsonl (up to 5). Read-only."
            >
              <div class="w-full sm:w-[260px] flex flex-col gap-1" data-action="settings-orchestration-jev-verdicts">
                <Show
                  when={(verdicts()?.length ?? 0) > 0}
                  fallback={
                    <span class="truncate leading-4 opacity-60">
                      {verdicts.loading
                        ? ""
                        : verdicts() === undefined
                          ? unavailable()
                          : language.t("settings.orchestration.verdicts.empty")}
                    </span>
                  }
                >
                  <For each={verdicts()}>
                    {(verdict) => (
                      <div class="flex items-baseline gap-2 leading-4">
                        <span class="shrink-0 opacity-60" style={{ "font-variant-numeric": "tabular-nums" }}>{verdictTime(verdict.ts)}</span>
                        <span class="truncate">{String(verdict.event ?? "unknown")}</span>
                        <span class="truncate opacity-60">{verdictDetail(verdict)}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
    </>
  )
}
