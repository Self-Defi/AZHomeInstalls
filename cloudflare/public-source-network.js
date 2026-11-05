// Only globally routable addresses may be used for public-source validation.
// Connection-time enforcement is also required; see public-source-fetch.js.
export function publicHostname(host) {
 if(typeof host!=='string'||host!==host.trim()||host.length>253||!host.includes('.')||host.endsWith('.'))return false;
 if(/(^|\.)(localhost|localdomain|local|internal|intranet|corp|lan|home|arpa|onion|test|invalid|example)$/.test(host))return false;
 return host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))&&!/^[\d.]+$/.test(host);
}
export function publicSourceUrl(value) {
 try {
  const u=new URL(value);
  return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&publicHostname(u.hostname);
 } catch {return false;}
}
function ipv4(value) {
 if(typeof value!=='string'||value!==value.trim())return null;
 if(!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value))return null;
 const bytes=value.split('.').map(Number);return bytes.every(n=>n<=255)?bytes:null;
}
function ipv6(value) {
 if(typeof value!=='string'||value!==value.trim())return null;
 if(!/^[a-f\d:]+$/i.test(value)||!value.includes(':'))return null;
 const halves=value.split('::');if(halves.length>2)return null;
 const left=halves[0]?halves[0].split(':'):[],right=halves.length===2&&halves[1]?halves[1].split(':'):[];
 if([...left,...right].some(part=>! /^[a-f\d]{1,4}$/i.test(part)))return null;
 if(halves.length===1&&left.length!==8||halves.length===2&&left.length+right.length>=8)return null;
 return [...left,...Array(8-left.length-right.length).fill('0'),...right].map(part=>parseInt(part,16));
}
export function globallyRoutableAddress(value) {
 if(typeof value!=='string')return false;
 const v4=ipv4(value);
 if(v4){
  const [a,b,c]=v4;
  return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===0&&(c===0||c===2)||b===88&&c===99||b===168)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
 }
 const v6=ipv6(value);
 // Allow only global unicast. This also excludes ULA, link-local, multicast,
 // mapped IPv4, NAT64 and other IPv4 translation/transition address forms.
 if(!v6||(v6[0]&0xe000)!==0x2000)return false;
 if(v6[0]===0x2001&&(v6[1]<0x200||v6[1]===0xdb8))return false;
 if(v6[0]===0x2002||v6[0]===0x3ffe||v6[0]===0x3fff&&(v6[1]&0xf000)===0)return false;
 return true;
}
const resolver='https://cloudflare-dns.com/dns-query';
const canonical=name=>typeof name==='string'?name.toLowerCase().replace(/\.$/,''):'';
async function boundedText(response,limit) {
 if(Number(response.headers.get('content-length'))>limit)throw Error('Source DNS response too large');
 const reader=response.body?.getReader();if(!reader)throw Error('Source DNS response missing');
 const chunks=[];let size=0;
 try {
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('Source DNS response too large');chunks.push(value);}
 } finally {await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export async function resolvePublicAddresses(hostname,{signal,lookupFetch=globalThis.fetch}={}) {
 if(!publicHostname(hostname))throw Error('Source hostname is not public');
 const answers=await Promise.all([1,28].map(async type=>{
  const url=new URL(resolver);url.searchParams.set('name',hostname);url.searchParams.set('type',String(type));
  const response=await lookupFetch(url.href,{redirect:'manual',signal,cache:'no-store',headers:{Accept:'application/dns-json'}});
  if(!response.ok||!/^application\/(?:dns-json|json)(?:;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw Error('Source DNS lookup inconclusive');}
  const data=JSON.parse(await boundedText(response,65536));
  if(data.Status!==0||data.TC!==false||!Array.isArray(data.Question)||data.Question.length!==1||canonical(data.Question[0].name)!==hostname||data.Question[0].type!==type||data.Answer!==undefined&&!Array.isArray(data.Answer))throw Error('Source DNS lookup inconclusive');
  if((data.Answer||[]).some(record=>record.type!==5&&record.type!==type))throw Error('Source DNS answer type is inconsistent');
  return data.Answer||[];
 }));
 const records=answers.flat();if(records.length>128)throw Error('Source DNS answer limit exceeded');
 const aliases=new Map(),addresses=[];
 for(const record of records){
  const name=canonical(record.name);if(!publicHostname(name))throw Error('Source DNS alias is not public');
  if(record.type===5){
   const target=canonical(record.data);
   if(!publicHostname(target)||aliases.has(name)&&aliases.get(name)!==target)throw Error('Source DNS alias is not public or consistent');
   aliases.set(name,target);
  }else if(record.type===1||record.type===28){
   const ip=record.data;
   if(!(record.type===1?ipv4(ip):ipv6(ip))||!globallyRoutableAddress(ip))throw Error('Source DNS address is not globally routable');
   addresses.push({name,ip});
  }else throw Error('Source DNS answer type requires review');
 }
 const seen=new Set();let terminal=hostname;
 while(aliases.has(terminal)){
  if(seen.has(terminal)||seen.size>=8)throw Error('Source DNS alias loop or limit exceeded');
  seen.add(terminal);terminal=aliases.get(terminal);
 }
 if([...aliases.keys()].some(name=>!seen.has(name))||addresses.some(({name})=>name!==terminal)||!addresses.length)throw Error('Source DNS answer chain is inconclusive');
 return [...new Set(addresses.map(({ip})=>ip))].sort((a,b)=>Number(a.includes(':'))-Number(b.includes(':')));
}
