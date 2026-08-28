import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828170233_background_job_record",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`background_job\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`title\` text,
          \`status\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`completed_at\` integer,
          \`output\` text,
          \`error\` text,
          \`metadata\` text
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
