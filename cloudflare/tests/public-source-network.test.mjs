import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {globallyRoutableAddress,publicSourceUrl} from '../public-source-network.js';
import {createPublicSourceFetcher} from '../public-source-fetch.js';
import {solicitationPreflight} from '../outbound-validation.js';

const PUBLIC='93.184.216.34',PUBLIC6='2606:4700:4700::1111';
const prospect={id:1,organization:'Example Management',email_normalized:'public@example.com',segment:'property_manager',city:'Phoenix',source_url:'https://example.com/team',research_only:0};
const evidence=()=>new Response('Example Management property management in Phoenix public@example.com',{headers:{'content-type':'text/html'}});
function dns(answer=(host,type)=>type===1?[{name:host,type,data:PUBLIC}]:[]){
 const calls=[];
 return {calls,fetch:async(value,options)=>{
  const url=new URL(value);calls.push({url,options});
  assert.equal(url.origin+url.pathname,'https://cloudflare-dns.com/dns-query');
  assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
  const host=url.searchParams.get('name'),type=Number(url.searchParams.get('type'));
  return new Response(JSON.stringify({Status:0,TC:false,Question:[{name:host+'.',type}],Answer:answer(host,type)}),{headers:{'content-type':'application/dns-json'}});
 }};
}
async function validate(fetchSource,url=prospect.source_url){
 const writes=[];const env={LEADS_DB:{prepare(){return {bind(...values){writes.push(values);return {async run(){return {meta:{changes:1}};}};}};}}};
 const result=await solicitationPreflight(env,{...prospect,source_url:url},{fetchSource});
 assert.equal(writes.length,1);
 assert.equal(writes[0][3],result.status==='clear'?'verified':result.status);
 if(result.status!=='clear')assert.equal(writes[0][5],null,'Inconclusive checks clear previous validation expiry');
 return result;
}
const noSource=()=>assert.fail('Unsafe or inconclusive DNS must not issue a source request');

test('Cloudflare configuration requires public-only global fetch routing',()=>{
 const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'));
 assert.ok(!config.compatibility_flags.includes('global_fetch_private_origin'));
 assert.ok(!config.global_fetch_private_origin);
});

test('URL gate rejects IP literals, alternate numeric forms and internal hostnames before DNS or HTTP',async()=>{
 const invalid=['http://example.com','https://example.com:444','https://user:pass@example.com',
  'https://127.0.0.1','https://2130706433','https://0x7f000001','https://0177.0.0.1',
  'https://[::1]','https://[::ffff:127.0.0.1]','https://[fe80::1%25eth0]',
  'https://localhost','https://localhost.','https://localhost.example','https://app.local',
  'https://app.internal','https://app.corp','https://app.lan','https://app.home.arpa',
  'https://metadata.google.internal','https://example.com.'];
 for(const url of invalid){
  assert.equal(publicSourceUrl(url),false,url);
  assert.equal((await validate(createPublicSourceFetcher({lookupFetch:noSource,publicFetch:noSource}),url)).status,'manual_required',url);
 }
 assert.equal(publicSourceUrl('https://www.example.com/path'),true);
});

test('address policy excludes private, loopback, link-local, reserved and transition ranges',()=>{
 const unsafe=['0.0.0.0','0.1.2.3','10.0.0.1','100.64.0.1','100.127.255.254','127.0.0.1',
  '169.254.169.254','172.16.0.1','172.31.255.255','192.168.1.1','192.0.0.9','192.0.2.1','192.88.99.1',
  '198.18.0.1','198.19.255.255','198.51.100.1','203.0.113.1','224.0.0.1','240.1.2.3','255.255.255.255',
  '::','::1','::ffff:7f00:1','::ffff:127.0.0.1','64:ff9b::7f00:1','64:ff9b:1::a00:1',
  '100::1','fc00::1','fd12:3456::1','fe80::1','fec0::1','ff02::1','2001::1','2001:2::1',
  '2001:20::1','2001:db8::1','2002:7f00:1::','3ffe::1','3fff::1','not-an-ip','8.8.8.8\n','2606:4700::1\n','127.1','0x7f000001','01.2.3.4'];
 for(const ip of unsafe)assert.equal(globallyRoutableAddress(ip),false,ip);
 for(const ip of [PUBLIC,PUBLIC6,'8.8.8.8','172.15.255.255','172.32.0.1','100.63.255.255','100.128.0.1','2001:4860:4860::8888'])assert.equal(globallyRoutableAddress(ip),true,ip);
});

test('hostnames resolving to unsafe IPv4 or IPv6 never issue a source request',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','100.100.100.200','::1','fd00::1','fe80::1','::ffff:7f00:1','64:ff9b::a00:1']){
  const lookup=dns((host,type)=>type===(ip.includes(':')?28:1)?[{name:host,type,data:ip}]:[]);
  const checked=await validate(createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:noSource}));
  assert.equal(checked.status,'manual_required');assert.match(checked.note,/DNS address/);
 }
});

test('mixed safe/unsafe answers across either DNS family fail closed',async()=>{
 for(const bad of ['10.0.0.1','fd00::1']){
  const lookup=dns((host,type)=>type===1?[{name:host,type,data:PUBLIC},...(bad.includes(':')?[]:[{name:host,type,data:bad}])]:bad.includes(':')?[{name:host,type,data:bad}]:[]);
  assert.equal((await validate(createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:noSource}))).status,'manual_required');
 }
});

test('CNAME chains cannot hide private addresses or internal names',async()=>{
 for(const target of ['metadata.google.internal','service.local','alias.example.com']){
  const lookup=dns((host,type)=>type===1?[{name:host,type:5,data:target},{name:target,type:1,data:target==='alias.example.com'?'169.254.169.254':PUBLIC}]:[]);
  assert.equal((await validate(createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:noSource}))).status,'manual_required');
 }
});

test('safe CNAME chains use only public global fetch with no privileged routing options',async()=>{
 const lookup=dns((host,type)=>[{name:host,type:5,data:'web.example.net.'},...(type===1?[{name:'web.example.net.',type:1,data:PUBLIC}]:[])]);
 let sources=0;
 const fetchSource=createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:async(url,options)=>{
  sources++;assert.equal(url,prospect.source_url);assert.equal(options.redirect,'manual');assert.equal(options.method,'GET');
  assert.equal(options.cf,undefined);assert.equal(options.headers.Host,undefined);assert.equal(options.headers.Authorization,undefined);
  assert.equal(options.cache,'no-store');return evidence();
 }});
 assert.equal((await validate(fetchSource)).status,'clear');assert.equal(sources,1);assert.equal(lookup.calls.length,2);
});

test('a DNS change after preflight is rejected by public-only connection-time egress without fallback',async()=>{
 const lookup=dns();let attempts=0;
 const fetchSource=createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:async()=>{
  // Model the platform boundary, separately exercised by the workerd smoke test:
  // a changed origin now resolves privately, so public-only egress rejects it.
  attempts++;throw Error('Public network policy rejected private destination');
 }});
 assert.equal((await validate(fetchSource)).status,'manual_required');assert.equal(attempts,1);
 assert.equal(lookup.calls.length,2,'No retries, private transport or alternative resolver fallback');
});

test('each redirect repeats DNS validation, including redirects back to the same hostname',async()=>{
 for(const location of ['/contact','https://www.example.com/contact']){
  let requests=0;
  const lookup=dns((host,type)=>type===1?[{name:host,type,data:requests?'10.0.0.1':PUBLIC}]:[]);
  const fetchSource=createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:async()=>{requests++;return new Response(null,{status:302,headers:{location}});}});
  assert.equal((await validate(fetchSource)).status,'manual_required');assert.equal(requests,1);assert.equal(lookup.calls.length,4);
 }
});

test('valid public redirects retain the existing bounded same-site policy',async()=>{
 const lookup=dns(),urls=[];
 const fetchSource=createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:async(url,options)=>{
  assert.equal(options.redirect,'manual');urls.push(url);
  return urls.length===1?new Response(null,{status:301,headers:{location:'https://www.example.com/contact'}}):evidence();
 }});
 assert.equal((await validate(fetchSource)).status,'clear');assert.equal(lookup.calls.length,4);
 assert.deepEqual(urls,['https://example.com/team','https://www.example.com/contact']);
});

test('AAAA-only public hosts are accepted only when both family lookups complete successfully',async()=>{
 const lookup=dns((host,type)=>type===28?[{name:host,type,data:PUBLIC6}]:[]);
 assert.equal((await validate(createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:async()=>evidence()}))).status,'clear');
 assert.equal(lookup.calls.length,2);
});

test('failed, partial, redirected or malformed DNS evidence remains manual review',async()=>{
 const lookup=dns();
 for(const getResponse of [()=>new Response(null,{status:403}),()=>new Response(null,{status:302,headers:{Location:'https://example.com'}}),()=>new Response('not JSON',{headers:{'content-type':'application/dns-json'}}),()=>{throw Error('DNS timeout');}]){
  const fetchSource=createPublicSourceFetcher({lookupFetch:async url=>{assert.equal(new URL(url).hostname,'cloudflare-dns.com');return getResponse();},publicFetch:noSource});
  assert.equal((await validate(fetchSource)).status,'manual_required');
 }
 for(const mutation of [data=>{data.Status=2;},data=>{data.TC=true;},data=>{data.Question[0].name='other.example.net';},data=>{data.Answer=[];},data=>{data.Answer=[{name:'other.example.net',type:1,data:PUBLIC}];},data=>{data.Answer=[{name:'example.com',type:5,data:'loop.example.net'},{name:'loop.example.net',type:5,data:'example.com'}];}]){
  const fetchSource=createPublicSourceFetcher({lookupFetch:async(...args)=>{const res=await lookup.fetch(...args),data=await res.json();mutation(data);return new Response(JSON.stringify(data),{headers:{'content-type':'application/dns-json'}});},publicFetch:noSource});
  assert.equal((await validate(fetchSource)).status,'manual_required');
 }
 // A successful A result must not mask a failed AAAA lookup.
 const partial=createPublicSourceFetcher({lookupFetch:async(url,options)=>Number(new URL(url).searchParams.get('type'))===28?new Response(null,{status:503}):lookup.fetch(url,options),publicFetch:noSource});
 assert.equal((await validate(partial)).status,'manual_required');
});

test('HTTP 403/526 and TLS failures remain inconclusive with public-only transport',async()=>{
 const lookup=dns();
 for(const publicFetch of [async()=>new Response(null,{status:403}),async()=>new Response(null,{status:526}),async()=>{throw Error('TLS certificate verification failed');}])assert.equal((await validate(createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch}))).status,'manual_required');
});


test('DNS size limits, alias depth and cancelled deadlines never issue source requests',async()=>{
 const oversized=createPublicSourceFetcher({lookupFetch:async()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/dns-json'}}),publicFetch:noSource});
 assert.equal((await validate(oversized)).status,'manual_required');
 const deep=dns((host,type)=>Array.from({length:9},(_,i)=>({name:i?'alias'+i+'.example.com':host,type:5,data:'alias'+(i+1)+'.example.com'})).concat(type===1?[{name:'alias9.example.com',type:1,data:PUBLIC}]:[]));
 assert.equal((await validate(createPublicSourceFetcher({lookupFetch:deep.fetch,publicFetch:noSource}))).status,'manual_required');
 const controller=new AbortController();controller.abort(Error('Deadline expired'));
 const lookup=dns();
 await assert.rejects(createPublicSourceFetcher({lookupFetch:lookup.fetch,publicFetch:noSource})(prospect.source_url,{signal:controller.signal}),/Deadline expired/);
});
