-- Rate-limit only AdPixel authentication attempts. Does not touch KDS tables or functions.
create table if not exists public.adpixel_auth_rate_limits (
  attempt_key text primary key check (char_length(attempt_key)=64),
  attempts integer not null default 0 check (attempts >= 0),
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.adpixel_auth_rate_limits enable row level security;
revoke all on public.adpixel_auth_rate_limits from anon, authenticated;
grant all on public.adpixel_auth_rate_limits to service_role;

create or replace function public.adpixel_consume_auth_attempt(
  p_attempt_key text,
  p_limit integer default 8,
  p_window_seconds integer default 900
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_row public.adpixel_auth_rate_limits%rowtype;
  now_at timestamptz := clock_timestamp();
  next_attempts integer;
  next_window timestamptz;
  next_blocked timestamptz;
begin
  if p_attempt_key is null or length(p_attempt_key) <> 64 or p_limit < 1 or p_limit > 100 or p_window_seconds < 30 or p_window_seconds > 86400 then
    return false;
  end if;
  insert into public.adpixel_auth_rate_limits(attempt_key, attempts, window_started_at, blocked_until, updated_at)
  values (p_attempt_key, 1, now_at, null, now_at)
  on conflict (attempt_key) do nothing;

  select * into current_row from public.adpixel_auth_rate_limits where attempt_key = p_attempt_key for update;
  if current_row.blocked_until is not null and current_row.blocked_until > now_at then
    return false;
  end if;

  if current_row.window_started_at < now_at - make_interval(secs => p_window_seconds) then
    next_attempts := 1;
    next_window := now_at;
    next_blocked := null;
  else
    next_attempts := current_row.attempts + 1;
    next_window := current_row.window_started_at;
    next_blocked := case when next_attempts >= p_limit then now_at + make_interval(secs => p_window_seconds) else null end;
  end if;

  update public.adpixel_auth_rate_limits
  set attempts = next_attempts, window_started_at = next_window, blocked_until = next_blocked, updated_at = now_at
  where attempt_key = p_attempt_key;
  return next_attempts < p_limit;
end;
$$;
revoke all on function public.adpixel_consume_auth_attempt(text, integer, integer) from public, anon, authenticated;
grant execute on function public.adpixel_consume_auth_attempt(text, integer, integer) to service_role;
