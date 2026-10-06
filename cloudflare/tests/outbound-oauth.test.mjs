import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGmail } from '../outbound-gmail.js';

test('OAuth diagnostics expose only known error codes and never response secrets',async()=>{
 const saved=globalThis.fetch;
 const env={OUTBOUND_GOOGLE_CLIENT_ID:'id',OUTBOUND_GOOGLE_CLIENT_SECRET:'private-secret',OUTBOUND_GOOGLE_REFRESH_TOKEN:'private-refresh'};
 try {
  for(const error of ['invalid_grant','invalid_client','private-refresh']) {
   globalThis.fetch=async()=>new Response(JSON.stringify({error,error_description:'private-secret private-refresh',refresh_token:'private-refresh'}),{status:400});
   const result=await checkGmail(env);
   assert.equal(result.authorized,false);
   const diagnostic=result.blockers.at(-1);
   assert.equal(diagnostic,'Outbound Google authorization failed (HTTP 400'+(error==='private-refresh'?'':'; '+error)+')');
   assert.doesNotMatch(JSON.stringify(result),/private-secret|private-refresh/);
  }
 } finally {globalThis.fetch=saved;}
});
