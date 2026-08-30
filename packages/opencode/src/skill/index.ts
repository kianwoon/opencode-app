import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// Built-in skill that ships with opencode. The model's intuition for what an
// opencode.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_OPENCODE_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."
const CUSTOMIZE_OPENCODE_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

export class NotRemovableError extends Schema.TaggedErrorClass<NotRemovableError>()("Skill.NotRemovableError", {
  name: Schema.String,
  location: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Skill "${this.name}" at ${this.location} cannot be removed: ${this.reason}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
  sources: Array<{ path: string; enabled: boolean }>
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly disabled: () => Effect.Effect<ReadonlySet<string>>
  readonly dirs: () => Effect.Effect<string[]>
  readonly sourceDirectories: () => Effect.Effect<Array<{ path: string; enabled: boolean }>>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  readonly remove: (name: string) => Effect.Effect<Info, NotFoundError | NotRemovableError>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }
  const cfg = yield* config.get()
  // Users can switch a discovered source directory off from the settings UI
  // without deleting files, so other tools sharing the directory keep working.
  const disabled = new Set((cfg.skills?.disabled_directories ?? []).map((item) => path.resolve(item)))
  const sources: Array<{ root: string; pattern: string; dot?: boolean; scope?: string }> = []
  // Canonical skill directories reported to the settings UI, including ones
  // toggled off. Matches under a disabled entry are filtered from state.
  const candidates: string[] = []

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      sources.push({ root, pattern: EXTERNAL_SKILL_PATTERN, dot: true, scope: "global" })
      candidates.push(root)
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      sources.push({ root, pattern: EXTERNAL_SKILL_PATTERN, dot: true, scope: "project" })
      candidates.push(path.join(root, "skills"))
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    sources.push({ root: dir, pattern: OPENCODE_SKILL_PATTERN })
    for (const name of ["skill", "skills"]) {
      const root = path.join(dir, name)
      if (!(yield* fsys.isDir(root))) continue
      candidates.push(root)
    }
  }

  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }
    sources.push({ root: dir, pattern: SKILL_PATTERN })
    candidates.push(dir)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      sources.push({ root: dir, pattern: SKILL_PATTERN })
      candidates.push(dir)
    }
  }

  const killed = [...disabled].filter((entry) => candidates.some((c) => c === entry || entry.startsWith(c + path.sep)))
  for (const source of sources) {
    yield* scan(state, source.root, source.pattern, { dot: source.dot, scope: source.scope })
  }

  if (killed.length > 0) {
    for (const match of state.matches) {
      if (killed.some((root) => match === root || match.startsWith(root + path.sep))) state.matches.delete(match)
    }
    for (const dir of state.dirs) {
      if (killed.some((root) => dir === root || dir.startsWith(root + path.sep))) state.dirs.delete(dir)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
    sources: candidates.map((p) => ({ path: p, enabled: !disabled.has(path.resolve(p)) })),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_OPENCODE_SKILL_NAME] = {
          name: CUSTOMIZE_OPENCODE_SKILL_NAME,
          description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    // User-disabled skill names from config. `all` stays unfiltered so the
    // settings UI can list and re-enable disabled skills; the accessors below
    // enforce the toggle at every consumption point.
    const disabled = Effect.fn("Skill.disabled")(function* () {
      const cfg = yield* config.get()
      return new Set(cfg.skills?.disabled_skills ?? []) as ReadonlySet<string>
    })

    const isDisabled = Effect.fnUntraced(function* (name: string) {
      return (yield* disabled()).has(name)
    })

    const activeNames = (s: State, disabledSet: ReadonlySet<string>) =>
      Object.values(s.skills)
        .filter((skill) => !disabledSet.has(skill.name))
        .map((skill) => skill.name)
        .toSorted()

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      if (yield* isDisabled(name)) return undefined
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const disabledSet = yield* disabled()
      const available = activeNames(s, disabledSet)
      if (disabledSet.has(name) || !s.skills[name]) return yield* new NotFoundError({ name, available })
      return s.skills[name]
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const sourceDirectories = Effect.fn("Skill.sourceDirectories")(function* () {
      return (yield* InstanceState.get(discovered)).sources
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const disabledSet = yield* disabled()
      const list = Object.values(s.skills)
        .filter((skill) => !disabledSet.has(skill.name))
        .toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    // Removes a file-backed skill by deleting its SKILL.md directory. Only the
    // standard `<skill-dir>/SKILL.md` layout is deletable: discovery also scans
    // arbitrary `**/SKILL.md` trees via config.skills.paths, where deleting
    // dirname(SKILL.md) could remove unrelated sibling content.
    const remove = Effect.fn("Skill.remove")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (!info) return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
      if (info.location === "<built-in>" || path.dirname(info.location) === ".") {
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
      yield* fsys.remove(dir, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (error) =>
            new NotRemovableError({
              name,
              location: info.location,
              reason: error instanceof Error ? error.message : String(error),
            }),
        ),
      )
      yield* InstanceState.invalidate(state)
      yield* InstanceState.invalidate(discovered)
      yield* Effect.logInfo("skill removed", { name, dir })
      return info
    })

    return Service.of({ get, require, all, disabled, dirs, sourceDirectories, available, remove })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
