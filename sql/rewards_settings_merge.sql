-- Atomic merge for pds.rewards_settings (PUT /api/rewards/settings). One statement merges the patch into the stored
-- JSON object (jsonb ||), so two overlapping saves of different fields both persist; the old read-merge-upsert in
-- application code could lose one. p_merge = false replaces the value (discover_quarter, apple_boosted).
-- Additive and idempotent. Service role only.
create or replace function pds.rewards_settings_merge(p_key text, p_patch jsonb, p_merge boolean default true)
returns jsonb
language sql
security invoker
set search_path = pds, pg_temp
as $$
  insert into pds.rewards_settings as s (key, value, updated_at)
  values (p_key, p_patch, now())
  on conflict (key) do update
    set value = case
          when p_merge and jsonb_typeof(s.value) = 'object' and jsonb_typeof(excluded.value) = 'object'
            then s.value || excluded.value
          else excluded.value
        end,
        updated_at = now()
  returning value;
$$;

revoke execute on function pds.rewards_settings_merge(text, jsonb, boolean) from public, anon, authenticated;
grant execute on function pds.rewards_settings_merge(text, jsonb, boolean) to service_role;
