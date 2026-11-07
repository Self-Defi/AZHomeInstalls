// Optional, rate-limited public-web discovery. Never auto-approve a search result.
// Brave Search API key must be configured as OUTBOUND_BRAVE_SEARCH_API_KEY.
// Each discovered candidate must independently pass solicitationPreflight before enrollment.
import { publicSourceUrl } from './public-source-network.js';
import { fetchPublicSource } from './public-source-fetch.js';

const searches=[
 {segment:'design_studio',q:'Phoenix Scottsdale interior design studio contact email'},
 {segment:'home_stager',q:'Phoenix Arizona home staging company contact email'},
 {segment:'property_manager',q:'Phoenix residential property management contact email'},
 {segment:'realtor',q:'Scottsdale realtor team contact email'},
 {segment:'moving_company',q:'Phoenix residential moving company contact email'},
 {segment:'builder_new_community',q:'Phoenix new home builder community contact email'}
];
const badHost=/\b(?:facebook|instagram|linkedin|yelp|yellowpages|mapquest|pinterest|houzz|angi|thumbtack|reddit|google|bing|brave|bbb|indeed|zillow|realtor\.com)\b/i;
const clean=s=>String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
const emailPattern=/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const bounded=async response=>{if(Number(response.headers.get('content-length'))>300000)throw Error('large');const t=await response.text();if(t.length>300000)throw Error('large');return t};
export async function discoverProspects(env,{fetchPage=fetchPublicSource,fetchSearch=fetch}={}){
 const key=String(env.OUTBOUND_BRAVE_SEARCH_API_KEY||'');
 if(!key)return {enabled:false,reason:'search_api_key_missing'};
 const db=env.LEADS_DB;
 const today=new Date().toISOString().slice(0,10);
 const cycle=Math.floor(Date.parse(today+'T00:00:00Z')/86400000);
 const search=searches[cycle%searches.length];
 const endpoint=new URL('https://api.search.brave.com/res/v1/web/search');
 endpoint.searchParams.set('q',search.q);
 endpoint.searchParams.set('count','10');
 const response=await fetchSearch(endpoint.href,{headers:{'Accept':'application/json','X-Subscription-Token':key},signal:AbortSignal.timeout(10000)});
 if(!response.ok)return {enabled:true,error:'search_http_'+response.status};
 const results=(await response.json()).web?.results||[];
 let found=0,reviewed=0;
 for(const result of results.slice(0,10)){
  if(found>=5)break;
  const url=String(result.url||'');
  if(!publicSourceUrl(url))continue;
  const host=new URL(url).hostname.replace(/^www\./,'');
  if(badHost.test(host))continue;
  try{
   const page=await fetchPage(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000)});
   if(!page.ok||!/text\/html/i.test(page.headers.get('content-type')||''))continue;
   const html=await bounded(page);
   const addresses=[...new Set((html.match(emailPattern)||[]).map(x=>x.toLowerCase()))].filter(e=>e.endsWith('@'+host)&&!/(example|noreply|no-reply|privacy|support@)/i.test(e)).slice(0,2);
   const title=clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]).split(/[|–—]/)[0].trim().slice(0,160);
   if(!title||title.length<4)continue;
   for(const email of addresses){
    reviewed++;
    const existing=await db.prepare('SELECT 1 FROM outbound_prospects_v2 WHERE email_normalized=?').bind(email).first();
    const suppressed=await db.prepare('SELECT 1 FROM email_suppressions WHERE email_normalized=?').bind(email).first();
    if(existing||suppressed)continue;
    const at=new Date().toISOString();
    await db.prepare(`INSERT OR IGNORE INTO outbound_prospects_v2(organization,domain,email,email_normalized,segment,city,source_url,source_observed_at,fit_reason,solicitation_checked_at,stage,wave_number,priority,validation_status,solicitation_status,research_only,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'prospect',2,'B','pending','manual_required',1,?,?)`)
     .bind(title,host,email,email,search.segment,'Phoenix',url,at,'Public search candidate; independent validation required',at,at,at).run();
    found++;
   }
  }catch{/* Failed public sources are skipped, never approved. */}
 }
 return {enabled:true,segment:search.segment,reviewed,added:found};
}
