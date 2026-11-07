-- 005_rls_lockdown_v1.sql
-- Applied to Supabase (zmjvuahejpofdfwnqmpt) on 2026-07-05.
-- The database is accessed exclusively by the backend via SUPABASE_SERVICE_ROLE_KEY
-- (service_role bypasses RLS), so anon/authenticated must have no direct access.
--
-- Supabase-only: on a plain Postgres there is no public REST API and no anon/authenticated
-- roles, and RLS without policies would lock out a backend role that doesn't own the
-- tables. The whole lockdown is therefore skipped when the anon role doesn't exist.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise notice '005_rls_lockdown_v1: no Supabase roles, skipping';
    return;
  end if;

  -- 1. Enable RLS on all public tables. No policies are defined on purpose:
  --    with RLS on and zero policies, anon/authenticated see no rows,
  --    while service_role is unaffected.
  alter table public.turn_artifacts enable row level security;
  alter table public.entity_state enable row level security;
  alter table public.graph_nodes enable row level security;
  alter table public.memory_items enable row level security;
  alter table public.graph_checkpoints enable row level security;
  alter table public.graph_summaries enable row level security;
  alter table public.quest_state enable row level security;
  alter table public.turns enable row level security;
  alter table public.event_edges enable row level security;
  alter table public.relations enable row level security;
  alter table public.graph_edges enable row level security;
  alter table public.graph_jobs enable row level security;
  alter table public.game_sessions enable row level security;
  alter table public.events enable row level security;
  alter table public.entities enable row level security;
  alter table public.embedding_jobs enable row level security;

  -- 2. apply_state_patches_v1 is SECURITY DEFINER and bypasses RLS —
  --    it must not be callable with the public anon key.
  revoke execute on function public.apply_state_patches_v1(uuid, bigint, integer, bigint, text, jsonb) from public, anon, authenticated;

  -- 3. Remove direct table/sequence grants from public roles (defense in depth;
  --    also hides tables from the anon/authenticated GraphQL schema).
  revoke all on all tables in schema public from anon, authenticated;
  revoke all on all sequences in schema public from anon, authenticated;

  -- 4. Future tables/sequences follow the same rule.
  alter default privileges in schema public revoke all on tables from anon, authenticated;
  alter default privileges in schema public revoke all on sequences from anon, authenticated;
end $$;
