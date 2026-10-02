import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { outboundApi } from '../outbound.js';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_leads.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0002_outbound.sql',import.meta.url),'utf8'));
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
 return {db,call};
}
const prospect={organization:'Example Management',email:'Public@example.com',segment:'property_manager',city:'Phoenix',source_url:'https://example.com/team',fit_reason:'Your company lists Phoenix residential management.'};
test('review enrollment is idempotent and manual replies cancel all pending steps',async()=>{
 const {db,call}=fixture();
 const created=await call('prospects','POST',prospect);assert.equal(created.status,201);
 const id=created.data.id;
 assert.equal((await call('preview')).data.messages.length,0);
 assert.equal((await call('prospects/'+id+'/approve','POST',{})).status,400);
 assert.equal((await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'})).status,200);
 assert.equal((await call('prospects/'+id+'/approve','POST',{reviewed_by:'Jay'})).status,409);
 assert.equal(db.prepare('SELECT count(*) AS n FROM outbound_messages').get().n,3);
 assert.equal((await call('preview')).data.messages.length,1);
 assert.equal((await call('prospects/'+id+'/reply','POST',{})).status,200);
 assert.equal((await call('preview')).data.messages.length,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM outbound_messages WHERE status='cancelled'").get().n,3);
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
 assert.equal(db.prepare('SELECT stage FROM outbound_prospects WHERE id=?').get(id).stage,'do_not_contact');
 const lead=db.prepare('SELECT unsubscribed,next_followup_at FROM leads').get();
 assert.equal(lead.unsubscribed,1);assert.equal(lead.next_followup_at,null);
 assert.equal((await call('preview')).data.messages.length,0);
 assert.equal((await call('status')).data.live_sending,false);
 db.close();
});
