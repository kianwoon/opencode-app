export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { AppProcess } from "@opencode/util/process"
import { Git } from "@opencode/core/git"
import { gitExecutable } from "@opencode/core/util/git-executable"
import { Global } from "@opencode/util/global"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionStore } from "@opencode/core/session/store"
import { AbsolutePath } from "@opencode/core/schema"
import { rmSync } from "node:fs"
import os from "node:os"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedError<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: Project.ID,
    actual: Project.ID,
  },
) {}

export class DestinationNotFoundError extends Schema.TaggedError<DestinationNotFoundError>()(
  "MoveSession.DestinationNotFoundError",
  { directory: AbsolutePath },
) {}

export class DestinationNotDirectoryError extends Schema.TaggedError<DestinationNotDirectoryError>()(
  "MoveSession.DestinationNotDirectoryError",
  { directory: AbsolutePath },
) {}

export class ApplyChangesError extends Schema.TaggedError<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedError<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedError<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type Error =
  | Session.NotFoundError
  | DestinationProjectMismatchError
  | DestinationNotFoundError
  | DestinationNotDirectoryError
  | Session.DestinationNotFoundError
  | Session.DestinationNotDirectoryError
  | Session.DestinationUnavailableError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlPlaneMoveSession") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const project = yield* Project.Service
    const sessions = yield* SessionStore.Service
    const session = yield* Session.Service
    const execution = yield* SessionExecution.Service
    const proc = yield* AppProcess.Service

    const gitRun = Effect.fnUntraced(function* (
      cwd: AbsolutePath,
      args: string[],
      options?: { stdin?: string; env?: Record<string, string> },
    ) {
      return yield* proc
        .run(
          ChildProcess.make(gitExecutable(), args, {
            cwd,
            env: options?.env,
            extendEnv: true,
            stdin: "ignore",
          }),
          { stdin: options?.stdin },
        )
        .pipe(
          Effect.map((result) => ({
            exitCode: result.exitCode,
            stdout: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
          })),
          Effect.catch((error) => Effect.succeed({ exitCode: 1, stdout: "", stderr: error.message })),
        )
    })

    // A local stand-in for the removed `Git.change` API. Capture writes intent-to-add
    // entries into a throwaway index so untracked files join the patch while the
    // repository's real index (and any staged work) is left untouched.
    const captureChanges = Effect.fn("MoveSession.captureChanges")(function* (directory: AbsolutePath) {
      const indexPath = path.join(os.tmpdir(), `opencode-move-session-${process.pid}-${Date.now()}.index`)
      const env = { GIT_INDEX_FILE: indexPath }
      return yield* Effect.gen(function* () {
        const head = yield* gitRun(directory, ["rev-parse", "--verify", "--quiet", "HEAD"], { env })
        // The empty tree resolves an unborn branch to "everything is new".
        const base = head.exitCode === 0 ? head.stdout.trim() : "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        const added = yield* gitRun(directory, ["add", "-N", "--", "."], { env })
        if (added.exitCode !== 0)
          return yield* new CaptureChangesError({
            message: added.stderr.trim() || "Unable to stage untracked changes",
          })
        const diff = yield* gitRun(directory, ["diff", base, "--binary", "--no-color", "--no-ext-diff", "--relative"], {
          env,
        })
        if (diff.exitCode !== 0)
          return yield* new CaptureChangesError({ message: diff.stderr.trim() || "Unable to capture changes" })
        return diff.stdout
      }).pipe(Effect.ensuring(Effect.sync(() => rmSync(indexPath, { force: true }))))
    })

    const applyChanges = Effect.fn("MoveSession.applyChanges")(function* (
      directory: AbsolutePath,
      patch: string,
    ) {
      const result = yield* gitRun(directory, ["apply", "--binary", "--whitespace=nowarn", "-"], { stdin: patch })
      if (result.exitCode !== 0)
        return yield* new ApplyChangesError({ message: result.stderr.trim() || "Unable to apply changes" })
    })

    const discardChanges = Effect.fn("MoveSession.discardChanges")(function* (directory: AbsolutePath) {
      const restored = yield* gitRun(directory, ["checkout", "--", "."])
      if (restored.exitCode !== 0)
        return yield* new ResetSourceChangesError({
          directory,
          message: restored.stderr.trim() || "Unable to restore tracked changes",
        })
      const cleaned = yield* gitRun(directory, ["clean", "-fd", "--", "."])
      if (cleaned.exitCode !== 0)
        return yield* new ResetSourceChangesError({
          directory,
          message: cleaned.stderr.trim() || "Unable to remove untracked changes",
        })
    })

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* sessions.get(input.sessionID)
      if (!current) return yield* new Session.NotFoundError({ sessionID: input.sessionID })
      const value = input.destination.directory.trim()
      const expanded = value === "~" ? global.home : value.startsWith("~/") ? path.join(global.home, value.slice(2)) : value
      const directory = AbsolutePath.make(path.resolve(current.location.directory, expanded))
      const destinationInfo = yield* fs.stat(directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!destinationInfo) return yield* new DestinationNotFoundError({ directory })
      if (destinationInfo.type !== "Directory") return yield* new DestinationNotDirectoryError({ directory })
      if (current.location.directory === directory) return

      const source = yield* project.resolve(current.location.directory)
      const destination = yield* project.resolve(directory)
      if (input.moveChanges && current.projectID !== destination.id) {
        return yield* new DestinationProjectMismatchError({ expected: current.projectID, actual: destination.id })
      }
      // A move must not race active execution: a mid-drain relocation would let
      // the source Location dispatch a request assembled under stale instructions
      // and history. Serialize like removal does — stop the drain, then move.
      yield* execution.interrupt(input.sessionID)
      yield* execution.awaitIdle(input.sessionID)

      const moveChanges = input.moveChanges && source.directory !== destination.directory
      const sourceRepository = moveChanges ? yield* git.repo.discover(current.location.directory) : undefined
      if (moveChanges && !sourceRepository)
        return yield* new CaptureChangesError({ message: "Source is not a Git repository" })
      const patch = sourceRepository ? yield* captureChanges(current.location.directory) : ""
      if (patch.trim()) {
        const repository = yield* git.repo.discover(directory)
        if (!repository) return yield* new ApplyChangesError({ message: "Destination is not a Git repository" })
        yield* applyChanges(directory, patch)
      }

      yield* session.move({
        sessionID: input.sessionID,
        directory,
      })

      if (patch.trim()) {
        if (!(yield* git.repo.discover(current.location.directory)))
          return yield* new ResetSourceChangesError({
            directory: current.location.directory,
            message: "Source is not a Git repository",
          })
        yield* discardChanges(current.location.directory)
      }
    })

    return Service.of({ moveSession })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    FSUtil.node,
    Git.node,
    AppProcess.node,
    Global.node,
    Project.node,
    Session.node,
    SessionStore.node,
    SessionExecution.node,
  ],
})
