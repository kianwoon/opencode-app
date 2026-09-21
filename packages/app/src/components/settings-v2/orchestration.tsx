import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Show, type Component, createMemo, createResource, For } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import type { ModelKey } from "@/context/local"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

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
  hands_model?: string
  reviewer_model?: string
  guru_model?: string
  computer_aid_model?: string
  enforcement?: Enforcement
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
    <ModelSelectorPopoverV2
      model={props.state as never}
      trigger={(triggerProps) => (
        <ButtonV2
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
        </ButtonV2>
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

export const SettingsOrchestrationV2: Component = () => {  const language = useLanguage()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()

  const brain = createMemo<BrainConfig>(() => serverSync().data.config.brain ?? {})
  const jev = createMemo(() => serverSync().data.config.jev ?? {})
  const governor = createMemo(() => serverSync().data.config.governor ?? {})
  const brainBooster = createMemo(() => serverSync().data.config.brainBooster ?? {})
  const jevDefault = createMemo(() => serverSync().data.config.jevDefault ?? {})
  const models = useModels()

  // Panel-mount reads of the server-owned effort-router state. Both fail
  // SILENT: `createResource` parks a failure in `.error`, so a missing/older
  // server or a malformed record renders "unknown" and never breaks the tab,
  // which stays usable for config writes.
  const [effortRouter] = createResource(async () => {
    const result = await serverSDK().client.global.effortRouter.get()
    return result.data ?? undefined
  })

  const [verdicts] = createResource(async () => {
    const result = await serverSDK().client.global.jevVerdicts.list({ limit: "5" })
    return result.data ?? []
  })

  // Context-gate config: server-owned file state, read at mount and after each
  // write. Read-only fields are displayed; only triage is writable here.
  const [gateConfig, gateConfigActions] = createResource(async () => {
    const result = await serverSDK().client.global.gateConfig.get()
    return result.data ?? undefined
  })

  const commitGateTriage = (value: boolean) => {
    void serverSDK()
      .client.global.gateConfig.update({ triageEnabled: value })
      .then(() => gateConfigActions.refetch())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const currentFor = (field: "model" | "hands_model" | "reviewer_model" | "guru_model" | "computer_aid_model") => {
    const value = brain()[field] ?? ""
    const [providerID, ...rest] = value.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return
    return models.find({ providerID, modelID })
  }

  const commitField = (field: "model" | "hands_model" | "reviewer_model" | "guru_model" | "computer_aid_model", item: ModelKey | undefined) => {
    commit({ [field]: item ? `${item.providerID}/${item.modelID}` : "" })
  }

  // Adapter exposing a brain field as the ModelState shape the composer
  // picker expects. Selection reads from server config; commit writes back.
  // The picker also uses `recent.push` when selecting; that only affects the
  // composer's recent list, which is harmless here.
  const stateFor = (field: "model" | "hands_model" | "reviewer_model" | "guru_model" | "computer_aid_model") => ({
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

  const section = (name: FeatureSection | "jevDefault") => serverSync().data.config[name] ?? {}

  const currentSectionModel = (name: FeatureSection | "jevDefault") => {
    const value = section(name).model ?? ""
    const [providerID, ...rest] = value.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return
    return models.find({ providerID, modelID })
  }

  const commitSection = (name: FeatureSection | "jevDefault", model: string) => {
    void serverSync()
      .updateConfig({ [name]: { ...section(name), model } })
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
    {
      field: "hands_model" as const,
      title: () => language.t("settings.orchestration.row.handsModel.title"),
      description: () => language.t("settings.orchestration.row.handsModel.description"),
    },
    {
      field: "reviewer_model" as const,
      title: () => language.t("settings.orchestration.row.reviewerModel.title"),
      description: () => language.t("settings.orchestration.row.reviewerModel.description"),
    },
    {
      field: "guru_model" as const,
      title: () => language.t("settings.orchestration.row.guruModel.title"),
      description: () => language.t("settings.orchestration.row.guruModel.description"),
    },
    {
      field: "computer_aid_model" as const,
      title: () => language.t("settings.orchestration.row.computerAidModel.title"),
      description: () => language.t("settings.orchestration.row.computerAidModel.description"),
    },
  ]

  const enforcementLabels: Record<Enforcement, () => string> = {
    strict: () => language.t("settings.orchestration.enforcement.option.strict"),
    advisory: () => language.t("settings.orchestration.enforcement.option.advisory"),
  }

  const commit = (patch: Partial<BrainConfig>) => {
    void serverSync()
      .updateConfig({ brain: { ...brain(), ...patch } })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const commitJev = (patch: { enabled?: boolean; threshold?: number }) => {
    void serverSync()
      .updateConfig({ jev: { ...jev(), ...patch } })
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

  const commitGovernor = (patch: { enabled?: boolean }) => {
    void serverSync()
      .updateConfig({ governor: { ...governor(), ...patch } })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const commitBrainBooster = (patch: { enabled?: boolean }) => {
    void serverSync()
      .updateConfig({ brainBooster: { ...brainBooster(), ...patch } })
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
          <SettingsListV2>
            <For each={modelRows}>
              {(row) => (
                <SettingsRowV2 title={row.title()} description={row.description()}>
                  <div class="w-full sm:w-[220px]">
                    <ModelFieldControl field={row.field} state={stateFor(row.field)} />
                  </div>
                </SettingsRowV2>
              )}
            </For>

            <SettingsRowV2
              title={language.t("settings.orchestration.enforcement.title")}
              description={language.t("settings.orchestration.enforcement.description")}
            >
              <SelectV2
                appearance="inline"
                data-action="settings-orchestration-enforcement"
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
            </SettingsRowV2>

            <SettingsRowV2
              title="Default Jev model"
              description={`Fallback decision model for tool routing, governor and booster when their own model is unset (currently ${modelLabel("jev")}).`}
            >
              <div class="w-full sm:w-[220px]">
                <ModelFieldControl field="jev-default-model" state={sectionStateFor("jevDefault")} />
              </div>
            </SettingsRowV2>

            <SettingsRowV2 title="Tool routing" description={`Route tools via ${modelLabel("jev")}. OFF keeps the full tool list.`}>
              <Switch checked={jev().enabled ?? false} onChange={() => commitJev({ enabled: !(jev().enabled ?? false) })} hideLabel>
                Toggle Jev tool routing
              </Switch>
            </SettingsRowV2>

            <SettingsRowV2 title="Tool routing model" description="Decision model for Jev tool routing (any provider; typesafe routes to SystemOne).">
              <div class="w-full sm:w-[220px]">
                <ModelFieldControl field="jev-model" state={sectionStateFor("jev")} />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title="Tool routing threshold"
              description="Confidence floor (0-1) a Jev row must reach to keep/drop a tool. Below it the row fails open and the tool stays. Default 0.7."
            >
              <div class="w-full sm:w-[220px]">
                <TextInputV2
                  data-action="settings-orchestration-jev-threshold"
                  type="number"
                  appearance="base"
                  numeric
                  min={0}
                  max={1}
                  step={0.05}
                  value={String(jev().threshold ?? JEV_DEFAULT_THRESHOLD)}
                  onChange={(event) => commitThreshold(event.currentTarget.value)}
                  aria-label="Tool routing threshold"
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
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
            </SettingsRowV2>

            <SettingsRowV2 title="Context governor model" description="Decision model for the context governor (any provider; typesafe routes to SystemOne).">
              <div class="w-full sm:w-[220px]">
                <ModelFieldControl field="governor-model" state={sectionStateFor("governor")} />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
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
            </SettingsRowV2>

            <SettingsRowV2 title="Brain booster model" description="Decision model for the brain booster (any provider; typesafe routes to SystemOne).">
              <div class="w-full sm:w-[220px]">
                <ModelFieldControl field="brainBooster-model" state={sectionStateFor("brainBooster")} />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title="Context scoping"
              description="Withhold guide sections until session activity mentions them. Read-only; edit context-gate.json to change."
            >
              <Tag variant="neutral" data-action="settings-orchestration-gate-scoping-status">
                {gateConfig() === undefined
                  ? "unknown"
                  : gateConfig()?.scopingEnabled
                    ? "scoping on"
                    : "scoping off"}
              </Tag>
            </SettingsRowV2>

            <SettingsRowV2
              title="Section summarization"
              description="Compress oversize markdown sections before they enter context. Read-only; edit context-gate.json to change."
            >
              <Tag variant="neutral" data-action="settings-orchestration-gate-summarize-status">
                {gateConfig() === undefined
                  ? "unknown"
                  : gateConfig()?.summarizeEnabled
                    ? "summarize on"
                    : "summarize off"}
              </Tag>
            </SettingsRowV2>

            <SettingsRowV2
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
            </SettingsRowV2>

            <SettingsRowV2
              title="Effort router status"
              description="Resolved from effort-router.json at panel mount. Read-only; edit the file to change the router itself."
            >
              <Tag variant="neutral" data-action="settings-orchestration-effort-router-status">
                {effortRouter() === undefined ? "unknown" : effortRouter()?.jev.enabled ? "jev enabled" : "jev disabled"}
              </Tag>
            </SettingsRowV2>

            <SettingsRowV2
              title="Guardrail status"
              description="Pre-execution Noul guardrail bands for risky tools. Read-only; OFF means risky tools run unchecked."
            >
              <Tag variant="neutral" data-action="settings-orchestration-guardrail-status">
                {effortRouter() === undefined
                  ? "unknown"
                  : effortRouter()?.guardrail.enabled
                    ? "guardrail enabled"
                    : "guardrail disabled"}
              </Tag>
            </SettingsRowV2>

            <SettingsRowV2
              title="Recent Jev verdicts"
              description="Newest effort-router decisions from effort-router.jsonl (up to 5). Read-only."
            >
              <div class="w-full sm:w-[260px] flex flex-col gap-1" data-action="settings-orchestration-jev-verdicts">
                <Show
                  when={(verdicts()?.length ?? 0) > 0}
                  fallback={
                    <span class="truncate leading-4 opacity-60">
                      {verdicts.error ? "unknown" : verdicts.loading ? "" : "No recent verdicts"}
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
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
