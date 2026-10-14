-- AdPixel production schema. Run through Supabase migrations.
create extension if not exists pgcrypto;

create table if not exists public.adpixel_orders (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null check (char_length(customer_name) between 1 and 100),
  customer_email text not null check (char_length(customer_email) between 3 and 254),
  main_image_path text not null,
  popup_image_path text,
  target_url text not null,
  pixel_width integer not null check (pixel_width between 1 and 100),
  pixel_height integer not null check (pixel_height between 1 and 100),
  custom_position boolean not null default false,
  popup_text text,
  popup_button text,
  popup_url text,
  amount_cents integer not null check (amount_cents >= 0),
  free_code_used boolean not null default false,
  payment_status text not null default 'pending'
    check (payment_status in ('pending','free_pending_review','manual_review','paid','refunded','failed')),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','published')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.adpixel_ads (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.adpixel_orders(id) on delete cascade,
  image_path text not null,
  target_url text not null,
  pixel_width integer not null check (pixel_width between 1 and 100),
  pixel_height integer not null check (pixel_height between 1 and 100),
  position_x integer,
  position_y integer,
  popup_image_path text,
  popup_text text,
  popup_button text,
  popup_url text,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists adpixel_orders_created_at_idx on public.adpixel_orders(created_at desc);
create index if not exists adpixel_orders_status_idx on public.adpixel_orders(status, payment_status);
create index if not exists adpixel_ads_published_idx on public.adpixel_ads(published, published_at desc);

alter table public.adpixel_orders enable row level security;
alter table public.adpixel_ads enable row level security;

-- No anon/authenticated policies on purpose. Access is mediated by the Edge Function.
revoke all on public.adpixel_orders from anon, authenticated;
revoke all on public.adpixel_ads from anon, authenticated;
grant all on public.adpixel_orders to service_role;
grant all on public.adpixel_ads to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('adpixel-assets', 'adpixel-assets', true, 8388608, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public = true, file_size_limit = 8388608,
  allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif'];

-- Public read is intentionally limited to files referenced by published ads in the frontend.
-- Uploads and management happen only through the service-role Edge Function.
