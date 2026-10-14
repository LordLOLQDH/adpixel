# AdPixel — Backend

AdPixel is a static website backed by Supabase Edge Functions, PostgreSQL and Supabase Storage.

## Connected Supabase project
- Project: `KDS-AI-v1`
- Project ref: `eopvkwhcgznvubesaszv`
- Region: `eu-central-1`
- Edge Function: `adpixel-api`

AdPixel uses its own `adpixel_*` tables and the `adpixel-assets` storage bucket in this existing project. This avoids creating another Supabase project, but shares project availability and quota with KDS AI.

## Security
- Admin and free-upload codes are checked only by the Edge Function against Supabase Function Secrets; they are never included in frontend files.
- Admin login issues a signed four-hour session token; protected admin actions require it.
- Direct anon/authenticated access to orders and ad records is blocked by RLS.
- Amazon gift-card codes are not stored or treated as verified. This app has no reliable way to validate authenticity and remaining balance; submissions are rejected rather than pretending they were checked.
- Regular orders remain unpaid until a real payment provider and verified webhook are integrated.

## Files
- `supabase/migrations/202610140001_adpixel_backend.sql`: order/ad schema, RLS, image bucket.
- `supabase/functions/adpixel-api/index.ts`: order creation, public gallery and protected admin API.
- `admin.html`: admin panel.
- `config.js`: public Supabase URL and anon key only; never place secrets here.

## Required Supabase Function Secrets
The Edge Function is deployed, but admin login and free uploads will remain disabled until these are set under Supabase Dashboard → Edge Functions → Secrets for the connected project:
- `ADPIXEL_ADMIN_CODE`: a new strong admin code.
- `ADPIXEL_FREE_CODE`: private free-upload code.
- `ADPIXEL_SESSION_SECRET`: at least 32 random bytes for signed admin sessions.
- `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL`: normally provided by Supabase to Edge Functions; never expose the service role key publicly.

Rotate any code previously exposed in frontend source before launch.

## Payment status
The backend stores orders and uploaded images and supports admin approval/publishing for free orders. It does not charge cards or redeem Amazon gift cards. Do not mark an order paid until payment is independently confirmed.
