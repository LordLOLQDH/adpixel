-- AdPixel partner program. Isolated tables only; existing KDS schema and functions are untouched.
create table if not exists public.adpixel_partners (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null check (char_length(display_name) between 1 and 100),
  website_url text,
  password_salt text not null,
  password_hash text not null,
  partner_code text not null,
  status text not null default 'active' check (status in ('active','suspended','pending')),
  banner_status text not null default 'not_configured' check (banner_status in ('not_configured','pending','verified','warning','blocked')),
  free_ad_status text not null default 'locked' check (free_ad_status in ('locked','eligible','requested','approved','suspended','used')),
  free_ad_order_id uuid,
  last_banner_check_at timestamptz,
  last_banner_check_message text,
  suspended_at timestamptz,
  suspension_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email),
  unique (partner_code)
);
create table if not exists public.adpixel_referrals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.adpixel_partners(id) on delete cascade,
  order_id uuid not null unique references public.adpixel_orders(id) on delete cascade,
  referral_code text not null,
  attributed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.adpixel_partner_events (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid references public.adpixel_partners(id) on delete set null,
  event_type text not null check (char_length(event_type) between 1 and 80),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.adpixel_banner_checks (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.adpixel_partners(id) on delete cascade,
  site_url text not null,
  result text not null check (result in ('verified','warning','blocked')),
  message text not null,
  http_status integer,
  checked_at timestamptz not null default now()
);
alter table public.adpixel_orders
  add column if not exists partner_id uuid references public.adpixel_partners(id) on delete set null,
  add column if not exists referral_code text,
  add column if not exists referral_attributed_at timestamptz,
  add column if not exists popup_custom_position boolean not null default false;
alter table public.adpixel_ads
  add column if not exists partner_id uuid references public.adpixel_partners(id) on delete set null,
  add column if not exists is_partner_free boolean not null default false;
create index if not exists adpixel_partners_status_idx on public.adpixel_partners(status);
create index if not exists adpixel_referrals_partner_time_idx on public.adpixel_referrals(partner_id, attributed_at desc);
create index if not exists adpixel_partner_events_partner_time_idx on public.adpixel_partner_events(partner_id, created_at desc);
create index if not exists adpixel_banner_checks_partner_time_idx on public.adpixel_banner_checks(partner_id, checked_at desc);
alter table public.adpixel_partners enable row level security;
alter table public.adpixel_referrals enable row level security;
alter table public.adpixel_partner_events enable row level security;
alter table public.adpixel_banner_checks enable row level security;
revoke all on public.adpixel_partners, public.adpixel_referrals, public.adpixel_partner_events, public.adpixel_banner_checks from anon, authenticated;
grant all on public.adpixel_partners, public.adpixel_referrals, public.adpixel_partner_events, public.adpixel_banner_checks to service_role;
grant all on public.adpixel_orders, public.adpixel_ads to service_role;
