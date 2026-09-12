PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`payload` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_after` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`error_code` text,
	`error_message` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_progress_range" CHECK("__new_jobs"."progress" BETWEEN 0 AND 100),
	CONSTRAINT "jobs_attempts_nonnegative" CHECK("__new_jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_positive" CHECK("__new_jobs"."max_attempts" > 0),
	CONSTRAINT "jobs_attempts_within_max" CHECK("__new_jobs"."attempts" <= "__new_jobs"."max_attempts"),
	CONSTRAINT "jobs_state_valid" CHECK("__new_jobs"."state" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_lease_consistent" CHECK(("__new_jobs"."state" = 'running' AND "__new_jobs"."lease_owner" IS NOT NULL AND "__new_jobs"."lease_expires_at" IS NOT NULL AND "__new_jobs"."completed_at" IS NULL) OR ("__new_jobs"."state" <> 'running' AND "__new_jobs"."lease_owner" IS NULL AND "__new_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "jobs_completion_consistent" CHECK(("__new_jobs"."state" IN ('succeeded', 'failed', 'cancelled')) = ("__new_jobs"."completed_at" IS NOT NULL)),
	CONSTRAINT "jobs_success_progress_complete" CHECK("__new_jobs"."state" <> 'succeeded' OR "__new_jobs"."progress" = 100)
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "organization_id", "project_id", "type", "state", "payload", "progress", "attempts", "max_attempts", "run_after", "lease_owner", "lease_expires_at", "error_code", "error_message", "created_by", "created_at", "updated_at", "completed_at") SELECT "id", "organization_id", "project_id", "type", "state", "payload", "progress", "attempts", "max_attempts", "run_after", "lease_owner", "lease_expires_at", "error_code", "error_message", "created_by", "created_at", "updated_at", "completed_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_queue_idx` ON `jobs` (`state`,`run_after`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_project_created_idx` ON `jobs` (`organization_id`,`project_id`,`created_at`);