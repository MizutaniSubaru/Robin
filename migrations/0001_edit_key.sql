-- message.edited gains editKey, and its dedup key changes from the edit date to it. The key is what
-- the adapter now builds: the received_at of the updateMessageEdited, found in raw_updates (TDLib
-- message id = server id * 2^20). Within one edit date only the first edit used to be committed.
-- An edit without its raw update fails the NOT NULL below and with it the whole migration
CREATE TABLE `edit_keys` (`id` integer PRIMARY KEY NOT NULL, `edit_key` text NOT NULL);
--> statement-breakpoint
INSERT INTO `edit_keys` (`id`, `edit_key`)
SELECT e.`id`, (
  SELECT CAST(min(r.`received_at`) AS TEXT)
  FROM `raw_updates` r
  WHERE r.`type` = 'updateMessageEdited'
    AND r.`account` = e.`account`
    AND json_extract(r.`payload`, '$.chat_id') = CAST(replace(replace(e.`chat`, 'tg:bot:', ''), 'tg:', '') AS INTEGER)
    AND json_extract(r.`payload`, '$.message_id') = CAST(json_extract(e.`payload`, '$.messageId') AS INTEGER) * 1048576
    AND json_extract(r.`payload`, '$.edit_date') = e.`server_date`
)
FROM `events` e
WHERE e.`kind` = 'message.edited';
--> statement-breakpoint
UPDATE `events`
SET `payload` = json_set(`events`.`payload`, '$.editKey', k.`edit_key`),
  `dedup_key` = 'edit:' || json_extract(`events`.`payload`, '$.messageId') || ':' || k.`edit_key`
FROM `edit_keys` k
WHERE k.`id` = `events`.`id`;
--> statement-breakpoint
DROP TABLE `edit_keys`;
