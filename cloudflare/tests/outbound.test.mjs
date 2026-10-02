import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, normalizeEmail, validateProspect, renderTemplate, outboundApi, OFFSETS } from '../outbound.js';
const prospect={organization:'Example Homes',email:' Public@Example.com ',segment:'property_manager',city:'Phoenix',source_url:'https://example.com/team',fit_reason:'Your public site lists residential management in Phoenix.'};
test('normalization and public evidence are required',()=>{
 assert.equal(normalizeEmail(prospect.email),'public@example.com');
 assert.equal(validateProspect(prospect).domain,'example.com');
 for(const change of [{email:'bad'},{segment:'homeowner'},{source_url:'http://example.com'},{source_url:'https://127.0.0.1'},{source_url:'https://user:pass@example.com'},{fit_reason:''}])
  assert.throws(()=>validateProspect({...prospect,...change}));
});
test('sequence has initial, day 4, day 10 only',()=>{
 assert.deepEqual(OFFSETS,[0,3,9]);
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
