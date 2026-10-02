// Pilot foundation: no provider adapter and no live send path.
const SEGMENTS = new Set(['property_manager','realtor']);
export const OFFSETS = [0,3,9];
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
export function validateProspect(body) {
 const p = {};
 for(const key of ['organization','contact_name','role','email','segment','city','source_url','fit_reason'])
  p[key] = String(body[key] || '').trim();
 p.email_normalized = normalizeEmail(p.email);
 if(!validEmail(p.email_normalized)) throw Error('Valid public business email required');
 if(!SEGMENTS.has(p.segment)) throw Error('Unsupported launch segment');
 if(!publicUrl(p.source_url)) throw Error('Public HTTPS source URL required');
 for(const key of ['organization','city','fit_reason']) if(!p[key] || p[key].length>1000) throw Error('Missing or oversized '+key);
 if(p.email.length>254 || p.source_url.length>2000 || p.contact_name.length>200 || p.role.length>200) throw Error('Field too long');
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
 const greeting = p.contact_name ? 'Hi '+p.contact_name+',' : 'Hello,';
 const offer = p.segment==='property_manager'
  ? 'AZHomeInstalls provides residential installation support for residents, including TV mounting, cord concealing, shelving, and selected fixture installations.'
  : 'AZHomeInstalls helps buyers and relocating households settle in with TV mounting, cord concealing, shelving, and selected home installations.';
 const subjects = ['Residential installation support for '+p.organization,'Following up on installation support','Final check-in on installation support'];
 const bodies = [
  offer+'\n\n'+p.fit_reason+'\n\nWould residential installation support be useful for your '+(p.segment==='property_manager'?'residents':'clients')+'?',
  'Following up on my introduction. Would you like the AZHomeInstalls service and starting-price list for future residential installation requests?',
  'This is my final check-in. If installation support becomes useful, you can reply here. I will close out this outreach sequence.'
 ];
 return {subject:'ADV: '+subjects[step],text:[greeting,'',bodies[step],'','AZHomeInstalls','https://azhomeinstalls.com/services/','Advertisement — Residential installation services.','Not a Licensed Contractor.',footer.address || '[MAILING ADDRESS REQUIRED]',footer.optout || '[UNSUBSCRIBE LINK REQUIRED]'].join('\n')};
}
async function audit(env,id,type,detail={}) {
 await env.LEADS_DB.prepare('INSERT INTO outbound_events(prospect_id,event_type,detail,created_at) VALUES(?,?,?,?)').bind(id,type,JSON.stringify(detail),now()).run();
}
export async function suppress(env,email,reason,source) {
 const normalized = normalizeEmail(email), at=now();
 await env.LEADS_DB.batch([
  env.LEADS_DB.prepare('INSERT OR IGNORE INTO email_suppressions(email_normalized,reason,source,created_at) VALUES(?,?,?,?)').bind(normalized,reason,source,at),
  env.LEADS_DB.prepare("UPDATE outbound_prospects SET stage='do_not_contact',updated_at=? WHERE email_normalized=?").bind(at,normalized),
  env.LEADS_DB.prepare("UPDATE outbound_enrollments SET status='stopped',stop_reason=? WHERE prospect_id IN (SELECT id FROM outbound_prospects WHERE email_normalized=?)").bind(reason,normalized),
  env.LEADS_DB.prepare("UPDATE outbound_messages SET status='cancelled' WHERE status IN ('queued','claimed') AND enrollment_id IN (SELECT e.id FROM outbound_enrollments e JOIN outbound_prospects p ON p.id=e.prospect_id WHERE p.email_normalized=?)").bind(normalized),
  env.LEADS_DB.prepare("UPDATE leads SET unsubscribed=1,next_followup_at=NULL WHERE lower(trim(email))=?").bind(normalized)
 ]);
}
async function preview(env) {
 const {results=[]} = await env.LEADS_DB.prepare(
  "SELECT p.*,m.id AS message_id,m.step,m.due_at FROM outbound_messages m JOIN outbound_enrollments e ON e.id=m.enrollment_id JOIN outbound_prospects p ON p.id=e.prospect_id LEFT JOIN email_suppressions s ON s.email_normalized=p.email_normalized WHERE m.status='queued' AND e.status='queued' AND p.approved_at IS NOT NULL AND p.last_reply_at IS NULL AND s.email_normalized IS NULL AND m.step=0 ORDER BY m.id LIMIT 20").all();
 return results.map(p=>({prospect_id:p.id,message_id:p.message_id,...renderTemplate(p,Number(p.step),{address:env.OUTBOUND_MAILING_ADDRESS})}));
}
export async function outboundApi(request,env,url) {
 if(!await authorized(request,env)) return json({error:'Outbound authorization required'},401);
 if(!env.LEADS_DB) return json({error:'Database unavailable'},503);
 try {
  const parts=url.pathname.split('/').filter(Boolean);
  const resource=parts[3], id=Number(parts[4]), action=parts[5];
  if(resource==='status' && request.method==='GET') {
   const settings=await env.LEADS_DB.prepare('SELECT * FROM outbound_settings WHERE id=1').first();
   return json({settings,live_sending:false,mode:'dry_run',blockers:['Approved outbound transport not configured','Reply and delivery ingestion not configured','Unsubscribe transport not configured',...(!env.OUTBOUND_MAILING_ADDRESS?['Mailing address missing']:[])]});
  }
  if(resource==='prospects' && !parts[4]) {
   if(request.method==='GET') {
    const {results=[]}=await env.LEADS_DB.prepare('SELECT * FROM outbound_prospects ORDER BY id DESC LIMIT 500').all();
    return json({prospects:results});
   }
   if(request.method==='POST') {
    const p=validateProspect(await request.json()), at=now();
    if(await env.LEADS_DB.prepare('SELECT 1 FROM email_suppressions WHERE email_normalized=?').bind(p.email_normalized).first()) return json({error:'Contact is permanently suppressed'},409);
    if(await env.LEADS_DB.prepare('SELECT 1 FROM outbound_prospects WHERE email_normalized=?').bind(p.email_normalized).first()) return json({error:'Contact already exists'},409);
    const r=await env.LEADS_DB.prepare("INSERT INTO outbound_prospects(organization,domain,contact_name,role,email,email_normalized,segment,city,source_url,source_observed_at,fit_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(p.organization,p.domain,p.contact_name,p.role,p.email,p.email_normalized,p.segment,p.city,p.source_url,at,p.fit_reason,at,at).run();
    const prospectId=r.meta.last_row_id;
    await env.LEADS_DB.prepare('INSERT INTO outbound_sources(prospect_id,source_url,observed_at,evidence) VALUES(?,?,?,?)').bind(prospectId,p.source_url,at,p.fit_reason).run();
    await audit(env,prospectId,'prospect_created');
    return json({ok:true,id:prospectId},201);
   }
  }
  if(resource==='prospects' && Number.isInteger(id) && id>0 && request.method==='POST') {
   const p=await env.LEADS_DB.prepare('SELECT * FROM outbound_prospects WHERE id=?').bind(id).first();
   if(!p) return json({error:'Prospect not found'},404);
   const body=await request.json();
   if(action==='suppress') {
    await suppress(env,p.email_normalized,'manual_optout','admin');
    await audit(env,id,'suppressed'); return json({ok:true});
   }
   if(action==='reply') {
    const at=now();
    await env.LEADS_DB.batch([
     env.LEADS_DB.prepare("UPDATE outbound_prospects SET stage='replied',last_reply_at=?,updated_at=? WHERE id=? AND stage!='do_not_contact'").bind(at,at,id),
     env.LEADS_DB.prepare("UPDATE outbound_enrollments SET status='stopped',stop_reason='reply',last_reply_at=? WHERE prospect_id=?").bind(at,id),
     env.LEADS_DB.prepare("UPDATE outbound_messages SET status='cancelled' WHERE status IN ('queued','claimed') AND enrollment_id IN (SELECT id FROM outbound_enrollments WHERE prospect_id=?)").bind(id)
    ]);
    await audit(env,id,'reply_recorded',{manual:true}); return json({ok:true});
   }
   if(action==='approve') {
    const reviewer=String(body.reviewed_by||'').trim();
    if(!reviewer || reviewer.length>200) return json({error:'Reviewer name required'},400);
    if(p.stage!=='prospect' || await env.LEADS_DB.prepare('SELECT 1 FROM email_suppressions WHERE email_normalized=?').bind(p.email_normalized).first()) return json({error:'Prospect cannot be enrolled'},409);
    const at=now();
    await env.LEADS_DB.batch([
     env.LEADS_DB.prepare("UPDATE outbound_prospects SET approved_at=?,reviewed_by=?,stage='queued',updated_at=? WHERE id=? AND stage='prospect'").bind(at,reviewer,at,id),
     env.LEADS_DB.prepare("INSERT OR IGNORE INTO outbound_enrollments(prospect_id,created_at) VALUES(?,?)").bind(id,at),
     ...OFFSETS.map((offset,step)=>env.LEADS_DB.prepare("INSERT OR IGNORE INTO outbound_messages(enrollment_id,step,day_offset,idempotency_key) SELECT id,?,?,? FROM outbound_enrollments WHERE prospect_id=?").bind(step,offset,'pilot-v1:'+id+':'+step,id))
    ]);
    await audit(env,id,'approved',{reviewer}); return json({ok:true});
   }
  }
  if(resource==='preview' && request.method==='GET') return json({mode:'dry_run',messages:await preview(env)});
  if(resource==='metrics' && request.method==='GET') {
   const {results=[]}=await env.LEADS_DB.prepare('SELECT segment,stage,count(*) AS count FROM outbound_prospects GROUP BY segment,stage').all();
   const messages=await env.LEADS_DB.prepare("SELECT count(*) AS queued FROM outbound_messages WHERE status='queued'").first();
   const suppressed=await env.LEADS_DB.prepare('SELECT count(*) AS count FROM email_suppressions').first();
   return json({prospects:results,messages,suppressed:suppressed.count,live_sending:false});
  }
  return json({error:'Route not found'},404);
 } catch(error) {
  console.error('Outbound API failed',{message:error.message});
  if(/no such table/.test(error.message)) return json({error:'Outbound migration has not been applied'},503);
  return json({error:request.method==='POST'?'Request failed validation or could not be saved':'Outbound request failed'},400);
 }
}
