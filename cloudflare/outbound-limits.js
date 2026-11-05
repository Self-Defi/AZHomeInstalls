// New introductions have a hard pilot ceiling, independent of follow-ups.
export function dailyNewLimit(env, settings = {daily_cap: 5}) {
 const configured = Number(env.OUTBOUND_NEW_DAILY_CAP ?? 5);
 const stored = Number(settings?.daily_cap);
 if (![configured, stored].every(n => Number.isInteger(n) && n >= 1)) return 0;
 return Math.min(5, configured, stored);
}
