CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`project_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`request_id` text NOT NULL,
	`summary` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `audit_events_organization_created_idx` ON `audit_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_project_created_idx` ON `audit_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_request_id_idx` ON `audit_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_organization_slug_unique` ON `projects` (`organization_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_id_organization_unique` ON `projects` (`id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `projects_organization_id_idx` ON `projects` (`organization_id`);