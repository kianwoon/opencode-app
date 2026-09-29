import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260929132508_aromatic_marrow",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workflow_attempt\` (
          \`part_id\` text PRIMARY KEY,
          \`attempts\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
