CREATE TABLE IF NOT EXISTS outbound_wave_plan (
 prospect_id INTEGER PRIMARY KEY REFERENCES outbound_prospects_v2(id),
 wave_number INTEGER NOT NULL,
 launch_day INTEGER NOT NULL DEFAULT 1,
 send_order INTEGER NOT NULL,
 planned_at TEXT NOT NULL,
 UNIQUE(wave_number, launch_day, send_order)
);

CREATE INDEX IF NOT EXISTS outbound_wave_plan_wave_day
ON outbound_wave_plan(wave_number,launch_day,send_order);