import { phoenixDate } from './outbound-controls.js';
import { dailyNewLimit } from './outbound-limits.js';
import { solicitationPreflight } from './outbound-validation.js';

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
 AND p.validation_status='verified' AND p.validation_expires_at>? AND p.solicitation_status='clear'
 AND s.email_normalized IS NULL`;
export async function prepareInventory(env,suppress,offsets,{validateSource=solicitationPreflight}={}) {
 if(env.OUTBOUND_AUTO_ENROLL_WAVE1!=='true')return {reason:'automation_disabled'};
 const db=env.LEADS_DB,owner=crypto.randomUUID(),now=new Date().toISOString();
 const lease=await db.prepare('UPDATE outbound_settings SET pipeline_lease=?,pipeline_lease_until=? WHERE id=1 AND (pipeline_lease_until IS NULL OR pipeline_lease_until<?)')
  .bind(owner,new Date(Date.parse(now)+10*60000).toISOString(),now).run();
 if(lease.meta.changes!==1)return {reason:'busy'};
 let validated=0,enrolled=0,review=0,researched=0;
 try {
  const {results:rows=[]}=await db.prepare(`SELECT p.* FROM outbound_prospects_v2 p
   LEFT JOIN outbound_wave_plan w ON w.prospect_id=p.id
   LEFT JOIN email_suppressions s ON s.email_normalized=p.email_normalized
   WHERE p.wave_number=2 AND p.last_reply_at IS NULL AND s.email_normalized IS NULL
   AND (p.stage='prospect' AND NOT EXISTS(SELECT 1 FROM outbound_enrollments_v2 e WHERE e.prospect_id=p.id)
    OR p.stage='queued' AND EXISTS(SELECT 1 FROM outbound_enrollments_v2 e JOIN outbound_messages_v2 m ON m.enrollment_id=e.id WHERE e.prospect_id=p.id AND e.status='queued' AND m.step=0 AND m.status='queued' AND NOT EXISTS(SELECT 1 FROM outbound_introduction_reservations r WHERE r.message_id=m.id)))
   AND (p.validation_status='verified' OR p.validation_checked_at IS NULL OR p.validation_checked_at<?)
   ORDER BY p.research_only ASC,p.validation_checked_at IS NOT NULL,p.validation_checked_at,COALESCE(w.launch_day,999),w.send_order,p.priority,p.id LIMIT 12`)
   .bind(new Date(Date.parse(now)-86400000).toISOString()).all();
  for(const p of rows) {
   const time=new Date().toISOString();
   if((await db.prepare(inventorySql).bind(time).first()).n>=25)break;
   const lock=await db.prepare('SELECT 1 FROM outbound_settings WHERE id=1 AND pipeline_lease=? AND pipeline_lease_until>?').bind(owner,time).first();
   if(!lock)return {reason:'lease_expired',validated,enrolled,review};
   if(p.validation_status!=='verified'||!p.validation_expires_at||p.validation_expires_at<=time) {
    const checked=await validateSource(env,{...p,research_only:0});
    if(checked.status==='blocked'){await suppress(env,p.email_normalized,'no_solicitation','public_source');review++;continue;}
    if(checked.status!=='clear'){review++;continue;}validated++;
   }
   const timestamp=new Date().toISOString();
   if(p.research_only){
    const promoted=await db.prepare(`UPDATE outbound_prospects_v2 SET research_only=0,updated_at=? WHERE id=? AND research_only=1 AND stage='prospect' AND validation_status='verified' AND validation_expires_at>? AND solicitation_status='clear' AND last_reply_at IS NULL AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=outbound_prospects_v2.email_normalized)`).bind(timestamp,p.id,timestamp).run();
    if(!promoted.meta.changes){review++;continue;}
    researched++;
   }
   // Approval, enrollment and sequence insertion are one D1 transaction. Recheck
   // every gate after network I/O; a concurrent opt-out must always win.
   const results=await db.batch([
    db.prepare(`UPDATE outbound_prospects_v2 SET approved_at=?,reviewed_by='OAS Wave 2 public-evidence validation',stage='queued',updated_at=?
     WHERE id=? AND stage='prospect' AND research_only=0 AND last_reply_at IS NULL
     AND validation_status='verified' AND validation_expires_at>? AND solicitation_status='clear'
     AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=outbound_prospects_v2.email_normalized)
     AND NOT EXISTS(SELECT 1 FROM outbound_enrollments_v2 WHERE prospect_id=outbound_prospects_v2.id)
     AND EXISTS(SELECT 1 FROM outbound_settings WHERE id=1 AND pipeline_lease=? AND pipeline_lease_until>?)
     AND (${inventorySql})<25`).bind(timestamp,timestamp,p.id,timestamp,owner,timestamp,timestamp),
    db.prepare(`INSERT OR IGNORE INTO outbound_enrollments_v2(prospect_id,campaign_version,created_at)
     SELECT id,'wave-v2',? FROM outbound_prospects_v2 WHERE id=? AND stage='queued' AND approved_at IS NOT NULL
     AND research_only=0 AND last_reply_at IS NULL AND validation_status='verified' AND validation_expires_at>?
     AND solicitation_status='clear' AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=outbound_prospects_v2.email_normalized)`)
     .bind(timestamp,p.id,timestamp),
    ...offsets.map((offset,step)=>db.prepare(`INSERT OR IGNORE INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key)
     SELECT e.id,?,?,? FROM outbound_enrollments_v2 e JOIN outbound_prospects_v2 p ON p.id=e.prospect_id
     WHERE p.id=? AND e.status='queued' AND p.stage='queued' AND p.approved_at IS NOT NULL AND p.validation_status='verified'
     AND p.validation_expires_at>? AND p.research_only=0 AND p.last_reply_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=p.email_normalized)`)
     .bind(step,offset,'wave-v2:'+p.id+':'+step,p.id,timestamp))
   ]);
   if(results[0].meta.changes) {
    enrolled++;
    await db.prepare('INSERT INTO outbound_events_v2(prospect_id,event_type,detail,created_at) VALUES(?,?,?,?)')
     .bind(p.id,'approved',JSON.stringify({source:'validated_wave2_inventory',target:25}),timestamp).run();
   }
  }
  return {validated,enrolled,review,researched,inventory:(await db.prepare(inventorySql).bind(new Date().toISOString()).first()).n,target:25};
 } finally {
  await db.prepare('UPDATE outbound_settings SET pipeline_lease=NULL,pipeline_lease_until=NULL WHERE id=1 AND pipeline_lease=?').bind(owner).run();
 }
}
export async function operationalReport(env) {
 const db=env.LEADS_DB,now=new Date().toISOString(),day=phoenixDate();
 const settings=await db.prepare('SELECT daily_cap,paused FROM outbound_settings WHERE id=1').first();
 const used=Number((await db.prepare(introductionUsageSql).bind(day,day).first()).n);
 const sent=await db.prepare("SELECT COUNT(*) n FROM outbound_messages_v2 WHERE step=0 AND date(sent_at,'-7 hours')=?").bind(day).first();
 const inventory=await db.prepare(inventorySql).bind(now).first();
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
