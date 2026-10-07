import { gmailConfiguration, checkGmail, syncGmail, runGmail, sendGmailTest, gmailTestStatus } from './outbound-gmail.js';
import { unsubscribe, unsubscribeUrl, recordEvent, stopForReply, linkLead, phoenixDate } from './outbound-controls.js';
import { outboundProviderStatus, addProspectToInstantly, listInstantlyLeads, webhookAuthorized, normalizeInstantlyWebhook } from './outbound-provider.js';
// Provider synchronization is available; campaign launch remains gated.
const SEGMENTS = new Set(['property_manager','design_studio','home_stager','realtor','moving_company','builder_new_community']);
export const OFFSETS = [0,7,17];
export const normalizeEmail = value => String(value || '').trim().toLowerCase();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const now = () => new Date().toISOString();
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
function publicUrl(value) {
 try {
  const u = new URL(value);
  if(u.protocol!=='https:' || u.username || u.password || !u.hostname.includes('.') ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return false;
  return true;
 } catch { return false; }
}
const NO_SOLICIT_PATTERNS = [
 /\bno\s+solicitors?\b/i,
 /\bno\s+solicitation\b/i,
 /\bno\s+vendor\s+solicitation\b/i,
 /\bdo\s+not\s+solicit\b/i,
 /\bno\s+sales\s+solicitation\b/i
];

function htmlToText(html) {
 return String(html || "")
  .replace(/<script[\s\S]*?<\/script>/gi," ")
  .replace(/<style[\s\S]*?<\/style>/gi," ")
  .replace(/<[^>]+>/g," ")
  .replace(/&nbsp;/gi," ")
  .replace(/&amp;/gi,"&")
  .replace(/\s+/g," ")
  .trim();
}

async function solicitationPreflight(env,p) {
 const checkedAt=now();
 let status="manual_required", note="";
 try {
  const response=await fetch(p.source_url,{
   method:"GET",
   redirect:"error",
   signal:AbortSignal.timeout(10000),
   headers:{"User-Agent":"AZHomeInstalls-Outreach-Compliance/1.0"}
  });
  const type=String(response.headers.get("content-type")||"").toLowerCase();
  if(!response.ok) {
   note="Source page returned HTTP "+response.status;
  } else if(!type.includes("text/html") && !type.includes("text/plain")) {
   note="Source is not machine-readable HTML/text; manual re-check required";
  } else {
   const text=htmlToText((await response.text()).slice(0,750000));
   const hit=NO_SOLICIT_PATTERNS.find(rx=>rx.test(text));
   if(hit) {
    status="blocked";
    note="Explicit no-solicitation language detected on public source";
   } else {
    status="clear";
    note="No explicit no-solicitation phrase detected on reviewed public source";
   }
  }
 } catch(error) {
  note="Source re-check failed: "+String(error?.message||error).slice(0,300);
 }
 await env.LEADS_DB.prepare("UPDATE outbound_prospects_v2 SET solicitation_checked_at=?,solicitation_status=?,solicitation_note=?,updated_at=? WHERE id=?")
  .bind(checkedAt,status,note,checkedAt,p.id).run();
 return {status,note,checked_at:checkedAt};
}

export function validateProspect(body) {
 const p = {};
 for(const key of ['organization','contact_name','role','email','segment','city','source_url','fit_reason','personalization_hook','priority'])
  p[key] = String(body[key] || '').trim();
 p.wave_number = Number(body.wave_number || 1);
 p.vendor_friendly = body.vendor_friendly === true || body.vendor_friendly === 1 || body.vendor_friendly === '1' ? 1 : 0;
 p.solicitation_checked_at = String(body.solicitation_checked_at || '').trim();
 if(['email','organization','contact_name'].some(k=>/[\r\n]/.test(p[k]))) throw Error('Single-line identity fields required');
 p.email_normalized = normalizeEmail(p.email);
 if(!validEmail(p.email_normalized)) throw Error('Valid public business email required');
 if(!SEGMENTS.has(p.segment)) throw Error('Unsupported launch segment');
 if(!Number.isInteger(p.wave_number) || p.wave_number < 1 || p.wave_number > 999) throw Error('Valid wave number required');
 if(!['A','B','C'].includes(p.priority || 'B')) p.priority = 'B';
 if(!p.solicitation_checked_at || Number.isNaN(Date.parse(p.solicitation_checked_at))) throw Error('Solicitation check timestamp required');
 if(!publicUrl(p.source_url)) throw Error('Public HTTPS source URL required');
 for(const key of ['organization','city','fit_reason']) if(!p[key] || p[key].length>1000) throw Error('Missing or oversized '+key);
 if(p.email.length>254 || p.source_url.length>2000 || p.contact_name.length>200 || p.role.length>200 || p.personalization_hook.length>1000) throw Error('Field too long');
 p.domain = p.email_normalized.split('@')[1];
 return p;
}
export async function authorized(request,env) {
 const expected = String(env.OUTBOUND_ADMIN_TOKEN || '');
 const supplied = (request.headers.get('Authorization') || '').replace(/^Bearer /,'');
 if(expected.length<32 || supplied.length!==expected.length) return false;
 // Compare digests to avoid early-exit string comparison of secret values.
 const digest = async v => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));
 const [a,b] = await Promise.all([digest(expected),digest(supplied)]);
 let diff=0; for(let i=0;i<a.length;i++) diff |= a[i]^b[i];
 return diff===0;
}
export function renderTemplate(p,step,footer) {
 if(!Number.isInteger(step) || step<0 || step>2) throw Error('Invalid sequence step');
 const greeting = p.contact_name ? 'Hi '+p.contact_name+',' : 'Hi '+p.organization+' team,';
 const company=p.organization;
 const templates = {
  property_manager: ['Installation support for your residents', "I’m Jay with AZHomeInstalls. We help Phoenix-area residents with TV mounting, cord concealing, shelving, and selected home installations.", `Would having a local installation contact be useful when residents at ${company} ask for help getting settled?`, 'If so, I can send a short service overview for your team.'],
  home_stager: ['Installation help for staging projects', 'I’m Jay with AZHomeInstalls. We provide residential installation support, including TV mounting, cord concealing, and shelving.', `I’m reaching out to see whether ${company} could use a local installation contact when a staging project needs those finishing details handled.`, 'Would you like a short overview of the work we can help with?'],
  design_studio: ['Installation support for residential projects', 'I’m Jay with AZHomeInstalls. We help with TV mounting, cord concealing, shelving, and selected residential installations.', `For ${company} projects involving those details, we’d welcome the opportunity to review the installation scope and provide an estimate.`, 'Would a short service overview be useful for your team?'],
  realtor: ['A local installation contact for your buyers', 'I’m Jay with AZHomeInstalls. We help Phoenix-area homeowners get settled with TV mounting, cord concealing, shelving, and selected home installations.', 'Do your buyers ever ask for a local contact for that work after closing?', 'I can send a short service overview you can share when the need comes up.'],
  moving_company: ['Helping customers finish their move', 'I’m Jay with AZHomeInstalls. After a move, homeowners often still need TVs mounted, cords concealed, or shelving installed.', 'We handle those residential installation tasks in the Phoenix area.', `Would a local installation contact be useful for ${company} customers who ask about help after delivery?`],
  builder_new_community: ['Post-close installation help for homeowners', 'I’m Jay with AZHomeInstalls. We provide post-close installation help for Phoenix-area homeowners, including TV mounting, cord concealing, shelving, and selected home installations.', `Would ${company} find it useful to have a local installation contact to share with homeowners after closing?`, 'I can send a short service overview for your homeowner information materials.']
 };
 const template=templates[p.segment];
 if(!template) throw Error('Unsupported launch segment');
 const subjects=[template[0],'Following up on installation support','Final check-in on installation support'];
 // Only reviewed customer-facing details belong in copy; internal fit notes never do.
 const initial=[template[1],p.personalization_hook,template[2],template[3]].filter(Boolean).join('\n\n');
 const bodies=[initial,'Following up on my introduction. Would you like a short AZHomeInstalls service overview for future residential installation requests?','This is my final check-in. If installation support becomes useful, you can reply here. I will close out this outreach sequence.'];
 return {subject:'ADV: '+subjects[step],text:[greeting,'',bodies[step],'','Jay','AZHomeInstalls','https://azhomeinstalls.com/services/','Advertisement — Residential installation services.','Not a Licensed Contractor.',footer.address || '[MAILING ADDRESS REQUIRED]',footer.optout || '[UNSUBSCRIBE LINK REQUIRED]'].join('\n')};
}
async function audit(env,id,type,detail={}) {
 await env.LEADS_DB.prepare('INSERT INTO outbound_events_v2(prospect_id,event_type,detail,created_at) VALUES(?,?,?,?)').bind(id,type,JSON.stringify(detail),now()).run();
}
export async function suppress(env,email,reason,source) {
 const normalized = normalizeEmail(email), at=now();
 await env.LEADS_DB.batch([
  env.LEADS_DB.prepare('INSERT OR IGNORE INTO email_suppressions(email_normalized,reason,source,created_at) VALUES(?,?,?,?)').bind(normalized,reason,source,at),
  env.LEADS_DB.prepare("UPDATE outbound_prospects_v2 SET stage='do_not_contact',updated_at=? WHERE email_normalized=?").bind(at,normalized),
  env.LEADS_DB.prepare("UPDATE outbound_enrollments_v2 SET status='stopped',stop_reason=? WHERE prospect_id IN (SELECT id FROM outbound_prospects_v2 WHERE email_normalized=?)").bind(reason,normalized),
  env.LEADS_DB.prepare("UPDATE outbound_messages_v2 SET status='cancelled' WHERE status IN ('queued','claimed') AND enrollment_id IN (SELECT e.id FROM outbound_enrollments_v2 e JOIN outbound_prospects_v2 p ON p.id=e.prospect_id WHERE p.email_normalized=?)").bind(normalized),
  env.LEADS_DB.prepare("UPDATE leads SET unsubscribed=1,next_followup_at=NULL WHERE lower(trim(email))=?").bind(normalized)
 ]);
}
async function preview(env) {
 const {results=[]} = await env.LEADS_DB.prepare(
  "SELECT p.*,m.id AS message_id,m.step,m.due_at FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id JOIN outbound_prospects_v2 p ON p.id=e.prospect_id LEFT JOIN email_suppressions s ON s.email_normalized=p.email_normalized WHERE m.status='queued' AND e.status='queued' AND p.approved_at IS NOT NULL AND p.last_reply_at IS NULL AND s.email_normalized IS NULL AND m.step=0 ORDER BY m.id LIMIT 20").all();
 return Promise.all(results.map(async p=>({prospect_id:p.id,message_id:p.message_id,...renderTemplate(p,Number(p.step),{address:env.OUTBOUND_MAILING_ADDRESS,optout:env.OUTBOUND_UNSUBSCRIBE_SECRET ? 'Unsubscribe: '+await unsubscribeUrl(env,p) : undefined})})));
}

export async function prepareDailyProspects(env) {
 if(env.OUTBOUND_AUTO_ENROLL_WAVE1!=='true') return;
 const db=env.LEADS_DB, day=phoenixDate(), limit=Number(env.OUTBOUND_NEW_DAILY_CAP||5);
 const used=await db.prepare("SELECT COUNT(*) AS n FROM outbound_messages_v2 WHERE step=0 AND (status IN ('queued','claimed') OR sent_at IS NOT NULL AND date(sent_at,'-7 hours')=?)").bind(day).first();
 let slots=Math.max(0,limit-Number(used?.n||0));
 if(!slots) return;
 const {results:rows=[]}=await db.prepare("SELECT p.* FROM outbound_prospects_v2 p LEFT JOIN outbound_wave_plan w ON w.prospect_id=p.id LEFT JOIN email_suppressions s ON s.email_normalized=p.email_normalized WHERE p.stage='prospect' AND p.wave_number=1 AND p.source_observed_at<'2026-10-08' AND p.last_reply_at IS NULL AND p.solicitation_status IN ('reviewed','clear') AND s.email_normalized IS NULL AND NOT EXISTS(SELECT 1 FROM outbound_enrollments_v2 e WHERE e.prospect_id=p.id) ORDER BY CASE WHEN w.launch_day IS NULL THEN 999 ELSE w.launch_day END,w.send_order,p.priority,p.id LIMIT 8").all();
 for(const p of rows) {
  if(!slots) break;
  const checked=await solicitationPreflight(env,p);
  if(checked.status==='blocked') {await suppress(env,p.email_normalized,'no_solicitation','public_source');continue;}
  if(checked.status!=='clear') continue;
  const time=now();
  await db.batch([
   db.prepare("UPDATE outbound_prospects_v2 SET approved_at=?,reviewed_by='Jay: daily five authorization 2026-10-07',stage='queued',updated_at=? WHERE id=? AND stage='prospect' AND solicitation_status='clear' AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=?)").bind(time,time,p.id,p.email_normalized),
   db.prepare("INSERT OR IGNORE INTO outbound_enrollments_v2(prospect_id,created_at) SELECT id,? FROM outbound_prospects_v2 WHERE id=? AND stage='queued' AND approved_at IS NOT NULL").bind(time,p.id),
   ...OFFSETS.map((offset,step)=>db.prepare("INSERT OR IGNORE INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key) SELECT id,?,?,? FROM outbound_enrollments_v2 WHERE prospect_id=?").bind(step,offset,'wave-v1:'+p.id+':'+step,p.id))
  ]);
  await audit(env,p.id,'approved',{reviewer:'Jay',source:'authorized_daily_wave1',daily_new_limit:limit});
  slots--;
 }
}

export async function syncOutboundProvider(env) {
 if(!env.LEADS_DB) return {ok:false,reason:"database_unavailable"};
 if((env.OUTBOUND_PROVIDER||'gmail')==='gmail') return runGmail(env,renderTemplate,suppress,prepareDailyProspects);
 const provider=(env.OUTBOUND_PROVIDER||'gmail')==='gmail'?gmailConfiguration(env):outboundProviderStatus(env);
 if(!provider.configured) return {ok:false,reason:"provider_not_configured",blockers:provider.blockers};

 const {results:prospects=[]}=await env.LEADS_DB.prepare(
  "SELECT id,email_normalized,last_reply_at,provider_lead_id,provider_status FROM outbound_prospects_v2 WHERE provider='instantly' AND provider_campaign_id=? AND stage NOT IN ('do_not_contact','converted') ORDER BY id LIMIT 100"
 ).bind(String(env.INSTANTLY_CAMPAIGN_ID||"")).all();

 if(!prospects.length) return {ok:true,checked:0,replies:0};
 const byEmail=new Map(prospects.map(p=>[p.email_normalized,p]));
 const data=await listInstantlyLeads(env,prospects.map(p=>p.email_normalized));
 const items=Array.isArray(data?.items)?data.items:[];
 let replies=0,updated=0;

 for(const lead of items){
  const email=normalizeEmail(lead?.email);
  const p=byEmail.get(email);
  if(!p) continue;
  const at=now();
  const verification=lead?.verification_status==null?null:String(lead.verification_status);
  const lastReply=lead?.timestamp_last_reply?String(lead.timestamp_last_reply):null;
  const replyCount=Number(lead?.email_reply_count||0);
  const lastContact=lead?.timestamp_last_contact?String(lead.timestamp_last_contact):null;

  await env.LEADS_DB.prepare(
   "UPDATE outbound_prospects_v2 SET provider_lead_id=COALESCE(provider_lead_id,?),verification_status=COALESCE(?,verification_status),provider_status=?,updated_at=? WHERE id=?"
  ).bind(String(lead?.id||"")||null,verification,lastContact?"contacted":"synced",at,p.id).run();
  updated++;

  if(replyCount>0 && lastReply && (!p.last_reply_at || Date.parse(lastReply)>Date.parse(p.last_reply_at))){
   await stopForReply(env,p.id,lastReply);
   await env.LEADS_DB.prepare(
    "INSERT INTO outbound_events_v2(prospect_id,external_event_id,event_type,detail,created_at) VALUES(?,?,?,?,?)"
   ).bind(p.id,"instantly-reply:"+p.id+":"+lastReply,"reply",JSON.stringify({provider:"instantly",source:"hourly_poll",reply_count:replyCount}),lastReply).run();
   replies++;
  }
 }
 return {ok:true,checked:prospects.length,matched:items.length,updated,replies};
}

export async function outboundApi(request,env,url) {
 if(url.pathname==='/api/admin/outbound/unsubscribe') return unsubscribe(request,env,url,suppress);
 if(url.pathname==='/api/admin/outbound/provider-webhook') {
  if(request.method!=="POST") return json({error:"Method not allowed"},405);
  if(!webhookAuthorized(request,env)) return json({error:"Webhook authorization required"},401);
  const event=normalizeInstantlyWebhook(await request.json());
  if(!event.email || !event.external_event_id) return json({error:"Webhook event cannot be correlated"},400);
  const p=await env.LEADS_DB.prepare("SELECT * FROM outbound_prospects_v2 WHERE email_normalized=?").bind(event.email).first();
  if(!p) return json({ok:true,ignored:true});
  const exists=await env.LEADS_DB.prepare("SELECT 1 FROM outbound_events_v2 WHERE external_event_id=?").bind(event.external_event_id).first();
  if(exists) return json({ok:true,duplicate:true});
  const at=now();
  if(event.event_type==="reply") await stopForReply(env,p.id,at);
  if(["hard_bounce","unsubscribe"].includes(event.event_type)) await suppress(env,p.email_normalized,event.event_type,"instantly_webhook");
  if(event.event_type==="sent") {
   const localStep=event.step==null?null:Math.max(0,Number(event.step)-1);
   await env.LEADS_DB.prepare("UPDATE outbound_prospects_v2 SET provider_status='sent',updated_at=? WHERE id=?").bind(at,p.id).run();
   if(localStep!=null) {
    await env.LEADS_DB.prepare("UPDATE outbound_messages_v2 SET status='sent',sent_at=COALESCE(sent_at,?),provider_message_id=COALESCE(provider_message_id,?) WHERE enrollment_id IN (SELECT id FROM outbound_enrollments_v2 WHERE prospect_id=?) AND step=?")
     .bind(at,event.provider_message_id,p.id,localStep).run();
    if(localStep===0) {
     const d=phoenixDate(new Date(at));
     await env.LEADS_DB.prepare("UPDATE outbound_daily_limits SET sent=sent+1 WHERE phoenix_date=?").bind(d).run();
    }
   }
  }
  await env.LEADS_DB.prepare("INSERT INTO outbound_events_v2(prospect_id,external_event_id,event_type,detail,created_at) VALUES(?,?,?,?,?)")
   .bind(p.id,event.external_event_id,event.event_type,JSON.stringify({provider:"instantly",provider_event_type:event.provider_event_type,provider_message_id:event.provider_message_id,step:event.step}),at).run();
  return json({ok:true});
 }
 if(!await authorized(request,env)) return json({error:'Outbound authorization required'},401);
 if(!env.LEADS_DB) return json({error:'Database unavailable'},503);
 try {
  const parts=url.pathname.split('/').filter(Boolean);
  const resource=parts[3], id=Number(parts[4]), action=parts[5];
  if(resource==='gmail-check' && request.method==='GET') return json(await checkGmail(env));
  if(resource==='gmail-test-send' && request.method==='POST') {
   try{return json(await sendGmailTest(env));}catch(e){
    const safe=new Set(['Keep campaign paused; another operation may be running','Acceptance test sending is closed after launch approval','Test recipient is suppressed','Test already prepared. Check results; do not resend','Daily cap reached; no test sent','Test send outcome uncertain. Do not resend; inspect Gmail Sent']);
    return json({error:safe.has(e.message)?e.message:'Test blocked. Recheck Workspace authorization and configuration.'},400);
   }
  }
  if(resource==='gmail-test-results' && request.method==='POST') return json(await gmailTestStatus(env,suppress));
  if(resource==='status' && request.method==='GET') {
   const settings=await env.LEADS_DB.prepare('SELECT * FROM outbound_settings WHERE id=1').first();
   const provider=(env.OUTBOUND_PROVIDER||'gmail')==='gmail'?gmailConfiguration(env):outboundProviderStatus(env);
   const blockers=[...provider.blockers,
    ...(String(env.OUTBOUND_UNSUBSCRIBE_SECRET||'').length<32?['Opt-out signing secret missing or too short']:[]),
    ...(!env.OUTBOUND_MAILING_ADDRESS?['Mailing address missing']:[]),
    ...(env.OUTBOUND_MAILBOX_APPROVED!=='true'?['Mailbox approval pending']:[]),
    ...((env.OUTBOUND_PROVIDER||'gmail')!=='gmail'?['Campaign sending configuration has not been verified']:[])];
   return json({settings,provider,mailbox_approved:env.OUTBOUND_MAILBOX_APPROVED==='true',sending_identity:'outreach@azhomeinstalls.com',live_sending:blockers.length===0&&!settings.paused,mode:blockers.length===0?'ready':'preparation',blockers});
  }
  if(resource==='prospects' && !parts[4]) {
   if(request.method==='GET') {
    const {results=[]}=await env.LEADS_DB.prepare(`SELECT p.*,w.launch_day,w.send_order FROM outbound_prospects_v2 p LEFT JOIN outbound_wave_plan w ON w.prospect_id=p.id ORDER BY p.wave_number ASC, CASE WHEN w.launch_day IS NULL THEN 999 ELSE w.launch_day END ASC, CASE WHEN w.send_order IS NULL THEN 999 ELSE w.send_order END ASC, p.priority ASC, p.id DESC LIMIT 500`).all();
    return json({prospects:results});
   }
   if(request.method==='POST') {
    const p=validateProspect(await request.json()), at=now();
    if(await env.LEADS_DB.prepare('SELECT 1 FROM email_suppressions WHERE email_normalized=?').bind(p.email_normalized).first()) return json({error:'Contact is permanently suppressed'},409);
    if(await env.LEADS_DB.prepare('SELECT 1 FROM outbound_prospects_v2 WHERE email_normalized=?').bind(p.email_normalized).first()) return json({error:'Contact already exists'},409);
    const r=await env.LEADS_DB.prepare("INSERT INTO outbound_prospects_v2(organization,domain,contact_name,role,email,email_normalized,segment,city,source_url,source_observed_at,fit_reason,personalization_hook,wave_number,priority,vendor_friendly,solicitation_checked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(p.organization,p.domain,p.contact_name,p.role,p.email,p.email_normalized,p.segment,p.city,p.source_url,at,p.fit_reason,p.personalization_hook,p.wave_number,p.priority,p.vendor_friendly,p.solicitation_checked_at,at,at).run();
    const prospectId=r.meta.last_row_id;
    await env.LEADS_DB.prepare('INSERT INTO outbound_sources_v2(prospect_id,source_url,observed_at,evidence) VALUES(?,?,?,?)').bind(prospectId,p.source_url,at,p.fit_reason).run();
    await audit(env,prospectId,'prospect_created');
    return json({ok:true,id:prospectId},201);
   }
  }
  if(resource==='prospects' && Number.isInteger(id) && id>0 && request.method==='POST') {
   const p=await env.LEADS_DB.prepare('SELECT * FROM outbound_prospects_v2 WHERE id=?').bind(id).first();
   if(!p) return json({error:'Prospect not found'},404);
   const body=await request.json();
   if(action==='suppress') {
    await suppress(env,p.email_normalized,'manual_optout','admin');
    await audit(env,id,'suppressed'); return json({ok:true});
   }
   if(action==='reply') {
    await stopForReply(env,id);
    await audit(env,id,'reply_recorded',{manual:true}); return json({ok:true});
   }
   if(action==='link-lead') return await linkLead(env,p,body);
   if(action==='qualify') {
    if(p.stage!=='replied') return json({error:'Record a reply before qualification'},409);
    await env.LEADS_DB.prepare("UPDATE outbound_prospects_v2 SET stage='qualified',updated_at=? WHERE id=? AND stage='replied'").bind(now(),id).run();
    await audit(env,id,'qualified');return json({ok:true});
   }
   if(action==='recheck') {
    const result=await solicitationPreflight(env,p);
    if(result.status==='blocked') await suppress(env,p.email_normalized,'no_solicitation','public_source');
    await audit(env,id,'solicitation_rechecked',result);
    return json({ok:true,...result});
   }
   if(action==='approve') {
    const reviewer=String(body.reviewed_by||'').trim();
    if(!reviewer || reviewer.length>200) return json({error:'Reviewer name required'},400);
    if(p.stage!=='prospect' || await env.LEADS_DB.prepare('SELECT 1 FROM email_suppressions WHERE email_normalized=?').bind(p.email_normalized).first()) return json({error:'Prospect cannot be enrolled'},409);
    if(p.solicitation_status==='blocked') return json({error:'Public source prohibits solicitation'},409);
    const at=now();
    await env.LEADS_DB.batch([
     env.LEADS_DB.prepare("UPDATE outbound_prospects_v2 SET approved_at=?,reviewed_by=?,stage='queued',updated_at=? WHERE id=? AND stage='prospect'").bind(at,reviewer,at,id),
     env.LEADS_DB.prepare("INSERT OR IGNORE INTO outbound_enrollments_v2(prospect_id,created_at) VALUES(?,?)").bind(id,at),
     ...OFFSETS.map((offset,step)=>env.LEADS_DB.prepare("INSERT OR IGNORE INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key) SELECT id,?,?,? FROM outbound_enrollments_v2 WHERE prospect_id=?").bind(step,offset,'wave-v1:'+id+':'+step,id))
    ]);
    await audit(env,id,'approved',{reviewer}); return json({ok:true});
   }
  }
  if(resource==='events' && request.method==='POST') return await recordEvent(env,await request.json(),suppress);
  if (resource === "settings" && request.method === "POST") {
      const body = await request.json(), cap = Number(body.daily_cap);
      if (!Number.isInteger(cap) || cap < 1 || cap > 20) return json({ error: "Daily cap must be 1–20" }, 400);
      const requestedPaused = body.paused === false ? 0 : 1;
      if(requestedPaused===0){
        const checked=await checkGmail(env);
        if(!checked.authorized) return json({error:"Gmail authorization verification failed",blockers:checked.blockers},409);
        const provider=(env.OUTBOUND_PROVIDER||'gmail')==='gmail'?gmailConfiguration(env):outboundProviderStatus(env);
        const blockers=[
          ...provider.blockers,
          ...((env.OUTBOUND_PROVIDER||'gmail')!=='gmail'?["Campaign sending configuration has not been verified"]:[]),
          ...(!env.OUTBOUND_UNSUBSCRIBE_SECRET?["Opt-out signing secret missing"]:[]),
          ...(!env.OUTBOUND_MAILING_ADDRESS?["Mailing address missing"]:[]),
          ...(env.OUTBOUND_MAILBOX_APPROVED!=="true"?["Mailbox approval pending"]:[])
        ];
        if(blockers.length) return json({error:"OAS cannot be activated until all readiness gates pass",blockers},409);
      }
      await env.LEADS_DB.prepare("UPDATE outbound_settings SET daily_cap=?,paused=? WHERE id=1").bind(cap,requestedPaused).run();
      await audit(env, null, "settings_changed", { daily_cap: cap, paused:Boolean(requestedPaused) });
      return json({ ok:true, paused:Boolean(requestedPaused) });
    }
  if(resource==='queue' && request.method==='GET') {
   const {results=[]}=await env.LEADS_DB.prepare('SELECT m.id,m.step,m.day_offset,m.status,m.due_at,m.sent_at,m.delivered_at,p.organization,p.stage,e.stop_reason FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id JOIN outbound_prospects_v2 p ON p.id=e.prospect_id ORDER BY m.id DESC LIMIT 500').all();
   return json({messages:results,phoenix_date:phoenixDate(),live_sending:false});
  }
  if(resource==='preview' && request.method==='GET') return json({mode:'dry_run',messages:await preview(env)});
  if(resource==='metrics' && request.method==='GET') {
   const {results=[]}=await env.LEADS_DB.prepare('SELECT wave_number,segment,stage,count(*) AS count FROM outbound_prospects_v2 GROUP BY wave_number,segment,stage ORDER BY wave_number,segment,stage').all();
   const messages=await env.LEADS_DB.prepare("SELECT count(*) AS queued FROM outbound_messages_v2 WHERE status='queued'").first();
   const suppressed=await env.LEADS_DB.prepare('SELECT count(*) AS count FROM email_suppressions').first();
   const funnel=await env.LEADS_DB.prepare("SELECT (SELECT count(*) FROM outbound_messages_v2 WHERE sent_at IS NOT NULL) AS sent,(SELECT count(*) FROM outbound_messages_v2 WHERE delivered_at IS NOT NULL) AS delivered,(SELECT count(DISTINCT prospect_id) FROM outbound_events_v2 WHERE event_type IN ('reply_recorded','reply')) AS replied,(SELECT count(DISTINCT lead_id) FROM outbound_lead_links_v2) AS estimate_requested,(SELECT count(DISTINCT l.id) FROM outbound_lead_links_v2 x JOIN leads l ON l.id=x.lead_id WHERE l.status IN ('accepted','scheduled','completed')) AS estimate_accepted,(SELECT count(DISTINCT l.id) FROM outbound_lead_links_v2 x JOIN leads l ON l.id=x.lead_id WHERE l.status='completed') AS install_completed").first();
   return json({prospects:results,messages,suppressed:suppressed.count,funnel,live_sending:false});
  }
  return json({error:'Route not found'},404);
 } catch(error) {
  console.error('Outbound API failed',{message:error.message});
  if(/no such table/.test(error.message)) return json({error:'Outbound migration has not been applied'},503);
  return json({error:request.method==='POST'?'Request failed validation or could not be saved':'Outbound request failed'},400);
 }
}

