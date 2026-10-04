import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261004180722_session_stable_head_seen",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_stable_head\` ADD \`seen\` text DEFAULT '[]' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
