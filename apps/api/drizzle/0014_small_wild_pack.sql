CREATE TABLE `agent_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`plan_hash` text NOT NULL,
	`planner_version` text NOT NULL,
	`summary` text NOT NULL,
	`risk_class` text NOT NULL,
	`reversibility` text NOT NULL,
	`required_role` text NOT NULL,
	`tool_calls` text NOT NULL,
	`target_snapshot` text NOT NULL,
	`budget` text NOT NULL,
	`estimated_cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`estimated_output_bytes` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`,`organization_id`,`project_id`) REFERENCES `agent_runs`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_plans_hash_valid" CHECK(length("agent_plans"."plan_hash") = 64 AND "agent_plans"."plan_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "agent_plans_risk_valid" CHECK("agent_plans"."risk_class" IN ('standard', 'sensitive', 'destructive')),
	CONSTRAINT "agent_plans_reversibility_valid" CHECK("agent_plans"."reversibility" IN ('reversible', 'compensatable', 'irreversible')),
	CONSTRAINT "agent_plans_role_valid" CHECK("agent_plans"."required_role" IN ('owner', 'admin')),
	CONSTRAINT "agent_plans_estimates_nonnegative" CHECK("agent_plans"."estimated_cost_micro_usd" >= 0 AND "agent_plans"."estimated_output_bytes" >= 0),
	CONSTRAINT "agent_plans_expiry_valid" CHECK("agent_plans"."expires_at" > "agent_plans"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_plans_hash_unique` ON `agent_plans` (`plan_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_plans_id_tenant_unique` ON `agent_plans` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_plans_id_hash_tenant_unique` ON `agent_plans` (`id`,`plan_hash`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `agent_plans_project_created_idx` ON `agent_plans` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`state` text DEFAULT 'planning' NOT NULL,
	`request` text NOT NULL,
	`provider` text,
	`model` text,
	`budget` text NOT NULL,
	`steps_used` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`,`organization_id`) REFERENCES `projects`(`id`,`organization_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_runs_state_valid" CHECK("agent_runs"."state" IN ('planning', 'awaiting_approval', 'executing', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "agent_runs_usage_nonnegative" CHECK("agent_runs"."steps_used" >= 0 AND "agent_runs"."tokens_used" >= 0 AND "agent_runs"."cost_micro_usd" >= 0),
	CONSTRAINT "agent_runs_completion_consistent" CHECK(("agent_runs"."state" IN ('succeeded', 'failed', 'cancelled')) = ("agent_runs"."completed_at" IS NOT NULL)),
	CONSTRAINT "agent_runs_cancellation_consistent" CHECK(("agent_runs"."state" = 'cancelled') = ("agent_runs"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_id_tenant_unique` ON `agent_runs` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_project_created_idx` ON `agent_runs` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`plan_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`decided_by` text,
	`decision_reason` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`consumed_at` integer,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`decided_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`plan_id`,`plan_hash`,`organization_id`,`project_id`) REFERENCES `agent_plans`(`id`,`plan_hash`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "approval_requests_state_valid" CHECK("approval_requests"."state" IN ('pending', 'approved', 'rejected', 'expired', 'cancelled', 'consumed')),
	CONSTRAINT "approval_requests_hash_valid" CHECK(length("approval_requests"."plan_hash") = 64 AND "approval_requests"."plan_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "approval_requests_decision_consistent" CHECK(("approval_requests"."state" IN ('approved', 'rejected', 'consumed')) = ("approval_requests"."decided_by" IS NOT NULL AND "approval_requests"."decided_at" IS NOT NULL)),
	CONSTRAINT "approval_requests_consumption_consistent" CHECK(("approval_requests"."state" = 'consumed') = ("approval_requests"."consumed_at" IS NOT NULL)),
	CONSTRAINT "approval_requests_expiry_valid" CHECK("approval_requests"."expires_at" > "approval_requests"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_requests_one_pending_per_plan` ON `approval_requests` (`plan_id`) WHERE "approval_requests"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `approval_requests_id_tenant_unique` ON `approval_requests` (`id`,`organization_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `approval_requests_inbox_idx` ON `approval_requests` (`organization_id`,`project_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `tool_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`approval_request_id` text NOT NULL,
	`call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`arguments_hash` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`run_id`,`organization_id`,`project_id`) REFERENCES `agent_runs`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`plan_id`,`organization_id`,`project_id`) REFERENCES `agent_plans`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approval_request_id`,`organization_id`,`project_id`) REFERENCES `approval_requests`(`id`,`organization_id`,`project_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tool_executions_state_valid" CHECK("tool_executions"."state" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
	CONSTRAINT "tool_executions_attempt_nonnegative" CHECK("tool_executions"."attempt" >= 0),
	CONSTRAINT "tool_executions_started_consistent" CHECK(("tool_executions"."state" <> 'queued') = ("tool_executions"."started_at" IS NOT NULL)),
	CONSTRAINT "tool_executions_completed_consistent" CHECK(("tool_executions"."state" IN ('succeeded', 'failed', 'cancelled', 'skipped')) = ("tool_executions"."completed_at" IS NOT NULL)),
	CONSTRAINT "tool_executions_arguments_hash_valid" CHECK(length("tool_executions"."arguments_hash") = 64 AND "tool_executions"."arguments_hash" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_executions_plan_call_unique` ON `tool_executions` (`plan_id`,`call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tool_executions_idempotency_unique` ON `tool_executions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `tool_executions_run_state_idx` ON `tool_executions` (`run_id`,`state`);
--> statement-breakpoint
CREATE TRIGGER `agent_plans_immutable_update`
BEFORE UPDATE ON `agent_plans`
BEGIN
	SELECT RAISE(ABORT, 'agent plans are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `agent_plans_immutable_delete`
BEFORE DELETE ON `agent_plans`
BEGIN
	SELECT RAISE(ABORT, 'agent plans are immutable');
END;
