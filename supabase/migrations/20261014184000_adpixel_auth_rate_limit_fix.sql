-- Correct the counter so a newly inserted attempt is counted exactly once.
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
  on conflict (attempt_key) do update
  set attempts = case
        when public.adpixel_auth_rate_limits.window_started_at < now_at - make_interval(secs => p_window_seconds) then 1
        else public.adpixel_auth_rate_limits.attempts + 1
      end,
      window_started_at = case
        when public.adpixel_auth_rate_limits.window_started_at < now_at - make_interval(secs => p_window_seconds) then now_at
        else public.adpixel_auth_rate_limits.window_started_at
      end,
      blocked_until = case
        when public.adpixel_auth_rate_limits.window_started_at < now_at - make_interval(secs => p_window_seconds) then null
        when public.adpixel_auth_rate_limits.attempts + 1 >= p_limit then now_at + make_interval(secs => p_window_seconds)
        else public.adpixel_auth_rate_limits.blocked_until
      end,
      updated_at = now_at
  returning attempts, window_started_at, blocked_until into next_attempts, next_window, next_blocked;
  return next_attempts < p_limit and (next_blocked is null or next_blocked <= now_at);
end;
$$;
revoke all on function public.adpixel_consume_auth_attempt(text, integer, integer) from public, anon, authenticated;
grant execute on function public.adpixel_consume_auth_attempt(text, integer, integer) to service_role;
