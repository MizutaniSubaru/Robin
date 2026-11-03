CREATE TABLE `agent_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`chat` text NOT NULL,
	`trigger` text NOT NULL,
	`from_ts` integer,
	`to_ts` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `agent_runs_chat_started_at_idx` ON `agent_runs` (`chat`,`started_at`);--> statement-breakpoint
CREATE TABLE `chat_snapshots` (
	`chat` text PRIMARY KEY NOT NULL,
	`last_ts` integer NOT NULL,
	`reducer_version` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`chat` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`inbound_account` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`ts` integer NOT NULL,
	`ts_source` text NOT NULL,
	`server_date` integer,
	`chat` text NOT NULL,
	`kind` text NOT NULL,
	`v` integer DEFAULT 1 NOT NULL,
	`account` text NOT NULL,
	`dedup_key` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_event_id_unique` ON `events` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_chat_dedup_key_uq` ON `events` (`chat`,`dedup_key`);--> statement-breakpoint
CREATE INDEX `events_chat_ts_idx` ON `events` (`chat`,`ts`,`id`);--> statement-breakpoint
CREATE TABLE `files` (
	`file_key` text PRIMARY KEY NOT NULL,
	`local_path` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `files_sha256_idx` ON `files` (`sha256`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`request` text NOT NULL,
	`response` text,
	`usage` text,
	`latency_ms` integer,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `llm_calls_run_id_idx` ON `llm_calls` (`run_id`);--> statement-breakpoint
CREATE TABLE `media_descriptions` (
	`desc_key` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `raw_updates_received_at_idx` ON `raw_updates` (`received_at`);--> statement-breakpoint
CREATE TABLE `stickers` (
	`file_key` text PRIMARY KEY NOT NULL,
	`set_name` text,
	`emoji` text,
	`format` text NOT NULL,
	`sendable_remote_id` text,
	`enabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stickers_emoji_idx` ON `stickers` (`emoji`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`args` text NOT NULL,
	`result` text,
	`status` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tool_calls_run_id_idx` ON `tool_calls` (`run_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`user` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`username` text,
	`is_bot` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
