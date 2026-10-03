CREATE TABLE IF NOT EXISTS outbound_prospects_v2 (
 id INTEGER PRIMARY KEY,
 organization TEXT NOT NULL,
 domain TEXT NOT NULL,
 contact_name TEXT NOT NULL DEFAULT '',
 role TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL,
 email_normalized TEXT NOT NULL UNIQUE,
 segment TEXT NOT NULL,
 city TEXT NOT NULL,
 source_url TEXT NOT NULL,
 source_observed_at TEXT NOT NULL,
 fit_reason TEXT NOT NULL,
 personalization_hook TEXT NOT NULL DEFAULT '',
 wave_number INTEGER NOT NULL DEFAULT 1,
 priority TEXT NOT NULL DEFAULT 'B',
 vendor_friendly INTEGER NOT NULL DEFAULT 0,
 solicitation_checked_at TEXT NOT NULL,
 stage TEXT NOT NULL DEFAULT 'prospect',
 approved_at TEXT,
 reviewed_by TEXT,
 last_reply_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_sources_v2 (
 id INTEGER PRIMARY KEY,
 prospect_id INTEGER NOT NULL REFERENCES outbound_prospects_v2(id),
 source_url TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 evidence TEXT NOT NULL,
 UNIQUE(prospect_id,source_url)
);

CREATE TABLE IF NOT EXISTS outbound_enrollments_v2 (
 id INTEGER PRIMARY KEY,
 prospect_id INTEGER NOT NULL UNIQUE REFERENCES outbound_prospects_v2(id),
 campaign_version TEXT NOT NULL DEFAULT 'wave-v1',
 status TEXT NOT NULL DEFAULT 'queued',
 stop_reason TEXT,
 started_at TEXT,
 last_reply_at TEXT,
 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_messages_v2 (
 id INTEGER PRIMARY KEY,
 enrollment_id INTEGER NOT NULL REFERENCES outbound_enrollments_v2(id),
 step INTEGER NOT NULL,
 day_offset INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'queued',
 due_at TEXT,
 claimed_until TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 subject TEXT,
 body_text TEXT,
 provider_message_id TEXT UNIQUE,
 sent_at TEXT,
 delivered_at TEXT,
 last_error TEXT,
 UNIQUE(enrollment_id,step)
);

CREATE INDEX IF NOT EXISTS outbound_messages_v2_due ON outbound_messages_v2(status,due_at);

CREATE TABLE IF NOT EXISTS outbound_events_v2 (
 id INTEGER PRIMARY KEY,
 prospect_id INTEGER REFERENCES outbound_prospects_v2(id),
 message_id INTEGER REFERENCES outbound_messages_v2(id),
 external_event_id TEXT UNIQUE,
 event_type TEXT NOT NULL,
 detail TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_lead_links_v2 (
 prospect_id INTEGER NOT NULL REFERENCES outbound_prospects_v2(id),
 lead_id INTEGER NOT NULL REFERENCES leads(id),
 attribution_method TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(prospect_id,lead_id)
);