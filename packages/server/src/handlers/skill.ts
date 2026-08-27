import { SkillV2 } from "@opencode-ai/core/skill"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SkillNotFoundError, SkillNotRemovableError } from "@opencode-ai/protocol/errors"
import { response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(SkillV2.Service.use((skill) => skill.list())))
    .handle("skill.directories", () =>
      response(
        Effect.flatMap(SkillV2.Service, (skill) =>
          Effect.map(skill.sources(), (sources) =>
            sources
              .filter((source) => source.type === "directory")
              .map((source) => ({ path: source.path, enabled: true })),
          ),
        ),
      ),
    )
    .handle(
      "skill.remove",
      Effect.fn("SkillHttpApi.remove")(function* (ctx: { params: { name: string } }) {
        const result = yield* Effect.flatMap(SkillV2.Service, (skill) => skill.remove(ctx.params.name)).pipe(
          Effect.mapBoth({
            onFailure: (error) =>
              error._tag === "SkillV2.NotFoundError"
                ? new SkillNotFoundError({ skill: ctx.params.name, message: error.message })
                : new SkillNotRemovableError({ skill: ctx.params.name, message: error.message }),
            onSuccess: (info) => ({ name: info.name, location: info.location }),
          }),
        )
        return yield* response(Effect.succeed(result))
      }),
    ),
)
