-- Additive only. Existing contacts, messages, events and suppression history remain intact.
ALTER TABLE outbound_prospects_v2 ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE outbound_prospects_v2 ADD COLUMN validation_checked_at TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN validation_expires_at TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN validation_note TEXT NOT NULL DEFAULT '';
ALTER TABLE outbound_prospects_v2 ADD COLUMN validated_source_url TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN research_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_settings ADD COLUMN pipeline_lease TEXT;
ALTER TABLE outbound_settings ADD COLUMN pipeline_lease_until TEXT;
CREATE TABLE outbound_introduction_reservations (
 message_id INTEGER PRIMARY KEY REFERENCES outbound_messages_v2(id),
 phoenix_date TEXT NOT NULL,
 owner TEXT NOT NULL,
 reserved_at TEXT NOT NULL
);
CREATE INDEX outbound_introduction_reservations_day ON outbound_introduction_reservations(phoenix_date);
CREATE INDEX outbound_validation_backlog ON outbound_prospects_v2(wave_number,validation_status,validation_checked_at);
-- Carry forward uncertain pre-migration introductions; never free a slot merely
-- because its old Worker lease elapsed. No historical message row is changed.
INSERT INTO outbound_introduction_reservations(message_id,phoenix_date,owner,reserved_at)
 SELECT id,COALESCE(date(claimed_until,'-10 minutes','-7 hours'),date('now','-7 hours')),
 'legacy-uncertain',COALESCE(claimed_until,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NULL
 AND (status='claimed' OR last_error LIKE '%uncertain%');
