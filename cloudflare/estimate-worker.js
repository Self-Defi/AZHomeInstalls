const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDueFollowups(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

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
