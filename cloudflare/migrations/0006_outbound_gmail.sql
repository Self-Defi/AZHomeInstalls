ALTER TABLE outbound_messages_v2 ADD COLUMN gmail_thread_id TEXT;
ALTER TABLE outbound_messages_v2 ADD COLUMN rfc_message_id TEXT;
ALTER TABLE outbound_settings ADD COLUMN gmail_lease TEXT;
ALTER TABLE outbound_settings ADD COLUMN gmail_lease_until TEXT;
ALTER TABLE outbound_settings ADD COLUMN gmail_last_sync_at TEXT;
CREATE INDEX IF NOT EXISTS outbound_gmail_thread ON outbound_messages_v2(gmail_thread_id);
UPDATE outbound_settings SET paused=1,daily_cap=5 WHERE id=1;
