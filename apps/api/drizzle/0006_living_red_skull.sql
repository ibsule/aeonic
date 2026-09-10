CREATE TABLE `storage_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`backend` text NOT NULL,
	`namespace` text NOT NULL,
	`object_key` text NOT NULL,
	`state` text DEFAULT 'staging' NOT NULL,
	`size_bytes` integer,
	`sha256` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finalized_at` integer,
	`deleted_at` integer,
	`error_code` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "storage_objects_size_nonnegative" CHECK("storage_objects"."size_bytes" IS NULL OR "storage_objects"."size_bytes" >= 0),
	CONSTRAINT "storage_objects_state_valid" CHECK("storage_objects"."state" IN ('staging', 'available', 'deleting', 'deleted', 'failed')),
	CONSTRAINT "storage_objects_sha256_valid" CHECK("storage_objects"."sha256" IS NULL OR (length("storage_objects"."sha256") = 64 AND "storage_objects"."sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "storage_objects_available_metadata" CHECK("storage_objects"."state" <> 'available' OR ("storage_objects"."size_bytes" IS NOT NULL AND "storage_objects"."sha256" IS NOT NULL AND "storage_objects"."finalized_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_objects_key_unique` ON `storage_objects` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `storage_objects_id_tenant_unique` ON `storage_objects` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `storage_objects_project_state_idx` ON `storage_objects` (`organization_id`,`project_id`,`state`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`asset_id` text,
	`storage_object_id` text,
	`protocol` text NOT NULL,
	`state` text DEFAULT 'created' NOT NULL,
	`expected_bytes` integer,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`checksum_algorithm` text,
	`expected_checksum` text,
	`actual_checksum` text,
	`original_filename` text,
	`declared_mime_type` text,
	`detected_mime_type` text,
	`idempotency_key` text,
	`expires_at` integer,
	`error_code` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`,`organization_id`,`project_id`) REFERENCES `assets`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`storage_object_id`,`organization_id`,`project_id`) REFERENCES `storage_objects`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "uploads_expected_bytes_nonnegative" CHECK("uploads"."expected_bytes" IS NULL OR "uploads"."expected_bytes" >= 0),
	CONSTRAINT "uploads_received_bytes_nonnegative" CHECK("uploads"."received_bytes" >= 0),
	CONSTRAINT "uploads_received_within_expected" CHECK("uploads"."expected_bytes" IS NULL OR "uploads"."received_bytes" <= "uploads"."expected_bytes"),
	CONSTRAINT "uploads_checksum_pair" CHECK(("uploads"."checksum_algorithm" IS NULL) = ("uploads"."expected_checksum" IS NULL)),
	CONSTRAINT "uploads_state_valid" CHECK("uploads"."state" IN ('created', 'receiving', 'validating', 'completed', 'rejected', 'failed', 'expired', 'terminated')),
	CONSTRAINT "uploads_expected_checksum_valid" CHECK("uploads"."expected_checksum" IS NULL OR (length("uploads"."expected_checksum") = 64 AND "uploads"."expected_checksum" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "uploads_actual_checksum_valid" CHECK("uploads"."actual_checksum" IS NULL OR (length("uploads"."actual_checksum") = 64 AND "uploads"."actual_checksum" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_project_idempotency_unique` ON `uploads` (`project_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `uploads_project_state_idx` ON `uploads` (`organization_id`,`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `uploads_expiry_idx` ON `uploads` (`state`,`expires_at`);--> statement-breakpoint
CREATE TEMP TABLE `__asset_versions_storage_key_guard` (`invalid_count` integer CHECK (`invalid_count` = 0));--> statement-breakpoint
INSERT INTO `__asset_versions_storage_key_guard` SELECT count(*) FROM `asset_versions` WHERE `storage_key` IS NOT NULL;--> statement-breakpoint
DROP TABLE `__asset_versions_storage_key_guard`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_asset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`version` integer NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`storage_object_id` text,
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
	FOREIGN KEY (`storage_object_id`,`organization_id`,`project_id`) REFERENCES `storage_objects`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "asset_versions_version_positive" CHECK("__new_asset_versions"."version" > 0),
	CONSTRAINT "asset_versions_size_nonnegative" CHECK("__new_asset_versions"."size_bytes" IS NULL OR "__new_asset_versions"."size_bytes" >= 0),
	CONSTRAINT "asset_versions_state_valid" CHECK("__new_asset_versions"."state" IN ('uploading', 'validating', 'processing', 'ready', 'rejected', 'failed')),
	CONSTRAINT "asset_versions_sha256_valid" CHECK("__new_asset_versions"."sha256" IS NULL OR (length("__new_asset_versions"."sha256") = 64 AND "__new_asset_versions"."sha256" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
INSERT INTO `__new_asset_versions`("id", "organization_id", "project_id", "asset_id", "version", "state", "storage_object_id", "sha256", "mime_type", "size_bytes", "width", "height", "duration_ms", "metadata", "created_by", "created_at") SELECT "id", "organization_id", "project_id", "asset_id", "version", CASE WHEN "state" = 'pending' THEN 'uploading' ELSE "state" END, NULL, "sha256", "mime_type", "size_bytes", "width", "height", "duration_ms", "metadata", "created_by", "created_at" FROM `asset_versions`;--> statement-breakpoint
DROP TABLE `asset_versions`;--> statement-breakpoint
ALTER TABLE `__new_asset_versions` RENAME TO `asset_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `asset_versions_asset_version_unique` ON `asset_versions` (`asset_id`,`version`);--> statement-breakpoint
CREATE INDEX `asset_versions_project_created_idx` ON `asset_versions` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE TEMP TABLE `__asset_versions_backup` AS SELECT * FROM `asset_versions`;--> statement-breakpoint
CREATE TABLE `__new_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`public_id` text NOT NULL,
	`name` text NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`media_kind` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assets_current_version_nonnegative" CHECK("__new_assets"."current_version" >= 0),
	CONSTRAINT "assets_state_valid" CHECK("__new_assets"."state" IN ('uploading', 'validating', 'processing', 'ready', 'replacing', 'deleting', 'deleted', 'rejected', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_assets`("id", "organization_id", "project_id", "public_id", "name", "folder", "media_kind", "visibility", "state", "current_version", "created_by", "created_at", "updated_at", "deleted_at") SELECT "id", "organization_id", "project_id", "public_id", "name", "folder", "media_kind", "visibility", CASE WHEN "state" = 'pending' THEN 'uploading' ELSE "state" END, "current_version", "created_by", "created_at", "updated_at", "deleted_at" FROM `assets`;--> statement-breakpoint
DROP TABLE `assets`;--> statement-breakpoint
ALTER TABLE `__new_assets` RENAME TO `assets`;--> statement-breakpoint
CREATE UNIQUE INDEX `assets_project_public_id_unique` ON `assets` (`project_id`,`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_id_organization_project_unique` ON `assets` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `assets_project_created_idx` ON `assets` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
DELETE FROM `asset_versions`;--> statement-breakpoint
INSERT INTO `asset_versions` SELECT * FROM `__asset_versions_backup`;--> statement-breakpoint
DROP TABLE `__asset_versions_backup`;
