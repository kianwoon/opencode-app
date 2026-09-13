export * as ProjectDirectories from "./directories"

import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AbsolutePath, optional } from "../schema"
import { ProjectSchema } from "./schema"
import { ProjectDirectoryTable, ProjectTable } from "./sql"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"

export interface Directory {
  readonly directory: AbsolutePath
  readonly strategy?: string
}

export const CreateInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
  strategy: Schema.optional(Schema.String),
  behavior: Schema.Literals(["ignore", "replace"]).pipe(Schema.optional),
})
export type CreateInput = typeof CreateInput.Type

export const RemoveInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
})
export type RemoveInput = typeof RemoveInput.Type

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export const ListInput = Schema.Struct({
  projectID: ProjectSchema.ID,
}).annotate({ identifier: "Project.DirectoriesInput" })
export type ListInput = typeof ListInput.Type

export const ListOutput = Schema.Array(
  Schema.Struct({
    directory: AbsolutePath,
    strategy: optional(Schema.String),
  }),
).annotate({ identifier: "Project.Directories" })
export type ListOutput = typeof ListOutput.Type

export interface Interface {
  readonly list: (projectID: ProjectSchema.ID) => Effect.Effect<ReadonlyArray<Directory>>
  readonly get: (input: {
    projectID: ProjectSchema.ID
    directory: AbsolutePath
  }) => Effect.Effect<Directory | undefined>
  readonly contains: (input: { projectID: ProjectSchema.ID; directory: AbsolutePath }) => Effect.Effect<boolean>
  /**
   * Reverse lookup: find the project that owns a directory or one of its
   * ancestors. Used as a fallback when git based discovery fails so existing
   * directory to project mappings remain reachable.
   */
  readonly findDirectory: (input: AbsolutePath) => Effect.Effect<Owner | undefined>
  readonly create: (input: CreateInput, tx?: Transaction) => Effect.Effect<boolean>
  readonly remove: (input: RemoveInput, tx?: Transaction) => Effect.Effect<boolean>
}

export interface Owner {
  readonly projectID: ProjectSchema.ID
  readonly worktree: AbsolutePath
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectDirectories") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const create = Effect.fn("ProjectDirectories.create")(function* (input: CreateInput, tx?: Transaction) {
      const insert = (tx ?? db)
        .insert(ProjectDirectoryTable)
        .values({ project_id: input.projectID, directory: input.directory, strategy: input.strategy })
      const query =
        input.behavior === "replace"
          ? insert.onConflictDoUpdate({
              target: [ProjectDirectoryTable.project_id, ProjectDirectoryTable.directory],
              set: { strategy: input.strategy ?? null },
              setWhere: input.strategy
                ? or(isNull(ProjectDirectoryTable.strategy), ne(ProjectDirectoryTable.strategy, input.strategy))
                : isNotNull(ProjectDirectoryTable.strategy),
            })
          : insert.onConflictDoNothing()
      return (
        (yield* query.returning({ directory: ProjectDirectoryTable.directory }).get().pipe(Effect.orDie)) !== undefined
      )
    })

    const remove = Effect.fn("ProjectDirectories.remove")(function* (input: RemoveInput, tx?: Transaction) {
      return (
        (yield* (tx ?? db)
          .delete(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, input.directory),
            ),
          )
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const list = Effect.fn("ProjectDirectories.list")(function* (projectID: ProjectSchema.ID) {
      const rows = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .orderBy(desc(ProjectDirectoryTable.time_created), asc(ProjectDirectoryTable.directory))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ directory: row.directory, strategy: row.strategy ?? undefined }))
    })

    const contains = Effect.fn("ProjectDirectories.contains")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      return (
        (yield* db
          .select({ directory: ProjectDirectoryTable.directory })
          .from(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, input.directory),
            ),
          )
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const get = Effect.fn("ProjectDirectories.get")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      const row = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(
          and(
            eq(ProjectDirectoryTable.project_id, input.projectID),
            eq(ProjectDirectoryTable.directory, input.directory),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? { directory: row.directory, strategy: row.strategy ?? undefined } : undefined
    })

    const findDirectory = Effect.fn("ProjectDirectories.findDirectory")(function* (input: AbsolutePath) {
      const candidates = ancestors(input)
      if (candidates.length === 0) return undefined
      const rows = yield* db
        .select({
          projectID: ProjectDirectoryTable.project_id,
          directory: ProjectDirectoryTable.directory,
          worktree: ProjectTable.worktree,
        })
        .from(ProjectDirectoryTable)
        .innerJoin(ProjectTable, eq(ProjectTable.id, ProjectDirectoryTable.project_id))
        .where(inArray(ProjectDirectoryTable.directory, candidates))
        .all()
        .pipe(Effect.orDie)
      // Deepest matching directory wins, mirroring git's nearest-ancestor discovery.
      const best = rows.toSorted((a, b) => b.directory.length - a.directory.length)[0]
      return best ? { projectID: best.projectID, worktree: best.worktree } : undefined
    })

    return Service.of({
      list,
      get,
      contains,
      findDirectory,
      create,
      remove,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })

// Directory plus every ancestor up to and including the filesystem root.
function ancestors(input: AbsolutePath): AbsolutePath[] {
  const result: AbsolutePath[] = []
  let current: string = input
  while (true) {
    result.push(AbsolutePath.make(current))
    const parent = path.dirname(current)
    if (parent === current) return result
    current = parent
  }
}
