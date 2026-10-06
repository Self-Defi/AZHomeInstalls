# AHI outbound pilot foundation

This release provides a review dashboard at /admin/outbound/, protected API,
public-source prospect records, reviewed enrollment, three message slots,
manual stop-on-reply, permanent marketing suppression, audit events, and
message previews. It cannot send prospect emails.

## Deployment

1. Apply migrations in order to the existing database. If 0001 is already
   applied, only 0002 is new:
   `npx wrangler d1 migrations apply azhomeinstalls-leads --remote`
2. Create a random secret of at least 32 characters and configure it:
   `npx wrangler secret put OUTBOUND_ADMIN_TOKEN`
   Never commit the credential or embed it in HTML. The dashboard retains it
   only in memory. Restrict both admin page and API with Cloudflare Access,
   then migrate to verified Access JWT authorization for normal daily use.
3. Set OUTBOUND_MAILING_ADDRESS to the real approved business postal address.
4. Deploy through the existing Cloudflare build rooted in cloudflare.
5. Visit /admin/outbound/, connect, add a sourced contact, approve it, and
   preview the queue. Missing migrations return a controlled 503.

The existing /api/admin* Worker route covers the outbound endpoints.
The original lead CRM has no application-level authorization in the reviewed
source. External Cloudflare Access protection must be verified separately.
This release adds authorization to outbound endpoints only.

## API

All endpoints below require Authorization: Bearer OUTBOUND_ADMIN_TOKEN.

- GET /api/admin/outbound/status
- GET or POST /api/admin/outbound/prospects
- POST /api/admin/outbound/prospects/:id/approve (reviewed_by required)
- POST /api/admin/outbound/prospects/:id/reply
- POST /api/admin/outbound/prospects/:id/suppress
- GET /api/admin/outbound/preview
- GET /api/admin/outbound/metrics

Suppression cancels pending messages and disables existing lead follow-ups
for the same normalized address. Imports cannot reintroduce that address.
No endpoint unsuppresses it. Reply recording stops the enrollment permanently;
authenticated event ingestion is available, but no email provider is connected yet. Auto-replies also stop the sequence conservatively.

## Preparation controls (October 3)

No new D1 migration is required. This release still cannot send emails.
The assigned Gilbert address is configured, with OUTBOUND_MAILBOX_APPROVED=false.
Only change that flag after iPostal1 approves the mailbox.

Create a separate random secret of at least 32 characters named
OUTBOUND_UNSUBSCRIBE_SECRET. Keep it stable: rotating it invalidates existing
opt-out links. Never reuse the admin credential as the signing secret.
Preview links become available after this secret is configured. GET displays a
confirmation; POST suppresses immediately and requires no admin credential.
Before any live use, verify Cloudflare Access allows this exact public endpoint
without login (the remaining admin endpoints must stay protected). One-click
email headers and provider integration still need to be connected and tested.

Additional authenticated endpoints:
- POST settings: {daily_cap: 1–20}; saving always leaves sending paused.
- GET queue: sequence message state; all follow-ups remain unscheduled until
  an actual initial send is recorded by a future dispatcher.
- POST prospects/:id/qualify: only after a recorded reply.
- POST prospects/:id/link-lead: {lead_id}; attach an existing CRM estimate
  request, including a customer's request referred by the partner. Repeated
  links are idempotent; a partner can refer multiple installs. This stops
  outreach but creates no customer record and sends no customer email.
- POST events: {external_event_id, message_id, event_type}. This is an internal
  trusted bridge protected by the admin credential, not a raw provider webhook.
  A future adapter must verify the provider signature and correlate its message
  ID before calling it. Supported events: reply, auto_reply, delivered,
  hard_bounce, complaint, unsubscribe. Do not send mailbox contents or secrets
  in event payloads. Duplicate events have idempotent effects. Delivery requires
  a recorded sent_at; unsent previews cannot be marked delivered.

Metrics count messages sent/delivered, prospects with recorded human replies,
explicitly linked estimate requests, and distinct CRM lead IDs accepted or
completed. Accepted/completed currently reflect CRM statuses; do not interpret
these as immutable historical totals. Auto-replies are excluded from human
reply counts. Linking a lead explicitly asserts an estimate request, so only
link actual requests, not a generic partner contact. Delivery means receiving
server acceptance, not verified inbox placement. The scheduling helper has
Phoenix weekday dates but is not connected to a send dispatcher yet.

## Next implementation

- Select a transport whose policy explicitly permits the intended prospecting.
  Cloudflare Email Service currently documents transactional-only use:
  https://developers.cloudflare.com/email-service/reference/faq/
- Verify SPF, DKIM, DMARC and received-message alignment for the chosen sender.
- Connect provider-verified reply and delivery/bounce events to the trusted bridge.
- Connect signed opt-out body links and one-click email headers in the provider adapter.
- Dispatcher: weekday Phoenix send window, atomic daily reservations, unique
  message keys, leased claims, provider idempotency where available, and
  reconciliation rather than blind retry after ambiguous timeouts.
- First send sets started_at; follow-ups are due +3/+9 days, shifted into the
  next permitted weekday window. Do not release overdue steps together.
- Global daily cap includes follow-ups; start at 5, review before 15–20.
- CRM attribution links a partner to multiple real installation requests.
- Track sent, server-delivered, human reply, qualified, estimate requested,
  estimate accepted, completed install, revenue, complaints and suppressions.
  Do not infer inbox placement from delivered or success from opens.

## Compliance defaults

Previews identify advertising and AHI's unlicensed status and use ADV:.
Arizona's published statute and federal preemption need to be considered
together; ADV: is a conservative pilot convention, not a determination of
enforceability. Immediate suppression is stricter than either published
opt-out processing deadline. Mailing address and unsubscribe placeholders
must never appear in a live message.

Sources:
- https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- https://www.azleg.gov/ars/44/01372-01.htm
- https://www.law.cornell.edu/uscode/text/15/7707

Run local checks with `npm test` in cloudflare.

## October 6 launch audit

Mailbox approval is confirmed. The deployed Worker has opt-out signing and
webhook secrets. D1 contains 100 unapproved prospects; sending is paused.
INSTANTLY_API_KEY and INSTANTLY_CAMPAIGN_ID are still missing, and the available
Gmail connector belongs to cbp.cep@gmail.com rather than the Workspace mailbox.
Do not mistake provider key presence for a tested campaign. Activation remains
blocked until a provider campaign is inspected, its sender is verified as
outreach@azhomeinstalls.com, and end-to-end reply/opt-out tests pass.

POST prospects/:id/recheck fetches the public source with a ten-second timeout
and refuses redirects. Explicit no-solicitation results permanently suppress
the contact. Unreadable/redirected sources require manual review.
Tests now apply migrations 0001 through 0005 and exercise the v2 tables.
The current campaign sequence offsets are 0/7/17 days. The pilot limit is
five total emails/day, including provider-managed follow-ups, before scaling.

## Direct Gmail engine — October 6, 2026

AHI now defaults to its own Gmail API transport instead of Instantly. Existing Calendar
credentials and transactional Cloudflare Email code are unchanged.

Configure these **separate Worker secrets**, never in GitHub or chat:
- `OUTBOUND_GOOGLE_CLIENT_ID`
- `OUTBOUND_GOOGLE_CLIENT_SECRET`
- `OUTBOUND_GOOGLE_REFRESH_TOKEN`

Enable Gmail API in your Google Cloud project. Use a Workspace-internal OAuth app
where available and authorize `johnj@azhomeinstalls.com` with offline access for:
`gmail.send`, `gmail.readonly`, `gmail.settings.basic` (full scope URL prefix:
`https://www.googleapis.com/auth/`). Keep Calendar refresh-token authorization intact.
Use an OAuth authorization-code flow or Google's OAuth Playground with your own OAuth
client credentials. Do not use the Playground's default client for a permanent token.
The mailbox must list `outreach@azhomeinstalls.com` as an accepted Gmail Send As identity.
Receiving mail at an alias alone does not establish this.

Migration: `0006_outbound_gmail.sql` adds thread correlation and a processing lease;
it deliberately pauses sending and sets the pilot daily cap to 5.

Authenticated `GET /api/admin/outbound/gmail-check` verifies mailbox identity, alias,
and API access without sending. It returns no tokens or message content.
`OUTBOUND_GMAIL_TESTED=false` remains the deployment default. Change to true only after
controlled send/reply/opt-out tests pass. Then activate through the authenticated CRM.

Hourly scheduled execution sends at most one message per run, weekdays 9–17 Phoenix,
with a maximum 5 total messages/day initially. Follow-ups count toward this cap and are
scheduled 7 and 17 days after the actual initial send. Any inbound reply, including an
auto-reply, stops the sequence. Replies are checked both by tracked Gmail threads and
by exact contact sender since send time. Read failures prevent further sends.
Permanent suppression remains in D1 and applies to initial messages and follow-ups.

Uncertain send outcomes remain claimed, consume reserved capacity, and pause outreach.
Never retry automatically: reconcile Gmail Sent and update the record under admin review.
The Gmail API has no send idempotency guarantee. A successful API response records
**sent**, not delivered. Delivery/inbox placement is unknown without additional evidence.
Delivery-status notifications correlated into tracked threads trigger suppression;
bounces arriving in unrelated threads need manual reconciliation before reactivation.

Live acceptance checklist: correct From/Reply-To; SPF/DKIM/DMARC header results on a
controlled recipient; external access to opt-out URL without Cloudflare Access login;
POST opt-out suppression; reply and auto-reply cancellation; simulated read failure,
ambiguous send, daily cap, and pause. Confirm no unrelated campaign mail is queued.
No claim of live readiness should be made before these checks pass.
