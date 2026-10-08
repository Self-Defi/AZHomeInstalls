// AHI-owned Gmail transport. Separate refresh token; never borrow Calendar authorization.
import { phoenixDate, followupDue, unsubscribeUrl, stopForReply } from './outbound-controls.js';
const API='https://gmail.googleapis.com/gmail/v1/users/me';
const SEND='https://www.googleapis.com/auth/gmail.send';
const READ='https://www.googleapis.com/auth/gmail.readonly';
const SETTINGS='https://www.googleapis.com/auth/gmail.settings.basic';
const at=()=>new Date().toISOString();
export function gmailConfiguration(env) {
 const blockers=[];
 for(const name of ['OUTBOUND_GOOGLE_CLIENT_ID','OUTBOUND_GOOGLE_CLIENT_SECRET','OUTBOUND_GOOGLE_REFRESH_TOKEN']) if(!env[name]) blockers.push(name+' missing');
 if(String(env.OUTBOUND_UNSUBSCRIBE_SECRET||'').length<32) blockers.push('Opt-out signing secret missing or too short');
 if(!env.OUTBOUND_MAILING_ADDRESS) blockers.push('Mailing address missing');
 if(env.OUTBOUND_MAILBOX_APPROVED!=='true') blockers.push('Mailbox approval pending');
 if(env.OUTBOUND_GMAIL_TESTED!=='true') blockers.push('Gmail send/reply/opt-out acceptance tests pending');
 return {provider:'gmail',configured:blockers.length===0,blockers};
}
async function session(env) {
 if(!env.OUTBOUND_GOOGLE_CLIENT_ID||!env.OUTBOUND_GOOGLE_CLIENT_SECRET||!env.OUTBOUND_GOOGLE_REFRESH_TOKEN) throw Error('Separate outbound Google OAuth credentials required');
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.OUTBOUND_GOOGLE_CLIENT_ID,client_secret:env.OUTBOUND_GOOGLE_CLIENT_SECRET,refresh_token:env.OUTBOUND_GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'}),signal:AbortSignal.timeout(15000)});
 const data=await response.json();
 if(!response.ok||!data.access_token) {
  // Never expose Google's free-form response: it may echo credential material.
  const safeErrors=new Set(['invalid_client','invalid_grant','invalid_request','unauthorized_client','unsupported_grant_type','invalid_scope','deleted_client','org_internal','access_denied']);
  const code=safeErrors.has(data.error)?'; '+data.error:'';
  throw Error('Outbound Google authorization failed (HTTP '+response.status+code+')');
 }
 const scopes=new Set(String(data.scope||'').split(' '));
 if(![SEND,READ,SETTINGS].every(s=>scopes.has(s))) throw Error('Outbound token must grant gmail.send, gmail.readonly and gmail.settings.basic');
 return data.access_token;
}
async function request(token,path,options={}) {
 const r=await fetch(API+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(15000)});
 const data=await r.json();
 if(!r.ok) throw Error('Gmail API HTTP '+r.status);
 return data;
}
async function identity(token) {
 const profile=await request(token,'/profile');
 if(profile.emailAddress?.toLowerCase()!=='johnj@azhomeinstalls.com') throw Error('Outbound OAuth must belong to johnj@azhomeinstalls.com');
 const aliases=await request(token,'/settings/sendAs');
 if(!aliases.sendAs?.some(a=>a.sendAsEmail?.toLowerCase()==='outreach@azhomeinstalls.com'&&a.verificationStatus==='accepted')) throw Error('outreach@azhomeinstalls.com must be an accepted Gmail Send As identity');
 return profile;
}
export async function checkGmail(env) {
 const configuration=gmailConfiguration(env);
 try {
  const token=await session(env);const profile=await identity(token);
  await request(token,'/messages?maxResults=1');
  return {...configuration,authorized:true,mailbox:profile.emailAddress,sender:'outreach@azhomeinstalls.com'};
 }catch(e){return {...configuration,authorized:false,blockers:[...configuration.blockers,e.message]};}
}
function base64(value){return btoa(String.fromCharCode(...new TextEncoder().encode(value)));}
export function buildMime({to,subject,text,messageId,optout,replyToId}) {
 for(const value of [to,subject,messageId,optout,replyToId||'']) if(/[\r\n]/.test(value)) throw Error('Invalid mail header');
 if(!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to)) throw Error('Invalid recipient');
 const headers=['From: AZHomeInstalls <outreach@azhomeinstalls.com>','Reply-To: outreach@azhomeinstalls.com','To: '+to,'Subject: =?UTF-8?B?'+base64(subject)+'?=','Date: '+new Date().toUTCString(),'Message-ID: <'+messageId+'>','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','List-Unsubscribe: <'+optout+'>','List-Unsubscribe-Post: List-Unsubscribe=One-Click'];
 if(replyToId) headers.push('In-Reply-To: <'+replyToId+'>','References: <'+replyToId+'>');
 const body=base64(text).match(/.{1,76}/g)?.join('\r\n')||'';
 return base64(headers.join('\r\n')+'\r\n\r\n'+body).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
const header=(m,name)=>m.payload?.headers?.find(h=>h.name.toLowerCase()===name.toLowerCase())?.value||'';
export function incomingAfterSend(message,sentAt) {
 return !message.labelIds?.includes('SENT') && Number(message.internalDate)>=Date.parse(sentAt);
}
export async function syncGmail(env,suppress,tokenOverride) {
 const token=tokenOverride||await session(env);await identity(token);
 // Delivery failures may arrive outside the original thread. Never continue
 // sending when a recent failure cannot be correlated safely to a contact.
 const first=await env.LEADS_DB.prepare('SELECT MIN(sent_at) AS sent_at FROM outbound_messages_v2 WHERE sent_at IS NOT NULL').first();
 if(first?.sent_at){
  const q='{from:mailer-daemon from:postmaster} after:'+Math.floor(Date.parse(first.sent_at)/1000);
  const failures=await request(token,'/messages?includeSpamTrash=true&maxResults=100&q='+encodeURIComponent(q));
  const hold=async(message=null)=>{
   await env.LEADS_DB.batch([
    env.LEADS_DB.prepare('UPDATE outbound_settings SET paused=1 WHERE id=1'),
    env.LEADS_DB.prepare('INSERT OR IGNORE INTO outbound_events_v2(external_event_id,event_type,detail,created_at) VALUES(?,?,?,?)').bind('gmail-pause:'+(message?.id||'delivery-scan-capacity'),'campaign_paused',JSON.stringify({provider:'gmail',reason:message?'unmatched_delivery_failure':'delivery_scan_capacity',gmail_message_id:message?.id||null,gmail_thread_id:message?.threadId||null}),at())
   ]);
   throw Error('Delivery failure needs review; outreach paused');
  };
  if(failures.nextPageToken)await hold();
  for(const item of failures.messages||[]){
   const external='gmail:'+item.id;
   if(await env.LEADS_DB.prepare('SELECT 1 FROM outbound_events_v2 WHERE external_event_id=?').bind(external).first())continue;
   const message=await request(token,'/messages/'+encodeURIComponent(item.id)+'?format=metadata');
   if(!incomingAfterSend(message,first.sent_at))continue;
   if(!/mailer-daemon|postmaster/i.test(header(message,'From'))&&!/delivery-status/i.test(header(message,'Content-Type')))continue;
   const row=await env.LEADS_DB.prepare('SELECT m.id,p.id AS prospect_id,p.email_normalized FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id JOIN outbound_prospects_v2 p ON p.id=e.prospect_id WHERE m.gmail_thread_id=? AND m.sent_at IS NOT NULL ORDER BY m.id DESC LIMIT 1').bind(message.threadId||'').first();
   if(!row)await hold(message);
   await suppress(env,row.email_normalized,'bounce','gmail_thread');
   await env.LEADS_DB.prepare('INSERT OR IGNORE INTO outbound_events_v2(prospect_id,message_id,external_event_id,event_type,detail,created_at) VALUES(?,?,?,?,?,?)').bind(row.prospect_id,row.id,external,'hard_bounce',JSON.stringify({provider:'gmail',delivery_scan:true}),at()).run();
  }
 }
 const {results:rows=[]}=await env.LEADS_DB.prepare("SELECT m.id,m.gmail_thread_id,m.sent_at,p.id AS prospect_id,p.email_normalized FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id JOIN outbound_prospects_v2 p ON p.id=e.prospect_id WHERE m.gmail_thread_id IS NOT NULL AND p.last_reply_at IS NULL AND p.stage NOT IN ('do_not_contact','converted') ORDER BY m.id LIMIT 501").all();
 if(rows.length>500) throw Error('Reply scan capacity exceeded; sending blocked');
 let replies=0;
 const seen=new Set();
 for(const row of rows){
  if(seen.has(row.gmail_thread_id))continue;seen.add(row.gmail_thread_id);
  const thread=await request(token,'/threads/'+encodeURIComponent(row.gmail_thread_id)+'?format=metadata&metadataHeaders=From&metadataHeaders=Auto-Submitted&metadataHeaders=Content-Type');
  for(const message of thread.messages||[]){
   if(!incomingAfterSend(message,row.sent_at))continue;
   const external='gmail:'+message.id;
   if(await env.LEADS_DB.prepare('SELECT 1 FROM outbound_events_v2 WHERE external_event_id=?').bind(external).first())continue;
   const bounce=/mailer-daemon|postmaster/i.test(header(message,'From'))||/delivery-status/i.test(header(message,'Content-Type'));
   if(bounce)await suppress(env,row.email_normalized,'bounce','gmail_thread');
   else await stopForReply(env,row.prospect_id);
   await env.LEADS_DB.prepare('INSERT OR IGNORE INTO outbound_events_v2(prospect_id,message_id,external_event_id,event_type,detail,created_at) VALUES(?,?,?,?,?,?)').bind(row.prospect_id,row.id,external,bounce?'hard_bounce':'reply',JSON.stringify({provider:'gmail',auto_reply:!!header(message,'Auto-Submitted')}),at()).run();
   replies++;
  }
 }
 const contacts=new Map();
 for(const row of rows){if(!contacts.has(row.email_normalized))contacts.set(row.email_normalized,row);}
 for(const [email,row] of contacts){
  const q='from:'+email+' after:'+Math.floor(Date.parse(row.sent_at)/1000);
  const list=await request(token,'/messages?maxResults=100&q='+encodeURIComponent(q));
  if(list.nextPageToken)throw Error('Contact reply scan exceeds capacity; sending blocked');
  for(const item of list.messages||[]){
   const external='gmail:'+item.id;
   if(await env.LEADS_DB.prepare('SELECT 1 FROM outbound_events_v2 WHERE external_event_id=?').bind(external).first())continue;
   const message=await request(token,'/messages/'+encodeURIComponent(item.id)+'?format=metadata');
   if(!incomingAfterSend(message,row.sent_at))continue;
   await stopForReply(env,row.prospect_id);
   await env.LEADS_DB.prepare('INSERT OR IGNORE INTO outbound_events_v2(prospect_id,message_id,external_event_id,event_type,detail,created_at) VALUES(?,?,?,?,?,?)').bind(row.prospect_id,row.id,external,'reply',JSON.stringify({provider:'gmail',new_thread:true}),at()).run();
   replies++;
  }
 }
 return {ok:true,checked:seen.size,replies};
}
export function effectiveDailyCap(settings,env,day) {
 // A single dated launch allowance counts the setup test without raising future caps.
 const extra=env.OUTBOUND_LAUNCH_DATE===day && env.OUTBOUND_LAUNCH_EXTRA==='1' ? 1 : 0;
 return Number(settings.daily_cap)+extra;
}
export async function runGmail(env,renderTemplate,suppress,prepareDaily) {
 // A crashed send is uncertain. Never automatically re-send a claimed message.
 if(!gmailConfiguration(env).configured)return {ok:false,reason:'configuration_pending'};
 const db=env.LEADS_DB;const lease=crypto.randomUUID(),now=at();
 const locked=await db.prepare('UPDATE outbound_settings SET gmail_lease=?,gmail_lease_until=? WHERE id=1 AND (gmail_lease_until IS NULL OR gmail_lease_until<?)').bind(lease,new Date(Date.now()+10*60000).toISOString(),now).run();
 if(locked.meta.changes!==1)return {ok:false,reason:'busy'};
 try {
  const token=await session(env);await syncGmail(env,suppress,token);
  await db.prepare('UPDATE outbound_settings SET gmail_last_sync_at=? WHERE id=1').bind(at()).run();
  const settings=await db.prepare('SELECT * FROM outbound_settings WHERE id=1').first();
  if(settings.paused)return {ok:true,reason:'paused'};
  const local=new Date(Date.now()-7*3600000);
  if([0,6].includes(local.getUTCDay())||local.getUTCHours()<9||local.getUTCHours()>=17)return {ok:true,reason:'outside_business_hours'};
  if(prepareDaily) await prepareDaily(env);
  const newLimit=Math.max(1,Math.min(20,Number(env.OUTBOUND_NEW_DAILY_CAP||20)));
  const row=await db.prepare("SELECT m.*,p.id AS prospect_id,p.organization,p.contact_name,p.segment,p.personalization_hook,p.fit_reason,p.email_normalized,p.approved_at,p.last_reply_at,p.solicitation_status FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id JOIN outbound_prospects_v2 p ON p.id=e.prospect_id LEFT JOIN email_suppressions s ON s.email_normalized=p.email_normalized WHERE m.status='queued' AND e.status IN ('queued','active') AND p.approved_at IS NOT NULL AND p.last_reply_at IS NULL AND p.stage NOT IN ('do_not_contact','converted','qualified','replied') AND p.solicitation_status='clear' AND s.email_normalized IS NULL AND (m.step<>0 OR (SELECT COUNT(*) FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NOT NULL AND date(sent_at,'-7 hours')=?)<?) AND (m.step=0 OR m.due_at IS NOT NULL AND m.due_at<=?) ORDER BY CASE WHEN m.step=0 THEN 0 ELSE 1 END,m.step DESC,m.id LIMIT 1").bind(phoenixDate(),newLimit,at()).first();
  if(!row)return {ok:true,reason:'no_approved_due_messages'};
  const day=phoenixDate(),cap=effectiveDailyCap(settings,env,day);
  await db.prepare('INSERT OR IGNORE INTO outbound_daily_limits(phoenix_date,cap) VALUES(?,?)').bind(day,cap).run();
  const quota=await db.prepare('UPDATE outbound_daily_limits SET reserved=reserved+1,cap=? WHERE phoenix_date=? AND sent+reserved<?').bind(cap,day,cap).run();
  if(quota.meta.changes!==1)return {ok:true,reason:'daily_cap'};
  const optout=await unsubscribeUrl(env,{id:row.prospect_id,email_normalized:row.email_normalized});
  const content=renderTemplate(row,row.step,{address:env.OUTBOUND_MAILING_ADDRESS,optout:'Unsubscribe: '+optout});
  const messageId='ahi-outbound-'+row.id+'@azhomeinstalls.com';
  const first=await db.prepare('SELECT gmail_thread_id,rfc_message_id,subject FROM outbound_messages_v2 WHERE enrollment_id=? AND step=0').bind(row.enrollment_id).first();
  if(row.step && first?.subject) content.subject=first.subject;
  const raw=buildMime({to:row.email_normalized,...content,messageId,optout,replyToId:row.step?first?.rfc_message_id:undefined});
  const claim=await db.prepare("UPDATE outbound_messages_v2 SET status='claimed',attempts=attempts+1,claimed_until=?,subject=?,body_text=?,rfc_message_id=? WHERE id=? AND status='queued' AND EXISTS(SELECT 1 FROM outbound_settings WHERE id=1 AND paused=0 AND gmail_lease=?) AND NOT EXISTS(SELECT 1 FROM email_suppressions WHERE email_normalized=?) AND NOT EXISTS(SELECT 1 FROM outbound_prospects_v2 WHERE id=? AND last_reply_at IS NOT NULL)").bind(new Date(Date.now()+600000).toISOString(),content.subject,content.text,messageId,row.id,lease,row.email_normalized,row.prospect_id).run();
  if(claim.meta.changes!==1){await db.prepare('UPDATE outbound_daily_limits SET reserved=reserved-1 WHERE phoenix_date=?').bind(day).run();return {ok:false,reason:'claim_cancelled'};}
  try {
   const sent=await request(token,'/messages/send',{method:'POST',body:JSON.stringify({raw,...(row.step&&first?.gmail_thread_id?{threadId:first.gmail_thread_id}:{})})});
   if(!sent.id||!sent.threadId)throw Error('Send result lacks Gmail correlation');
   const sentAt=at();
   await db.batch([
    db.prepare("UPDATE outbound_messages_v2 SET status='sent',sent_at=?,provider_message_id=?,gmail_thread_id=? WHERE id=?").bind(sentAt,sent.id,sent.threadId,row.id),
    db.prepare('UPDATE outbound_daily_limits SET reserved=reserved-1,sent=sent+1 WHERE phoenix_date=?').bind(day),
    db.prepare("UPDATE outbound_prospects_v2 SET stage=?,provider='gmail',updated_at=? WHERE id=? AND stage NOT IN ('do_not_contact','replied','converted','qualified')").bind(row.step?'follow_up':'sent',sentAt,row.prospect_id),
    db.prepare("UPDATE outbound_enrollments_v2 SET status=CASE WHEN status='stopped' THEN status ELSE 'active' END,started_at=COALESCE(started_at,?) WHERE id=?").bind(sentAt,row.enrollment_id),
    db.prepare('INSERT INTO outbound_events_v2(prospect_id,message_id,event_type,detail,created_at) VALUES(?,?,?,?,?)').bind(row.prospect_id,row.id,'sent',JSON.stringify({provider:'gmail'}),sentAt),
    ...(row.step===0?[7,17].map((offset,i)=>db.prepare("UPDATE outbound_messages_v2 SET due_at=? WHERE enrollment_id=? AND step=? AND status='queued'").bind(followupDue(sentAt,offset),row.enrollment_id,i+1)):[])
   ]);
   return {ok:true,sent:1,message_id:row.id};
  }catch(e){
   await db.prepare('UPDATE outbound_messages_v2 SET last_error=? WHERE id=?').bind('Send outcome uncertain; reconcile Gmail Sent before any retry',row.id).run();
   await db.prepare('UPDATE outbound_settings SET paused=1 WHERE id=1').run();
   throw Error('Gmail send outcome uncertain; outreach paused for reconciliation');
  }
 } finally {await db.prepare('UPDATE outbound_settings SET gmail_lease=NULL,gmail_lease_until=NULL WHERE id=1 AND gmail_lease=?').bind(lease).run();}
}

// One controlled acceptance message, fixed to the owner's selected external inbox.
// It never opens campaign sending or marks acceptance complete.
const TEST_RECIPIENT='discoveruroptions@gmail.com';
const TEST_CAMPAIGN='gmail-acceptance-v1';
export async function gmailTestStatus(env,suppress) {
 const db=env.LEADS_DB;
 const p=await db.prepare('SELECT p.* FROM outbound_prospects_v2 p JOIN outbound_enrollments_v2 e ON e.prospect_id=p.id WHERE e.campaign_version=? AND p.email_normalized=?').bind(TEST_CAMPAIGN,TEST_RECIPIENT).first();
 if(!p)return {recipient:TEST_RECIPIENT,sent:false,reply_detected:false,unsubscribed:false};
 await syncGmail(env,suppress);
 const current=await db.prepare('SELECT * FROM outbound_prospects_v2 WHERE id=?').bind(p.id).first();
 const m=await db.prepare('SELECT m.* FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id WHERE e.prospect_id=? AND m.step=0').bind(p.id).first();
 const pending=await db.prepare("SELECT count(*) AS n FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id WHERE e.prospect_id=? AND m.step>0 AND m.status='queued'").bind(p.id).first();
 const suppression=await db.prepare('SELECT reason FROM email_suppressions WHERE email_normalized=?').bind(TEST_RECIPIENT).first();
 return {recipient:TEST_RECIPIENT,sent:m?.status==='sent',send_status:m?.status||'not_sent',reply_detected:!!current.last_reply_at,followups_cancelled:pending.n===0,unsubscribed:suppression?.reason==='unsubscribe',next:'Reply from the recipient inbox first, check results, then open the email unsubscribe link and confirm. Inbox placement and authentication headers require recipient inspection.'};
}
export async function sendGmailTest(env) {
 const db=env.LEADS_DB, lease=crypto.randomUUID(), started=at();
 const locked=await db.prepare('UPDATE outbound_settings SET gmail_lease=?,gmail_lease_until=? WHERE id=1 AND paused=1 AND (gmail_lease_until IS NULL OR gmail_lease_until<?)').bind(lease,new Date(Date.now()+600000).toISOString(),started).run();
 if(locked.meta.changes!==1)throw Error('Keep campaign paused; another operation may be running');
 try {
  const blockers=gmailConfiguration(env).blockers.filter(b=>b!=='Gmail send/reply/opt-out acceptance tests pending');
  if(blockers.length)throw Error(blockers.join('; '));
  if(env.OUTBOUND_GMAIL_TESTED==='true')throw Error('Acceptance test sending is closed after launch approval');
  if(await db.prepare('SELECT 1 FROM email_suppressions WHERE email_normalized=?').bind(TEST_RECIPIENT).first())throw Error('Test recipient is suppressed');
  if(await db.prepare('SELECT 1 FROM outbound_prospects_v2 WHERE email_normalized=?').bind(TEST_RECIPIENT).first())throw Error('Test already prepared. Check results; do not resend');
  const token=await session(env);await identity(token);
  const created=await db.prepare("INSERT INTO outbound_prospects_v2(organization,domain,contact_name,email,email_normalized,segment,city,source_url,source_observed_at,fit_reason,solicitation_checked_at,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind('AHI controlled acceptance test','gmail.com','Jay',TEST_RECIPIENT,TEST_RECIPIENT,'property_manager','Owner test inbox','https://azhomeinstalls.com',started,'Owner supplied recipient for controlled testing',started,'sent',started,started).run();
  const pid=created.meta.last_row_id;
  const enrolled=await db.prepare("INSERT INTO outbound_enrollments_v2(prospect_id,campaign_version,status,stop_reason,created_at) VALUES(?,?,'stopped','acceptance_test',?)").bind(pid,TEST_CAMPAIGN,started).run();
  const eid=enrolled.meta.last_row_id;
  const optout=await unsubscribeUrl(env,{id:pid,email_normalized:TEST_RECIPIENT});
  const subject='AHI outbound setup test — reply, then unsubscribe';
  const text=['This is the controlled AZHomeInstalls outbound setup test requested by Jay.','', '1. Confirm this arrived and the sender is outreach@azhomeinstalls.com.', '2. Reply with: AHI test reply.', '3. In AHI Outbound, check test results before unsubscribing.', '4. Open the link below and press Unsubscribe, then check test results again.','', 'Unsubscribe: '+optout,'',env.OUTBOUND_MAILING_ADDRESS].join('\n');
  const messageId='ahi-acceptance-'+pid+'@azhomeinstalls.com';
  const raw=buildMime({to:TEST_RECIPIENT,subject,text,messageId,optout});
  const inserted=await db.prepare("INSERT INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key,status,subject,body_text,rfc_message_id,attempts) VALUES(?,0,0,?,'claimed',?,?,?,1)").bind(eid,'acceptance:'+eid+':0',subject,text,messageId).run();
  const mid=inserted.meta.last_row_id;
  // These follow-ups can only be cancelled: enrollment is stopped and approval is absent.
  await db.batch([1,2].map((step)=>db.prepare("INSERT INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key,status) VALUES(?,?,?,?,'queued')").bind(eid,step,step===1?7:17,'acceptance:'+eid+':'+step)));
  const settings=await db.prepare('SELECT daily_cap FROM outbound_settings WHERE id=1').first();
  const day=phoenixDate();
  await db.prepare('INSERT OR IGNORE INTO outbound_daily_limits(phoenix_date,cap) VALUES(?,?)').bind(day,settings.daily_cap).run();
  const reserved=await db.prepare('UPDATE outbound_daily_limits SET reserved=reserved+1 WHERE phoenix_date=? AND sent+reserved<?').bind(day,settings.daily_cap).run();
  if(reserved.meta.changes!==1)throw Error('Daily cap reached; no test sent');
  try {
   const sent=await request(token,'/messages/send',{method:'POST',body:JSON.stringify({raw})});
   if(!sent.id||!sent.threadId)throw Error('Missing send correlation');
   const sentAt=at();
   await db.batch([
    db.prepare("UPDATE outbound_messages_v2 SET status='sent',sent_at=?,provider_message_id=?,gmail_thread_id=? WHERE id=?").bind(sentAt,sent.id,sent.threadId,mid),
    db.prepare('UPDATE outbound_daily_limits SET reserved=reserved-1,sent=sent+1 WHERE phoenix_date=?').bind(day),
    db.prepare('INSERT INTO outbound_events_v2(prospect_id,message_id,event_type,detail,created_at) VALUES(?,?,?,?,?)').bind(pid,mid,'sent',JSON.stringify({provider:'gmail',acceptance_test:true}),sentAt)
   ]);
   return {ok:true,recipient:TEST_RECIPIENT,message:'One test accepted by Gmail. Check recipient inbox; campaign remains paused.'};
  }catch(e){
   await db.prepare('UPDATE outbound_messages_v2 SET last_error=? WHERE id=?').bind('Test send outcome uncertain; inspect Gmail Sent before any retry',mid).run();
   throw Error('Test send outcome uncertain. Do not resend; inspect Gmail Sent');
  }
 }finally{await db.prepare('UPDATE outbound_settings SET gmail_lease=NULL,gmail_lease_until=NULL WHERE id=1 AND gmail_lease=?').bind(lease).run();}
}
