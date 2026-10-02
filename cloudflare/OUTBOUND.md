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
there is no automatic inbound reply ingestion in this release.

## Next implementation

- Select a transport whose policy explicitly permits the intended prospecting.
  Cloudflare Email Service currently documents transactional-only use:
  https://developers.cloudflare.com/email-service/reference/faq/
- Verify SPF, DKIM, DMARC and received-message alignment for the chosen sender.
- Add authenticated inbound reply handling and delivery/bounce events with
  deduplication, thread correlation, and conservative pause on auto-replies.
- Add signed opt-out tokens, body link and standards-based one-click endpoint.
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
