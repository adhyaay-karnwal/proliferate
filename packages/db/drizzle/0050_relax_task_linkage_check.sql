-- Relax sessions_task_linkage_check to allow scratch sessions (no configuration).
-- Scratch sessions have kind='task' but no repo/baseline linkage. The constraint
-- now only enforces linkage when a configuration_id is present.
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_task_linkage_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_linkage_check" CHECK ((kind != 'task'::text) OR (configuration_id IS NULL) OR (repo_id IS NOT NULL AND repo_baseline_id IS NOT NULL AND repo_baseline_target_id IS NOT NULL));
