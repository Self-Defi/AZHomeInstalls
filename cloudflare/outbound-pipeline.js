import { phoenixDate } from './outbound-controls.js';
import { dailyNewLimit } from './outbound-limits.js';

// Count historical sends and durable reservations once, including uncertain sends.
export const introductionUsageSql=`SELECT COUNT(*) AS n FROM outbound_messages_v2 m
 LEFT JOIN outbound_introduction_reservations r ON r.message_id=m.id
 WHERE m.step=0 AND (date(m.sent_at,'-7 hours')=? OR r.phoenix_date=?)`;
const inventorySql=`SELECT COUNT(*) AS n FROM outbound_prospects_v2 p
 JOIN outbound_enrollments_v2 e ON e.prospect_id=p.id
 JOIN outbound_messages_v2 m ON m.enrollment_id=e.id AND m.step=0
 LEFT JOIN email_suppressions s ON s.email_normalized=p.email_normalized
 WHERE m.status='queued' AND NOT EXISTS(SELECT 1 FROM outbound_introduction_reservations r WHERE r.message_id=m.id) AND e.status='queued' AND p.wave_number=2 AND p.research_only=0
 AND p.approved_at IS NOT NULL AND p.last_reply_at IS NULL AND p.stage='queued'
 AND p.solicitation_status='clear'
 AND s.email_normalized IS NULL`;
export async function prepareInventory(env,suppress,offsets) {
 if(env.OUTBOUND_AUTO_ENROLL_WAVE1!=='true')return {reason:'automation_disabled'};
 const db=env.LEADS_DB,owner=crypto.randomUUID(),now=new Date().toISOString();
 const lease=await db.prepare('UPDATE outbound_settings SET pipeline_lease=?,pipeline_lease_until=? WHERE id=1 AND (pipeline_lease_until IS NULL OR pipeline_lease_until<?)')
  .bind(owner,new Date(Date.parse(now)+10*60000).toISOString(),now).run();
 if(lease.meta.changes!==1)return {reason:'busy'};
 let enrolled=0;
 try {
  // Approved-wave contract: prospect screening happens before upload/approval.
  // This routine never infers approval from wave_number and never re-fetches sources.
  const {results:rows=[]}=await db.prepare(`SELECT p.id FROM outbound_prospects_v2 p
   LEFT JOIN outbound_wave_plan w ON w.prospect_id=p.id
   LEFT JOIN email_suppressions s ON s.email_normalized=p.email_normalized
   WHERE p.wave_number=2 AND p.approved_at IS NOT NULL AND length(trim(COALESCE(p.reviewed_by,'')))>0
   AND p.research_only=0 AND p.last_reply_at IS NULL AND p.solicitation_status='clear'
   AND p.stage IN ('prospect','queued') AND s.email_normalized IS NULL
   AND NOT EXISTS(SELECT 1 FROM outbound_enrollments_v2 e WHERE e.prospect_id=p.id)
   ORDER BY COALESCE(w.launch_day,999),w.send_order,p.priority,p.id LIMIT 100`).all();
  for(const p of rows) {
   const time=new Date().toISOString();
   if(Number((await db.prepare(inventorySql).first())?.n||0)>=25)break;
   if(!await db.prepare('SELECT 1 FROM outbound_settings WHERE id=1 AND pipeline_lease=? AND pipeline_lease_until>?').bind(owner,time).first())
    return {reason:'lease_expired',enrolled};
   const results=await db.batch([
    db.prepare(`UPDATE outbound_prospects_v2 SET stage='queued',updated_at=? WHERE id=?
      AND wave_number=2 AND stage IN ('prospect','queued') AND approved_at IS NOT NULL
      AND length(trim(COALESCE(reviewed_by,'')))>0 AND research_only=0 AND last_reply_at IS NULL
      AND solicitation_status='clear'
      AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=outbound_prospects_v2.email_normalized)
      AND NOT EXISTS(SELECT 1 FROM outbound_enrollments_v2 WHERE prospect_id=outbound_prospects_v2.id)
      AND EXISTS(SELECT 1 FROM outbound_settings WHERE id=1 AND pipeline_lease=? AND pipeline_lease_until>?)
      AND (${inventorySql})<25`).bind(time,p.id,owner,time),
    db.prepare(`INSERT OR IGNORE INTO outbound_enrollments_v2(prospect_id,campaign_version,created_at)
      SELECT id,'wave-v2',? FROM outbound_prospects_v2 WHERE id=? AND stage='queued'
      AND approved_at IS NOT NULL AND length(trim(COALESCE(reviewed_by,'')))>0
      AND research_only=0 AND last_reply_at IS NULL AND solicitation_status='clear'
      AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=outbound_prospects_v2.email_normalized)`).bind(time,p.id),
    ...offsets.map((offset,step)=>db.prepare(`INSERT OR IGNORE INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key)
      SELECT e.id,?,?,? FROM outbound_enrollments_v2 e JOIN outbound_prospects_v2 p ON p.id=e.prospect_id
      WHERE p.id=? AND e.status='queued' AND p.stage='queued' AND p.approved_at IS NOT NULL
      AND length(trim(COALESCE(p.reviewed_by,'')))>0 AND p.solicitation_status='clear'
      AND p.research_only=0 AND p.last_reply_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=p.email_normalized)`)
      .bind(step,offset,'wave-v2:'+p.id+':'+step,p.id))
   ]);
   if(results[1]?.meta?.changes) {
    enrolled++;
    await db.prepare('INSERT INTO outbound_events_v2(prospect_id,event_type,detail,created_at) VALUES(?,?,?,?)')
     .bind(p.id,'approved_wave_enrolled',JSON.stringify({source:'preapproved_wave2_inventory',target:25}),time).run();
   }
  }
  return {enrolled,inventory:Number((await db.prepare(inventorySql).first())?.n||0),target:25};
 } finally {
  await db.prepare('UPDATE outbound_settings SET pipeline_lease=NULL,pipeline_lease_until=NULL WHERE id=1 AND pipeline_lease=?').bind(owner).run();
 }
}
export async function operationalReport(env) {
 const db=env.LEADS_DB,now=new Date().toISOString(),day=phoenixDate();
 const settings=await db.prepare('SELECT daily_cap,paused FROM outbound_settings WHERE id=1').first();
 const used=Number((await db.prepare(introductionUsageSql).bind(day,day).first()).n);
 const sent=await db.prepare("SELECT COUNT(*) n FROM outbound_messages_v2 WHERE step=0 AND date(sent_at,'-7 hours')=?").bind(day).first();
 const inventory=await db.prepare(inventorySql).first();
 const followups=await db.prepare(`SELECT SUM(CASE WHEN status='queued' AND due_at<=? THEN 1 ELSE 0 END) due,
  SUM(CASE WHEN status='queued' AND due_at>? THEN 1 ELSE 0 END) scheduled,
  SUM(CASE WHEN date(sent_at,'-7 hours')=? THEN 1 ELSE 0 END) sent_today,
  SUM(CASE WHEN status='claimed' THEN 1 ELSE 0 END) uncertain
  FROM outbound_messages_v2 WHERE step>0`).bind(now,now,day).first();
 const {results:backlog=[]}=await db.prepare(`SELECT validation_status,COUNT(*) count FROM outbound_prospects_v2
  WHERE wave_number=2 AND research_only=0 AND stage IN ('prospect','queued')
  AND (validation_status<>'verified' OR validation_expires_at<=? OR validation_expires_at IS NULL)
  GROUP BY validation_status`).bind(now).all();
 const {results:failures=[]}=await db.prepare(`SELECT id,step,status,last_error FROM outbound_messages_v2 WHERE last_error IS NOT NULL OR status='claimed' OR (sent_at IS NULL AND EXISTS(SELECT 1 FROM outbound_introduction_reservations r WHERE r.message_id=outbound_messages_v2.id)) ORDER BY id DESC LIMIT 50`).all();
 const {results:pauses=[]}=await db.prepare("SELECT event_type,detail,created_at FROM outbound_events_v2 WHERE event_type='campaign_paused' ORDER BY id DESC LIMIT 20").all();
 return {phoenix_date:day,paused:!!settings.paused,introductions:{limit:dailyNewLimit(env,settings),sent:sent.n,used,remaining:Math.max(0,dailyNewLimit(env,settings)-used)},inventory:{target:25,ready:inventory.n,shortfall:Math.max(0,25-inventory.n)},followups,validation_backlog:backlog,failures,pauses};
}
