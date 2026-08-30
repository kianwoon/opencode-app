export * as ConfigSkills from "./skills"

import { Schema } from "effect"

// Structured skills config carries discovery paths plus user toggles made from
// the settings UI. The flat string-array form is the legacy current-config
// shape; the union in config.ts accepts both.
export const Structured = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
  disabled_directories: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Discovered skill source directories to exclude, matched against the resolved absolute directory path",
  }),
  disabled_skills: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Skill names to exclude from discovery and slash commands, matched exactly against the skill name",
  }),
})
export type Structured = Schema.Schema.Type<typeof Structured>
