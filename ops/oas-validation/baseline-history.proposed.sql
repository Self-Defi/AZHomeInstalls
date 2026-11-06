-- PROPOSAL ONLY. Not executed against production in this task.
-- Run only after complete schema equivalence review, verified backup rehearsal,
-- effective sending/enrollment pause and a separate production-write authorization.
-- These timestamps record the reconciliation time, not invented deployment dates.
WITH expected(id,name) AS (VALUES
 (1,'0001_leads.sql'),
 (2,'0002_outbound.sql'),
 (3,'0003_outbound_wave_v2.sql'),
 (4,'0004_outbound_wave_plan.sql'),
 (5,'0005_outbound_provider_state.sql'),
 (6,'0006_outbound_gmail.sql')
)
INSERT INTO d1_migrations(id,name,applied_at)
SELECT e.id,e.name,CURRENT_TIMESTAMP
FROM expected e
WHERE CASE WHEN
 (SELECT COUNT(*) FROM d1_migrations)<=6
 AND (SELECT COUNT(*) FROM d1_migrations)=COALESCE((SELECT MAX(id) FROM d1_migrations),0)
 AND NOT EXISTS(SELECT 1 FROM d1_migrations h LEFT JOIN expected x ON x.id=h.id WHERE x.id IS NULL OR h.name IS NOT x.name OR h.applied_at IS NULL)
 AND COALESCE((SELECT paused=1 AND daily_cap=5 FROM outbound_settings WHERE id=1),0)=1
 AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('outbound_introduction_reservations','outbound_introduction_reservations_day','outbound_validation_backlog'))
 AND NOT EXISTS(SELECT 1 FROM pragma_table_xinfo('outbound_prospects_v2') WHERE name IN ('validation_status','validation_checked_at','validation_expires_at','validation_note','validated_source_url','research_only'))
 AND NOT EXISTS(SELECT 1 FROM pragma_table_xinfo('outbound_settings') WHERE name IN ('pipeline_lease','pipeline_lease_until'))
 THEN 1 ELSE json_extract('STOP_RECONCILIATION_PRECONDITION_FAILED','$') END = 1
 AND NOT EXISTS(SELECT 1 FROM d1_migrations h WHERE h.id=e.id)
ORDER BY e.id;
