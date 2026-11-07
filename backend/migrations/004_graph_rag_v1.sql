-- GraphRAG v1 (stage 7): derived graph projection + summary cache + async jobs.
-- Safe to run multiple times.

create table if not exists public.graph_nodes (
  node_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  node_type text not null check (node_type in ('entity', 'event', 'relation', 'summary_topic')),
  node_key text not null,
  entity_id uuid references public.entities(entity_id) on delete set null,
  event_id bigint references public.events(event_id) on delete set null,
  relation_id bigint references public.relations(relation_id) on delete set null,
  label text not null,
  payload jsonb not null default '{}'::jsonb,
  importance double precision not null default 0.5 check (importance >= 0 and importance <= 1),
  time_from timestamptz,
  time_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, node_type, node_key),
  check (
    (node_type = 'entity' and entity_id is not null and event_id is null and relation_id is null)
    or (node_type = 'event' and event_id is not null and entity_id is null and relation_id is null)
    or (node_type = 'relation' and relation_id is not null and entity_id is null and event_id is null)
    or (node_type = 'summary_topic' and entity_id is null and event_id is null and relation_id is null)
  )
);

create table if not exists public.graph_edges (
  edge_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  from_node_id bigint not null references public.graph_nodes(node_id) on delete cascade,
  to_node_id bigint not null references public.graph_nodes(node_id) on delete cascade,
  edge_type text not null,
  weight double precision not null default 0 check (weight >= -1 and weight <= 1),
  evidence_event_id bigint references public.events(event_id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, from_node_id, to_node_id, edge_type),
  check (from_node_id <> to_node_id)
);

create table if not exists public.graph_summaries (
  summary_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  scope_type text not null check (scope_type in ('entity', 'location', 'faction', 'global', 'thread')),
  scope_key text not null,
  summary_text text not null,
  source_node_ids bigint[] not null default '{}'::bigint[],
  source_edge_ids bigint[] not null default '{}'::bigint[],
  model text not null default 'gemini-2.5-flash',
  freshness_turn_no integer not null default 0,
  token_count integer not null default 0,
  quality_score double precision not null default 0.5 check (quality_score >= 0 and quality_score <= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, scope_type, scope_key)
);

create table if not exists public.graph_jobs (
  job_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  turn_id bigint references public.turns(turn_id) on delete set null,
  job_type text not null check (job_type in ('build_incremental', 'refresh_summary', 'backfill')),
  scope_type text check (scope_type in ('entity', 'location', 'faction', 'global', 'thread')),
  scope_key text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  priority integer not null default 50,
  attempts integer not null default 0 check (attempts >= 0),
  run_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.graph_checkpoints (
  session_id uuid primary key references public.game_sessions(session_id) on delete cascade,
  last_event_id bigint references public.events(event_id) on delete set null,
  last_relation_updated_at timestamptz,
  last_turn_no integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_graph_nodes_session_type_key
  on public.graph_nodes (session_id, node_type, node_key);

create index if not exists idx_graph_nodes_session_updated_at
  on public.graph_nodes (session_id, updated_at desc);

create index if not exists idx_graph_edges_session_from_to
  on public.graph_edges (session_id, from_node_id, to_node_id);

create index if not exists idx_graph_edges_session_created_at
  on public.graph_edges (session_id, created_at desc);

create index if not exists idx_graph_summaries_session_scope
  on public.graph_summaries (session_id, scope_type, scope_key);

create index if not exists idx_graph_summaries_session_updated_at
  on public.graph_summaries (session_id, updated_at desc);

create index if not exists idx_graph_jobs_status_run_after
  on public.graph_jobs (status, run_after, priority desc);

create index if not exists idx_graph_jobs_session_created_at
  on public.graph_jobs (session_id, created_at desc);

drop trigger if exists trg_graph_nodes_updated_at on public.graph_nodes;
create trigger trg_graph_nodes_updated_at
before update on public.graph_nodes
for each row execute function public.set_updated_at();

drop trigger if exists trg_graph_summaries_updated_at on public.graph_summaries;
create trigger trg_graph_summaries_updated_at
before update on public.graph_summaries
for each row execute function public.set_updated_at();

drop trigger if exists trg_graph_jobs_updated_at on public.graph_jobs;
create trigger trg_graph_jobs_updated_at
before update on public.graph_jobs
for each row execute function public.set_updated_at();

drop trigger if exists trg_graph_checkpoints_updated_at on public.graph_checkpoints;
create trigger trg_graph_checkpoints_updated_at
before update on public.graph_checkpoints
for each row execute function public.set_updated_at();
