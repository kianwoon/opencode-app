import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Show, type Component, createMemo, For } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import type { ModelKey } from "@/context/local"
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
export const SettingsOrchestrationV2: Component = () => {  const language = useLanguage()
  const serverSync = useServerSync()

  const brain = createMemo<BrainConfig>(() => serverSync().data.config.brain ?? {})
  const jev = createMemo(() => serverSync().data.config.jev ?? {})
  const governor = createMemo(() => serverSync().data.config.governor ?? {})
  const brainBooster = createMemo(() => serverSync().data.config.brainBooster ?? {})
  const jevDefault = createMemo(() => serverSync().data.config.jevDefault ?? {})
  const models = useModels()

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

  const commitJev = (patch: { enabled?: boolean }) => {
    void serverSync()
      .updateConfig({ jev: { ...jev(), ...patch } })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
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
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
