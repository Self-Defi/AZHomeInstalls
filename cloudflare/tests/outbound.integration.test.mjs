import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { outboundApi } from '../outbound.js';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_leads.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0002_outbound.sql',import.meta.url),'utf8'));
 for(const name of ['0003_outbound_wave_v2.sql','0004_outbound_wave_plan.sql','0005_outbound_provider_state.sql','0006_outbound_gmail.sql']) db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
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
const prospect={organization:'Example Management',email:'Public@example.com',segment:'property_manager',city:'Phoenix',source_url:'https://example.com/team',fit_reason:'Your company lists Phoenix residential management.',solicitation_checked_at:'2026-10-06T15:00:00Z'};
test('review enrollment is idempotent and manual replies cancel all pending steps',async()=>{
 const {db,call}=fixture();
 const created=await call('prospects','POST',prospect);assert.equal(created.status,201);
 const id=created.data.id;
 assert.equal((await call('preview')).data.messages.length,0);
 assert.equal((await call('prospects/'+id+'/approve','POST',{})).status,400);
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
 await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
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
 await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
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
  await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  const body={external_event_id:'event-1',message_id:1,event_type:type};
  assert.equal((await call('events','POST',body)).status,200);
  assert.equal((await call('events','POST',body)).data.duplicate,true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbound_messages_v2 WHERE status='cancelled'").get().n,3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbound_events_v2 WHERE external_event_id IS NOT NULL').get().n,1);
  db.close();
 }
 const {db,call}=fixture();await call('prospects','POST',prospect);await call('prospects/1/approve','POST',{reviewed_by:'Jay'});
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
test('daily enrollment skips blocked sources, queues five once, and leaves capacity for followups',async()=>{
 const {db,call,env}=fixture();gmailEnv(env);
 const saved=globalThis.fetch, oldNow=Date.now;
 try {
  Date.now=()=>Date.parse('2026-10-07T17:00:00Z');
  Object.assign(env,{OUTBOUND_AUTO_ENROLL_WAVE1:'true',OUTBOUND_NEW_DAILY_CAP:'5'});
  for(let i=0;i<8;i++) await call('prospects','POST',{...prospect,organization:'Team '+i,email:'person'+i+'@example.com',source_url:'https://example.com/'+i});
  db.exec("UPDATE outbound_settings SET paused=0,daily_cap=20;UPDATE outbound_prospects_v2 SET source_observed_at='2026-10-06',solicitation_status='reviewed'");
  const fake=gmailMock();
  globalThis.fetch=async(url,opts)=>String(url).startsWith('https://example.com/')?new Response(String(url).endsWith('/0')?'No vendor solicitation':'Residential services',{headers:{'content-type':'text/html'}}):fake.fetch(url,opts);
  await prepareDailyProspects(env);await prepareDailyProspects(env);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbound_messages_v2 WHERE step=0 AND status='queued'").get().n,5);
  assert.equal(db.prepare("SELECT stage FROM outbound_prospects_v2 WHERE email_normalized='person0@example.com'").get().stage,'do_not_contact');
  for(let i=0;i<5;i++) assert.equal((await runGmail(env,renderTemplate,suppress,prepareDailyProspects)).sent,1);
  assert.equal((await runGmail(env,renderTemplate,suppress,prepareDailyProspects)).reason,'no_approved_due_messages');
  assert.equal(fake.sends,5);
  db.exec("UPDATE outbound_messages_v2 SET due_at='2020-01-01' WHERE step=1");
  assert.equal((await runGmail(env,renderTemplate,suppress,prepareDailyProspects)).sent,1);
  assert.equal(fake.sends,6);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbound_messages_v2 WHERE step=0 AND sent_at IS NOT NULL").get().n,5);
 } finally {globalThis.fetch=saved;Date.now=oldNow;db.close();}
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
test('Gmail cap includes all sequence messages and ambiguous sends pause without retry',async()=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;const oldNow=Date.now;
 try{
  Date.now=()=>Date.parse('2026-10-06T17:00:00Z');
  const id=(await call('prospects','POST',prospect)).data.id;await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  db.exec("UPDATE outbound_prospects_v2 SET solicitation_status='clear';UPDATE outbound_settings SET paused=0,daily_cap=1");
  const fake=gmailMock();globalThis.fetch=fake.fetch;
  assert.equal((await runGmail(env,renderTemplate,suppress)).sent,1);
  assert.equal(db.prepare("SELECT sent FROM outbound_daily_limits").get().sent,1);
  assert.ok(db.prepare('SELECT due_at FROM outbound_messages_v2 WHERE step=1').get().due_at);
  db.exec("UPDATE outbound_messages_v2 SET due_at='2020-01-01' WHERE step=1");
  assert.equal((await runGmail(env,renderTemplate,suppress)).reason,'daily_cap');assert.equal(fake.sends,1);
  db.exec('UPDATE outbound_settings SET daily_cap=2');globalThis.fetch=gmailMock({failSend:true}).fetch;
  await assert.rejects(runGmail(env,renderTemplate,suppress),/uncertain/);
  assert.equal(db.prepare('SELECT paused FROM outbound_settings').get().paused,1);
  assert.equal(db.prepare('SELECT status FROM outbound_messages_v2 WHERE step=1').get().status,'claimed');
  db.exec('UPDATE outbound_settings SET paused=0');globalThis.fetch=fake.fetch;
  await runGmail(env,renderTemplate,suppress);assert.equal(fake.sends,1);
 }finally{globalThis.fetch=saved;Date.now=oldNow;db.close();}
});
test('Gmail rejects wrong account and inbound replies cancel queued followups before send',async()=>{
 const {db,call,env}=fixture();gmailEnv(env);const saved=globalThis.fetch;const oldNow=Date.now;
 try{
  Date.now=()=>Date.parse('2026-10-06T17:00:00Z');
  globalThis.fetch=gmailMock({wrongIdentity:true}).fetch;
  assert.equal((await call('gmail-check')).data.authorized,false);
  const id=(await call('prospects','POST',prospect)).data.id;await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'});
  db.exec("UPDATE outbound_settings SET paused=0;UPDATE outbound_prospects_v2 SET solicitation_status='clear'");
  globalThis.fetch=gmailMock().fetch;await runGmail(env,renderTemplate,suppress);
  // Simulate an incoming reply later than the recorded send.
  Date.now=()=>Date.now.realTime;Date.now.realTime=new Date().getTime()+60000;
  const fake=gmailMock({incoming:true});globalThis.fetch=fake.fetch;
  await runGmail(env,renderTemplate,suppress);
  assert.equal(db.prepare('SELECT stage FROM outbound_prospects_v2').get().stage,'replied');
  assert.equal(db.prepare("SELECT count(*) n FROM outbound_messages_v2 WHERE status='cancelled'").get().n,2);assert.equal(fake.sends,0);
 }finally{globalThis.fetch=saved;Date.now=oldNow;db.close();}
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
