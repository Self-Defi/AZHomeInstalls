# OAS Wave 2 reliability

This change extends PR #5 (`c9d5b02`) without changing production data or sending
live email. Work was developed on `fix/oas-wave2-pipeline-20261105`.

## Baseline investigation

The original 20-test baseline had 17 passes and three failures:

- Greeting: commit `7a32591` intentionally switched to `Company,` without `Hi` or
  `team`. The assertion was stale. Production wording is preserved.
- Enrollment: commit `38cc5e5` intentionally selected Wave 2. The test imported
  Wave 1 records. It now exercises Wave 2 and confirms other waves are excluded.
- Sending cap: commit `bbfbc98` intentionally separated introductions and
  follow-ups. The shared-cap assertion was stale. Independent follow-ups remain.
  Investigation also found a real defect: settings up to 20 could permit more
  than five introductions. Both inventory and sender accounting are repaired;
  the sender now hard-clamps introductions to five (or a lower configured cap).

PR #5's source-clearance and prior-enrollment checks are retained. The tests now
freeze the whole Date API instead of mixing mocked Date.now with real new Date.

## Behavior

- Inputs are existing, explicitly supplied business records with public source
  URLs and exact email addresses. This is a validation/replenishment pipeline,
  not a discovery scraper. No emails are inferred from names or domains. Records
  marked `research_only` or `discovery_only` stay outside automatic enrollment.
- Public evidence must contain the exact email (visible text or mailto link),
  organization name, relevant segment services, and the recorded city or an
  Arizona service area. Scripts/styles do not count. Checks expire after seven
  days. Old contacts begin pending; existing records are not deleted or silently
  marked verified. Initial sends and manual approval require current validation.
- HTTPS redirects are manually followed for at most three hops, within the same
  hostname or its www variant. Each destination is checked. IP literals,
  credentials, insecure URLs, nonstandard ports, cross-site redirects, loops,
  oversized pages, unreadable bodies, 403, 526 and timeouts require review.
  Requests have a ten-second deadline and a 750 KB response limit.
- Explicit no-solicitation language permanently suppresses the address and
  cancels pending outreach. Duplicate normalized email addresses, enrollments
  and sequence messages remain protected by existing unique constraints.
- `OUTBOUND_AUTO_ENROLL_WAVE1=true` is retained as the existing automation switch
  for compatibility; it manages **Wave 2**. Each cron run targets 25 current,
  approved, unsent contacts, not five queued messages. It checks up to 100
  candidates per run. Unresolved sources are retried no more than daily by
  automation; the authenticated recheck action can request an immediate retry.
  When qualified supply is insufficient, inventory shortfall is reported.
- A separate pipeline lease and transactional eligibility checks prevent
  competing inventory runs from overfilling or resurrecting suppressed records.
- Gmail sends at most one message per invocation during existing weekday
  09:00–17:00 Phoenix hours. Introductions are capped at
  `min(5, OUTBOUND_NEW_DAILY_CAP, settings.daily_cap)`. Invalid introduction
  settings fail closed. The old dated launch allowance cannot raise this cap.
- A single SQLite INSERT..SELECT reserves daily capacity for each introduction.
  Durable reservations and historical sends are counted once per Arizona day.
  Reservations survive crashes and expired leases; historical uncertain initial
  sends are backfilled conservatively. Repeated cron calls cannot reuse slots.
  Only a known pre-send cancellation releases a reservation. The legacy aggregate
  remains available for older consumers, but no longer enforces capacity.
- The Worker rechecks lease ownership, suppression, pause, enrollment and the
  business-hour boundary before dispatch. Uncertain Gmail responses retain the
  claim and reservation and pause sending. There is no automatic retry.
- Follow-ups retain +7/+17-day timing from actual initial sends, shifted to the
  next weekday at 10am Phoenix. They have their own daily quota (default five,
  `OUTBOUND_FOLLOWUP_DAILY_CAP`, capped at 20), reuse the Gmail thread and original
  subject/References, and run before new introductions when overdue. Step 2
  cannot overtake an unsent step 1. Replies, auto-replies, bounces and opt-outs
  retain their existing stop/suppression behavior. Uncertain follow-up claims
  conservatively consume follow-up capacity even after lease expiry.

## Operations

Authenticated `GET /api/admin/outbound/operations` returns:

- Arizona date; introductions sent, used/reserved capacity, limit and remaining.
- Ready inventory, target and shortfall.
- Due/scheduled follow-ups, follow-ups sent today and uncertain claims.
- Validation backlog by status, recent failed/uncertain messages, and persisted
  campaign pause diagnostics.

The same report appears in `status.operations` and the admin dashboard. Legacy
settings up to 20 remain readable for compatibility, but cannot raise the hard
introduction ceiling. The dashboard offers only 1–5 new introductions/day.

## Local validation

From `/workspace/AZHomeInstalls/cloudflare`:

```sh
npm test
/workspace/azhome-tools/node_modules/.bin/wrangler d1 migrations apply azhomeinstalls-leads --local --persist-to /workspace/azhome-wave2-validation-state
/workspace/azhome-tools/node_modules/.bin/wrangler deploy --dry-run --outdir /workspace/azhome-wave2-build
```

36 tests passed, zero failed/skipped. Coverage includes the three baseline
failures, public evidence and unsafe/inconclusive redirects, 25-contact inventory
replenishment, duplicate prevention, concurrent pipeline runs, concurrent actual
scheduled Worker handlers, expired lease takeover, ambiguous-send retention,
Arizona midnight rollover, follow-up threading/dates and migration preservation.
External requests and Gmail sends in tests are mocked; databases are local.
Local Wrangler reporting endpoints returned HTTP 200 with a five-introduction
limit, five remaining slots and an inventory shortfall of 25 on an empty DB.
The dashboard module passed Node syntax checking. Migration rerun and Worker
bundle dry run passed. No production D1 or Gmail access was used.

## Deployment procedure — instructions only, not executed

1. Obtain explicit deployment authorization. Pause campaign sending and disable
   automatic enrollment through the existing operator controls/configuration.
   Preserve an export or Time Travel recovery point for D1 and record the current
   Worker version. Inspect any uncertain claims; do not automatically retry them.
2. Apply migration `0007_outbound_reliability.sql` using the repository's normal
   D1 migration command against the intended database. Migrations 0001–0006
   must already be present. This migration adds columns/table/indexes and copies
   uncertain introduction reservations; it does not alter historical contacts,
   messages, events, suppression history or campaign settings.
3. Deploy the reviewed Worker and admin page together. Keep sending paused.
   There are no new paid services or required secrets. Preserve existing Gmail,
   Calendar, email and admin bindings. Keep `OUTBOUND_NEW_DAILY_CAP=5` and verify
   the independent follow-up quota. Retain the existing five-minute cron.
4. Inspect the authenticated operations report and validation backlogs. Resume
   inventory validation only after reviewing the relevant public source domains
   and current records. Confirm blocked sources remain blocked, expired records
   require fresh evidence, and research-only records are flagged appropriately.
5. Verify read-only Gmail identity diagnostics and existing opt-out protection.
   Only after separate authorization should the operator resume live sending or
   conduct a controlled live acceptance check. Monitor used capacity and uncertain
   claims; Gmail API acceptance means sent, not delivered or inbox placement.

## Rollback

Pause sending and disable automatic enrollment first. Restore the previous
Worker/admin version with campaign sending still paused. Keep migration 0007,
reservations, validation evidence and suppression history; do not drop tables,
restore an older DB snapshot over current records, or clear uncertain claims.
The previous Worker ignores the additive schema but has the known configurable
cap gap, so it must not resume unattended. Reconcile every in-flight send against
Gmail Sent before any manual state repair. Prefer a forward fix; validate the
replacement's five-introduction limit locally before resuming.

## Remaining risks and limits

- Validation is deliberately conservative. JavaScript-rendered/obfuscated email,
  alternate company branding, external canonical domains, bot protection or
  unrecognized services may produce a review backlog. The system never treats
  an inconclusive check as approval. Public absence of a restriction is evidence
  from the checked page, not a legal determination or guarantee of consent.
- Existing research records are not automatically classified from free-form
  notes: operators must mark discovery-only material as `research_only` before
  enabling the pipeline. It still cannot pass without exact public evidence.
- A large exhausted candidate pool may take multiple cron runs. At 100 checks
  and ten seconds per source, a slow run can outlast its ten-minute lease; stale
  owners stop before approval and subsequent runs continue the backlog.
- Gmail offers no send-idempotency key. Once a provider request is in flight, an
  opt-out cannot retract it, and a timeout cannot prove non-delivery. These cases
  pause/hold for manual reconciliation rather than retrying.
- Unit/integration concurrency tests use SQLite and Worker mocks; the local
  Wrangler smoke test uses D1 emulation. Production D1/Gmail behavior and recipient
  delivery were not exercised. Deployment must remain paused until reviewed.

## Public-source SSRF and DNS rebinding hardening

Public-source requests now have two independent boundaries:

1. `public-source-network.js` rejects IP-literal URLs (including alternate numeric
   spellings), internal/reserved hostname suffixes, credentials, non-HTTPS and
   nonstandard ports. For each source hop it queries A and AAAA through the fixed
   HTTPS Cloudflare DNS JSON endpoint. Both queries must succeed. Every returned
   address and CNAME is validated; private, loopback, link-local, shared-address,
   reserved/documentation, IPv4-mapped/translation and other non-global ranges
   are rejected. Mixed public/private answers, inconsistent aliases, loops,
   truncated/empty/oversized responses, partial-family failure and DNS errors
   remain `manual_required` and invalidate previous evidence expiry.
2. `public-source-fetch.js` uses only Cloudflare's public global `fetch()` with
   `redirect: manual`, no caller credentials, no Host override, no
   `resolveOverride`, and no origin, service or VPC binding. The deployment config
   explicitly enables **`global_fetch_strictly_public`**. This prevents own-zone
   URLs from using the privileged private-origin shortcut. The public-network
   runtime egress boundary rejects private destinations when connecting, including
   a DNS change after application preflight. A DNS precheck alone is not a
   rebinding defense; the addresses are not claimed to be pinned.

The validator repeats both gates on every redirect, including same-host path
redirects and www transitions. Existing same-site, three-hop, ten-second,
response-size, business/email-evidence, suppression and manual-review behavior
remain. HTTPS certificate verification is left to the native fetch runtime.
DNS/egress failures never trigger another transport or an approval fallback.

**Deployment requirement:** retain `global_fetch_strictly_public` in Cloudflare
configuration, including dashboard/API uploads. Do not add
`global_fetch_private_origin`, route validation through a private binding, or run
this module through an unrestricted Node HTTP implementation. If self-hosting
workerd, its `globalOutbound` network must allow only `public`, as in the runtime
fixture. Cloudflare's public-network guard is part of the security boundary.

A pinned-IP socket approach was investigated but is not used: Workers' native
`startTls({expectedServerHostname})` option can be rejected by runtime policy, and
`cf.resolveOverride` is not an arbitrary external-host pinning mechanism. There
is no custom TLS stack, certificate-validation bypass or experimental socket API.
No new paid service, secret, or D1 migration is needed. The fixed DNS destination
is `cloudflare-dns.com`; a restricted local development network must allow it to
exercise real public-source lookups. Source failures remain in review if it is
unavailable.

Current validation: **50 Node tests passed**, zero failed/skipped, plus a native
workerd isolation test covering **six actual public-network policy denials**.
The application tests model post-preflight DNS changes and verify no fallback;
the native test separately checks connection-time rejection rather than assuming
that a mocked fetch enforces it. These are local tests, not a production probe.

```sh
# From cloudflare; workerd is available alongside Wrangler in the prepared tools.
npm test
node tests/run-public-egress.mjs /workspace/azhome-tools/node_modules/.bin/workerd
/workspace/azhome-tools/node_modules/.bin/wrangler deploy --dry-run --outdir /workspace/azhome-ssrf-build
```

The native runner checks policy-denial diagnostics as well as test exit status,
so ordinary DNS, TLS or connection failures cannot masquerade as a passing
isolation check. No deployment, production D1 write or live email is part of
these commands. Any rollback must retain the public-only routing flag and must
not restore unrestricted source fetches.

Runtime references:
- [Cloudflare compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- [Public-only global fetch contract in workerd](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp)
- [Workers request options and resolveOverride scope](https://developers.cloudflare.com/workers/runtime-apis/request/)
