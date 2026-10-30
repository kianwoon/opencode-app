import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// baseline-guard:allow new forward migration file following the existing migration convention
// Forward migration for the fork's scheduled-task tables. The task schema is
// read and written by Task/TaskScheduler; the core migration chain must
// enumerate every table the runtime code touches.
const migration: DatabaseMigration.Migration = {
  id: "20261031000000_task",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`task\` (
          \`id\` text PRIMARY KEY,
          \`title\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`cron\` text NOT NULL,
          \`enabled\` integer NOT NULL DEFAULT 1,
          \`session_id\` text,
          \`directory\` text NOT NULL,
          \`next_run_at\` integer,
          \`last_run_at\` integer,
          \`missed_runs\` integer NOT NULL DEFAULT 0,
          \`run_count\` integer NOT NULL DEFAULT 0,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
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
          CONSTRAINT \`fk_task_run_task_id_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`task_run_task_started_idx\` ON \`task_run\` (\`task_id\`,\`started_at\`);`)
    })
  },
}

export default migration
