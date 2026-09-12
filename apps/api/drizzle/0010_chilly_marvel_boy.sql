CREATE TABLE `transform_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`grammar_version` integer NOT NULL,
	`canonical_spec` text NOT NULL,
	`definition` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "transform_presets_version_positive" CHECK("transform_presets"."version" > 0),
	CONSTRAINT "transform_presets_grammar_v1" CHECK("transform_presets"."grammar_version" = 1),
	CONSTRAINT "transform_presets_name_valid" CHECK(length("transform_presets"."name") BETWEEN 1 AND 64 AND "transform_presets"."name" NOT GLOB '*[^a-z0-9-]*' AND substr("transform_presets"."name", 1, 1) GLOB '[a-z]' AND substr("transform_presets"."name", -1, 1) GLOB '[a-z0-9]' AND "transform_presets"."name" NOT GLOB '*--*'),
	CONSTRAINT "transform_presets_spec_valid" CHECK(length("transform_presets"."canonical_spec") BETWEEN 1 AND 256 AND "transform_presets"."canonical_spec" NOT GLOB '*[^a-z0-9_.,]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transform_presets_project_name_version_unique` ON `transform_presets` (`project_id`,`name`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `transform_presets_id_tenant_unique` ON `transform_presets` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `transform_presets_project_name_idx` ON `transform_presets` (`organization_id`,`project_id`,`name`,`version`);