const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
import { outboundApi, syncOutboundProvider } from "./outbound.js";
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}


function makeLeadCode(id) {
  return `AZH-${String(id).padStart(6, "0")}`;
}

async function storeLead(env, lead) {
  if (!env.LEADS_DB) {
    console.warn("Lead database binding missing; email delivery will continue without D1 storage.");
    return null;
  }

  const now = new Date().toISOString();
  const result = await env.LEADS_DB.prepare(
    `INSERT INTO leads (
      lead_code, name, phone, email, zip, service, description,
      photo_count, scope_acknowledgment, source, status,
      followup_stage, next_followup_at, last_contact_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'website', 'new', 0, ?, ?, ?, ?)`
  ).bind(
    "PENDING",
    lead.name,
    lead.phone,
    lead.email,
    lead.zip,
    lead.service,
    lead.description,
    lead.photoCount,
    lead.ack,
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    now,
    now,
    now
  ).run();

  const id = Number(result.meta?.last_row_id);
  if (!id) return null;

  const leadCode = makeLeadCode(id);
  await env.LEADS_DB.prepare(
    "UPDATE leads SET lead_code = ?, updated_at = ? WHERE id = ?"
  ).bind(leadCode, now, id).run();

  await env.LEADS_DB.prepare(
    "INSERT INTO lead_events (lead_id, event_type, detail) VALUES (?, 'lead_created', ?)"
  ).bind(id, JSON.stringify({ source: "website" })).run();

  return { id, leadCode };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}


function randomToken(bytes=24){
  const raw=new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let bin="";
  for(const b of raw) bin+=String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

async function sha256Hex(value){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}

async function ensureEstimateResponseSchema(env){
  if(!env.LEADS_DB) return;
  await env.LEADS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS estimate_responses (
      lead_id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      amount_cents INTEGER NOT NULL,
      response_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    )`
  ).run();
  await env.LEADS_DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_estimate_responses_token_hash ON estimate_responses(token_hash)"
  ).run();
}


const AZ_TIMEZONE="America/Phoenix";
const STANDARD_START_HOUR=8;
const STANDARD_LATEST_START_HOUR=16;
const DEFAULT_JOB_MINUTES=120;
const DEFAULT_BUFFER_MINUTES=30;

function calendarConfigured(env){
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}
async function getGoogleAccessToken(env){
  if(!calendarConfigured(env)) return null;
  const body=new URLSearchParams({
    client_id:String(env.GOOGLE_CLIENT_ID),
    client_secret:String(env.GOOGLE_CLIENT_SECRET),
    refresh_token:String(env.GOOGLE_REFRESH_TOKEN),
    grant_type:"refresh_token"
  });
  const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  if(!r.ok) throw new Error("Google Calendar authentication failed");
  const d=await r.json();
  if(!d.access_token) throw new Error("Google Calendar access token missing");
  return d.access_token;
}
function calendarId(env){return String(env.GOOGLE_CALENDAR_ID||"primary").trim()||"primary"}
async function googleCalendarRequest(env,path,options={}){
  const token=await getGoogleAccessToken(env);
  if(!token) throw new Error("Google Calendar is not configured");
  const r=await fetch("https://www.googleapis.com/calendar/v3"+path,{...options,headers:{...(options.headers||{}),Authorization:"Bearer "+token}});
  const text=await r.text();
  let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!r.ok) throw new Error(data?.error?.message||("Google Calendar HTTP "+r.status));
  return data;
}
function azParts(d){
  return new Intl.DateTimeFormat("en-CA",{timeZone:AZ_TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d).reduce((o,x)=>(o[x.type]=x.value,o),{});
}
function azLocalToISO(y,m,d,h,min=0){
  return new Date(Date.UTC(Number(y),Number(m)-1,Number(d),Number(h)+7,Number(min))).toISOString();
}
async function getCalendarBusy(env,timeMin,timeMax){
  const id=calendarId(env);
  const data=await googleCalendarRequest(env,"/freeBusy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({timeMin,timeMax,timeZone:AZ_TIMEZONE,items:[{id}]})});
  return data?.calendars?.[id]?.busy||[];
}
function overlapsBusy(start,end,busy){
  const s=new Date(start).getTime(),e=new Date(end).getTime();
  return busy.some(b=>s<new Date(b.end).getTime()&&e>new Date(b.start).getTime());
}
async function getCalendarAvailableSlots(env){
  if(!calendarConfigured(env)) return [];
  const jobMinutes=Math.max(30,Number(env.DEFAULT_JOB_MINUTES||DEFAULT_JOB_MINUTES));
  const bufferMinutes=Math.max(0,Number(env.DEFAULT_BUFFER_MINUTES||DEFAULT_BUFFER_MINUTES));
  const stepMinutes=30;
  const now=Date.now(), horizon=new Date(now+14*24*60*60*1000);
  const busy=await getCalendarBusy(env,new Date(now).toISOString(),horizon.toISOString());
  const slots=[];
  for(let day=0;day<14&&slots.length<60;day++){
    const probe=new Date(now+day*24*60*60*1000),p=azParts(probe);
    for(let h=STANDARD_START_HOUR;h<=STANDARD_LATEST_START_HOUR;h++){
      for(let min=0;min<60;min+=stepMinutes){
        if(h===STANDARD_LATEST_START_HOUR&&min>0) continue;
        const start=azLocalToISO(p.year,p.month,p.day,h,min);
        if(new Date(start).getTime()<now+2*60*60*1000) continue;
        const end=new Date(new Date(start).getTime()+jobMinutes*60000).toISOString();
        const blockEnd=new Date(new Date(end).getTime()+bufferMinutes*60000).toISOString();
        if(!overlapsBusy(start,blockEnd,busy)) slots.push({id:"gcal:"+start,start_at:start,source:"google_calendar"});
        if(slots.length>=60) break;
      }
      if(slots.length>=60) break;
    }
  }
  return slots;
}
async function createCalendarBooking(env,lead,startAt){
  const duration=Math.max(30,Number(env.DEFAULT_JOB_MINUTES||DEFAULT_JOB_MINUTES));
  const endAt=new Date(new Date(startAt).getTime()+duration*60000).toISOString();
  const id=encodeURIComponent(calendarId(env));
  const event={
    summary:`AZHomeInstalls — ${lead.service} — ${lead.name}`,
    description:[`Reference: ${lead.lead_code}`,`Customer: ${lead.name}`,`Phone: ${lead.phone||""}`,`Email: ${lead.email}`,`Service: ${lead.service}`].join("\n"),
    start:{dateTime:startAt,timeZone:AZ_TIMEZONE},
    end:{dateTime:endAt,timeZone:AZ_TIMEZONE},
    attendees:isValidEmail(lead.email)?[{email:lead.email}]:[]
  };
  const data=await googleCalendarRequest(env,`/calendars/${id}/events?sendUpdates=all`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(event)});
  return {event_id:data.id||null,html_link:data.htmlLink||null,end_at:endAt};
}

async function ensureSchedulingSchema(env){
  if(!env.LEADS_DB) return;
  await env.LEADS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS installation_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_at TEXT NOT NULL UNIQUE,
      booked_lead_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      booked_at TEXT,
      FOREIGN KEY (booked_lead_id) REFERENCES leads(id) ON DELETE SET NULL
    )`
  ).run();
  await env.LEADS_DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_installation_slots_start ON installation_slots(start_at)"
  ).run();
}

async function getOpenInstallationSlots(env){
  if(calendarConfigured(env)){
    try{return await getCalendarAvailableSlots(env)}catch(e){console.error("Calendar availability failed",e?.message||String(e))}
  }
  await ensureSchedulingSchema(env);
  const now=new Date().toISOString();
  const {results=[]}=await env.LEADS_DB.prepare(
    "SELECT id, start_at FROM installation_slots WHERE booked_lead_id IS NULL AND start_at > ? ORDER BY start_at ASC LIMIT 60"
  ).bind(now).all();
  return results.map(r=>({...r,source:"manual"}));
}

async function logLeadEvent(env, leadId, eventType, detail = {}) {
  if (!env.LEADS_DB || !leadId) return;
  await env.LEADS_DB.prepare(
    "INSERT INTO lead_events (lead_id, event_type, detail) VALUES (?, ?, ?)"
  ).bind(leadId, eventType, JSON.stringify(detail)).run();
}

async function sendCustomerMessage(env, { to, subject, text, html, replyTo }) {
  const from = String(env.FROM_EMAIL || "").trim();
  const recipient = String(to || "").trim();
  if (!isValidEmail(from) || !isValidEmail(recipient)) {
    throw new Error("Invalid sender or recipient address for customer message");
  }

  return env.EMAIL.send({
    to: recipient,
    from,
    replyTo: replyTo || from,
    subject,
    text,
    html
  });
}

async function sendImmediateConfirmation(env, lead) {
  const subject = "We received your AZHomeInstalls request";
  const text = [
    `Hi ${lead.name},`,
    "",
    "Thanks for contacting AZHomeInstalls. We received your project request and will review the details and photos before scheduling.",
    "",
    `Reference: ${lead.leadCode}`,
    `Service: ${lead.service}`,
    "",
    "If you need to add anything, reply directly to this email.",
    "",
    "AZHomeInstalls",
    "Residential Installation Services"
  ].join("\n");

  const html = `
    <p>Hi ${esc(lead.name)},</p>
    <p>Thanks for contacting AZHomeInstalls. We received your project request and will review the details and photos before scheduling.</p>
    <p><strong>Reference:</strong> ${esc(lead.leadCode)}<br>
    <strong>Service:</strong> ${esc(lead.service)}</p>
    <p>If you need to add anything, reply directly to this email.</p>
    <p>AZHomeInstalls<br>Residential Installation Services</p>`;

  await sendCustomerMessage(env, {
    to: lead.email,
    subject,
    text,
    html,
    replyTo: env.FROM_EMAIL
  });
}


function estimateTemplate(lead, amountCents, responseToken) {
  const amount = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(amountCents || 0) / 100);
  const responseUrl = `https://azhomeinstalls.com/estimate-response/?token=${encodeURIComponent(responseToken)}`;
  const subject = `AZHomeInstalls estimate — ${lead.service}`;
  const text = [
    `Hi ${lead.name},`,
    "",
    `We prepared an estimate for your ${lead.service} project.`,
    "",
    `Estimate: ${amount}`,
    `Reference: ${lead.lead_code}`,
    "",
    "Review and respond to your estimate:",
    responseUrl,
    "",
    "You can accept the estimate, decline it, or reply to this email with questions.",
    "",
    "AZHomeInstalls",
    "Residential Installation Services"
  ].join("\\n");
  const html = `
    <p>Hi ${esc(lead.name)},</p>
    <p>We prepared an estimate for your <strong>${esc(lead.service)}</strong> project.</p>
    <p style="font-size:20px"><strong>Estimate: ${esc(amount)}</strong></p>
    <p><strong>Reference:</strong> ${esc(lead.lead_code)}</p>
    <p style="margin:24px 0"><a href="${esc(responseUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:14px 22px;border-radius:10px;font-weight:700">Review &amp; Respond</a></p>
    <p>You can accept the estimate, decline it, or reply to this email with questions.</p>
    <p>AZHomeInstalls<br>Residential Installation Services</p>`;
  return { subject, text, html, amount };
}

function followupTemplate(stage, lead) {
  if (stage === 0) {
    return {
      subject: `AZHomeInstalls — checking in on ${lead.service}`,
      text: `Hi ${lead.name},\n\nWe’re reviewing your ${lead.service} request. If there is anything else we should know about the project, reply to this email and send it over.\n\nReference: ${lead.lead_code}\n\nAZHomeInstalls`,
      html: `<p>Hi ${esc(lead.name)},</p><p>We’re reviewing your <strong>${esc(lead.service)}</strong> request. If there is anything else we should know about the project, reply to this email and send it over.</p><p><strong>Reference:</strong> ${esc(lead.lead_code)}</p><p>AZHomeInstalls</p>`
    };
  }
  if (stage === 1) {
    return {
      subject: `Still interested in your ${lead.service} project?`,
      text: `Hi ${lead.name},\n\nJust checking in on your ${lead.service} project. If you’re ready to move forward, reply here and we’ll coordinate the next step.\n\nReference: ${lead.lead_code}\n\nAZHomeInstalls`,
      html: `<p>Hi ${esc(lead.name)},</p><p>Just checking in on your <strong>${esc(lead.service)}</strong> project. If you’re ready to move forward, reply here and we’ll coordinate the next step.</p><p><strong>Reference:</strong> ${esc(lead.lead_code)}</p><p>AZHomeInstalls</p>`
    };
  }
  return {
    subject: `Final follow-up — ${lead.service}`,
    text: `Hi ${lead.name},\n\nThis is our final follow-up on your ${lead.service} request. If you still want to move forward, just reply to this email and we’ll pick it back up.\n\nReference: ${lead.lead_code}\n\nAZHomeInstalls`,
    html: `<p>Hi ${esc(lead.name)},</p><p>This is our final follow-up on your <strong>${esc(lead.service)}</strong> request. If you still want to move forward, just reply to this email and we’ll pick it back up.</p><p><strong>Reference:</strong> ${esc(lead.lead_code)}</p><p>AZHomeInstalls</p>`
  };
}

async function processDueFollowups(env) {
  if (!env.LEADS_DB || !env.EMAIL) return;

  const now = new Date().toISOString();
  const { results = [] } = await env.LEADS_DB.prepare(
    `SELECT id, lead_code, name, email, service, status, followup_stage, created_at
     FROM leads
     WHERE unsubscribed = 0
       AND status IN ('new', 'contacted', 'estimate_sent')
       AND next_followup_at IS NOT NULL
       AND next_followup_at <= ?
       AND followup_stage < 3
     ORDER BY next_followup_at ASC
     LIMIT 25`
  ).bind(now).all();

  for (const lead of results) {
    try {
      const template = followupTemplate(Number(lead.followup_stage), lead);
      await sendCustomerMessage(env, {
        to: lead.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
        replyTo: env.FROM_EMAIL
      });

      const nextStage = Number(lead.followup_stage) + 1;
      let nextFollowup = null;

      if (nextStage === 1) {
        nextFollowup = new Date(Date.parse(lead.created_at) + 72 * 60 * 60 * 1000).toISOString();
      } else if (nextStage === 2) {
        nextFollowup = new Date(Date.parse(lead.created_at) + 7 * 24 * 60 * 60 * 1000).toISOString();
      }

      await env.LEADS_DB.prepare(
        `UPDATE leads
         SET followup_stage = ?,
             next_followup_at = ?,
             last_contact_at = ?,
             status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,
             updated_at = ?
         WHERE id = ?`
      ).bind(nextStage, nextFollowup, now, now, lead.id).run();

      await logLeadEvent(env, lead.id, "followup_sent", {
        stage: nextStage,
        subject: template.subject
      });
    } catch (error) {
      console.error("Lead follow-up failed", {
        leadId: lead.id,
        leadCode: lead.lead_code,
        message: error?.message || String(error)
      });
      await logLeadEvent(env, lead.id, "followup_failed", {
        stage: Number(lead.followup_stage),
        message: error?.message || String(error)
      });
    }
  }
}


const ADMIN_STATUSES = new Set(["new","contacted","estimate_sent","accepted","scheduled","completed","lost","do_not_contact"]);

function jsonResponse(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}
  });
}

async function getLeadById(env,id){
  return env.LEADS_DB.prepare(
    "SELECT id, lead_code, name, phone, email, zip, service, description, photo_count, scope_acknowledgment, source, status, followup_stage, next_followup_at, last_contact_at, estimate_amount_cents, scheduled_for, completed_at, unsubscribed, created_at, updated_at FROM leads WHERE id = ?"
  ).bind(id).first();
}

async function handleAdminApi(request,env,url){
  if(!env.LEADS_DB) return jsonResponse({error:"Lead database unavailable"},503);
  const parts=url.pathname.split("/").filter(Boolean);

  if(parts.length===3 && parts[0]==="api" && parts[1]==="admin" && parts[2]==="calendar-status"){
    if(request.method!=="GET") return jsonResponse({error:"Method not allowed"},405);
    return jsonResponse({
      configured:calendarConfigured(env),
      calendar_id:calendarConfigured(env)?calendarId(env):null,
      timezone:AZ_TIMEZONE,
      business_hours:{days:"Monday–Sunday",start:"8:00 AM",latest_standard_start:"4:00 PM"},
      after_hours:{enabled:true,label:"Emergency / premium"}
    });
  }

  if(parts.length===3 && parts[0]==="api" && parts[1]==="admin" && parts[2]==="slots"){
    await ensureSchedulingSchema(env);
    if(request.method==="GET"){
      const {results=[]}=await env.LEADS_DB.prepare(
        `SELECT s.id, s.start_at, s.booked_lead_id, s.created_at, s.booked_at,
                l.lead_code, l.name
         FROM installation_slots s
         LEFT JOIN leads l ON l.id=s.booked_lead_id
         WHERE s.start_at > datetime('now','-1 day')
         ORDER BY s.start_at ASC LIMIT 200`
      ).all();
      return jsonResponse({slots:results});
    }
    if(request.method==="POST"){
      const body=await request.json().catch(()=>({}));
      const startAt=String(body.start_at||"").trim();
      const d=new Date(startAt);
      if(!startAt||Number.isNaN(d.getTime())) return jsonResponse({error:"Valid start time is required"},400);
      if(d.getTime()<=Date.now()) return jsonResponse({error:"Installation time must be in the future"},400);
      try{
        const result=await env.LEADS_DB.prepare(
          "INSERT INTO installation_slots (start_at) VALUES (?)"
        ).bind(d.toISOString()).run();
        return jsonResponse({ok:true,id:Number(result.meta?.last_row_id||0)},201);
      }catch(error){
        if(String(error?.message||error).toLowerCase().includes("unique")) return jsonResponse({error:"That installation time already exists"},409);
        throw error;
      }
    }
    return jsonResponse({error:"Method not allowed"},405);
  }

  if(parts.length===4 && parts[0]==="api" && parts[1]==="admin" && parts[2]==="slots"){
    await ensureSchedulingSchema(env);
    const slotId=Number(parts[3]);
    if(!Number.isInteger(slotId)||slotId<1) return jsonResponse({error:"Invalid slot id"},400);
    if(request.method!=="DELETE") return jsonResponse({error:"Method not allowed"},405);
    const slot=await env.LEADS_DB.prepare("SELECT id, booked_lead_id FROM installation_slots WHERE id=?").bind(slotId).first();
    if(!slot) return jsonResponse({error:"Slot not found"},404);
    if(slot.booked_lead_id) return jsonResponse({error:"Booked slots cannot be deleted"},409);
    await env.LEADS_DB.prepare("DELETE FROM installation_slots WHERE id=?").bind(slotId).run();
    return jsonResponse({ok:true});
  }

  if(parts.length===3 && parts[0]==="api" && parts[1]==="admin" && parts[2]==="leads"){
    if(request.method!=="GET") return jsonResponse({error:"Method not allowed"},405);
    const {results=[]}=await env.LEADS_DB.prepare(
      "SELECT id, lead_code, name, phone, email, zip, service, status, followup_stage, next_followup_at, last_contact_at, estimate_amount_cents, scheduled_for, completed_at, unsubscribed, created_at, updated_at FROM leads ORDER BY datetime(created_at) DESC, id DESC LIMIT 500"
    ).all();

    const metrics={new:0,open:0,accepted:0,scheduled:0,completed:0,open_value_cents:0,scheduled_value_cents:0,completed_value_cents:0};
    for(const lead of results){
      const value=Number(lead.estimate_amount_cents||0);
      if(lead.status==="new") metrics.new++;
      if(["new","contacted","estimate_sent","accepted"].includes(lead.status)){ metrics.open++; metrics.open_value_cents+=value; }
      if(lead.status==="accepted") metrics.accepted++;
      if(lead.status==="scheduled"){ metrics.scheduled++; metrics.scheduled_value_cents+=value; }
      if(lead.status==="completed"){ metrics.completed++; metrics.completed_value_cents+=value; }
    }
    return jsonResponse({leads:results,metrics});
  }

  if(parts.length===4 && parts[0]==="api" && parts[1]==="admin" && parts[2]==="leads"){
    const id=Number(parts[3]);
    if(!Number.isInteger(id)||id<1) return jsonResponse({error:"Invalid lead id"},400);

    if(request.method==="GET"){
      const lead=await getLeadById(env,id);
      if(!lead) return jsonResponse({error:"Lead not found"},404);
      const {results:events=[]}=await env.LEADS_DB.prepare(
        "SELECT id, event_type, detail, created_at FROM lead_events WHERE lead_id = ? ORDER BY id DESC LIMIT 100"
      ).bind(id).all();
      return jsonResponse({lead,events});
    }

    if(request.method==="PATCH"){
      const lead=await getLeadById(env,id);
      if(!lead) return jsonResponse({error:"Lead not found"},404);
      const body=await request.json();

      let status=body.status===undefined?lead.status:String(body.status);
      if(!ADMIN_STATUSES.has(status)) return jsonResponse({error:"Invalid status"},400);

      let amount=lead.estimate_amount_cents;
      if(body.estimate_amount_cents!==undefined){
        amount=(body.estimate_amount_cents===null||body.estimate_amount_cents==="")?null:Math.round(Number(body.estimate_amount_cents));
        if(amount!==null&&!Number.isFinite(amount)) return jsonResponse({error:"Invalid estimate amount"},400);
      }

      let scheduled=body.scheduled_for===undefined?lead.scheduled_for:(body.scheduled_for||null);
      if(status==="accepted"&&scheduled) status="scheduled";
      let nextFollow=body.next_followup_at===undefined?lead.next_followup_at:(body.next_followup_at||null);
      let unsub=body.unsubscribed===undefined?Number(lead.unsubscribed||0):(body.unsubscribed?1:0);
      let completed=lead.completed_at;

      if(["accepted","scheduled","completed","lost","do_not_contact"].includes(status)) nextFollow=null;
      if(status==="completed"&&!completed) completed=new Date().toISOString();
      if(status!=="completed") completed=null;
      if(status==="do_not_contact") unsub=1;

      const now=new Date().toISOString();
      await env.LEADS_DB.prepare(
        "UPDATE leads SET status=?, estimate_amount_cents=?, scheduled_for=?, next_followup_at=?, completed_at=?, unsubscribed=?, updated_at=? WHERE id=?"
      ).bind(status,amount,scheduled,nextFollow,completed,unsub,now,id).run();

      await logLeadEvent(env,id,"lead_updated",{
        status,
        estimate_amount_cents:amount,
        scheduled_for:scheduled,
        next_followup_at:nextFollow,
        unsubscribed:unsub
      });

      return jsonResponse({lead:await getLeadById(env,id)});
    }

    return jsonResponse({error:"Method not allowed"},405);
  }


  if(parts.length===5 && parts[0]==="api" && parts[1]==="admin" && parts[2]==="leads" && parts[4]==="note"){
    const id=Number(parts[3]);
    if(!Number.isInteger(id)||id<1) return jsonResponse({error:"Invalid lead id"},400);
    if(request.method!=="POST") return jsonResponse({error:"Method not allowed"},405);
    const lead=await getLeadById(env,id);
    if(!lead) return jsonResponse({error:"Lead not found"},404);
    const body=await request.json();
    const note=String(body.note||"").trim();
    if(!note) return jsonResponse({error:"Note is required"},400);
    if(note.length>4000) return jsonResponse({error:"Note is too long"},400);
    await logLeadEvent(env,id,"internal_note",{note});
    return jsonResponse({ok:true});
  }

  if(parts.length===5 && parts[0]==="api" && parts[1]==="admin" && parts[2]==="leads" && parts[4]==="estimate"){
    const id=Number(parts[3]);
    if(!Number.isInteger(id)||id<1) return jsonResponse({error:"Invalid lead id"},400);
    if(request.method!=="POST") return jsonResponse({error:"Method not allowed"},405);
    if(!env.EMAIL) return jsonResponse({error:"Email binding unavailable"},503);

    const lead=await getLeadById(env,id);
    if(!lead) return jsonResponse({error:"Lead not found"},404);
    if(Number(lead.unsubscribed||0)===1||lead.status==="do_not_contact"){
      return jsonResponse({error:"Lead cannot receive email"},409);
    }

    const body=await request.json();
    const amountCents=Math.round(Number(body.estimate_amount_cents));
    if(!Number.isFinite(amountCents)||amountCents<=0) return jsonResponse({error:"Valid estimate amount is required"},400);

    await ensureEstimateResponseSchema(env);
    const responseToken=randomToken();
    const tokenHash=await sha256Hex(responseToken);
    const template=estimateTemplate(lead,amountCents,responseToken);
    await sendCustomerMessage(env,{
      to:lead.email,
      subject:template.subject,
      text:template.text,
      html:template.html,
      replyTo:env.FROM_EMAIL
    });

    const now=new Date().toISOString();
    await env.LEADS_DB.prepare(
      `INSERT INTO estimate_responses (lead_id, token_hash, amount_cents, response_status, created_at, responded_at)
       VALUES (?, ?, ?, 'pending', ?, NULL)
       ON CONFLICT(lead_id) DO UPDATE SET
         token_hash=excluded.token_hash,
         amount_cents=excluded.amount_cents,
         response_status='pending',
         created_at=excluded.created_at,
         responded_at=NULL`
    ).bind(id,tokenHash,amountCents,now).run();
    const nextFollowup=new Date(Date.now()+48*60*60*1000).toISOString();
    await env.LEADS_DB.prepare(
      "UPDATE leads SET status='estimate_sent', estimate_amount_cents=?, next_followup_at=?, last_contact_at=?, updated_at=? WHERE id=?"
    ).bind(amountCents,nextFollowup,now,now,id).run();
    await logLeadEvent(env,id,"estimate_sent",{amount_cents:amountCents,subject:template.subject});
    return jsonResponse({ok:true,lead:await getLeadById(env,id)});
  }

  if(parts.length===5 && parts[0]==="api" && parts[1]==="admin" && parts[2]==="leads" && parts[4]==="followup"){
    const id=Number(parts[3]);
    if(!Number.isInteger(id)||id<1) return jsonResponse({error:"Invalid lead id"},400);
    if(request.method!=="POST") return jsonResponse({error:"Method not allowed"},405);
    if(!env.EMAIL) return jsonResponse({error:"Email binding unavailable"},503);

    const lead=await getLeadById(env,id);
    if(!lead) return jsonResponse({error:"Lead not found"},404);
    if(Number(lead.unsubscribed||0)===1||lead.status==="do_not_contact"){
      return jsonResponse({error:"Lead is not eligible for nurture emails"},409);
    }

    const stage=Math.min(Number(lead.followup_stage||0),2);
    const template=followupTemplate(stage,lead);

    await sendCustomerMessage(env,{
      to:lead.email,
      subject:template.subject,
      text:template.text,
      html:template.html,
      replyTo:env.FROM_EMAIL
    });

    const now=new Date().toISOString();
    const nextStage=Math.min(stage+1,3);
    let nextFollowup=null;
    if(nextStage===1) nextFollowup=new Date(Date.now()+48*60*60*1000).toISOString();
    if(nextStage===2) nextFollowup=new Date(Date.now()+4*24*60*60*1000).toISOString();

    await env.LEADS_DB.prepare(
      "UPDATE leads SET followup_stage=?, next_followup_at=?, last_contact_at=?, status=CASE WHEN status='new' THEN 'contacted' ELSE status END, updated_at=? WHERE id=?"
    ).bind(nextStage,nextFollowup,now,now,id).run();

    await logLeadEvent(env,id,"manual_followup_sent",{stage:nextStage,subject:template.subject});
    return jsonResponse({ok:true,lead:await getLeadById(env,id)});
  }

  return jsonResponse({error:"Admin API route not found"},404);
}


async function getEstimateResponseByToken(env,token){
  if(!env.LEADS_DB||!token) return null;
  await ensureEstimateResponseSchema(env);
  const tokenHash=await sha256Hex(token);
  return env.LEADS_DB.prepare(
    `SELECT er.lead_id, er.amount_cents, er.response_status, er.created_at, er.responded_at,
            l.lead_code, l.name, l.email, l.phone, l.service, l.status, l.scheduled_for
     FROM estimate_responses er
     JOIN leads l ON l.id=er.lead_id
     WHERE er.token_hash=?`
  ).bind(tokenHash).first();
}

async function notifyEstimateResponse(env,lead,action){
  if(!env.EMAIL) return;
  const destination=String(env.DESTINATION_EMAIL||"").trim();
  if(!isValidEmail(destination)) return;
  const accepted=action==="accept";
  const amount=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(lead.amount_cents||0)/100);
  const subject=`Estimate ${accepted?"accepted":"declined"} — ${lead.lead_code}`;
  const text=[
    `${lead.name} has ${accepted?"accepted":"declined"} the AZHomeInstalls estimate.`,
    "",
    `Reference: ${lead.lead_code}`,
    `Service: ${lead.service}`,
    `Estimate: ${amount}`,
    `Customer: ${lead.name}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone||""}`
  ].join("\n");
  await sendCustomerMessage(env,{to:destination,subject,text,html:`<p><strong>${esc(lead.name)}</strong> has ${accepted?"accepted":"declined"} the estimate.</p><p><strong>Reference:</strong> ${esc(lead.lead_code)}<br><strong>Service:</strong> ${esc(lead.service)}<br><strong>Estimate:</strong> ${esc(amount)}<br><strong>Email:</strong> ${esc(lead.email)}<br><strong>Phone:</strong> ${esc(lead.phone||"")}</p>`,replyTo:lead.email});
}

async function sendAcceptanceConfirmation(env,lead){
  if(!env.EMAIL) return;
  const amount=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(lead.amount_cents||0)/100);
  await sendCustomerMessage(env,{
    to:lead.email,
    subject:`Estimate accepted — ${lead.service}`,
    text:[`Hi ${lead.name},`,"",`We received your acceptance for the ${lead.service} estimate of ${amount}.`,"","We’ll contact you to coordinate scheduling.", "",`Reference: ${lead.lead_code}`,"","AZHomeInstalls"].join("\n"),
    html:`<p>Hi ${esc(lead.name)},</p><p>We received your acceptance for the <strong>${esc(lead.service)}</strong> estimate of <strong>${esc(amount)}</strong>.</p><p>We’ll contact you to coordinate scheduling.</p><p><strong>Reference:</strong> ${esc(lead.lead_code)}</p><p>AZHomeInstalls</p>`,
    replyTo:env.FROM_EMAIL
  });
}

async function sendSchedulingConfirmation(env,lead,startAt){
  if(!env.EMAIL) return;
  const when=new Intl.DateTimeFormat("en-US",{timeZone:"America/Phoenix",weekday:"long",month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(startAt));
  const customerSubject=`Installation scheduled — ${lead.service}`;
  await sendCustomerMessage(env,{
    to:lead.email,
    subject:customerSubject,
    text:[`Hi ${lead.name},`,"",`Your AZHomeInstalls installation is scheduled for ${when} Arizona time.`,"",`Reference: ${lead.lead_code}`,`Service: ${lead.service}`,"","If you need to make a change, reply to this email.","","AZHomeInstalls"].join("\n"),
    html:`<p>Hi ${esc(lead.name)},</p><p>Your AZHomeInstalls installation is scheduled for <strong>${esc(when)} Arizona time</strong>.</p><p><strong>Reference:</strong> ${esc(lead.lead_code)}<br><strong>Service:</strong> ${esc(lead.service)}</p><p>If you need to make a change, reply to this email.</p><p>AZHomeInstalls</p>`,
    replyTo:env.FROM_EMAIL
  });
  const destination=String(env.DESTINATION_EMAIL||"").trim();
  if(isValidEmail(destination)){
    await sendCustomerMessage(env,{
      to:destination,
      subject:`Installation scheduled — ${lead.lead_code}`,
      text:[`${lead.name} selected an installation time.`,"",`Reference: ${lead.lead_code}`,`Service: ${lead.service}`,`Scheduled: ${when} Arizona time`,`Phone: ${lead.phone||""}`,`Email: ${lead.email}`].join("\n"),
      html:`<p><strong>${esc(lead.name)}</strong> selected an installation time.</p><p><strong>Reference:</strong> ${esc(lead.lead_code)}<br><strong>Service:</strong> ${esc(lead.service)}<br><strong>Scheduled:</strong> ${esc(when)} Arizona time<br><strong>Phone:</strong> ${esc(lead.phone||"")}<br><strong>Email:</strong> ${esc(lead.email)}</p>`,
      replyTo:lead.email
    });
  }
}

async function handleEstimateResponseApi(request,env,url){
  if(!env.LEADS_DB) return jsonResponse({error:"Lead database unavailable"},503);
  const token=String(url.searchParams.get("token")||"").trim();
  if(!token) return jsonResponse({error:"Missing estimate token"},400);
  const record=await getEstimateResponseByToken(env,token);
  if(!record) return jsonResponse({error:"Estimate link is invalid"},404);

  if(request.method==="GET"){
    return jsonResponse({
      lead_code:record.lead_code,
      name:record.name,
      service:record.service,
      amount_cents:Number(record.amount_cents||0),
      response_status:record.response_status,
      lead_status:record.status,
      scheduled_for:record.scheduled_for||null,
      available_slots:record.response_status==="accepted"&&record.status==="accepted"?await getOpenInstallationSlots(env):[],
      responded_at:record.responded_at
    });
  }

  if(request.method!=="POST") return jsonResponse({error:"Method not allowed"},405);
  const body=await request.json().catch(()=>({}));
  const action=String(body.action||"");
  if(!["accept","decline","schedule"].includes(action)) return jsonResponse({error:"Invalid response"},400);

  if(action==="schedule"){
    if(record.response_status!=="accepted"||record.status!=="accepted") return jsonResponse({error:"Estimate must be accepted before scheduling"},409);
    const rawSlot=String(body.slot_id||"");
    if(rawSlot.startsWith("gcal:")){
      if(!calendarConfigured(env)) return jsonResponse({error:"Calendar scheduling is unavailable"},503);
      const startAt=rawSlot.slice(5);
      if(Number.isNaN(new Date(startAt).getTime())||new Date(startAt).getTime()<=Date.now()) return jsonResponse({error:"Installation time is no longer available"},409);
      const available=await getCalendarAvailableSlots(env);
      if(!available.some(s=>s.id===rawSlot)) return jsonResponse({error:"Installation time was just booked. Please choose another."},409);
      const now=new Date().toISOString();
      const refreshedLead=await getEstimateResponseByToken(env,token);
      const booking=await createCalendarBooking(env,refreshedLead,startAt);
      const update=await env.LEADS_DB.prepare("UPDATE leads SET status='scheduled', scheduled_for=?, next_followup_at=NULL, last_contact_at=?, updated_at=? WHERE id=? AND status='accepted'").bind(startAt,now,now,record.lead_id).run();
      if(Number(update?.meta?.changes||0)!==1) return jsonResponse({error:"Lead could not be scheduled"},409);
      await logLeadEvent(env,record.lead_id,"installation_scheduled",{scheduled_for:startAt,source:"customer_google_calendar",calendar_event_id:booking.event_id});
      const refreshed=await getEstimateResponseByToken(env,token);
      try{await sendSchedulingConfirmation(env,refreshed,startAt)}catch(e){console.error("Scheduling confirmation failed",e?.message||String(e))}
      return jsonResponse({ok:true,response_status:"accepted",lead_status:"scheduled",scheduled_for:startAt,calendar_event_id:booking.event_id});
    }
    await ensureSchedulingSchema(env);
    const slotId=Number(rawSlot);
    if(!Number.isInteger(slotId)||slotId<1) return jsonResponse({error:"Valid installation time is required"},400);
    const slot=await env.LEADS_DB.prepare("SELECT id, start_at, booked_lead_id FROM installation_slots WHERE id=?").bind(slotId).first();
    if(!slot) return jsonResponse({error:"Installation time is no longer available"},404);
    if(slot.booked_lead_id) return jsonResponse({error:"Installation time was just booked. Please choose another."},409);
    if(new Date(slot.start_at).getTime()<=Date.now()) return jsonResponse({error:"Installation time is no longer available"},409);
    const now=new Date().toISOString();
    const results=await env.LEADS_DB.batch([
      env.LEADS_DB.prepare("UPDATE installation_slots SET booked_lead_id=?, booked_at=? WHERE id=? AND booked_lead_id IS NULL").bind(record.lead_id,now,slotId),
      env.LEADS_DB.prepare("UPDATE leads SET status='scheduled', scheduled_for=?, next_followup_at=NULL, last_contact_at=?, updated_at=? WHERE id=? AND status='accepted'").bind(slot.start_at,now,now,record.lead_id)
    ]);
    const slotChanges=Number(results?.[0]?.meta?.changes||0);
    const leadChanges=Number(results?.[1]?.meta?.changes||0);
    if(slotChanges!==1||leadChanges!==1) return jsonResponse({error:"Installation time could not be reserved. Please refresh and choose another."},409);
    await logLeadEvent(env,record.lead_id,"installation_scheduled",{slot_id:slotId,scheduled_for:slot.start_at,source:"customer_manual_slot"});
    const refreshed=await getEstimateResponseByToken(env,token);
    try{await sendSchedulingConfirmation(env,refreshed,slot.start_at)}catch(e){console.error("Scheduling confirmation failed",e?.message||String(e))}
    return jsonResponse({ok:true,response_status:"accepted",lead_status:"scheduled",scheduled_for:slot.start_at});
  }

  if(record.response_status!=="pending"){
    return jsonResponse({ok:true,already_responded:true,response_status:record.response_status,lead_status:record.status,scheduled_for:record.scheduled_for||null,available_slots:record.response_status==="accepted"&&record.status==="accepted"?await getOpenInstallationSlots(env):[]});
  }

  const now=new Date().toISOString();
  if(action==="accept"){
    await env.LEADS_DB.prepare(
      "UPDATE leads SET status='accepted', next_followup_at=NULL, last_contact_at=?, updated_at=? WHERE id=?"
    ).bind(now,now,record.lead_id).run();
    await env.LEADS_DB.prepare(
      "UPDATE estimate_responses SET response_status='accepted', responded_at=? WHERE lead_id=?"
    ).bind(now,record.lead_id).run();
    await logLeadEvent(env,record.lead_id,"estimate_accepted",{amount_cents:Number(record.amount_cents||0),source:"customer_link"});
  }else{
    await env.LEADS_DB.prepare(
      "UPDATE leads SET status='lost', next_followup_at=NULL, last_contact_at=?, updated_at=? WHERE id=?"
    ).bind(now,now,record.lead_id).run();
    await env.LEADS_DB.prepare(
      "UPDATE estimate_responses SET response_status='declined', responded_at=? WHERE lead_id=?"
    ).bind(now,record.lead_id).run();
    await logLeadEvent(env,record.lead_id,"estimate_declined",{amount_cents:Number(record.amount_cents||0),source:"customer_link"});
  }

  const refreshed=await getEstimateResponseByToken(env,token);
  try{await notifyEstimateResponse(env,refreshed,action)}catch(e){console.error("Estimate response admin notification failed",e?.message||String(e))}
  if(action==="accept"){
    try{await sendAcceptanceConfirmation(env,refreshed)}catch(e){console.error("Estimate acceptance confirmation failed",e?.message||String(e))}
  }
  return jsonResponse({ok:true,response_status:action==="accept"?"accepted":"declined",lead_status:action==="accept"?"accepted":"lost",available_slots:action==="accept"?await getOpenInstallationSlots(env):[]});
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      processDueFollowups(env),
      syncOutboundProvider(env).catch(error => {
        console.error("Outbound provider sync failed", { message: error?.message || String(error) });
      })
    ]));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/admin/outbound/")) {
      return outboundApi(request, env, url);
    }

    if (url.pathname === "/api/estimate-response") {
      try {
        return await handleEstimateResponseApi(request, env, url);
      } catch (error) {
        console.error("Estimate response API failed", { message: error?.message || String(error) });
        return jsonResponse({ error: "Estimate response request failed" }, 500);
      }
    }

    if (url.pathname.startsWith("/api/admin/")) {
      try {
        return await handleAdminApi(request, env, url);
      } catch (error) {
        console.error("Admin API failed", {
          path: url.pathname,
          method: request.method,
          message: error?.message || String(error)
        });
        return jsonResponse({ error: "Admin API request failed" }, 500);
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const form = await request.formData();

      // Honeypot
      if (String(form.get("website") || "").trim()) {
        return Response.redirect("https://azhomeinstalls.com/thanks/", 303);
      }

      const name = String(form.get("name") || "").trim();
      const phone = String(form.get("phone") || "").trim();
      const email = String(form.get("email") || "").trim();
      const zip = String(form.get("zip") || "").trim();
      const service = String(form.get("service") || "").trim();
      const description = String(form.get("description") || "").trim();
      const ack = String(form.get("scope_acknowledgment") || "").trim();

      if (!name || !phone || !email || !zip || !service || !description || !ack) {
        return new Response("Missing required fields", { status: 400 });
      }

      const attachments = [];
      let totalBytes = 0;

      for (const key of ["attachment1", "attachment2", "attachment3"]) {
        const file = form.get(key);
        if (!file || typeof file === "string" || file.size === 0) continue;

        if (!ALLOWED_TYPES.has(file.type)) {
          return new Response("Only JPG, PNG, and WebP images are allowed.", { status: 400 });
        }

        totalBytes += file.size;
        if (totalBytes > MAX_TOTAL_BYTES) {
          return new Response("Combined photo upload is too large. Please keep it under 4 MB.", { status: 413 });
        }

        attachments.push({
          content: arrayBufferToBase64(await file.arrayBuffer()),
          filename: file.name || key,
          type: file.type,
          disposition: "attachment"
        });
      }

      const storedLead = await storeLead(env, {
        name,
        phone,
        email,
        zip,
        service,
        description,
        photoCount: attachments.length,
        ack
      });

      const leadRef = storedLead?.leadCode ? ` [${storedLead.leadCode}]` : "";
      const subject = `New AZHomeInstalls Estimate Request${leadRef} — ${service}`;
      const text = [
        "NEW AZHOMEINSTALLS ESTIMATE REQUEST",
        storedLead?.leadCode ? `Lead ID: ${storedLead.leadCode}` : "",
        "",
        `Name: ${name}`,
        `Phone: ${phone}`,
        `Email: ${email}`,
        `ZIP: ${zip}`,
        `Service: ${service}`,
        "",
        "Project description:",
        description,
        "",
        `Scope acknowledgment: ${ack}`,
        `Photos attached: ${attachments.length}`
      ].join("\n");

      const html = `
        <h2>New AZHomeInstalls Estimate Request</h2>
        ${storedLead?.leadCode ? `<p><strong>Lead ID:</strong> ${esc(storedLead.leadCode)}</p>` : ""}
        <table cellpadding="7" cellspacing="0" border="0">
          <tr><td><strong>Name</strong></td><td>${esc(name)}</td></tr>
          <tr><td><strong>Phone</strong></td><td>${esc(phone)}</td></tr>
          <tr><td><strong>Email</strong></td><td>${esc(email)}</td></tr>
          <tr><td><strong>ZIP</strong></td><td>${esc(zip)}</td></tr>
          <tr><td><strong>Service</strong></td><td>${esc(service)}</td></tr>
          <tr><td><strong>Photos</strong></td><td>${attachments.length}</td></tr>
        </table>
        <h3>Project description</h3>
        <p>${esc(description).replace(/\n/g, "<br>")}</p>
        <p><strong>Scope acknowledgment:</strong> ${esc(ack)}</p>`;

      const destinationEmail = String(env.DESTINATION_EMAIL || "").trim();
      const fromEmail = String(env.FROM_EMAIL || "").trim();
      const replyToEmail = String(email || "").trim();

      const addressValidation = {
        destination: isValidEmail(destinationEmail),
        from: isValidEmail(fromEmail),
        replyTo: isValidEmail(replyToEmail)
      };

      if (!addressValidation.destination || !addressValidation.from || !addressValidation.replyTo) {
        console.error(
          "Estimate email address validation failed: " +
            JSON.stringify(addressValidation)
        );
        return new Response(
          "We could not send your request. Please try again or email info@azhomeinstalls.com.",
          { status: 500 }
        );
      }

      const sendResult = await env.EMAIL.send({
        to: destinationEmail,
        from: fromEmail,
        replyTo: replyToEmail,
        subject,
        text,
        html,
        attachments
      });

      console.log("Estimate email sent", {
        messageId: sendResult?.messageId || null,
        attachmentCount: attachments.length
      });

      if (storedLead?.id) {
        await logLeadEvent(env, storedLead.id, "internal_notification_sent", {
          messageId: sendResult?.messageId || null
        });

        try {
          await sendImmediateConfirmation(env, {
            name,
            email,
            service,
            leadCode: storedLead.leadCode
          });
          await logLeadEvent(env, storedLead.id, "customer_confirmation_sent", {
            to: email
          });
        } catch (confirmationError) {
          console.error("Customer confirmation failed", {
            leadId: storedLead.id,
            message: confirmationError?.message || String(confirmationError)
          });
          await logLeadEvent(env, storedLead.id, "customer_confirmation_failed", {
            message: confirmationError?.message || String(confirmationError)
          });
        }
      }

      return Response.redirect("https://azhomeinstalls.com/thanks/", 303);
    } catch (error) {
      const errorDetails = {
        name: error?.name || "Error",
        code: error?.code || null,
        message: error?.message || String(error),
        hasEmailBinding: Boolean(env?.EMAIL),
        hasDestinationEmail: Boolean(env?.DESTINATION_EMAIL),
        hasFromEmail: Boolean(env?.FROM_EMAIL)
      };
      console.error("Estimate submission failed: " + JSON.stringify(errorDetails));
      return new Response("We could not send your request. Please try again or email info@azhomeinstalls.com.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  }
};
