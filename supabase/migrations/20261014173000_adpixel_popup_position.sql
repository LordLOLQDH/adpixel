-- Store the optional popup-position flag on published ads without changing existing rows.
alter table public.adpixel_ads
  add column if not exists popup_custom_position boolean not null default false;
