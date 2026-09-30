# AZHomeInstalls Estimate Worker

Cloudflare Worker backend for the website estimate form.

## Endpoint
`POST https://forms.azhomeinstalls.com/estimate`

## What it accepts
- name
- phone
- email
- zip
- service
- description
- up to 4 JPG/PNG/WebP project photos

## Cloudflare setup
1. In Cloudflare: **Compute > Email Service > Email Sending** and onboard `azhomeinstalls.com`.
2. Confirm `cbp.cep@gmail.com` is a verified destination address.
3. Create a Worker named `azhomeinstalls-estimates`.
4. Deploy `src/index.js`.
5. Add a Send Email binding named `EMAIL`, restricted to `cbp.cep@gmail.com`.
6. Add Worker variables:
   - `DOMAIN=azhomeinstalls.com`
   - `DESTINATION_EMAIL=cbp.cep@gmail.com`
7. Add a custom domain/route for the Worker:
   - `forms.azhomeinstalls.com`
8. Test the website estimate form.

Cloudflare Email Service supports Worker email bindings and file attachments. The destination is intentionally restricted to the verified business inbox target.
