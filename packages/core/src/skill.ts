export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SkillV2.NotFoundError", {
  name: Schema.String,
}) {
  override get message() {
    return `Skill "${this.name}" not found`
  }
}

export class NotRemovableError extends Schema.TaggedErrorClass<NotRemovableError>()("SkillV2.NotRemovableError", {
  name: Schema.String,
  location: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Skill "${this.name}" at ${this.location} cannot be removed: ${this.reason}`
  }
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  readonly remove: (name: string) => Effect.Effect<Info, NotFoundError | NotRemovableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      return skills
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        for (const skill of loaded) skills.set(skill.name, skill)
      }
      return Array.from(skills.values())
    })

    // Removes a file-backed skill by deleting its SKILL.md directory. Only the
    // standard `<skill-dir>/SKILL.md` layout is deletable; sources also glob
    // loose `*.md` files and nested trees where dirname(location) could remove
    // unrelated sibling content. The whole per-source cache is dropped because
    // list() does not attribute skills to sources.
    const remove = Effect.fn("SkillV2.remove")(function* (name: string) {
      const skills = yield* list()
      const info = skills.find((skill) => skill.name === name)
      if (!info) return yield* new NotFoundError({ name })
      if (info.location.startsWith("/builtin/")) {
        return yield* new NotRemovableError({
          name,
          location: info.location,
          reason: "built-in skills cannot be removed",
        })
      }
      if (path.basename(info.location) !== "SKILL.md") {
        return yield* new NotRemovableError({
          name,
          location: info.location,
          reason: "only skills backed by a SKILL.md directory can be removed",
        })
      }
      const dir = path.dirname(info.location)
      yield* fs
        .remove(dir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            (error) =>
              new NotRemovableError({
                name,
                location: info.location,
                reason: error instanceof Error ? error.message : String(error),
              }),
          ),
        )
      cache.clear()
      yield* Effect.logInfo("skill removed", { name, dir })
      return info
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
      remove,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
