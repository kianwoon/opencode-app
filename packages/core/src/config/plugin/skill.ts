export * as ConfigSkillPlugin from "./skill"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { Global } from "../../global"
import { Location } from "../../location"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const Plugin = define({
  id: "config-skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    yield* ctx.skill.transform(
      Effect.fn(function* (draft) {
    const entries = yield* config.entries()
    // Derive the disabled-directory list from location config documents. V1
    // documents carry the structured `skills` object; current documents use
    // a flat string array, so only V1 documents can contribute entries here.
    const disabled = new Set(
      entries
        .flatMap((entry) => (entry.type === "document" ? [entry.info] : []))
        .flatMap((info) => {
          const skills: unknown = (info as Record<string, unknown>)["skills"]
          if (!isRecord(skills)) return []
          const list: unknown = skills["disabled_directories"]
          return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
        })
        .map((item) => {
          const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
          return path.resolve(expanded)
        }),
    )
    const isDisabled = (dir: string) => disabled.size > 0 && disabled.has(path.resolve(dir))
    const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
    const items = entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
    for (const directory of directories) {
      if (isDisabled(path.join(directory, "skill")) && isDisabled(path.join(directory, "skills"))) continue
      draft.source(
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }),
      )
      draft.source(
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join(directory, "skills")),
        }),
      )
    }
        for (const item of items) {
          if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
            draft.source(SkillV2.UrlSource.make({ type: "url", url: item }))
            continue
          }
          const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
            }),
          )
        }
      }),
    )
  }),
})
