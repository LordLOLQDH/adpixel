-- Idempotency key prevents duplicate orders on retry; existing orders remain valid.
alter table public.adpixel_orders
  add column if not exists idempotency_key uuid;
create unique index if not exists adpixel_orders_idempotency_key_uidx
  on public.adpixel_orders(idempotency_key)
  where idempotency_key is not null;
