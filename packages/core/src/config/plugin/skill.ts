export * as ConfigSkillPlugin from "./skill"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { ConfigSkills, type Structured as ConfigSkillsStructured } from "../skills"
import { Config } from "../../config"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { Global } from "../../global"
import { Location } from "../../location"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const strings = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []

const isHttpUrl = (item: string) => URL.canParse(item) && /^https?:$/.test(new URL(item).protocol)

// Skills config is a flat string array (legacy current-config shape) or the
// structured object (paths/urls plus user toggles). Normalize both to the
// structured form so every document contributes discovery entries and toggles.
const structured = (value: unknown): ConfigSkillsStructured => {
  if (Array.isArray(value)) {
    const items = strings(value)
    return {
      ...(items.some(isHttpUrl) ? { urls: items.filter(isHttpUrl) } : {}),
      ...(items.some((item) => !isHttpUrl(item)) ? { paths: items.filter((item) => !isHttpUrl(item)) } : {}),
    }
  }
  if (!isRecord(value)) return {}
  return {
    ...(Array.isArray(value.paths) ? { paths: strings(value.paths) } : {}),
    ...(Array.isArray(value.urls) ? { urls: strings(value.urls) } : {}),
    ...(Array.isArray(value.disabled_directories) ? { disabled_directories: strings(value.disabled_directories) } : {}),
    ...(Array.isArray(value.disabled_skills) ? { disabled_skills: strings(value.disabled_skills) } : {}),
  }
}

const expand = (item: string, home: string) => (item.startsWith("~/") ? path.join(home, item.slice(2)) : item)

export const Plugin = define({
  id: "config-skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    yield* ctx.skill.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const docs = entries.flatMap((entry) => (entry.type === "document" ? [structured(entry.info.skills)] : []))
        // Users can switch a discovered source directory off from the settings
        // UI without deleting files, so other tools sharing it keep working.
        const disabledDirectories = new Set(
          docs
            .flatMap((skills) => skills.disabled_directories ?? [])
            .map((item) => path.resolve(expand(item, global.home))),
        )
        const isDirectoryDisabled = (dir: string) =>
          disabledDirectories.size > 0 && disabledDirectories.has(path.resolve(dir))
        // Per-skill toggles: names are recorded on the draft and enforced at
        // every consumption point (guidance, tool, commands) so a disabled
        // skill stays listed for the settings UI but is never usable.
        for (const name of docs.flatMap((skills) => skills.disabled_skills ?? [])) draft.disable(name)
        const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
        const items = docs.flatMap((skills) => [...(skills.paths ?? []), ...(skills.urls ?? [])])
        for (const directory of directories) {
          if (isDirectoryDisabled(path.join(directory, "skill")) && isDirectoryDisabled(path.join(directory, "skills")))
            continue
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
          if (isHttpUrl(item)) {
            draft.source(SkillV2.UrlSource.make({ type: "url", url: item }))
            continue
          }
          const expanded = expand(item, global.home)
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
