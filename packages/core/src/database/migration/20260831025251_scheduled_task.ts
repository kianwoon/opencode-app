import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260831025251_scheduled_task",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`task\` (
          \`id\` text PRIMARY KEY,
          \`title\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`cron\` text NOT NULL,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`session_id\` text,
          \`directory\` text NOT NULL,
          \`next_run_at\` integer,
          \`last_run_at\` integer,
          \`missed_runs\` integer DEFAULT 0 NOT NULL,
          \`run_count\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`task_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`task_next_run_idx\` ON \`task\` (\`next_run_at\`);`)
      yield* tx.run(`CREATE INDEX \`task_directory_idx\` ON \`task\` (\`directory\`);`)
      yield* tx.run(`
        CREATE TABLE \`task_run\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`ended_at\` integer,
          \`error\` text,
          CONSTRAINT \`task_run_task_id_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`task_run_task_started_idx\` ON \`task_run\` (\`task_id\`, \`started_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
