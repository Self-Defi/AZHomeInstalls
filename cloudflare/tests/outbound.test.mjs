import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, normalizeEmail, validateProspect, renderTemplate, outboundApi, OFFSETS } from '../outbound.js';
const prospect={organization:'Example Homes',email:' Public@Example.com ',segment:'property_manager',city:'Phoenix',source_url:'https://example.com/team',fit_reason:'Your public site lists residential management in Phoenix.',solicitation_checked_at:'2026-10-06T15:00:00Z'};
test('normalization and public evidence are required',()=>{
 assert.equal(normalizeEmail(prospect.email),'public@example.com');
 assert.equal(validateProspect(prospect).domain,'example.com');
 for(const change of [{email:'bad'},{segment:'homeowner'},{source_url:'http://example.com'},{source_url:'https://127.0.0.1'},{source_url:'https://user:pass@example.com'},{fit_reason:''}])
  assert.throws(()=>validateProspect({...prospect,...change}));
});
test('sequence has initial, day 8, day 18 only',()=>{
 assert.deepEqual(OFFSETS,[0,7,17]);
 for(let i=0;i<3;i++){
  const m=renderTemplate(prospect,i,{address:'PO Box 123, Phoenix AZ 85001',optout:'Unsubscribe: https://example.com/unsubscribe'});
  assert.match(m.subject,/^ADV:/);assert.match(m.text,/Advertisement/);assert.match(m.text,/Not a Licensed Contractor/);assert.match(m.text,/PO Box/);assert.match(m.text,/Unsubscribe/);
 }
 assert.throws(()=>renderTemplate(prospect,3,{}));
});
test('outbound access fails closed with missing or wrong secret',async()=>{
 const token='a'.repeat(40);
 assert.equal(await authorized(new Request('https://example.com'),{}),false);
 assert.equal(await authorized(new Request('https://example.com',{headers:{Authorization:'Bearer '+token}}),{OUTBOUND_ADMIN_TOKEN:token}),true);
 assert.equal(await authorized(new Request('https://example.com',{headers:{Authorization:'Bearer '+'b'.repeat(40)}}),{OUTBOUND_ADMIN_TOKEN:token}),false);
 const response=await outboundApi(new Request('https://example.com/api/admin/outbound/prospects'),{},new URL('https://example.com/api/admin/outbound/prospects'));
 assert.equal(response.status,401);
});

test('Phoenix day and follow-ups use local day boundaries and weekday windows',async()=>{
 const {phoenixDate,followupDue}=await import('../outbound-controls.js');
 assert.equal(phoenixDate(new Date('2026-10-03T06:30:00Z')),'2026-10-02');
 assert.equal(followupDue('2026-10-01T17:00:00Z',3),'2026-10-05T17:00:00.000Z');
 assert.equal(followupDue('2026-10-01T17:00:00Z',9),'2026-10-12T17:00:00.000Z');
});


test('all sector emails exclude imported research notes',()=>{
 for(const segment of ['property_manager','home_stager','design_studio','realtor','moving_company','builder_new_community']) {
  const m=renderTemplate({...prospect,segment,personalization_hook:'Explicit vendor route; Property Services Manager contact is directly relevant.',fit_reason:'INTERNAL_ONLY'},0,{address:'Address',optout:'Unsubscribe'});
  assert.match(m.text,/Hi Example Homes team,/);
  assert.match(m.text,/I’m Jay with AZHomeInstalls/);
  assert.doesNotMatch(m.text,/Explicit vendor route|Property Services Manager|INTERNAL_ONLY|starting-price/);
 }
 assert.throws(()=>renderTemplate({...prospect,segment:'unknown'},0,{}));
});
test('launch allowance expires after its explicit Phoenix date',async()=>{
 const {effectiveDailyCap}=await import('../outbound-gmail.js');
 const settings={daily_cap:5},env={OUTBOUND_LAUNCH_DATE:'2026-10-06',OUTBOUND_LAUNCH_EXTRA:'1'};
 assert.equal(effectiveDailyCap(settings,env,'2026-10-06'),6);
 assert.equal(effectiveDailyCap(settings,env,'2026-10-07'),5);
 assert.equal(effectiveDailyCap(settings,{},'2026-10-06'),5);
 assert.equal(effectiveDailyCap(settings,{...env,OUTBOUND_LAUNCH_EXTRA:'100'},'2026-10-06'),5);
});
