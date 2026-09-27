PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_derivatives` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`asset_version_id` text NOT NULL,
	`storage_object_id` text,
	`cache_key` text NOT NULL,
	`kind` text DEFAULT 'image' NOT NULL,
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
	`duration_ms` integer,
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
	CONSTRAINT "derivatives_cache_key_valid" CHECK(length("__new_derivatives"."cache_key") = 64 AND "__new_derivatives"."cache_key" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "derivatives_grammar_v1" CHECK("__new_derivatives"."grammar_version" = 1),
	CONSTRAINT "derivatives_spec_valid" CHECK(length("__new_derivatives"."canonical_spec") BETWEEN 1 AND 256 AND "__new_derivatives"."canonical_spec" NOT GLOB '*[^a-z0-9_.,-]*'),
	CONSTRAINT "derivatives_kind_valid" CHECK("__new_derivatives"."kind" IN ('image', 'video_poster', 'video_transcode', 'pdf_thumbnail', 'pdf_text', 'office_preview')),
	CONSTRAINT "derivatives_output_format_valid" CHECK("__new_derivatives"."output_format" IN ('jpeg', 'png', 'webp', 'avif', 'mp4', 'webm', 'pdf', 'txt')),
	CONSTRAINT "derivatives_state_valid" CHECK("__new_derivatives"."state" IN ('queued', 'generating', 'ready', 'failed')),
	CONSTRAINT "derivatives_attempts_nonnegative" CHECK("__new_derivatives"."attempts" >= 0),
	CONSTRAINT "derivatives_lease_consistent" CHECK(("__new_derivatives"."state" = 'generating') = ("__new_derivatives"."lease_owner" IS NOT NULL AND "__new_derivatives"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "derivatives_size_nonnegative" CHECK("__new_derivatives"."size_bytes" IS NULL OR "__new_derivatives"."size_bytes" >= 0),
	CONSTRAINT "derivatives_sha256_valid" CHECK("__new_derivatives"."sha256" IS NULL OR (length("__new_derivatives"."sha256") = 64 AND "__new_derivatives"."sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "derivatives_dimensions_positive" CHECK(("__new_derivatives"."width" IS NULL OR "__new_derivatives"."width" > 0) AND ("__new_derivatives"."height" IS NULL OR "__new_derivatives"."height" > 0)),
	CONSTRAINT "derivatives_duration_nonnegative" CHECK("__new_derivatives"."duration_ms" IS NULL OR "__new_derivatives"."duration_ms" >= 0),
	CONSTRAINT "derivatives_ready_metadata" CHECK("__new_derivatives"."state" <> 'ready' OR ("__new_derivatives"."storage_object_id" IS NOT NULL AND "__new_derivatives"."size_bytes" IS NOT NULL AND "__new_derivatives"."sha256" IS NOT NULL AND "__new_derivatives"."mime_type" IS NOT NULL AND "__new_derivatives"."completed_at" IS NOT NULL)),
	CONSTRAINT "derivatives_terminal_unleased" CHECK("__new_derivatives"."state" NOT IN ('ready', 'failed') OR ("__new_derivatives"."lease_owner" IS NULL AND "__new_derivatives"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_derivatives`("id", "organization_id", "project_id", "asset_version_id", "storage_object_id", "cache_key", "kind", "grammar_version", "canonical_spec", "output_format", "processor_fingerprint", "state", "attempts", "lease_owner", "lease_expires_at", "size_bytes", "sha256", "mime_type", "width", "height", "duration_ms", "error_code", "created_by", "created_at", "updated_at", "completed_at") SELECT "id", "organization_id", "project_id", "asset_version_id", "storage_object_id", "cache_key", 'image', "grammar_version", "canonical_spec", "output_format", "processor_fingerprint", "state", "attempts", "lease_owner", "lease_expires_at", "size_bytes", "sha256", "mime_type", "width", "height", NULL, "error_code", "created_by", "created_at", "updated_at", "completed_at" FROM `derivatives`;--> statement-breakpoint
DROP TABLE `derivatives`;--> statement-breakpoint
ALTER TABLE `__new_derivatives` RENAME TO `derivatives`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `derivatives_project_cache_key_unique` ON `derivatives` (`project_id`,`cache_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `derivatives_id_tenant_unique` ON `derivatives` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `derivatives_asset_version_idx` ON `derivatives` (`organization_id`,`project_id`,`asset_version_id`);--> statement-breakpoint
CREATE INDEX `derivatives_generation_lease_idx` ON `derivatives` (`state`,`lease_expires_at`);
