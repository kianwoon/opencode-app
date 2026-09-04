import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { type Component, createMemo, For } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type Enforcement = "strict" | "advisory"

const enforcementOptions: Enforcement[] = ["strict", "advisory"]

type BrainConfig = {
  model?: string
  hands_model?: string
  reviewer_model?: string
  enforcement?: Enforcement
}

// Empty string means "unset": the brain agent expansion treats falsy models as
// absent, and the global config PATCH endpoint deep-merges, so cleared values
// must still be sent for the field to take effect.

export const SettingsOrchestrationV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const brain = createMemo<BrainConfig>(() => serverSync().data.config.brain ?? {})

  type ModelOption =
    | { key: string; kind: "unset" }
    | { key: string; kind: "model"; name: string; providerName: string }
  const models = useModels()
  const modelOptions = createMemo<ModelOption[]>(() => [
    { key: "unset", kind: "unset" },
    ...models.list().map((m) => ({ key: `${m.provider.id}/${m.id}`, kind: "model" as const, name: m.name, providerName: m.provider.name })),
  ])
  const currentFor = (field: "model" | "hands_model" | "reviewer_model"): ModelOption => {
    const value = brain()[field] ?? ""
    return modelOptions().find((o) => o.key === value) ?? modelOptions()[0]
  }

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
                    <SelectV2
                      appearance="base"
                      data-action={`settings-orchestration-${row.field}`}
                      options={modelOptions()}
                      current={currentFor(row.field)}
                      value={(o) => o.key}
                      label={(o) => (o.kind === "unset" ? language.t("common.default") : o.name)}
                      groupBy={(o) => (o.kind === "model" ? o.providerName : "")}
                      onSelect={(o) => {
                        if (!o) return
                        const next = o.kind === "unset" ? "" : o.key
                        if (next === (brain()[row.field] ?? "")) return
                        commit({ [row.field]: next })
                      }}
                    />
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
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
