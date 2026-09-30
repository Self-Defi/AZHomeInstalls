# AZHomeInstalls Estimate Worker

This Worker replaces the third-party FormSubmit dependency.

## What it does
- Receives POST requests at /api/estimate
- Validates required estimate fields
- Accepts up to 3 JPG/PNG/WebP photos
- Enforces a 4 MB combined upload limit
- Sends the lead and attachments through Cloudflare Email Service
- Redirects successful submissions to /thanks/
- Includes a honeypot spam check

## Cloudflare setup
1. Create a Worker named `azhomeinstalls-estimate`.
2. Use `estimate-worker.js` as the Worker code.
3. Add an Email binding named `EMAIL`.
4. Set Worker variables:
   - `FROM_EMAIL` = an address on azhomeinstalls.com that Cloudflare allows as a sender.
   - `DESTINATION_EMAIL` = a verified Email Routing destination address.
5. Add the Worker route:
   `azhomeinstalls.com/api/estimate*`
6. Ensure the azhomeinstalls.com DNS record is proxied through Cloudflare.
7. Deploy and submit a test request from https://azhomeinstalls.com/estimate/

Do not place API tokens or account secrets in this repository.


Git deployment trigger: Cloudflare Builds connected to main branch with root directory `cloudflare`.


Root directory confirmed: Cloudflare build root is `cloudflare` on branch `main`.
