CREATE TABLE `asset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`version` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`storage_key` text,
	`sha256` text,
	`mime_type` text,
	`size_bytes` integer,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`metadata` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`asset_id`,`organization_id`,`project_id`) REFERENCES `assets`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "asset_versions_version_positive" CHECK("asset_versions"."version" > 0),
	CONSTRAINT "asset_versions_size_nonnegative" CHECK("asset_versions"."size_bytes" IS NULL OR "asset_versions"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_versions_asset_version_unique` ON `asset_versions` (`asset_id`,`version`);--> statement-breakpoint
CREATE INDEX `asset_versions_project_created_idx` ON `asset_versions` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`public_id` text NOT NULL,
	`name` text NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`media_kind` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assets_current_version_nonnegative" CHECK("assets"."current_version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_project_public_id_unique` ON `assets` (`project_id`,`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_id_organization_project_unique` ON `assets` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `assets_project_created_idx` ON `assets` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
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
	CONSTRAINT "jobs_progress_range" CHECK("jobs"."progress" BETWEEN 0 AND 100),
	CONSTRAINT "jobs_attempts_nonnegative" CHECK("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_positive" CHECK("jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE INDEX `jobs_queue_idx` ON `jobs` (`state`,`run_after`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_project_created_idx` ON `jobs` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_api_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`key_id`) REFERENCES `apikey`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_project_api_keys`("key_id", "organization_id", "project_id", "created_by", "created_at", "revoked_at") SELECT "key_id", "organization_id", "project_id", "created_by", "created_at", "revoked_at" FROM `project_api_keys`;--> statement-breakpoint
DROP TABLE `project_api_keys`;--> statement-breakpoint
ALTER TABLE `__new_project_api_keys` RENAME TO `project_api_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `project_api_keys_project_idx` ON `project_api_keys` (`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `project_api_keys_created_by_idx` ON `project_api_keys` (`created_by`);--> statement-breakpoint
CREATE TABLE `__new_project_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_project_members`("id", "organization_id", "project_id", "user_id", "created_by", "created_at") SELECT "id", "organization_id", "project_id", "user_id", "created_by", "created_at" FROM `project_members`;--> statement-breakpoint
DROP TABLE `project_members`;--> statement-breakpoint
ALTER TABLE `__new_project_members` RENAME TO `project_members`;--> statement-breakpoint
CREATE UNIQUE INDEX `project_members_project_user_unique` ON `project_members` (`project_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `project_members_user_organization_idx` ON `project_members` (`user_id`,`organization_id`);