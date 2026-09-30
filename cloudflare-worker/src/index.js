const ALLOWED_ORIGINS = new Set([
  "https://self-defi.github.io",
  "https://azhomeinstalls.com",
  "https://www.azhomeinstalls.com",
]);

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://azhomeinstalls.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname !== "/estimate" || request.method !== "POST") {
      return json({ error: "Not found" }, 404, origin);
    }

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    try {
      const form = await request.formData();
      const name = String(form.get("name") || "").trim();
      const phone = String(form.get("phone") || "").trim();
      const email = String(form.get("email") || "").trim();
      const zip = String(form.get("zip") || "").trim();
      const service = String(form.get("service") || "").trim();
      const description = String(form.get("description") || "").trim();

      if (!name || !phone || !email || !service || !description) {
        return json({ error: "Please complete all required fields." }, 400, origin);
      }

      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!emailOk) return json({ error: "Please enter a valid email address." }, 400, origin);

      const files = form.getAll("photos").filter(v => v instanceof File && v.size > 0);
      if (files.length > 4) {
        return json({ error: "Please upload no more than 4 images." }, 400, origin);
      }

      const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
      const attachments = [];
      let totalBytes = 0;

      for (const file of files) {
        if (!allowedTypes.has(file.type)) {
          return json({ error: "Only JPG, PNG, and WebP images are allowed." }, 400, origin);
        }
        if (file.size > 5 * 1024 * 1024) {
          return json({ error: "Each image must be 5 MB or smaller." }, 400, origin);
        }
        totalBytes += file.size;
        if (totalBytes > 20 * 1024 * 1024) {
          return json({ error: "Combined photo size must be 20 MB or less." }, 400, origin);
        }
        attachments.push({
          filename: file.name || "project-photo",
          content: await file.arrayBuffer(),
          type: file.type,
          disposition: "attachment",
        });
      }

      const submitted = new Date().toISOString();

      await env.EMAIL.send({
        to: env.DESTINATION_EMAIL,
        from: `estimates@${env.DOMAIN}`,
        replyTo: email,
        subject: `Estimate Request — ${service} — ${name}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#1d1d1f">
            <div style="background:#111;color:#fff;padding:22px 26px;border-radius:12px 12px 0 0">
              <h1 style="margin:0;font-size:24px">AZHomeInstalls Estimate Request</h1>
            </div>
            <div style="border:1px solid #e5e5e5;border-top:0;padding:26px;border-radius:0 0 12px 12px">
              <p><strong>Name:</strong> ${esc(name)}</p>
              <p><strong>Phone:</strong> ${esc(phone)}</p>
              <p><strong>Email:</strong> ${esc(email)}</p>
              <p><strong>ZIP:</strong> ${esc(zip || "Not provided")}</p>
              <p><strong>Service:</strong> ${esc(service)}</p>
              <p><strong>Submitted:</strong> ${esc(submitted)}</p>
              <hr style="border:0;border-top:1px solid #eee;margin:22px 0">
              <p><strong>Project description</strong></p>
              <p style="white-space:pre-wrap">${esc(description)}</p>
              <p><strong>Photos attached:</strong> ${attachments.length}</p>
            </div>
          </div>
        `,
        attachments,
      });

      return json({ success: true }, 200, origin);
    } catch (error) {
      console.error(error);
      return json({ error: "The request could not be sent. Please try again." }, 500, origin);
    }
  },
};
