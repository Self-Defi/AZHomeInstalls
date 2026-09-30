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

export default {
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

      const isValidEmail = (value) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

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
