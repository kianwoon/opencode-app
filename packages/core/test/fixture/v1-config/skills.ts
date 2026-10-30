export * as ConfigSkillsV1 from "./skills"

import { Schema } from "effect"

export const Info = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
  disabled_directories: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Discovered skill source directories to exclude, matched against the resolved absolute directory path",
  }),
  disabled_skills: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Skill names to exclude from discovery and slash commands, matched exactly against the skill name",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
