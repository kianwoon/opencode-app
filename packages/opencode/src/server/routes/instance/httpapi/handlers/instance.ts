import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import * as ConfigPlugin from "@/config/plugin"
import { parsePluginSpecifier } from "@/plugin/shared"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@opencode-ai/core/global"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Effect } from "effect"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiPluginRemoveError, ApiSkillRemoveError, ApiVcsApplyError } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getSkillDirectories = Effect.fn("InstanceHttpApi.skillDirectories")(function* () {
      return yield* skill.sourceDirectories()
    })

    const removeSkill = Effect.fn("InstanceHttpApi.skillRemove")(function* (ctx: { params: { name: string } }) {
      return yield* skill.remove(ctx.params.name).pipe(
        Effect.mapBoth({
          onFailure: (error) => new ApiSkillRemoveError({ name: error._tag, data: { message: error.message } }),
          onSuccess: (info) => ({ name: info.name, location: info.location }),
        }),
      )
    })

    const removePlugin = Effect.fn("InstanceHttpApi.pluginRemove")(function* (ctx: { params: { name: string } }) {
      const cfg = yield* config.get()
      const name = ctx.params.name
      const origin = (cfg.plugin_origins ?? []).find((item) => {
        const spec = ConfigPlugin.pluginSpecifier(item.spec)
        const identity = spec.startsWith("file://") ? spec : parsePluginSpecifier(spec).pkg
        return identity === name
      })
      if (!origin) {
        return yield* new ApiPluginRemoveError({
          name: "ConfigPlugin.NotFoundError",
          data: { message: `Plugin "${name}" not found` },
        })
      }
      const spec = ConfigPlugin.pluginSpecifier(origin.spec)
      const result = yield* ConfigPlugin.removePluginFile(spec).pipe(
        Effect.catch((error) =>
          error._tag === "PlatformError"
            ? Effect.die(error)
            : new ApiPluginRemoveError({ name: error._tag, data: { message: error.message } }),
        ),
      )
      const remaining = (cfg.plugin ?? []).filter((item) => {
        const itemSpec = ConfigPlugin.pluginSpecifier(item)
        const identity = itemSpec.startsWith("file://") ? itemSpec : parsePluginSpecifier(itemSpec).pkg
        return identity !== name
      })
      if (!("file" in result)) {
        yield* config.updateGlobal({ ...cfg, plugin: remaining })
      } else {
        const dir = path.dirname(result.file ?? "file://")
        ConfigPlugin.invalidate(dir)
        if (remaining.length !== (cfg.plugin ?? []).length) {
          yield* config.updateGlobal({ ...cfg, plugin: remaining })
        }
      }
      yield* config.invalidate()
      return { name, location: spec }
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("skillDirectories", getSkillDirectories)
      .handle("skillRemove", removeSkill)
      .handle("pluginRemove", removePlugin)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
