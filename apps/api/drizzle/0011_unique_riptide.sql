CREATE TABLE `derivatives` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`asset_version_id` text NOT NULL,
	`storage_object_id` text,
	`cache_key` text NOT NULL,
	`grammar_version` integer NOT NULL,
	`canonical_spec` text NOT NULL,
	`output_format` text NOT NULL,
	`processor_fingerprint` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`size_bytes` integer,
	`sha256` text,
	`mime_type` text,
	`width` integer,
	`height` integer,
	`error_code` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_version_id`,`organization_id`,`project_id`) REFERENCES `asset_versions`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`storage_object_id`,`organization_id`,`project_id`) REFERENCES `storage_objects`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "derivatives_cache_key_valid" CHECK(length("derivatives"."cache_key") = 64 AND "derivatives"."cache_key" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "derivatives_grammar_v1" CHECK("derivatives"."grammar_version" = 1),
	CONSTRAINT "derivatives_spec_valid" CHECK(length("derivatives"."canonical_spec") BETWEEN 1 AND 256 AND "derivatives"."canonical_spec" NOT GLOB '*[^a-z0-9_.,]*'),
	CONSTRAINT "derivatives_output_format_valid" CHECK("derivatives"."output_format" IN ('jpeg', 'png', 'webp', 'avif')),
	CONSTRAINT "derivatives_state_valid" CHECK("derivatives"."state" IN ('queued', 'generating', 'ready', 'failed')),
	CONSTRAINT "derivatives_attempts_nonnegative" CHECK("derivatives"."attempts" >= 0),
	CONSTRAINT "derivatives_lease_consistent" CHECK(("derivatives"."state" = 'generating') = ("derivatives"."lease_owner" IS NOT NULL AND "derivatives"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "derivatives_size_nonnegative" CHECK("derivatives"."size_bytes" IS NULL OR "derivatives"."size_bytes" >= 0),
	CONSTRAINT "derivatives_sha256_valid" CHECK("derivatives"."sha256" IS NULL OR (length("derivatives"."sha256") = 64 AND "derivatives"."sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "derivatives_dimensions_positive" CHECK(("derivatives"."width" IS NULL OR "derivatives"."width" > 0) AND ("derivatives"."height" IS NULL OR "derivatives"."height" > 0)),
	CONSTRAINT "derivatives_ready_metadata" CHECK("derivatives"."state" <> 'ready' OR ("derivatives"."storage_object_id" IS NOT NULL AND "derivatives"."size_bytes" IS NOT NULL AND "derivatives"."sha256" IS NOT NULL AND "derivatives"."mime_type" IS NOT NULL AND "derivatives"."width" IS NOT NULL AND "derivatives"."height" IS NOT NULL AND "derivatives"."completed_at" IS NOT NULL)),
	CONSTRAINT "derivatives_terminal_unleased" CHECK("derivatives"."state" NOT IN ('ready', 'failed') OR ("derivatives"."lease_owner" IS NULL AND "derivatives"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `derivatives_project_cache_key_unique` ON `derivatives` (`project_id`,`cache_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `derivatives_id_tenant_unique` ON `derivatives` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `derivatives_asset_version_idx` ON `derivatives` (`organization_id`,`project_id`,`asset_version_id`);--> statement-breakpoint
CREATE INDEX `derivatives_generation_lease_idx` ON `derivatives` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_versions_id_tenant_unique` ON `asset_versions` (`id`,`organization_id`,`project_id`);