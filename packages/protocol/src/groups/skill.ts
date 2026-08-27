import { Skill } from "@opencode-ai/schema/skill"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SkillNotFoundError, SkillNotRemovableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("skill.directories", "/api/skill/directories", {
      query: LocationQuery,
      success: Location.response(
        Schema.Array(
          Schema.Struct({ path: Schema.String, enabled: Schema.Boolean }).annotate({
            identifier: "SkillDirectory",
            description: "A directory skills are discovered from and whether it is currently enabled.",
          }),
        ),
      ),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.directories",
          summary: "List skill directories",
          description:
            "List the directories skills are discovered from and whether each is currently enabled in config.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("skill.remove", "/api/skill/:name", {
      params: { name: Schema.String },
      query: LocationQuery,
      success: Location.response(
        Schema.Struct({ name: Schema.String, location: Schema.String }).annotate({
          identifier: "SkillRemoved",
          description: "The removed skill name and its former SKILL.md location.",
        }),
      ),
      error: [SkillNotFoundError, SkillNotRemovableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.remove",
          summary: "Remove skill",
          description: "Delete a file-backed skill by removing its SKILL.md directory.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skills",
      description: "Experimental skill routes.",
    }),
  )
