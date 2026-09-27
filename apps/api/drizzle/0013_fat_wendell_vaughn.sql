CREATE TABLE `ai_asset_exclusions` (
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`asset_id`,`organization_id`,`project_id`) REFERENCES `assets`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_asset_exclusions_asset_unique` ON `ai_asset_exclusions` (`organization_id`,`project_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `ai_index_records` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`index_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`asset_version_id` text NOT NULL,
	`point_id` text NOT NULL,
	`content_kind` text NOT NULL,
	`chunk_ordinal` integer DEFAULT 0 NOT NULL,
	`source_text` text,
	`caption` text,
	`metadata` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`index_id`) REFERENCES `ai_indexes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`,`organization_id`,`project_id`) REFERENCES `assets`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_version_id`,`organization_id`,`project_id`) REFERENCES `asset_versions`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_index_records_chunk_nonnegative" CHECK("ai_index_records"."chunk_ordinal" >= 0),
	CONSTRAINT "ai_index_records_dimensions_valid" CHECK("ai_index_records"."dimensions" BETWEEN 1 AND 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_index_records_point_unique` ON `ai_index_records` (`point_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_index_records_source_unique` ON `ai_index_records` (`index_id`,`asset_version_id`,`content_kind`,`chunk_ordinal`);--> statement-breakpoint
CREATE INDEX `ai_index_records_project_asset_idx` ON `ai_index_records` (`organization_id`,`project_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `ai_indexes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`state` text DEFAULT 'building' NOT NULL,
	`provider` text NOT NULL,
	`vision_model` text NOT NULL,
	`embedding_model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`pipeline_version` text NOT NULL,
	`prompt_version` text NOT NULL,
	`collection_name` text NOT NULL,
	`indexed_assets` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`evaluated_at` integer,
	`activated_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_indexes_state_valid" CHECK("ai_indexes"."state" IN ('building', 'evaluating', 'active', 'retired', 'failed')),
	CONSTRAINT "ai_indexes_dimensions_valid" CHECK("ai_indexes"."dimensions" BETWEEN 1 AND 65536),
	CONSTRAINT "ai_indexes_count_nonnegative" CHECK("ai_indexes"."indexed_assets" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_indexes_collection_unique` ON `ai_indexes` (`collection_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_indexes_one_active_per_project` ON `ai_indexes` (`organization_id`,`project_id`) WHERE "ai_indexes"."state" = 'active';--> statement-breakpoint
CREATE INDEX `ai_indexes_project_state_idx` ON `ai_indexes` (`organization_id`,`project_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_project_settings` (
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`allow_private_assets` integer DEFAULT false NOT NULL,
	`monthly_budget_micro_usd` integer DEFAULT 0 NOT NULL,
	`max_assets_per_run` integer DEFAULT 100 NOT NULL,
	`concurrency` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_project_settings_budget_nonnegative" CHECK("ai_project_settings"."monthly_budget_micro_usd" >= 0),
	CONSTRAINT "ai_project_settings_asset_limit_valid" CHECK("ai_project_settings"."max_assets_per_run" BETWEEN 1 AND 10000),
	CONSTRAINT "ai_project_settings_concurrency_valid" CHECK("ai_project_settings"."concurrency" BETWEEN 1 AND 16),
	CONSTRAINT "ai_project_settings_version_positive" CHECK("ai_project_settings"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_project_settings_project_unique` ON `ai_project_settings` (`organization_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `ai_usage_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`index_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`operation` text NOT NULL,
	`input_units` integer DEFAULT 0 NOT NULL,
	`output_units` integer DEFAULT 0 NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`index_id`) REFERENCES `ai_indexes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_usage_input_nonnegative" CHECK("ai_usage_ledger"."input_units" >= 0),
	CONSTRAINT "ai_usage_output_nonnegative" CHECK("ai_usage_ledger"."output_units" >= 0),
	CONSTRAINT "ai_usage_cost_nonnegative" CHECK("ai_usage_ledger"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE INDEX `ai_usage_ledger_project_occurred_idx` ON `ai_usage_ledger` (`organization_id`,`project_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `asset_search_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`public_id` text NOT NULL,
	`name` text NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`metadata_text` text DEFAULT '' NOT NULL,
	`extracted_text` text DEFAULT '' NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`,`organization_id`,`project_id`) REFERENCES `assets`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_search_documents_asset_unique` ON `asset_search_documents` (`organization_id`,`project_id`,`asset_id`);--> statement-breakpoint
CREATE INDEX `asset_search_documents_project_idx` ON `asset_search_documents` (`organization_id`,`project_id`);--> statement-breakpoint
INSERT INTO `asset_search_documents` (
	`organization_id`, `project_id`, `asset_id`, `public_id`, `name`, `folder`, `metadata_text`, `updated_at`
)
SELECT
	`assets`.`organization_id`,
	`assets`.`project_id`,
	`assets`.`id`,
	`assets`.`public_id`,
	`assets`.`name`,
	`assets`.`folder`,
	coalesce(cast(`asset_versions`.`metadata` as text), ''),
	`assets`.`updated_at`
FROM `assets`
LEFT JOIN `asset_versions`
	ON `asset_versions`.`asset_id` = `assets`.`id`
	AND `asset_versions`.`version` = `assets`.`current_version`
WHERE `assets`.`deleted_at` IS NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE `asset_search_fts` USING fts5(
	`name`,
	`folder`,
	`metadata_text`,
	`extracted_text`,
	`caption`,
	content='asset_search_documents',
	content_rowid='id',
	tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `asset_search_documents_ai` AFTER INSERT ON `asset_search_documents` BEGIN
	INSERT INTO `asset_search_fts` (`rowid`, `name`, `folder`, `metadata_text`, `extracted_text`, `caption`)
	VALUES (new.`id`, new.`name`, new.`folder`, new.`metadata_text`, new.`extracted_text`, new.`caption`);
END;--> statement-breakpoint
CREATE TRIGGER `asset_search_documents_ad` AFTER DELETE ON `asset_search_documents` BEGIN
	INSERT INTO `asset_search_fts` (`asset_search_fts`, `rowid`, `name`, `folder`, `metadata_text`, `extracted_text`, `caption`)
	VALUES ('delete', old.`id`, old.`name`, old.`folder`, old.`metadata_text`, old.`extracted_text`, old.`caption`);
END;--> statement-breakpoint
CREATE TRIGGER `asset_search_documents_au` AFTER UPDATE ON `asset_search_documents` BEGIN
	INSERT INTO `asset_search_fts` (`asset_search_fts`, `rowid`, `name`, `folder`, `metadata_text`, `extracted_text`, `caption`)
	VALUES ('delete', old.`id`, old.`name`, old.`folder`, old.`metadata_text`, old.`extracted_text`, old.`caption`);
	INSERT INTO `asset_search_fts` (`rowid`, `name`, `folder`, `metadata_text`, `extracted_text`, `caption`)
	VALUES (new.`id`, new.`name`, new.`folder`, new.`metadata_text`, new.`extracted_text`, new.`caption`);
END;--> statement-breakpoint
INSERT INTO `asset_search_fts` (`asset_search_fts`) VALUES ('rebuild');--> statement-breakpoint
CREATE TABLE `semantic_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`index_id` text NOT NULL,
	`evaluation_version` text NOT NULL,
	`query_count` integer NOT NULL,
	`recall_at_10_millionths` integer NOT NULL,
	`ndcg_at_10_millionths` integer NOT NULL,
	`tenant_filter_failures` integer DEFAULT 0 NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`index_id`) REFERENCES `ai_indexes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "semantic_evaluations_query_count_positive" CHECK("semantic_evaluations"."query_count" > 0),
	CONSTRAINT "semantic_evaluations_recall_range" CHECK("semantic_evaluations"."recall_at_10_millionths" BETWEEN 0 AND 1000000),
	CONSTRAINT "semantic_evaluations_ndcg_range" CHECK("semantic_evaluations"."ndcg_at_10_millionths" BETWEEN 0 AND 1000000),
	CONSTRAINT "semantic_evaluations_filter_failures_nonnegative" CHECK("semantic_evaluations"."tenant_filter_failures" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `semantic_evaluations_index_version_unique` ON `semantic_evaluations` (`index_id`,`evaluation_version`);
