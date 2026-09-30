const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
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

      const subject = `New AZHomeInstalls Estimate Request — ${service}`;
      const text = [
        "NEW AZHOMEINSTALLS ESTIMATE REQUEST",
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

      const sendResult = await env.EMAIL.send({
        to: env.DESTINATION_EMAIL,
        from: { email: env.FROM_EMAIL, name: "AZHomeInstalls Website" },
        replyTo: { email, name },
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
      console.error("Estimate submission failed", {
        name: error?.name || "Error",
        code: error?.code || null,
        message: error?.message || String(error),
        stack: error?.stack || null,
        hasEmailBinding: Boolean(env?.EMAIL),
        hasDestinationEmail: Boolean(env?.DESTINATION_EMAIL),
        hasFromEmail: Boolean(env?.FROM_EMAIL)
      });
      return new Response("We could not send your request. Please try again or email info@azhomeinstalls.com.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  }
};
