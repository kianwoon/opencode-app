import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260929124001_cheerful_zzzax",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_followup\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`deliver_at\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`payload\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_followup_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_followup_session_promoted_deliver_idx\` ON \`session_followup\` (\`session_id\`,\`promoted_seq\`,\`deliver_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
