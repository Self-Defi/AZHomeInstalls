// Provider-neutral controls. There is deliberately no send implementation.
const enc = new TextEncoder();
const stamp = () => new Date().toISOString();
const response = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
async function key(env) {
 if(String(env.OUTBOUND_UNSUBSCRIBE_SECRET||'').length<32) throw Error('Opt-out signing unavailable');
 return crypto.subtle.importKey('raw',enc.encode(env.OUTBOUND_UNSUBSCRIBE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
const hex = bytes => [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function unsubscribeToken(env,p) {
 const signature=await crypto.subtle.sign('HMAC',await key(env),enc.encode('ahi-optout-v1:'+p.id+':'+p.email_normalized));
 return p.id+'.'+hex(signature);
}
export async function unsubscribeUrl(env,p) {
 return 'https://azhomeinstalls.com/api/admin/outbound/unsubscribe?token='+await unsubscribeToken(env,p);
}
export async function unsubscribe(request,env,url,suppress) {
 try {
  const token=url.searchParams.get('token')||'', match=/^([1-9][0-9]*)\.([a-f0-9]{64})$/.exec(token);
  if(!match) return response({error:'Invalid opt-out link'},400);
  const p=await env.LEADS_DB.prepare('SELECT * FROM outbound_prospects_v2 WHERE id=?').bind(Number(match[1])).first();
  if(!p) return response({error:'Invalid opt-out link'},400);
  const bytes=new Uint8Array(match[2].match(/../g).map(x=>parseInt(x,16)));
  if(!await crypto.subtle.verify('HMAC',await key(env),bytes,enc.encode('ahi-optout-v1:'+p.id+':'+p.email_normalized))) return response({error:'Invalid opt-out link'},400);
  // GET is a confirmation only: link scanners must not unsubscribe a contact.
  if(request.method==='GET') return new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>AHI email preferences</title><h1>Stop AZHomeInstalls marketing emails</h1><form method="post"><button type="submit">Unsubscribe</button></form>',{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'"}});
  if(request.method!=='POST') return response({error:'Method not allowed'},405);
  await suppress(env,p.email_normalized,'unsubscribe','signed_link');
  return response({ok:true,message:'You will receive no further AZHomeInstalls marketing emails.'});
 } catch { return response({error:'Opt-out service unavailable; please reply requesting removal'},503); }
}
export function phoenixDate(date=new Date()) { return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit'}).format(date); }
export function followupDue(sentAt,offset) {
 const d=new Date(sentAt); if(!Number.isFinite(d.getTime())) throw Error('Invalid send date');
 d.setUTCDate(d.getUTCDate()+offset);
 // 10am Phoenix (UTC-7), Monday–Friday; offsets are relative to actual initial send.
 d.setUTCHours(17,0,0,0);
 while(d.getUTCDay()===0||d.getUTCDay()===6) d.setUTCDate(d.getUTCDate()+1);
 return d.toISOString();
}
export async function stopForReply(env,id,at=stamp()) {
 await env.LEADS_DB.batch([
  env.LEADS_DB.prepare("UPDATE outbound_prospects_v2 SET stage=CASE WHEN stage IN ('do_not_contact','converted','qualified') THEN stage ELSE 'replied' END,last_reply_at=?,updated_at=? WHERE id=?").bind(at,at,id),
  env.LEADS_DB.prepare("UPDATE outbound_enrollments_v2 SET status='stopped',stop_reason='reply',last_reply_at=? WHERE prospect_id=?").bind(at,id),
  env.LEADS_DB.prepare("UPDATE outbound_messages_v2 SET status='cancelled' WHERE status IN ('queued','claimed') AND enrollment_id IN (SELECT id FROM outbound_enrollments_v2 WHERE prospect_id=?)").bind(id)
 ]);
}
export async function recordEvent(env,body,suppress) {
 const allowed=new Set(['reply','auto_reply','delivered','hard_bounce','complaint','unsubscribe']);
 const external=String(body.external_event_id||'').trim();
 if(!allowed.has(body.event_type)||!external||external.length>200) return response({error:'Valid event type and unique external_event_id required'},400);
 const m=await env.LEADS_DB.prepare('SELECT m.*,p.id AS prospect_id,p.email_normalized FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id JOIN outbound_prospects_v2 p ON p.id=e.prospect_id WHERE m.id=?').bind(Number(body.message_id)||0).first();
 if(!m) return response({error:'Correlated outbound message required'},404);
 // Effects are idempotent and applied before recording receipt, so a failed write can be retried.
 if(await env.LEADS_DB.prepare('SELECT 1 FROM outbound_events_v2 WHERE external_event_id=?').bind(external).first()) return response({ok:true,duplicate:true});
 if(['reply','auto_reply'].includes(body.event_type)) await stopForReply(env,m.prospect_id);
 if(['hard_bounce','complaint','unsubscribe'].includes(body.event_type)) await suppress(env,m.email_normalized,body.event_type,'event_bridge');
 if(body.event_type==='delivered') {
  if(!m.sent_at) return response({error:'Cannot mark an unsent message delivered'},409);
  await env.LEADS_DB.prepare('UPDATE outbound_messages_v2 SET delivered_at=COALESCE(delivered_at,?) WHERE id=?').bind(stamp(),m.id).run();
 }
 if(body.event_type==='complaint') await env.LEADS_DB.prepare('UPDATE outbound_settings SET paused=1 WHERE id=1').run();
 await env.LEADS_DB.prepare('INSERT OR IGNORE INTO outbound_events_v2(prospect_id,message_id,external_event_id,event_type,detail,created_at) VALUES(?,?,?,?,?,?)').bind(m.prospect_id,m.id,external,body.event_type,JSON.stringify({source:'authenticated_bridge'}),stamp()).run();
 return response({ok:true});
}
export async function linkLead(env,p,body) {
 const leadId=Number(body.lead_id);
 if(!Number.isSafeInteger(leadId)||leadId<1) return response({error:'Valid existing CRM lead ID required'},400);
 if(!await env.LEADS_DB.prepare('SELECT id FROM leads WHERE id=?').bind(leadId).first()) return response({error:'CRM lead not found'},404);
 if(p.stage==='do_not_contact') return response({error:'Contact is suppressed'},409);
 const at=stamp();
 await stopForReply(env,p.id,at);
 await env.LEADS_DB.batch([
  env.LEADS_DB.prepare("INSERT OR IGNORE INTO outbound_lead_links_v2(prospect_id,lead_id,attribution_method,created_at) VALUES(?,?,'manual_partner_referral',?)").bind(p.id,leadId,at),
  env.LEADS_DB.prepare("UPDATE outbound_prospects_v2 SET stage='converted',updated_at=? WHERE id=? AND stage!='do_not_contact'").bind(at,p.id)
 ]);
 return response({ok:true,lead_id:leadId});
}
