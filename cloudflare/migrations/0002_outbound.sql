PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS outbound_prospects (
 id INTEGER PRIMARY KEY, organization TEXT NOT NULL, domain TEXT NOT NULL,
 contact_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL, email_normalized TEXT NOT NULL UNIQUE,
 segment TEXT NOT NULL CHECK(segment IN ('property_manager','realtor')),
 city TEXT NOT NULL, source_url TEXT NOT NULL, source_observed_at TEXT NOT NULL,
 fit_reason TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'prospect',
 approved_at TEXT, reviewed_by TEXT, last_reply_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound_sources (
 id INTEGER PRIMARY KEY, prospect_id INTEGER NOT NULL REFERENCES outbound_prospects(id),
 source_url TEXT NOT NULL, observed_at TEXT NOT NULL, evidence TEXT NOT NULL,
 UNIQUE(prospect_id,source_url)
);
CREATE TABLE IF NOT EXISTS outbound_enrollments (
 id INTEGER PRIMARY KEY, prospect_id INTEGER NOT NULL UNIQUE REFERENCES outbound_prospects(id),
 campaign_version TEXT NOT NULL DEFAULT 'pilot-v1',
 status TEXT NOT NULL DEFAULT 'queued', stop_reason TEXT, started_at TEXT,
 last_reply_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound_messages (
 id INTEGER PRIMARY KEY, enrollment_id INTEGER NOT NULL REFERENCES outbound_enrollments(id),
 step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 2),
 day_offset INTEGER NOT NULL CHECK(day_offset IN (0,3,9)),
 idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'queued',
 due_at TEXT, claimed_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 subject TEXT, body_text TEXT, provider_message_id TEXT UNIQUE,
 sent_at TEXT, delivered_at TEXT, last_error TEXT,
 UNIQUE(enrollment_id,step)
);
CREATE INDEX IF NOT EXISTS outbound_messages_due ON outbound_messages(status,due_at);
CREATE TABLE IF NOT EXISTS email_suppressions (
 email_normalized TEXT PRIMARY KEY, reason TEXT NOT NULL,
 scope TEXT NOT NULL DEFAULT 'all_marketing', source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound_events (
 id INTEGER PRIMARY KEY, prospect_id INTEGER REFERENCES outbound_prospects(id),
 message_id INTEGER REFERENCES outbound_messages(id), external_event_id TEXT UNIQUE,
 event_type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound_daily_limits (
 phoenix_date TEXT PRIMARY KEY, reserved INTEGER NOT NULL DEFAULT 0,
 sent INTEGER NOT NULL DEFAULT 0, cap INTEGER NOT NULL DEFAULT 5
);
CREATE TABLE IF NOT EXISTS outbound_lead_links (
 prospect_id INTEGER NOT NULL REFERENCES outbound_prospects(id),
 lead_id INTEGER NOT NULL REFERENCES leads(id), attribution_method TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(prospect_id,lead_id)
);
CREATE TABLE IF NOT EXISTS outbound_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 1,
 daily_cap INTEGER NOT NULL DEFAULT 5 CHECK(daily_cap BETWEEN 1 AND 20),
 timezone TEXT NOT NULL DEFAULT 'America/Phoenix'
);
INSERT OR IGNORE INTO outbound_settings(id) VALUES(1);
