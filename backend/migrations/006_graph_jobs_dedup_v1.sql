-- 006_graph_jobs_dedup_v1.sql
-- Applied to Supabase (zmjvuahejpofdfwnqmpt) on 2026-07-05.
-- Companion to the graph_jobs queue fix in supabaseWorldService.js:
-- one unfinished job per (session, type, scope), jobs closed without work
-- get the new 'skipped' status.

-- 1. Allow 'skipped' status for jobs closed without work (dedup / already fresh).
alter table public.graph_jobs drop constraint graph_jobs_status_check;
alter table public.graph_jobs add constraint graph_jobs_status_check
  check (status in ('pending', 'processing', 'completed', 'failed', 'skipped'));

-- 2. One-time cleanup: keep the newest unfinished job per target, skip the rest.
with ranked as (
  select job_id,
         row_number() over (
           partition by session_id, job_type, coalesce(scope_type, ''), coalesce(scope_key, '')
           order by created_at desc, job_id desc
         ) as rn
  from public.graph_jobs
  where status in ('pending', 'failed')
)
update public.graph_jobs gj
set status = 'skipped',
    last_error = 'superseded by newer duplicate (006 cleanup)'
from ranked r
where gj.job_id = r.job_id and r.rn > 1;

-- 3. Guard: at most one unfinished job per (session, type, scope).
create unique index if not exists uq_graph_jobs_active_target
  on public.graph_jobs (session_id, job_type, coalesce(scope_type, ''), coalesce(scope_key, ''))
  where status in ('pending', 'failed');
