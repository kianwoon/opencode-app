import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922090000_session_stable_head",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_stable_head\` (
          \`session_id\` text PRIMARY KEY,
          \`system\` text NOT NULL,
          \`tools\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_stable_head_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
