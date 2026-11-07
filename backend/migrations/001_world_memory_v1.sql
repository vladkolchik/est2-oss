-- World memory v1: canonical events + entity graph + hybrid retrieval.
-- Safe to run multiple times.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.game_sessions (
  session_id uuid primary key,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.turns (
  turn_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  turn_no integer not null,
  player_action text not null,
  gm_description text,
  current_state jsonb not null default '{}'::jsonb,
  next_state jsonb not null default '{}'::jsonb,
  mentions text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  unique (session_id, turn_no)
);

create table if not exists public.entities (
  entity_id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  entity_type text not null check (entity_type in ('player', 'npc', 'location', 'item', 'quest', 'faction', 'event_tag')),
  entity_key text not null,
  display_name text not null,
  aliases text[] not null default '{}'::text[],
  description_short text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, entity_type, entity_key)
);

create table if not exists public.events (
  event_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  turn_id bigint references public.turns(turn_id) on delete set null,
  event_type text not null default 'interaction',
  summary text not null,
  importance double precision not null default 0.5 check (importance >= 0 and importance <= 1),
  location_name text,
  actor_entity_ids uuid[] not null default '{}'::uuid[],
  payload jsonb not null default '{}'::jsonb,
  caused_by_event_id bigint references public.events(event_id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.event_edges (
  cause_event_id bigint not null references public.events(event_id) on delete cascade,
  effect_event_id bigint not null references public.events(event_id) on delete cascade,
  edge_type text not null default 'causes',
  created_at timestamptz not null default now(),
  primary key (cause_event_id, effect_event_id, edge_type),
  check (cause_event_id <> effect_event_id)
);

create table if not exists public.entity_state (
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  entity_id uuid not null references public.entities(entity_id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  relation_to_player double precision not null default 0,
  last_seen_turn bigint references public.turns(turn_id) on delete set null,
  last_seen_location text,
  updated_at timestamptz not null default now(),
  primary key (session_id, entity_id)
);

create table if not exists public.relations (
  relation_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  from_entity_id uuid not null references public.entities(entity_id) on delete cascade,
  to_entity_id uuid not null references public.entities(entity_id) on delete cascade,
  relation_type text not null,
  weight double precision not null default 0,
  evidence_event_id bigint references public.events(event_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, from_entity_id, to_entity_id, relation_type)
);

create table if not exists public.quest_state (
  quest_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  quest_key text not null,
  quest_name text not null,
  status text not null default 'active' check (status in ('active', 'completed', 'failed')),
  objectives jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, quest_key)
);

create table if not exists public.memory_items (
  memory_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  turn_id bigint references public.turns(turn_id) on delete set null,
  source_event_id bigint references public.events(event_id) on delete set null,
  text_content text not null,
  memory_fts tsvector generated always as (to_tsvector('simple', coalesce(text_content, ''))) stored,
  entity_ids uuid[] not null default '{}'::uuid[],
  location_name text,
  memory_type text not null default 'interaction',
  importance double precision not null default 0.5 check (importance >= 0 and importance <= 1),
  pinned boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now()
);

create table if not exists public.embedding_jobs (
  job_id bigserial primary key,
  session_id uuid not null references public.game_sessions(session_id) on delete cascade,
  memory_id bigint not null references public.memory_items(memory_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (memory_id)
);

create index if not exists idx_turns_session_created_at
  on public.turns (session_id, created_at desc);

create index if not exists idx_entities_session_type_key
  on public.entities (session_id, entity_type, entity_key);

create index if not exists idx_events_session_created_at
  on public.events (session_id, created_at desc);

create index if not exists idx_events_session_turn
  on public.events (session_id, turn_id desc);

create index if not exists idx_relations_session_from_to
  on public.relations (session_id, from_entity_id, to_entity_id);

create index if not exists idx_quest_state_session_status
  on public.quest_state (session_id, status);

create index if not exists idx_memory_items_session_created_at
  on public.memory_items (session_id, created_at desc);

create index if not exists idx_memory_items_session_pinned
  on public.memory_items (session_id, pinned, importance desc, created_at desc);

create index if not exists idx_memory_items_memory_fts
  on public.memory_items using gin (memory_fts);

create index if not exists idx_memory_items_embedding_hnsw
  on public.memory_items using hnsw (embedding vector_cosine_ops);

create index if not exists idx_embedding_jobs_status_run_after
  on public.embedding_jobs (status, run_after, attempts);

drop trigger if exists trg_game_sessions_updated_at on public.game_sessions;
create trigger trg_game_sessions_updated_at
before update on public.game_sessions
for each row execute function public.set_updated_at();

drop trigger if exists trg_entities_updated_at on public.entities;
create trigger trg_entities_updated_at
before update on public.entities
for each row execute function public.set_updated_at();

drop trigger if exists trg_entity_state_updated_at on public.entity_state;
create trigger trg_entity_state_updated_at
before update on public.entity_state
for each row execute function public.set_updated_at();

drop trigger if exists trg_relations_updated_at on public.relations;
create trigger trg_relations_updated_at
before update on public.relations
for each row execute function public.set_updated_at();

drop trigger if exists trg_quest_state_updated_at on public.quest_state;
create trigger trg_quest_state_updated_at
before update on public.quest_state
for each row execute function public.set_updated_at();

drop trigger if exists trg_embedding_jobs_updated_at on public.embedding_jobs;
create trigger trg_embedding_jobs_updated_at
before update on public.embedding_jobs
for each row execute function public.set_updated_at();

create or replace function public.search_memory_context_hybrid(
  p_session_id uuid,
  p_query_text text,
  p_query_embedding extensions.vector(1536) default null,
  p_match_count integer default 8,
  p_semantic_weight double precision default 1.0,
  p_keyword_weight double precision default 1.0,
  p_rrf_k integer default 50,
  p_pinned_boost double precision default 0.2
)
returns table (
  memory_id bigint,
  text_content text,
  importance double precision,
  pinned boolean,
  created_at timestamptz,
  score double precision
)
language sql
stable
as $$
with params as (
  select greatest(1, least(coalesce(p_match_count, 8), 30))::integer as k
),
semantic as (
  select
    mi.memory_id,
    row_number() over (order by mi.embedding <=> p_query_embedding) as rank_ix
  from public.memory_items mi
  where
    mi.session_id = p_session_id
    and p_query_embedding is not null
    and mi.embedding is not null
  order by mi.embedding <=> p_query_embedding
  limit (select k * 3 from params)
),
keyword as (
  select
    mi.memory_id,
    row_number() over (
      order by
        ts_rank_cd(mi.memory_fts, websearch_to_tsquery('simple', p_query_text)) desc,
        mi.importance desc,
        mi.created_at desc
    ) as rank_ix
  from public.memory_items mi
  where
    mi.session_id = p_session_id
    and coalesce(trim(p_query_text), '') <> ''
    and mi.memory_fts @@ websearch_to_tsquery('simple', p_query_text)
  order by rank_ix
  limit (select k * 3 from params)
),
pinned as (
  select mi.memory_id
  from public.memory_items mi
  where mi.session_id = p_session_id and mi.pinned = true
  order by mi.importance desc, mi.created_at desc
  limit (select least(5, k) from params)
),
rrf as (
  select
    mi.memory_id,
    coalesce(p_semantic_weight / (p_rrf_k + s.rank_ix), 0.0) +
    coalesce(p_keyword_weight / (p_rrf_k + k.rank_ix), 0.0) +
    case when p.memory_id is not null then p_pinned_boost else 0.0 end as score
  from public.memory_items mi
  left join semantic s on s.memory_id = mi.memory_id
  left join keyword k on k.memory_id = mi.memory_id
  left join pinned p on p.memory_id = mi.memory_id
  where
    mi.session_id = p_session_id
    and (s.rank_ix is not null or k.rank_ix is not null or p.memory_id is not null)
),
fallback_recent as (
  select
    mi.memory_id,
    0.01::double precision as score
  from public.memory_items mi
  where mi.session_id = p_session_id
  order by mi.created_at desc
  limit (select k from params)
),
combined as (
  select * from rrf
  union all
  select fr.* from fallback_recent fr
  where not exists (select 1 from rrf)
),
ranked as (
  select c.memory_id, max(c.score) as score
  from combined c
  group by c.memory_id
)
select
  mi.memory_id,
  mi.text_content,
  mi.importance,
  mi.pinned,
  mi.created_at,
  r.score
from ranked r
join public.memory_items mi on mi.memory_id = r.memory_id
order by r.score desc, mi.importance desc, mi.created_at desc
limit (select k from params);
$$;
