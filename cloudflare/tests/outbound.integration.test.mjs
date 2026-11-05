import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { outboundApi } from '../outbound.js';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_leads.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0002_outbound.sql',import.meta.url),'utf8'));
 for(const name of ['0003_outbound_wave_v2.sql','0004_outbound_wave_plan.sql','0005_outbound_provider_state.sql','0006_outbound_gmail.sql','0007_outbound_reliability.sql']) db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const wrap=(sql,values=[])=>({
  bind(...v){return wrap(sql,v)},
  async first(){return db.prepare(sql).get(...values)||null},
  async all(){return {results:db.prepare(sql).all(...values)}},
  async run(){const r=db.prepare(sql).run(...values);return {meta:{last_row_id:Number(r.lastInsertRowid),changes:Number(r.changes)}}}
 });
 const env={OUTBOUND_ADMIN_TOKEN:'test'.repeat(10),LEADS_DB:{prepare:wrap,async batch(statements){
  db.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}
 }}};
 const call=async(path,method='GET',body)=>{
  const url=new URL('https://example.com/api/admin/outbound/'+path);
  const r=await outboundApi(new Request(url,{method,headers:{Authorization:'Bearer '+env.OUTBOUND_ADMIN_TOKEN},...(body?{body:JSON.stringify(body)}:{})}),env,url);
  return {status:r.status,data:await r.json()};
 };
 return {db,call,env};
}
// Seed a completed public-evidence check for tests about sending/controls.
// Validation-specific tests below exercise the actual HTTP evidence path.
function markVerified(db,id) {
 db.prepare("UPDATE outbound_prospects_v2 SET solicitation_status='clear',validation_status='verified',validation_checked_at=?,validation_expires_at=? WHERE id=?")
  .run(new Date().toISOString(),new Date(Date.now()+7*86400000).toISOString(),id);
}
const prospect={organization:'Example Management',email:'Public@example.com',segment:'property_manager',city:'Phoenix',source_url:'https://example.com/team',fit_reason:'Your company lists Phoenix residential management.',solicitation_checked_at:'2026-10-06T15:00:00Z'};
test('review enrollment is idempotent and manual replies cancel all pending steps',async()=>{
 const {db,call}=fixture();
 const created=await call('prospects','POST',prospect);assert.equal(created.status,201);
 const id=created.data.id;
 assert.equal((await call('preview')).data.messages.length,0);
 assert.equal((await call('prospects/'+id+'/approve','POST',{})).status,400);
 assert.equal((await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'})).status,409);
 markVerified(db,id);
 assert.equal((await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'})).status,200);
 assert.equal((await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'})).status,409);
 assert.equal(db.prepare('SELECT count(*) AS n FROM outbound_messages_v2').get().n,3);
 assert.equal((await call('preview')).data.messages.length,1);
 assert.equal((await call('prospects/'+id+'/reply','POST',{})).status,200);
 assert.equal((await call('preview')).data.messages.length,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM outbound_messages_v2 WHERE status='cancelled'").get().n,3);
 db.close();
});
test('permanent suppression blocks reimport and stops existing lead followups',async()=>{
 const {db,call}=fixture();
 db.exec("INSERT INTO leads(lead_code,name,phone,email,zip,service,description,scope_acknowledgment,next_followup_at) VALUES('AHI-1','Test','555','PUBLIC@example.com','85001','TV','Test','yes','2026-10-03')");
 const id=(await call('prospects','POST',prospect)).data.id;
 markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
 assert.equal((await call('prospects/'+id+'/suppress','POST',{})).status,200);
 assert.equal((await call('prospects/'+id+'/suppress','POST',{})).status,200);
 assert.equal((await call('prospects','POST',prospect)).status,409);
 await call('prospects/'+id+'/reply','POST',{});
 assert.equal(db.prepare('SELECT stage FROM outbound_prospects_v2 WHERE id=?').get(id).stage,'do_not_contact');
 const lead=db.prepare('SELECT unsubscribed,next_followup_at FROM leads').get();
 assert.equal(lead.unsubscribed,1);assert.equal(lead.next_followup_at,null);
 assert.equal((await call('preview')).data.messages.length,0);
 assert.equal((await call('status')).data.live_sending,false);
 db.close();
});

test('signed unsubscribe GET is safe; POST permanently stops outreach',async()=>{
 const {db,call,env}=fixture();env.OUTBOUND_UNSUBSCRIBE_SECRET='signing'.repeat(8);
 const id=(await call('prospects','POST',prospect)).data.id;
 markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
 const {unsubscribeToken}=await import('../outbound-controls.js');
 const p=db.prepare('SELECT * FROM outbound_prospects_v2 WHERE id=?').get(id);
 const token=await unsubscribeToken(env,p);
 const url=new URL('https://example.com/api/admin/outbound/unsubscribe?token='+token);
 assert.equal((await outboundApi(new Request(url),env,url)).status,200);
 assert.equal(db.prepare('SELECT count(*) AS n FROM email_suppressions').get().n,0);
 assert.equal((await outboundApi(new Request(url,{method:'POST'}),env,url)).status,200);
 assert.equal((await outboundApi(new Request(url,{method:'POST'}),env,url)).status,200);
 assert.equal(db.prepare('SELECT count(*) AS n FROM email_suppressions').get().n,1);
 url.searchParams.set('token',token.slice(0,-1)+(token.endsWith('a')?'b':'a'));
 assert.equal((await outboundApi(new Request(url,{method:'POST'}),env,url)).status,400);
 db.close();
});
test('correlated events deduplicate and stop replies, auto replies, and complaints',async()=>{
 for(const type of ['reply','auto_reply','complaint','hard_bounce']) {
  const {db,call}=fixture();const id=(await call('prospects','POST',prospect)).data.id;
  markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  const body={external_event_id:'event-1',message_id:1,event_type:type};
  assert.equal((await call('events','POST',body)).status,200);
  assert.equal((await call('events','POST',body)).data.duplicate,true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbound_messages_v2 WHERE status='cancelled'").get().n,3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbound_events_v2 WHERE external_event_id IS NOT NULL').get().n,1);
  db.close();
 }
 const {db,call}=fixture();await call('prospects','POST',prospect);db.exec("UPDATE outbound_prospects_v2 SET solicitation_status='clear'");markVerified(db,1);await call('prospects/1/approve','POST',{reviewed_by:'Jay'});
 assert.equal((await call('events','POST',{external_event_id:'x',message_id:1,event_type:'delivered'})).status,409);
 assert.equal((await call('events','POST',{external_event_id:'x',message_id:999,event_type:'reply'})).status,404);
 db.close();
});
test('CRM referral attribution supports multiple jobs and counts distinct installs',async()=>{
 const {db,call}=fixture();const id=(await call('prospects','POST',prospect)).data.id;
 db.exec("INSERT INTO leads(lead_code,name,phone,email,zip,service,description,scope_acknowledgment,status) VALUES('AHI-1','Test','555','customer@example.com','85001','TV','Test','yes','completed')");
 assert.equal((await call('prospects/'+id+'/link-lead','POST',{lead_id:1})).status,200);
 assert.equal((await call('prospects/'+id+'/link-lead','POST',{lead_id:1})).status,200);
 assert.equal((await call('prospects/'+id+'/link-lead','POST',{lead_id:999})).status,404);
 const metrics=(await call('metrics')).data;
 assert.equal(metrics.funnel.install_completed,1);assert.equal(metrics.funnel.estimate_accepted,1);
 assert.equal((await call('settings','POST',{daily_cap:21})).status,400);
 assert.equal((await call('settings','POST',{daily_cap:20})).status,200);
 assert.equal((await call('status')).data.settings.paused,1);
 db.close();
});


test('launch readiness exposes real blockers and never activates on credentials alone',async()=>{
 const {db,call,env}=fixture();
 const status=(await call('status')).data;
 assert.ok(status.blockers.includes('OUTBOUND_GOOGLE_REFRESH_TOKEN missing'));
 assert.ok(status.blockers.includes('Mailbox approval pending'));
 env.INSTANTLY_API_KEY='configured-test-key';env.INSTANTLY_CAMPAIGN_ID='test-campaign';
 env.OUTBOUND_MAILBOX_APPROVED='true';env.OUTBOUND_MAILING_ADDRESS='Test business address';env.OUTBOUND_UNSUBSCRIBE_SECRET='sign'.repeat(10);
 assert.equal((await call('settings','POST',{daily_cap:5,paused:false})).status,409);
 assert.equal((await call('status')).data.settings.paused,1);
 const id=(await call('prospects','POST',prospect)).data.id;
 const savedFetch=globalThis.fetch;
 try {
  globalThis.fetch=async()=>new Response('No vendor solicitation',{headers:{'content-type':'text/html'}});
  assert.equal((await call('prospects/'+id+'/recheck','POST',{})).data.status,'blocked');
  assert.equal((await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'})).status,409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM email_suppressions').get().n,1);
 } finally {globalThis.fetch=savedFetch;db.close();}
});

import { runGmail, buildMime, syncGmail } from '../outbound-gmail.js';
import { renderTemplate, suppress } from '../outbound.js';
import { prepareDailyProspects } from '../outbound.js';
test('Wave 2 inventory is independent from five daily introductions and followups',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);
 const saved=globalThis.fetch;
 try {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-07T17:00:00Z')});
  Object.assign(env,{OUTBOUND_AUTO_ENROLL_WAVE1:'true',OUTBOUND_NEW_DAILY_CAP:'20'});
  for(let i=0;i<8;i++) await call('prospects','POST',{...prospect,wave_number:2,organization:'Team '+i,email:'person'+i+'@example.com',source_url:'https://example.com/'+i});
  db.exec("UPDATE outbound_settings SET paused=0,daily_cap=20;UPDATE outbound_prospects_v2 SET source_observed_at='2026-10-06',solicitation_status='reviewed'");
  const fake=gmailMock();
  globalThis.fetch=async(url,opts)=>String(url).startsWith('https://example.com/')?new Response(String(url).endsWith('/0')?'No vendor solicitation':('Team '+String(url).split('/').at(-1)+' property management Phoenix person'+String(url).split('/').at(-1)+'@example.com'),{headers:{'content-type':'text/html'}}):fake.fetch(url,opts);
  await prepareDailyProspects(env);await prepareDailyProspects(env);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbound_messages_v2 WHERE step=0 AND status='queued'").get().n,7);
  assert.equal(db.prepare("SELECT stage FROM outbound_prospects_v2 WHERE email_normalized='person0@example.com'").get().stage,'do_not_contact');
  for(let i=0;i<5;i++) assert.equal((await runGmail(env,renderTemplate,suppress,prepareDailyProspects)).sent,1);
  assert.equal((await runGmail(env,renderTemplate,suppress,prepareDailyProspects)).reason,'no_approved_due_messages');
  assert.equal(fake.sends,5);
  db.exec("UPDATE outbound_messages_v2 SET due_at='2020-01-01' WHERE step=1");
  assert.equal((await runGmail(env,renderTemplate,suppress,prepareDailyProspects)).sent,1);
  assert.equal(fake.sends,6);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NOT NULL").get().n,5);
 } finally {globalThis.fetch=saved;db.close();}
});
function gmailEnv(env){Object.assign(env,{OUTBOUND_GOOGLE_CLIENT_ID:'id',OUTBOUND_GOOGLE_CLIENT_SECRET:'secret',OUTBOUND_GOOGLE_REFRESH_TOKEN:'refresh',OUTBOUND_GMAIL_TESTED:'true',OUTBOUND_MAILBOX_APPROVED:'true',OUTBOUND_MAILING_ADDRESS:'Test mailing address',OUTBOUND_UNSUBSCRIBE_SECRET:'test'.repeat(10)});}
function gmailMock({failSend=false,incoming=false,wrongIdentity=false}={}){
 let sends=0;
 const fetch=async(url,opts={})=>{
  const u=String(url);let data={};
  if(u.endsWith('/token'))data={access_token:'token',scope:['send','readonly','settings.basic'].map(s=>'https://www.googleapis.com/auth/gmail.'+s).join(' ')};
  else if(u.endsWith('/profile'))data={emailAddress:wrongIdentity?'wrong@gmail.com':'johnj@azhomeinstalls.com'};
  else if(u.endsWith('/settings/sendAs'))data={sendAs:[{sendAsEmail:'outreach@azhomeinstalls.com',verificationStatus:'accepted'}]};
  else if(u.includes('/threads/'))data={messages:incoming?[{id:'reply1',internalDate:String(Date.now()+1000),labelIds:['INBOX'],payload:{headers:[{name:'From',value:'public@example.com'}]}}]:[]};
  else if(u.endsWith('/messages/send')){sends++;if(failSend)throw Error('timeout after acceptance');data={id:'sent'+sends,threadId:'thread1'};}
  return new Response(JSON.stringify(data));
 };
 return {fetch,get sends(){return sends}};
}
test('Gmail follow-ups have an independent cap and ambiguous sends pause without retry',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 try{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-06T17:00:00Z')});
  const id=(await call('prospects','POST',prospect)).data.id;markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  db.exec("UPDATE outbound_prospects_v2 SET solicitation_status='clear';UPDATE outbound_settings SET paused=0,daily_cap=1");
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  assert.equal(db.prepare("SELECT sent FROM outbound_daily_limits").get().sent,1);
  assert.ok(db.prepare('SELECT due_at FROM outbound_messages_v2 WHERE step=1').get().due_at);
  db.exec("UPDATE outbound_messages_v2 SET due_at='2020-01-01' WHERE step=1");
  assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);assert.equal(fake.sends,2);
  assert.equal(db.prepare('SELECT sent FROM outbound_daily_limits').get().sent,1);
  db.exec("UPDATE outbound_messages_v2 SET due_at='2020-01-01' WHERE step=2");
  db.exec('UPDATE outbound_settings SET daily_cap=2');globalThis.fetch=gmailMock({failSend:true}).fetch;
  await assert.rejects(runGmail(env,renderTemplate,suppress),/uncertain/);
  assert.equal(db.prepare('SELECT paused FROM outbound_settings').get().paused,1);
  assert.equal(db.prepare('SELECT status FROM outbound_messages_v2 WHERE step=2').get().status,'claimed');
  db.exec('UPDATE outbound_settings SET paused=0');globalThis.fetch=fake.fetch;
  await runGmail(env,renderTemplate,suppress);assert.equal(fake.sends,2);
 }finally{globalThis.fetch=saved;db.close();}
});
test('Gmail rejects wrong account and inbound replies cancel queued followups before send',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 try{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-06T17:00:00Z')});
  globalThis.fetch=gmailMock({wrongIdentity:true}).fetch;
  assert.equal((await call('gmail-check')).data.authorized,false);
  const id=(await call('prospects','POST',prospect)).data.id;markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  db.exec("UPDATE outbound_settings SET paused=0;UPDATE outbound_prospects_v2 SET solicitation_status='clear'");
  globalThis.fetch=gmailMock().fetch;await runGmail(env,renderTemplate,suppress);
  // Simulate an incoming reply later than the recorded send.
  t.mock.timers.setTime(Date.now()+60000);
  const fake=gmailMock({incoming:true});globalThis.fetch=fake.fetch;
  await runGmail(env,renderTemplate,suppress);
  assert.equal(db.prepare('SELECT stage FROM outbound_prospects_v2').get().stage,'replied');
  assert.equal(db.prepare("SELECT count(*) n FROM outbound_messages_v2 WHERE status='cancelled'").get().n,2);assert.equal(fake.sends,0);
 }finally{globalThis.fetch=saved;db.close();}
});
test('MIME encodes Unicode safely and rejects header injection',()=>{
 const args={to:'public@example.com',subject:'ADV: Installation — AHI',text:'Hello 👋',messageId:'ahi-1@azhomeinstalls.com',optout:'https://azhomeinstalls.com/api/admin/outbound/unsubscribe?token=test'};
 const mime=Buffer.from(buildMime(args),'base64url').toString();assert.match(mime,/List-Unsubscribe-Post: List-Unsubscribe=One-Click/);assert.match(mime,/From: AZHomeInstalls <outreach@azhomeinstalls.com>/);
 assert.throws(()=>buildMime({...args,subject:'Test\r\nBcc: attacker@example.com'}),/header/);
});

test('delivery scan suppresses correlated bounces and pauses on separate-thread failures',async()=>{
 for(const correlated of [true,false]){
  const {db,call,env}=fixture();gmailEnv(env);env.OUTBOUND_GMAIL_TESTED='false';const saved=globalThis.fetch;
  try{
   const fake=gmailMock();globalThis.fetch=fake.fetch;
   await call('gmail-test-send','POST',{});
   db.exec('UPDATE outbound_settings SET paused=0');
   const sentAt=db.prepare('SELECT sent_at FROM outbound_messages_v2 WHERE step=0').get().sent_at;
   globalThis.fetch=async(url,opts)=>{
    const u=String(url);
    if(u.includes('/messages?')&&decodeURIComponent(u).includes('from:mailer-daemon'))return new Response(JSON.stringify({messages:[{id:'dsn'}]}));
    if(u.includes('/messages/dsn?'))return new Response(JSON.stringify({id:'dsn',threadId:correlated?'thread1':'other-thread',internalDate:String(Date.parse(sentAt)+1000),labelIds:['INBOX'],payload:{headers:[{name:'From',value:'MAILER-DAEMON@example.com'},{name:'Content-Type',value:'multipart/report; report-type=delivery-status'}]}}));
    return fake.fetch(url,opts);
   };
   if(correlated){
    await syncGmail(env,suppress);
    assert.equal(db.prepare('SELECT reason FROM email_suppressions').get().reason,'bounce');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM outbound_messages_v2 WHERE status='queued'").get().n,0);
   }else{
    env.OUTBOUND_GMAIL_TESTED='true';
    await assert.rejects(runGmail(env,renderTemplate,suppress),/Delivery failure needs review/);
    assert.equal(db.prepare('SELECT paused FROM outbound_settings').get().paused,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM email_suppressions').get().n,0);
    const pause=db.prepare("SELECT detail FROM outbound_events_v2 WHERE event_type='campaign_paused'").get();
    assert.equal(JSON.parse(pause.detail).gmail_message_id,'dsn');
    assert.equal(JSON.parse(pause.detail).reason,'unmatched_delivery_failure');
   }
   assert.equal(fake.sends,1);
  }finally{globalThis.fetch=saved;db.close();}
 }
});

test('controlled Gmail test stays paused, sends once, detects reply and records opt-out',async()=>{
 const {db,call,env}=fixture();gmailEnv(env);env.OUTBOUND_GMAIL_TESTED='false';const saved=globalThis.fetch;
 try{
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  assert.equal((await call('gmail-test-send','POST',{})).data.ok,true);
  assert.equal(fake.sends,1);
  assert.equal(db.prepare('SELECT paused FROM outbound_settings').get().paused,1);
  const p=db.prepare('SELECT * FROM outbound_prospects_v2').get();
  assert.equal(p.email_normalized,'discoveruroptions@gmail.com');assert.equal(p.approved_at,null);
  assert.equal(db.prepare('SELECT status FROM outbound_enrollments_v2').get().status,'stopped');
  assert.equal((await call('gmail-test-send','POST',{})).status,400);assert.equal(fake.sends,1);
  assert.equal((await call('gmail-test-results','POST',{})).data.reply_detected,false);
  globalThis.fetch=gmailMock({incoming:true}).fetch;
  const reply=(await call('gmail-test-results','POST',{})).data;
  assert.equal(reply.reply_detected,true);assert.equal(reply.followups_cancelled,true);
  const {unsubscribeUrl}=await import('../outbound-controls.js');
  const url=new URL(await unsubscribeUrl(env,p));
  const r=await outboundApi(new Request(url,{method:'POST'}),env,url);assert.equal(r.status,200);
  assert.equal((await call('gmail-test-results','POST',{})).data.unsubscribed,true);
  assert.equal(env.OUTBOUND_GMAIL_TESTED,'false');
 }finally{globalThis.fetch=saved;db.close()}
});
test('controlled Gmail test fails closed when active and never retries uncertain send',async()=>{
 const {db,call,env}=fixture();gmailEnv(env);env.OUTBOUND_GMAIL_TESTED='false';const saved=globalThis.fetch;
 try{
  const fake=gmailMock({failSend:true});globalThis.fetch=fake.fetch;
  db.exec('UPDATE outbound_settings SET paused=0');
  assert.equal((await call('gmail-test-send','POST',{})).status,400);assert.equal(fake.sends,0);
  db.exec('UPDATE outbound_settings SET paused=1');
  assert.match((await call('gmail-test-send','POST',{})).data.error,/uncertain/);
  assert.equal((await call('gmail-test-send','POST',{})).status,400);assert.equal(fake.sends,1);
  assert.equal(db.prepare('SELECT reserved FROM outbound_daily_limits').get().reserved,1);
  assert.equal(db.prepare('SELECT status FROM outbound_messages_v2 WHERE step=0').get().status,'claimed');
 }finally{globalThis.fetch=saved;db.close()}
});

test('new introductions stay at five with oversized settings and a historical launch allowance',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-07T17:00:00Z')});
 try {
  Object.assign(env,{OUTBOUND_NEW_DAILY_CAP:'20',OUTBOUND_LAUNCH_DATE:'2026-10-07',OUTBOUND_LAUNCH_EXTRA:'1',OUTBOUND_FOLLOWUP_DAILY_CAP:'2'});
  for(let i=0;i<7;i++) {
   const created=await call('prospects','POST',{...prospect,wave_number:2,email:'ceiling'+i+'@example.com'});
   assert.equal(created.status,201);
   markVerified(db,created.data.id);assert.equal((await call('prospects/'+created.data.id+'/approve','POST',{reviewed_by:'Jay'})).status,200);
  }
  db.exec("UPDATE outbound_settings SET paused=0,daily_cap=20;UPDATE outbound_prospects_v2 SET solicitation_status='clear'");
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  for(let i=0;i<5;i++) assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  assert.equal((await runGmail(env,renderTemplate,suppress)).reason,'no_approved_due_messages');
  assert.equal(fake.sends,5);
  assert.equal(db.prepare('SELECT sent, reserved, cap FROM outbound_daily_limits').get().cap,5);
  // Follow-ups have their own quota, and take priority over remaining introductions.
  db.exec("UPDATE outbound_messages_v2 SET due_at='2020-01-01' WHERE step=1");
  for(let i=0;i<2;i++) assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  assert.equal((await runGmail(env,renderTemplate,suppress)).reason,'no_approved_due_messages');
  assert.equal(fake.sends,7);
  assert.equal(db.prepare('SELECT sent FROM outbound_daily_limits').get().sent,5);
  // On a new Phoenix day both quotas reset; overdue follow-ups still run first.
  t.mock.timers.setTime(Date.parse('2026-10-08T17:00:00Z'));
  const next=await runGmail(env,renderTemplate,suppress);
  assert.equal(db.prepare('SELECT step FROM outbound_messages_v2 WHERE id=?').get(next.message_id).step,1);
  assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  for(let i=0;i<2;i++) assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  assert.equal((await runGmail(env,renderTemplate,suppress)).reason,'no_approved_due_messages');
  assert.equal(db.prepare("SELECT sent FROM outbound_daily_limits WHERE phoenix_date='2026-10-08'").get().sent,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NOT NULL').get().n,7);
 } finally {globalThis.fetch=saved;db.close();}
});

test('Wave 2 preflight skips unreadable sources and excludes other waves, suppression and replies',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-07T17:00:00Z')});
 try {
  Object.assign(env,{OUTBOUND_AUTO_ENROLL_WAVE1:'true',OUTBOUND_NEW_DAILY_CAP:'100'});
  const ids=[];
  for(let i=0;i<8;i++) ids.push((await call('prospects','POST',{...prospect,wave_number:i===0?1:2,email:'preflight'+i+'@example.com',source_url:'https://example.com/'+i})).data.id);
  db.exec("UPDATE outbound_settings SET daily_cap=20;UPDATE outbound_prospects_v2 SET solicitation_status='reviewed'");
  await suppress(env,'preflight1@example.com','unsubscribe','test');
  await call('prospects/'+ids[2]+'/reply','POST',{});
  const checked=[];
  globalThis.fetch=async(url,options)=>{
   assert.equal(options.redirect,'manual'); checked.push(String(url));
   switch(String(url).split('/').at(-1)) {
    case '3': return new Response(null,{status:302,headers:{Location:'https://example.com/elsewhere'}});
    case '4': throw new Error('Simulated timeout');
    case '5': return new Response('binary',{headers:{'content-type':'application/pdf'}});
    case '6': return new Response('No vendor solicitation',{headers:{'content-type':'text/html'}});
    default: return new Response('Example Management property management Phoenix preflight7@example.com',{headers:{'content-type':'text/html'}});
   }
  };
  await prepareDailyProspects(env);await prepareDailyProspects(env);
  assert.ok(checked.every(url=>!['0','1','2'].includes(url.split('/').at(-1))));
  for(const i of [3,4,5])assert.equal(db.prepare('SELECT solicitation_status FROM outbound_prospects_v2 WHERE id=?').get(ids[i]).solicitation_status,'manual_required');
  assert.equal(db.prepare('SELECT stage FROM outbound_prospects_v2 WHERE id=?').get(ids[6]).stage,'do_not_contact');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_enrollments_v2').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_messages_v2').get().n,3);
  assert.equal(db.prepare('SELECT prospect_id FROM outbound_enrollments_v2').get().prospect_id,ids[7]);
  assert.match(db.prepare('SELECT idempotency_key FROM outbound_messages_v2 WHERE step=0').get().idempotency_key,/^wave-v2:/);
 } finally {globalThis.fetch=saved;db.close();}
});

test('lower and invalid introduction limits do not stop independently scheduled follow-ups',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-07T17:00:00Z')});
 try {
  env.OUTBOUND_NEW_DAILY_CAP='1';
  for(let i=0;i<2;i++) {
   const id=(await call('prospects','POST',{...prospect,email:'lower'+i+'@example.com'})).data.id;
   markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  }
  db.exec("UPDATE outbound_settings SET paused=0,daily_cap=20;UPDATE outbound_prospects_v2 SET solicitation_status='clear'");
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  assert.equal((await runGmail(env,renderTemplate,suppress)).reason,'no_approved_due_messages');
  env.OUTBOUND_NEW_DAILY_CAP='invalid';
  db.exec("UPDATE outbound_messages_v2 SET due_at='2020-01-01' WHERE step=1 AND enrollment_id=1");
  assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  assert.equal(fake.sends,2);
  assert.equal(db.prepare('SELECT sent FROM outbound_daily_limits').get().sent,1);
 } finally {globalThis.fetch=saved;db.close();}
});

const evidence=(emails=['public@example.com'])=>new Response('Example Management property management in Phoenix '+emails.join(' '),{headers:{'content-type':'text/html'}});

test('public validation follows only bounded HTTPS redirects on the same business website',async()=>{
 const {db,call}=fixture();const saved=globalThis.fetch;
 try {
  const id=(await call('prospects','POST',{...prospect,wave_number:2})).data.id;
  const urls=[];
  globalThis.fetch=async(url,options)=>{
   assert.equal(options.redirect,'manual');urls.push(String(url));
   return urls.length===1?new Response(null,{status:301,headers:{location:'https://www.example.com/contact'}}):evidence();
  };
  assert.equal((await call('prospects/'+id+'/recheck','POST',{})).data.status,'clear');
  assert.deepEqual(urls,['https://example.com/team','https://www.example.com/contact']);
  assert.equal(db.prepare('SELECT validated_source_url FROM outbound_prospects_v2').get().validated_source_url,urls[1]);
  assert.equal((await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'})).status,200);
 } finally {globalThis.fetch=saved;db.close();}
});

test('inconclusive, unsafe and unverified sources never qualify for manual approval',async()=>{
 const saved=globalThis.fetch;
 const cases=[
  ()=>new Response(null,{status:403}),()=>new Response(null,{status:526}),
  ()=>{throw new Error('Simulated timeout');},
  ()=>new Response(null,{status:302,headers:{location:'https://other.example.com/contact'}}),
  ()=>new Response(null,{status:302,headers:{location:'http://example.com/contact'}}),
  ()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/contact'}}),
  ()=>new Response(null,{status:302,headers:{location:'/team'}}),
  ()=>evidence(['guessed@example.com']),
  ()=>new Response('Different Company property management public@example.com',{headers:{'content-type':'text/html'}}),
  ()=>new Response('Example Management public@example.com',{headers:{'content-type':'text/html'}}),
  ()=>new Response('<script>Example Management property management public@example.com</script>',{headers:{'content-type':'text/html'}}),
  ()=>new Response('Example Management property management public@example.com',{headers:{'content-type':'application/pdf'}}),
  ()=>new Response('x'.repeat(750001),{headers:{'content-type':'text/html'}})
 ];
 try {
  for(const response of cases) {
   const {db,call}=fixture();
   try {
    const id=(await call('prospects','POST',{...prospect,wave_number:2})).data.id;
    globalThis.fetch=async()=>response();
    const checked=await call('prospects/'+id+'/recheck','POST',{});
    assert.equal(checked.data.status,'manual_required',checked.data.note);
    assert.equal((await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'})).status,409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_messages_v2').get().n,0);
   } finally {db.close();}
  }
 } finally {globalThis.fetch=saved;}
});

test('inventory fills to 25, replenishes after sends and concurrent pipeline invocations are idempotent',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-05T17:00:00Z')});
 try {
  env.OUTBOUND_AUTO_ENROLL_WAVE1='true';
  const emails=Array.from({length:30},(_,i)=>'inventory'+i+'@example.com');
  for(const email of emails)assert.equal((await call('prospects','POST',{...prospect,wave_number:2,email})).status,201);
  const fake=gmailMock();
  globalThis.fetch=async(url,options)=>String(url).startsWith('https://example.com/')?evidence(emails):fake.fetch(url,options);
  const runs=await Promise.all([prepareDailyProspects(env),prepareDailyProspects(env),prepareDailyProspects(env)]);
  assert.equal(runs.filter(r=>r.reason==='busy').length,2);
  assert.equal((await call('operations')).data.inventory.ready,25);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_messages_v2').get().n,75);
  await prepareDailyProspects(env);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_enrollments_v2').get().n,25);
  db.exec('UPDATE outbound_settings SET paused=0');
  for(let i=0;i<5;i++)assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  await prepareDailyProspects(env);
  const report=(await call('operations')).data;
  assert.equal(report.inventory.ready,25);assert.equal(report.introductions.sent,5);assert.equal(report.introductions.remaining,0);
  assert.equal(report.followups.scheduled,10);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_enrollments_v2').get().n,30);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_messages_v2').get().n,90);
  assert.equal((await call('prospects','POST',{...prospect,email:emails[0].toUpperCase()})).status,409);
 } finally {globalThis.fetch=saved;db.close();}
});

test('research records and stale evidence cannot enter or remain eligible for the introduction queue',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-05T17:00:00Z')});
 try {
  env.OUTBOUND_AUTO_ENROLL_WAVE1='true';
  const research=(await call('prospects','POST',{...prospect,wave_number:2,research_only:true})).data.id;
  globalThis.fetch=async()=>evidence();
  assert.equal((await call('prospects/'+research+'/recheck','POST',{})).data.status,'manual_required');
  assert.equal((await call('prospects/'+research+'/approve','POST',{reviewed_by:'Jay'})).status,409);
  await prepareDailyProspects(env);assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_messages_v2').get().n,0);
  const id=(await call('prospects','POST',{...prospect,wave_number:2,email:'fresh@example.com'})).data.id;
  globalThis.fetch=async()=>evidence(['fresh@example.com']);
  await prepareDailyProspects(env);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_messages_v2').get().n,3);
  t.mock.timers.setTime(Date.parse('2026-11-13T17:00:00Z'));
  db.exec('UPDATE outbound_settings SET paused=0');
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  assert.equal((await runGmail(env,renderTemplate,suppress)).reason,'no_approved_due_messages');
  assert.equal(fake.sends,0);
  globalThis.fetch=async()=>new Response(null,{status:526});await prepareDailyProspects(env);
  assert.equal(db.prepare('SELECT validation_status FROM outbound_prospects_v2 WHERE id=?').get(id).validation_status,'manual_required');
  assert.equal((await call('operations')).data.inventory.ready,0);
 } finally {globalThis.fetch=saved;db.close();}
});

test('suppression during a source fetch wins over automatic approval',async()=>{
 const {db,call,env}=fixture();const saved=globalThis.fetch;
 try {
  env.OUTBOUND_AUTO_ENROLL_WAVE1='true';
  await call('prospects','POST',{...prospect,wave_number:2});
  globalThis.fetch=async()=>{await suppress(env,'public@example.com','unsubscribe','test');return evidence();};
  await prepareDailyProspects(env);
  assert.equal(db.prepare('SELECT stage FROM outbound_prospects_v2').get().stage,'do_not_contact');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_enrollments_v2').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM email_suppressions').get().n,1);
 } finally {globalThis.fetch=saved;db.close();}
});

test('concurrent cron calls and retries cannot send more than five introductions',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-05T17:00:00Z')});
 try {
  for(let i=0;i<10;i++) {
   const id=(await call('prospects','POST',{...prospect,email:'concurrent'+i+'@example.com'})).data.id;
   markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  }
  db.exec('UPDATE outbound_settings SET paused=0,daily_cap=20');
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  for(let round=0;round<8;round++)await Promise.all(Array.from({length:6},()=>runGmail(env,renderTemplate,suppress)));
  assert.equal(fake.sends,5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_introduction_reservations').get().n,5);
  assert.equal(db.prepare('SELECT SUM(attempts) n FROM outbound_messages_v2 WHERE step=0').get().n,5);
  assert.equal((await call('operations')).data.introductions.remaining,0);
 } finally {globalThis.fetch=saved;db.close();}
});

test('an expired Worker owner cannot send after another invocation takes its lease',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-05T17:00:00Z')});
 try {
  for(let i=0;i<2;i++) {
   const id=(await call('prospects','POST',{...prospect,email:'lease'+i+'@example.com'})).data.id;
   markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  }
  db.exec('UPDATE outbound_settings SET paused=0');
  const fake=gmailMock();let release,started;const gate=new Promise(r=>{release=r;});const entered=new Promise(r=>{started=r;});let first=true;
  globalThis.fetch=async(url,options)=>{
   if(first&&String(url).endsWith('/profile')){first=false;started();await gate;}
   return fake.fetch(url,options);
  };
  const old=runGmail(env,renderTemplate,suppress);await entered;
  t.mock.timers.setTime(Date.now()+11*60000);
  assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  release();assert.equal((await old).sent,undefined);
  assert.equal(fake.sends,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_introduction_reservations').get().n,1);
 } finally {globalThis.fetch=saved;db.close();}
});

test('uncertain introductions retain quota after lease expiry and are never retried',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-05T17:00:00Z')});
 try {
  for(let i=0;i<6;i++) {
   const id=(await call('prospects','POST',{...prospect,email:'uncertain'+i+'@example.com'})).data.id;
   markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  }
  db.exec('UPDATE outbound_settings SET paused=0');
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  for(let i=0;i<4;i++)await runGmail(env,renderTemplate,suppress);
  const uncertain=gmailMock({failSend:true});globalThis.fetch=uncertain.fetch;
  await assert.rejects(runGmail(env,renderTemplate,suppress),/uncertain/);
  t.mock.timers.setTime(Date.now()+11*60000);
  db.exec('UPDATE outbound_settings SET paused=0');globalThis.fetch=fake.fetch;
  assert.equal((await runGmail(env,renderTemplate,suppress)).sent,undefined);
  assert.equal(fake.sends,4);assert.equal(uncertain.sends,1);
  const report=(await call('operations')).data;
  assert.equal(report.introductions.used,5);assert.equal(report.introductions.remaining,0);assert.equal(report.failures.length,1);
 } finally {globalThis.fetch=saved;db.close();}
});

test('daily capacity rolls over at Arizona midnight, without sending outside business hours',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-06T06:59:59Z')});
 try {
  for(let i=0;i<5;i++) {
   const id=(await call('prospects','POST',{...prospect,email:'midnight'+i+'@example.com'})).data.id;
   markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
   const m=db.prepare('SELECT m.id FROM outbound_messages_v2 m JOIN outbound_enrollments_v2 e ON e.id=m.enrollment_id WHERE e.prospect_id=? AND m.step=0').get(id);
   db.prepare('INSERT INTO outbound_introduction_reservations VALUES(?,?,?,?)').run(m.id,'2026-11-05','test-owner',new Date().toISOString());
   db.prepare("UPDATE outbound_messages_v2 SET status='sent',sent_at=? WHERE id=?").run(new Date().toISOString(),m.id);
  }
  const before=(await call('operations')).data;
  assert.equal(before.phoenix_date,'2026-11-05');assert.equal(before.introductions.remaining,0);
  t.mock.timers.setTime(Date.parse('2026-11-06T07:00:00Z'));
  const after=(await call('operations')).data;
  assert.equal(after.phoenix_date,'2026-11-06');assert.equal(after.introductions.remaining,5);
  db.exec('UPDATE outbound_settings SET paused=0');const fake=gmailMock();globalThis.fetch=fake.fetch;
  assert.equal((await runGmail(env,renderTemplate,suppress)).reason,'outside_business_hours');assert.equal(fake.sends,0);
 } finally {globalThis.fetch=saved;db.close();}
});

test('scheduled Worker invocations share the same daily limit',async(t)=>{
 const worker=(await import('../estimate-worker.js')).default;
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-05T17:05:00Z')});
 try {
  for(let i=0;i<8;i++) {
   const id=(await call('prospects','POST',{...prospect,email:'scheduled'+i+'@example.com'})).data.id;
   markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  }
  db.exec('UPDATE outbound_settings SET paused=0');
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  for(let round=0;round<7;round++) {
   const pending=[];const ctx={waitUntil(promise){pending.push(promise);}};
   await Promise.all(Array.from({length:4},()=>worker.scheduled({scheduledTime:Date.now()},env,ctx)));
   await Promise.all(pending);
  }
  assert.equal(fake.sends,5);
  assert.equal((await call('operations')).data.introductions.remaining,0);
 } finally {globalThis.fetch=saved;db.close();}
});

test('followups keep +7/+17-day dates and reuse Gmail thread and message references',async(t)=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-05T17:00:00Z')});
 try {
  const id=(await call('prospects','POST',prospect)).data.id;
  markVerified(db,id);await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  db.exec('UPDATE outbound_settings SET paused=0');
  const fake=gmailMock(),requests=[];
  globalThis.fetch=async(url,options)=>{if(String(url).endsWith('/messages/send'))requests.push(JSON.parse(options.body));return fake.fetch(url,options);};
  await runGmail(env,renderTemplate,suppress);
  const messages=db.prepare('SELECT * FROM outbound_messages_v2 ORDER BY step').all();
  assert.equal(messages[1].due_at,'2026-11-12T17:00:00.000Z');
  // +17 days is Sunday, so it moves to Monday at 10am Phoenix.
  assert.equal(messages[2].due_at,'2026-11-23T17:00:00.000Z');
  t.mock.timers.setTime(Date.parse(messages[1].due_at));await runGmail(env,renderTemplate,suppress);
  assert.equal(requests[1].threadId,'thread1');
  const mime=Buffer.from(requests[1].raw,'base64url').toString();
  assert.ok(mime.includes('In-Reply-To: <'+messages[0].rfc_message_id+'>'));
  assert.ok(mime.includes('References: <'+messages[0].rfc_message_id+'>'));
  assert.equal(db.prepare('SELECT subject FROM outbound_messages_v2 WHERE step=1').get().subject,messages[0].subject);
 } finally {globalThis.fetch=saved;db.close();}
});

test('additive reliability migration preserves historical messages and suppressions without approving them',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  for(const name of ['0001_leads.sql','0002_outbound.sql','0003_outbound_wave_v2.sql','0004_outbound_wave_plan.sql','0005_outbound_provider_state.sql','0006_outbound_gmail.sql'])db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  db.exec("INSERT INTO email_suppressions(email_normalized,reason,source,created_at) VALUES('stop@example.com','unsubscribe','history','2026-10-01')");
  db.exec("INSERT INTO outbound_prospects_v2(organization,domain,email,email_normalized,segment,city,source_url,source_observed_at,fit_reason,solicitation_checked_at,created_at,updated_at) VALUES('Legacy','example.com','legacy@example.com','legacy@example.com','property_manager','Phoenix','https://example.com','2026-10-01','Recorded research','2026-10-01','2026-10-01','2026-10-01')");
  db.exec("INSERT INTO outbound_enrollments_v2(prospect_id,created_at) VALUES(1,'2026-10-01');INSERT INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key,status,sent_at) VALUES(1,0,0,'legacy:1:0','sent','2026-10-01T17:00:00Z')");
  db.exec("INSERT INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key,status,claimed_until,last_error) VALUES(1,1,7,'legacy:1:1','claimed','2026-10-08T17:10:00Z','Send outcome uncertain')");
  db.exec("INSERT INTO outbound_prospects_v2(organization,domain,email,email_normalized,segment,city,source_url,source_observed_at,fit_reason,solicitation_checked_at,created_at,updated_at) SELECT organization,domain,'uncertain@example.com','uncertain@example.com',segment,city,source_url,source_observed_at,fit_reason,solicitation_checked_at,created_at,updated_at FROM outbound_prospects_v2 WHERE id=1;INSERT INTO outbound_enrollments_v2(prospect_id,created_at) VALUES(2,'2026-10-08');INSERT INTO outbound_messages_v2(enrollment_id,step,day_offset,idempotency_key,status,claimed_until) VALUES(2,0,0,'legacy:2:0','claimed','2026-10-08T17:10:00Z')");
  db.exec(readFileSync(new URL('../migrations/0007_outbound_reliability.sql',import.meta.url),'utf8'));
  assert.equal(db.prepare('SELECT validation_status FROM outbound_prospects_v2').get().validation_status,'pending');
  assert.equal(db.prepare('SELECT sent_at FROM outbound_messages_v2').get().sent_at,'2026-10-01T17:00:00Z');
  assert.equal(db.prepare('SELECT reason FROM email_suppressions').get().reason,'unsubscribe');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outbound_introduction_reservations').get().n,1);
  assert.equal(db.prepare('SELECT phoenix_date FROM outbound_introduction_reservations').get().phoenix_date,'2026-10-08');
  assert.equal(db.prepare("SELECT status FROM outbound_messages_v2 WHERE step=1").get().status,'claimed');
 } finally {db.close();}
});
