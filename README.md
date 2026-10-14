# AdPixel — Werbeflächen und Partnerprogramm

Version: **0.4.0** (in Entwicklung)

AdPixel is a mobile-friendly static site backed by a Supabase Edge Function, PostgreSQL and Supabase Storage.

## Current infrastructure

- GitHub repository: `LordLOLQDH/adpixel`, branch `main`
- Supabase project: `KDS-AI-v1`, ref `eopvkwhcgznvubesaszv`, region `eu-central-1`
- Edge Function: `adpixel-api`
- Storage bucket: `adpixel-assets`
- Current static entry points: `index.html`, `admin.html`, `partner.html`

AdPixel uses only `adpixel_*` tables and the `adpixel-assets` bucket in the existing Supabase project. Do not alter KDS tables, functions, secrets or configuration while operating AdPixel.

## Pricing

Prices are authoritative in `supabase/functions/adpixel-api/pricing.ts` and recalculated server-side in integer euro cents. Browser-provided totals are never trusted.

| Package | Final package price | Free position surcharge |
|---:|---:|---:|
| 1 pixel | €0.01 | €0.30 |
| 2 pixels | €0.02 | €0.30 |
| 4 pixels | €0.04 | €0.30 |
| 10 pixels | €0.10 | €0.30 |
| 100 pixels | €1.00 | €0.25 |
| 200 pixels | €2.00 | €0.25 |
| 400 pixels | €3.70 | €0.25 |
| 500 pixels | €4.50 | €0.20 |

Popup: €2.00. Optional free popup position: €0.10. Actual dimensions are width × height and cannot exceed the selected package; 25 × 20 is valid for the 500-pixel package. No bonus-pixel claim is advertised because a bonus quantity/value has not been specified.

## Architecture and data model

Existing tables are preserved:
- `adpixel_orders`: customer order, image paths, dimensions, calculated cents, payment and approval states.
- `adpixel_ads`: published ads linked to orders.

Partner-program tables added by migration:
- `adpixel_partners`: account credentials (salted PBKDF2 hash only), unique partner code, status, banner state, free-ad state.
- `adpixel_referrals`: signed referral attribution associated with an order.
- `adpixel_partner_events`: partner and admin audit events.
- `adpixel_banner_checks`: timestamped integration-check results.

New AdPixel columns track referral attribution and optional popup position. RLS is enabled on all AdPixel tables; direct `anon` and `authenticated` table access is revoked. Data access is mediated by `adpixel-api` with the server-side service-role key. No KDS tables are modified by the AdPixel migrations.

## Partner program

- Registration and login use PBKDF2-SHA-256 with a random salt and 210,000 iterations. Partner sessions are signed and expire after 30 days; admin sessions expire after four hours.
- Each partner receives a random `AP-...` code, a personal link and an HTML banner marker.
- Referral attribution uses a server-signed token valid for 90 days. Self-referrals are rejected. Free-code orders and unpaid/refunded orders do not qualify.
- Progress counts manually confirmed paid pixels for attributed orders within the 90-day attribution period. A 500-paid-pixel threshold is required before a partner can request a free placement.
- Admin can suspend/reactivate partners and approve or suspend free-placement status. Suspending a partner or failing a banner check unpublishes their free partner ads.
- The free-placement size has not been specified. Therefore the system records eligibility/request/approval state but does not invent an unspecified free-ad size or silently create a free ad.

### Banner integration check limits

The checker requires HTTPS, rejects literal IP/private hosts where detected, resolves public A/AAAA records, follows at most three validated HTTPS redirects, times out requests, caps HTML reads at 512 KB, and searches for the exact partner marker. A marker check does **not** prove visual visibility, click behavior, or that a site operator has not spoofed the returned HTML. DNS resolution and the subsequent fetch cannot be pinned to the same address by this implementation, so it is not a complete defense against DNS rebinding. Do not treat it as a security certification.

Checks run when a partner explicitly requests one. A scheduled background checker is not active because no scheduler credential/configuration was available. Automatic deactivation occurs when a check detects a missing/invalid integration or when an admin suspends the partner; this is not a guarantee of continuous monitoring between checks.

## Payments

There is no integrated payment provider or verified payment webhook. Normal orders stay pending until an admin independently confirms payment. Setting a paid state requires a non-empty review note and is rejected for free-code orders. Do not mark an order paid merely because the browser submits a request. Amazon gift cards are not accepted as verifiable payment.

## API actions

Public:
- `pricing`
- `public_ads`
- `partner_click`
- `create_order`

Partner (signed session):
- `partner_register`
- `partner_login`
- `partner_dashboard`
- `partner_set_website`
- `partner_banner_check`
- `partner_request_free_ad`

Admin (signed four-hour session):
- `admin_login`
- `admin_orders`, `admin_ads`
- `admin_update_order`, `admin_publish`, `admin_unpublish`, `admin_delete_order`
- `admin_partners`, `admin_partner_update`, `admin_partner_free_ad`

## Configuration and secrets

Frontend `config.js` contains only the Supabase URL and public anon key. Never place service-role keys, admin codes, free codes, or session secrets in public files.

Required Supabase Function Secrets:
- `ADPIXEL_ADMIN_CODE`
- `ADPIXEL_FREE_CODE`
- `ADPIXEL_SESSION_SECRET` (at least 32 random bytes)
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (normally injected by Supabase)
- `ADPIXEL_ALLOWED_ORIGINS` if the site uses a production origin other than `https://lordlolqdh.github.io`; comma-separated exact origins, no paths.

Secrets cannot be read or set through the connected tools in this session. Verify these in Supabase Dashboard before enabling admin/free-code flows, and rotate any value previously disclosed in a public context.

## Migrations

- `supabase/migrations/202610140001_adpixel_backend.sql`
- `supabase/migrations/20261014170000_adpixel_partners.sql`
- `supabase/migrations/20261014173000_adpixel_popup_position.sql`
- `supabase/migrations/20261014180000_adpixel_order_idempotency.sql`

The new AdPixel migrations have been applied to the connected Supabase project. Order submissions include a unique idempotency key so retrying the same request does not create a second order. Do not edit applied migration files; create a new migration for future schema changes.

## Automated tests

Run:
```sh
deno test supabase/functions/adpixel-api/pricing.test.ts
deno check supabase/functions/adpixel-api/index.ts
```

GitHub Actions workflow `.github/workflows/adpixel-ci.yml` runs these checks on pushes and pull requests.

## Hosting and deployment limitations

The existing public site is currently served through GitHub Pages. This repository does not yet contain a Cloudflare Pages deployment or a configured Cloudflare credential. No hosting migration is claimed. GitHub Pages may not be appropriate for a commercial transaction-focused site; configure Cloudflare Pages (or another suitable host) and set `ADPIXEL_ALLOWED_ORIGINS` before launch. Keep the existing GitHub Pages publication in place until the replacement is live and verified; do not claim the old publication has been disabled.

## Security notes

- CORS is restricted to configured exact origins (default GitHub Pages origin).
- User input is validated server-side; image uploads are limited to 8 MB and accepted image MIME types.
- Order retries are deduplicated using a unique idempotency key; refunded or failed orders are unpublished.
- RLS and explicit grants prevent direct client access to private AdPixel tables.
- Admin actions require signed sessions; manually confirming a payment requires a note.
- The existing Supabase project also contains KDS data and functions. Do not change unrelated KDS resources as part of AdPixel operations.
