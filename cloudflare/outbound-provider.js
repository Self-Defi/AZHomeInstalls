const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";

export function outboundProviderStatus(env) {
  const provider = String(env.OUTBOUND_PROVIDER || "instantly").trim().toLowerCase();
  const blockers = [];
  if (provider !== "instantly") blockers.push("Unsupported outbound provider");
  if (!env.INSTANTLY_API_KEY) blockers.push("Instantly API v2 key missing");
  if (!env.INSTANTLY_CAMPAIGN_ID) blockers.push("Instantly campaign ID missing");
  if (!env.OUTBOUND_WEBHOOK_SECRET) blockers.push("Outbound webhook secret missing");
  return {
    provider,
    configured: blockers.length === 0,
    blockers
  };
}

async function instantlyRequest(env, path, options = {}) {
  if (!env.INSTANTLY_API_KEY) throw new Error("Instantly API key is not configured");
  const response = await fetch(INSTANTLY_BASE + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + env.INSTANTLY_API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.message || data?.error || ("Instantly HTTP " + response.status);
    throw new Error(String(message));
  }
  return data;
}

export async function addProspectToInstantly(env, prospect) {
  const campaign = String(env.INSTANTLY_CAMPAIGN_ID || "").trim();
  if (!campaign) throw new Error("Instantly campaign ID is not configured");
  const data = await instantlyRequest(env, "/leads", {
    method: "POST",
    body: JSON.stringify({
      campaign,
      email: prospect.email_normalized,
      personalization: prospect.personalization_hook || prospect.fit_reason || "",
      website: prospect.domain ? "https://" + prospect.domain : undefined,
      company_name: prospect.organization,
      job_title: prospect.role || undefined,
      skip_if_in_workspace: true,
      skip_if_in_campaign: true,
      verify_leads_on_import: true,
      custom_variables: {
        ahi_prospect_id: String(prospect.id),
        ahi_wave: Number(prospect.wave_number || 1),
        ahi_priority: prospect.priority || "B",
        ahi_segment: prospect.segment || ""
      }
    })
  });
  return {
    provider: "instantly",
    lead_id: data?.id || null,
    campaign_id: data?.campaign || campaign,
    verification_status: data?.verification_status == null ? null : String(data.verification_status),
    raw: data
  };
}

export function webhookAuthorized(request, env) {
  const expected = String(env.OUTBOUND_WEBHOOK_SECRET || "");
  const supplied = String(request.headers.get("X-AHI-Webhook-Secret") || "");
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}

export function normalizeInstantlyWebhook(body) {
  const event = String(body?.event_type || "").trim().toLowerCase();
  const email = String(body?.lead_email || body?.email || "").trim().toLowerCase();
  const providerMessageId = String(body?.message_id || body?.email_id || "").trim() || null;
  const externalId = String(body?.event_id || body?.id || "").trim() ||
    [event, email, providerMessageId || "", body?.timestamp || ""].join(":");
  const map = {
    email_sent: "sent",
    email_bounced: "hard_bounce",
    reply_received: "reply",
    lead_unsubscribed: "unsubscribe"
  };
  return {
    event_type: map[event] || event,
    provider_event_type: event,
    email,
    provider_message_id: providerMessageId,
    step: Number.isFinite(Number(body?.step)) ? Number(body.step) : null,
    external_event_id: externalId,
    raw: body
  };
}
