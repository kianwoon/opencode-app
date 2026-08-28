import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828163423_session_input_followup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`deliver_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
