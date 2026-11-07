-- Runtime context builder artifacts (debug/observability).
-- Safe to run multiple times.

create table if not exists public.turn_artifacts (
  artifact_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  turn_id bigint not null references public.turns(turn_id) on delete cascade,
  context_mode text,
  retrieval_count integer not null default 0,
  memory_ids bigint[] not null default '{}'::bigint[],
  retrieval_sources jsonb not null default '{}'::jsonb,
  section_budgets jsonb not null default '{}'::jsonb,
  latency_ms integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (turn_id)
);

create index if not exists idx_turn_artifacts_session_created_at
  on public.turn_artifacts (session_id, created_at desc);

create index if not exists idx_turn_artifacts_context_mode
  on public.turn_artifacts (context_mode, created_at desc);
