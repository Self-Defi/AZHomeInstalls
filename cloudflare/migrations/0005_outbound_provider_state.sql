ALTER TABLE outbound_prospects_v2 ADD COLUMN provider TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN provider_lead_id TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN provider_campaign_id TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN provider_status TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN verification_status TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN provider_synced_at TEXT;
ALTER TABLE outbound_prospects_v2 ADD COLUMN solicitation_status TEXT NOT NULL DEFAULT 'reviewed';
ALTER TABLE outbound_prospects_v2 ADD COLUMN solicitation_note TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS outbound_prospects_v2_provider_lead
ON outbound_prospects_v2(provider,provider_lead_id)
WHERE provider_lead_id IS NOT NULL;