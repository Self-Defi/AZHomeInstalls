import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { outboundApi } from '../outbound.js';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_leads.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0002_outbound.sql',import.meta.url),'utf8'));
 for(const name of ['0003_outbound_wave_v2.sql','0004_outbound_wave_plan.sql','0005_outbound_provider_state.sql']) db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
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
 assert.ok(status.blockers.includes('Instantly API v2 key missing'));
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
