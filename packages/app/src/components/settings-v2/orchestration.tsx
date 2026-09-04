import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, createEffect, createMemo, For } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
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
const modelFields = ["model", "hands_model", "reviewer_model"] as const

export const SettingsOrchestrationV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()

  const brain = createMemo<BrainConfig>(() => serverSync().data.config.brain ?? {})
  const [draft, setDraft] = createStore({
    model: brain().model ?? "",
    hands_model: brain().hands_model ?? "",
    reviewer_model: brain().reviewer_model ?? "",
  })

  // Resync server brain values into the local draft when the config changes
  // elsewhere (another client/tab, or an in-flight commit landing). Fields the
  // user is focused on or has typed into since the last sync are left alone so
  // external updates never clobber in-progress edits.
  const guarded: Record<(typeof modelFields)[number], boolean> = {
    model: false,
    hands_model: false,
    reviewer_model: false,
  }
  createEffect(() => {
    const server = brain()
    for (const field of modelFields) {
      if (guarded[field]) continue
      setDraft(field, server[field] ?? "")
    }
  })

  const modelRows = [
    {
      field: "model" as const,
      title: () => language.t("settings.orchestration.row.model.title"),
      description: () => language.t("settings.orchestration.row.model.description"),
      placeholder: () => language.t("settings.orchestration.row.model.placeholder"),
    },
    {
      field: "hands_model" as const,
      title: () => language.t("settings.orchestration.row.handsModel.title"),
      description: () => language.t("settings.orchestration.row.handsModel.description"),
      placeholder: () => language.t("settings.orchestration.row.handsModel.placeholder"),
    },
    {
      field: "reviewer_model" as const,
      title: () => language.t("settings.orchestration.row.reviewerModel.title"),
      description: () => language.t("settings.orchestration.row.reviewerModel.description"),
      placeholder: () => language.t("settings.orchestration.row.reviewerModel.placeholder"),
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

  const commitModel = (field: (typeof modelFields)[number]) => {
    guarded[field] = false
    if (draft[field] === (brain()[field] ?? "")) return
    commit({ [field]: draft[field] })
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
                    <TextInputV2
                      data-action={`settings-orchestration-${row.field}`}
                      type="text"
                      appearance="base"
                      value={draft[row.field]}
                      onFocus={() => {
                        guarded[row.field] = true
                      }}
                      onInput={(event) => {
                        guarded[row.field] = true
                        setDraft(row.field, event.currentTarget.value)
                      }}
                      onBlur={() => commitModel(row.field)}
                      placeholder={row.placeholder()}
                      spellcheck={false}
                      autocorrect="off"
                      autocomplete="off"
                      autocapitalize="off"
                      aria-label={row.title()}
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
