// Public evidence only. No email guessing, paid discovery service or automatic cross-site crawl.
import { publicSourceUrl } from './public-source-network.js';
import { fetchPublicSource } from './public-source-fetch.js';
export { publicSourceUrl };
const restricted=/\b(?:no\s+(?:vendor\s+|sales\s+)?solicitation|no\s+solicitors?|do\s+not\s+solicit)\b/i;
const relevant={property_manager:/property\s+management|residential\s+management|residents|rental\s+homes/i,design_studio:/interior\s+design|residential\s+design|design\s+studio/i,home_stager:/home\s+staging|staging\s+(?:homes|services)|home\s+stager/i,realtor:/real\s+estate|realtor|realty/i,moving_company:/moving\s+(?:company|services)|movers|relocation/i,builder_new_community:/home\s+builder|new\s+homes|residential\s+construction/i};
const textOf=html=>html.replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
const words=text=>text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim();
async function limitedBody(response) {
 if(Number(response.headers.get('content-length'))>750000)throw Error('Source exceeds review size limit');
 const reader=response.body?.getReader();if(!reader)return '';
 const chunks=[];let size=0;
 try {
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>750000)throw Error('Source exceeds review size limit');chunks.push(value);}
 } finally {await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return new TextDecoder().decode(bytes);
}
export async function solicitationPreflight(env,p,{fetchSource=fetchPublicSource}={}) {
 const checkedAt=new Date().toISOString();
 let status='manual_required',note='Public business evidence requires review',finalUrl=null;
 try {
  if(!publicSourceUrl(p.source_url))throw Error('Public HTTPS source required');
  let url=new URL(p.source_url);const site=url.hostname.replace(/^www\./,'');const seen=new Set();
  const signal=AbortSignal.timeout(10000);
  for(let hop=0;hop<=3;hop++) {
   if(seen.has(url.href))throw Error('Source redirect loop requires review');seen.add(url.href);
   const response=await fetchSource(url.href,{method:'GET',redirect:'manual',signal,headers:{'User-Agent':'AZHomeInstalls-Outreach-Compliance/1.0'}});
   if([301,302,303,307,308].includes(response.status)) {
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location||hop===3)throw Error('Source redirect limit requires review');
    const next=new URL(location,url);
    if(!publicSourceUrl(next.href)||next.hostname.replace(/^www\./,'')!==site)throw Error('Cross-site or unsafe redirect requires review');
    url=next;continue;
   }
   if(!response.ok){await response.body?.cancel();throw Error('Source page returned HTTP '+response.status);}
   if(!/text\/(html|plain)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw Error('Source is not readable HTML/text');}
   const html=await limitedBody(response),text=textOf(html);finalUrl=url.href;
   if(restricted.test(text)){status='blocked';note='Explicit no-solicitation language detected on public source';break;}
   // Match complete published addresses, including mailto links; never infer from a domain.
   const visible=html.replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ');
   const emails=new Set((text+' '+[...visible.matchAll(/href\s*=\s*["']mailto:([^"'?\s]+)/gi)].map(m=>m[1]).join(' ')).match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)?.map(e=>e.toLowerCase())||[]);
   const organization=words(p.organization), normalized=words(text);
   if(p.research_only){note='Research-only discovery record; not eligible for sending';break;}
   if(!emails.has(p.email_normalized)){note='Exact recipient email not found on public source';break;}
   if(!organization||!(' '+normalized+' ').includes(' '+organization+' ')||!relevant[p.segment]?.test(text)||!(/\b(?:Phoenix|Arizona|Gilbert|Chandler|Tempe|Mesa|Scottsdale|East Valley)\b/i.test(text)||(' '+normalized+' ').includes(' '+words(p.city)+' '))){note='Business identity, relevant services or service area not confirmed on public source';break;}
   status='clear';note='Public source confirms business identity, relevant services, exact email and no solicitation restriction';break;
  }
 } catch(error) {
  // Keep diagnostics bounded and avoid storing arbitrary upstream error text.
  note=/^(Source |Public HTTPS|Cross-site)/.test(error.message)?error.message:'Source unavailable or timed out; manual review required';
 }
 const verified=status==='clear';
 const expires=verified?new Date(Date.parse(checkedAt)+7*86400000).toISOString():null;
 await env.LEADS_DB.prepare('UPDATE outbound_prospects_v2 SET solicitation_checked_at=?,solicitation_status=?,solicitation_note=?,validation_status=?,validation_checked_at=?,validation_expires_at=?,validation_note=?,validated_source_url=?,updated_at=? WHERE id=?')
  .bind(checkedAt,status,note,verified?'verified':status,checkedAt,expires,note,finalUrl,checkedAt,p.id).run();
 return {status,note,checked_at:checkedAt,expires_at:expires};
}
