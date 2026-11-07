-- State updater v1:
-- - transactional patch application for entity_state / relations / quest_state / derived events
-- - validation guardrails for impossible state transitions
-- - world tick + encounter trigger generation based on last_seen and probabilities

create or replace function public.entity_state_is_dead(p_state jsonb)
returns boolean
language sql
immutable
as $$
  select
    case
      when p_state is null then false
      when jsonb_typeof(p_state->'is_dead') = 'boolean' then (p_state->>'is_dead')::boolean
      when lower(coalesce(p_state->>'status', '')) in ('dead', 'deceased', 'killed') then true
      else false
    end;
$$;

create or replace function public.apply_state_patches_v1(
  p_session_id uuid,
  p_turn_id bigint,
  p_turn_no integer,
  p_cause_event_id bigint default null,
  p_location_name text default null,
  p_patches jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state_patch jsonb;
  v_relation_patch jsonb;
  v_quest_patch jsonb;
  v_event_patch jsonb;
  v_world_cfg jsonb := coalesce(p_patches->'world_tick', '{}'::jsonb);

  v_entity_id uuid;
  v_from_entity_id uuid;
  v_to_entity_id uuid;
  v_relation_type text;
  v_relation_weight double precision;
  v_relation_metadata jsonb;
  v_relation_evidence bigint;

  v_existing_state jsonb;
  v_existing_relation_to_player double precision;
  v_existing_last_seen_turn bigint;
  v_existing_last_seen_location text;
  v_state_delta jsonb;
  v_merged_state jsonb;
  v_relation_to_player double precision;
  v_last_seen_turn bigint;
  v_last_seen_location text;
  v_reason text;

  v_quest_key text;
  v_quest_name text;
  v_quest_status text;
  v_quest_objectives jsonb;
  v_quest_metadata jsonb;

  v_event_type text;
  v_event_summary text;
  v_event_importance double precision;
  v_event_payload jsonb;
  v_event_location text;
  v_event_actor_ids uuid[];
  v_event_inserted_id bigint;

  v_player_entity_id uuid;
  v_candidate record;
  v_turns_since integer;
  v_probability double precision;
  v_roll double precision;
  v_roll_hex text;
  v_due_offset integer := greatest(1, least(coalesce((v_world_cfg->>'encounter_due_offset')::integer, 1), 6));
  v_max_candidates integer := greatest(1, least(coalesce((v_world_cfg->>'max_candidates')::integer, 8), 20));
  v_max_encounters integer := greatest(0, least(coalesce((v_world_cfg->>'max_encounters')::integer, 2), 5));
  v_base_probability double precision := greatest(0.01, least(coalesce((v_world_cfg->>'base_probability')::double precision, 0.12), 0.90));
  v_step_probability double precision := greatest(0.01, least(coalesce((v_world_cfg->>'step_probability')::double precision, 0.06), 0.30));
  v_max_probability double precision := greatest(0.05, least(coalesce((v_world_cfg->>'max_probability')::double precision, 0.78), 0.95));
  v_world_tick_enabled boolean := coalesce((v_world_cfg->>'enabled')::boolean, true);
  v_pending_exists boolean;

  v_state_upserts integer := 0;
  v_relation_upserts integer := 0;
  v_quest_upserts integer := 0;
  v_event_inserts integer := 0;
  v_world_candidates integer := 0;
  v_world_encounters integer := 0;
  v_world_tick_event_id bigint;
begin
  if p_session_id is null then
    raise exception 'apply_state_patches_v1: p_session_id is required';
  end if;
  if p_turn_id is null then
    raise exception 'apply_state_patches_v1: p_turn_id is required';
  end if;

  perform 1
  from public.turns t
  where t.turn_id = p_turn_id
    and t.session_id = p_session_id;
  if not found then
    raise exception 'apply_state_patches_v1: turn % does not belong to session %', p_turn_id, p_session_id;
  end if;

  for v_state_patch in
    select value
    from jsonb_array_elements(coalesce(p_patches->'state_patches', '[]'::jsonb))
  loop
    v_entity_id := nullif(v_state_patch->>'entity_id', '')::uuid;
    if v_entity_id is null then
      raise exception 'apply_state_patches_v1: state patch is missing entity_id';
    end if;

    select es.state, es.relation_to_player, es.last_seen_turn, es.last_seen_location
      into v_existing_state, v_existing_relation_to_player, v_existing_last_seen_turn, v_existing_last_seen_location
    from public.entity_state es
    where es.session_id = p_session_id
      and es.entity_id = v_entity_id
    for update;

    v_state_delta := case
      when jsonb_typeof(v_state_patch->'state_delta') = 'object' then v_state_patch->'state_delta'
      else '{}'::jsonb
    end;
    v_merged_state := coalesce(v_existing_state, '{}'::jsonb) || v_state_delta;

    if public.entity_state_is_dead(coalesce(v_existing_state, '{}'::jsonb))
       and not public.entity_state_is_dead(v_merged_state) then
      v_reason := lower(coalesce(v_state_patch->>'reason', ''));
      if v_reason !~ '(revive|resurrect|heal|medic|stimpak|defibrillator)' then
        raise exception 'apply_state_patches_v1: invalid dead->alive transition for entity %, reason: %', v_entity_id, coalesce(v_reason, '');
      end if;
    end if;

    v_relation_to_player := case
      when v_state_patch ? 'relation_to_player' then (v_state_patch->>'relation_to_player')::double precision
      else coalesce(v_existing_relation_to_player, 0)
    end;
    if v_relation_to_player < -1 or v_relation_to_player > 1 then
      raise exception 'apply_state_patches_v1: relation_to_player out of range for entity %', v_entity_id;
    end if;

    v_last_seen_turn := coalesce(
      nullif(v_state_patch->>'last_seen_turn', '')::bigint,
      p_turn_id,
      v_existing_last_seen_turn
    );
    v_last_seen_location := coalesce(
      nullif(v_state_patch->>'last_seen_location', ''),
      p_location_name,
      v_existing_last_seen_location
    );

    insert into public.entity_state (
      session_id,
      entity_id,
      state,
      relation_to_player,
      last_seen_turn,
      last_seen_location
    )
    values (
      p_session_id,
      v_entity_id,
      coalesce(v_merged_state, '{}'::jsonb),
      v_relation_to_player,
      v_last_seen_turn,
      v_last_seen_location
    )
    on conflict (session_id, entity_id) do update
    set
      state = excluded.state,
      relation_to_player = excluded.relation_to_player,
      last_seen_turn = excluded.last_seen_turn,
      last_seen_location = excluded.last_seen_location;

    v_state_upserts := v_state_upserts + 1;
  end loop;

  for v_relation_patch in
    select value
    from jsonb_array_elements(coalesce(p_patches->'relation_patches', '[]'::jsonb))
  loop
    v_from_entity_id := nullif(v_relation_patch->>'from_entity_id', '')::uuid;
    v_to_entity_id := nullif(v_relation_patch->>'to_entity_id', '')::uuid;
    v_relation_type := nullif(trim(coalesce(v_relation_patch->>'relation_type', '')), '');
    v_relation_weight := coalesce((v_relation_patch->>'weight')::double precision, 0);
    v_relation_metadata := case
      when jsonb_typeof(v_relation_patch->'metadata') = 'object' then v_relation_patch->'metadata'
      else '{}'::jsonb
    end;
    v_relation_evidence := coalesce(nullif(v_relation_patch->>'evidence_event_id', '')::bigint, p_cause_event_id);

    if v_from_entity_id is null or v_to_entity_id is null or v_relation_type is null then
      raise exception 'apply_state_patches_v1: relation patch must include from_entity_id/to_entity_id/relation_type';
    end if;
    if v_relation_weight < -1 or v_relation_weight > 1 then
      raise exception 'apply_state_patches_v1: relation weight out of range (%).', v_relation_weight;
    end if;

    insert into public.relations (
      session_id,
      from_entity_id,
      to_entity_id,
      relation_type,
      weight,
      evidence_event_id,
      metadata
    )
    values (
      p_session_id,
      v_from_entity_id,
      v_to_entity_id,
      v_relation_type,
      v_relation_weight,
      v_relation_evidence,
      v_relation_metadata
    )
    on conflict (session_id, from_entity_id, to_entity_id, relation_type) do update
    set
      weight = excluded.weight,
      evidence_event_id = coalesce(excluded.evidence_event_id, relations.evidence_event_id),
      metadata = coalesce(relations.metadata, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb);

    v_relation_upserts := v_relation_upserts + 1;
  end loop;

  for v_quest_patch in
    select value
    from jsonb_array_elements(coalesce(p_patches->'quest_patches', '[]'::jsonb))
  loop
    v_quest_name := nullif(trim(coalesce(v_quest_patch->>'quest_name', '')), '');
    v_quest_key := nullif(trim(coalesce(v_quest_patch->>'quest_key', '')), '');
    v_quest_status := lower(coalesce(v_quest_patch->>'status', 'active'));
    v_quest_objectives := case
      when jsonb_typeof(v_quest_patch->'objectives') = 'array' then v_quest_patch->'objectives'
      else '[]'::jsonb
    end;
    v_quest_metadata := case
      when jsonb_typeof(v_quest_patch->'metadata') = 'object' then v_quest_patch->'metadata'
      else '{}'::jsonb
    end;

    if v_quest_name is null then
      raise exception 'apply_state_patches_v1: quest patch requires quest_name';
    end if;
    if v_quest_key is null then
      v_quest_key := lower(regexp_replace(v_quest_name, '\s+', ' ', 'g'));
    end if;
    if v_quest_status not in ('active', 'completed', 'failed') then
      raise exception 'apply_state_patches_v1: invalid quest status %', v_quest_status;
    end if;

    insert into public.quest_state (
      session_id,
      quest_key,
      quest_name,
      status,
      objectives,
      metadata
    )
    values (
      p_session_id,
      v_quest_key,
      v_quest_name,
      v_quest_status,
      v_quest_objectives,
      v_quest_metadata
    )
    on conflict (session_id, quest_key) do update
    set
      quest_name = excluded.quest_name,
      status = excluded.status,
      objectives = excluded.objectives,
      metadata = coalesce(quest_state.metadata, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb);

    v_quest_upserts := v_quest_upserts + 1;
  end loop;

  for v_event_patch in
    select value
    from jsonb_array_elements(coalesce(p_patches->'event_patches', '[]'::jsonb))
  loop
    v_event_type := nullif(trim(coalesce(v_event_patch->>'event_type', '')), '');
    if v_event_type is null then
      v_event_type := 'state_update';
    end if;
    v_event_summary := left(coalesce(nullif(trim(v_event_patch->>'summary'), ''), format('State update (%s).', v_event_type)), 1200);
    v_event_importance := coalesce((v_event_patch->>'importance')::double precision, 0.4);
    if v_event_importance < 0 or v_event_importance > 1 then
      raise exception 'apply_state_patches_v1: event importance out of range for %', v_event_type;
    end if;

    v_event_payload := case
      when jsonb_typeof(v_event_patch->'payload') = 'object' then v_event_patch->'payload'
      else '{}'::jsonb
    end;
    v_event_location := coalesce(nullif(v_event_patch->>'location_name', ''), p_location_name);

    select coalesce(array_agg(raw_id::uuid), '{}'::uuid[])
      into v_event_actor_ids
    from (
      select value as raw_id
      from jsonb_array_elements_text(coalesce(v_event_patch->'actor_entity_ids', '[]'::jsonb))
    ) ids
    where raw_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

    insert into public.events (
      session_id,
      turn_id,
      event_type,
      summary,
      importance,
      location_name,
      actor_entity_ids,
      payload,
      caused_by_event_id
    )
    values (
      p_session_id,
      p_turn_id,
      v_event_type,
      v_event_summary,
      v_event_importance,
      v_event_location,
      coalesce(v_event_actor_ids, '{}'::uuid[]),
      v_event_payload,
      p_cause_event_id
    )
    returning event_id into v_event_inserted_id;

    if p_cause_event_id is not null then
      insert into public.event_edges (cause_event_id, effect_event_id, edge_type)
      values (p_cause_event_id, v_event_inserted_id, 'state_patch')
      on conflict do nothing;
    end if;

    v_event_inserts := v_event_inserts + 1;
  end loop;

  if v_world_tick_enabled and v_max_encounters > 0 then
    select e.entity_id
      into v_player_entity_id
    from public.entities e
    where e.session_id = p_session_id
      and e.entity_type = 'player'
    order by e.created_at asc
    limit 1;

    for v_candidate in
      select
        es.entity_id,
        e.display_name,
        es.last_seen_location,
        coalesce(t.turn_no, greatest(1, p_turn_no - 3)) as last_seen_turn_no,
        coalesce(r.weight, 0) as relation_weight
      from public.entity_state es
      join public.entities e
        on e.entity_id = es.entity_id
       and e.session_id = es.session_id
       and e.entity_type = 'npc'
      left join public.turns t
        on t.turn_id = es.last_seen_turn
      left join public.relations r
        on r.session_id = es.session_id
       and r.from_entity_id = es.entity_id
       and r.to_entity_id = v_player_entity_id
       and r.relation_type = 'attitude_to_player'
      where es.session_id = p_session_id
        and (es.last_seen_turn is null or es.last_seen_turn <> p_turn_id)
      order by es.updated_at desc
      limit v_max_candidates
    loop
      v_world_candidates := v_world_candidates + 1;
      v_turns_since := greatest(1, p_turn_no - coalesce(v_candidate.last_seen_turn_no, p_turn_no - 3));
      v_probability := least(v_max_probability, v_base_probability + least(10, v_turns_since) * v_step_probability);

      if coalesce(lower(v_candidate.last_seen_location), '') = coalesce(lower(p_location_name), '') then
        v_probability := least(0.95, v_probability + 0.18);
      else
        v_probability := greatest(0.02, v_probability - 0.04);
      end if;

      if v_candidate.relation_weight >= 0.55 then
        v_probability := least(0.95, v_probability + 0.06);
      elsif v_candidate.relation_weight <= -0.55 then
        v_probability := least(0.95, v_probability + 0.10);
      end if;

      v_roll_hex := substr(md5(p_session_id::text || ':' || p_turn_no::text || ':' || v_candidate.entity_id::text), 1, 8);
      v_roll := (('x' || v_roll_hex)::bit(32)::bigint)::double precision / 4294967295.0;

      if v_roll <= v_probability then
        select exists (
          select 1
          from public.events ev
          where ev.session_id = p_session_id
            and ev.event_type = 'encounter_hint'
            and ev.actor_entity_ids @> array[v_candidate.entity_id]::uuid[]
            and coalesce(ev.payload->>'status', 'pending') = 'pending'
          limit 1
        ) into v_pending_exists;

        if not v_pending_exists then
          insert into public.events (
            session_id,
            turn_id,
            event_type,
            summary,
            importance,
            location_name,
            actor_entity_ids,
            payload,
            caused_by_event_id
          )
          values (
            p_session_id,
            p_turn_id,
            'encounter_hint',
            format('Movement traces suggest %s may appear nearby soon.', coalesce(v_candidate.display_name, 'someone')),
            greatest(0.25, least(0.9, v_probability)),
            coalesce(p_location_name, v_candidate.last_seen_location),
            array[v_candidate.entity_id]::uuid[],
            jsonb_build_object(
              'status', 'pending',
              'due_turn_no', p_turn_no + v_due_offset,
              'source', 'world_tick_v1',
              'last_seen_location', v_candidate.last_seen_location,
              'probability', round((v_probability::numeric), 4)
            ),
            p_cause_event_id
          )
          returning event_id into v_event_inserted_id;

          if p_cause_event_id is not null then
            insert into public.event_edges (cause_event_id, effect_event_id, edge_type)
            values (p_cause_event_id, v_event_inserted_id, 'deferred_encounter')
            on conflict do nothing;
          end if;

          v_world_encounters := v_world_encounters + 1;
          exit when v_world_encounters >= v_max_encounters;
        end if;
      end if;
    end loop;

    insert into public.events (
      session_id,
      turn_id,
      event_type,
      summary,
      importance,
      location_name,
      actor_entity_ids,
      payload,
      caused_by_event_id
    )
    values (
      p_session_id,
      p_turn_id,
      'world_tick',
      format('World tick evaluated %s NPCs and queued %s encounter trigger(s).', v_world_candidates, v_world_encounters),
      0.2,
      p_location_name,
      '{}'::uuid[],
      jsonb_build_object(
        'source', 'state_updater_v1',
        'turn_no', p_turn_no,
        'candidates', v_world_candidates,
        'encounters_generated', v_world_encounters
      ),
      p_cause_event_id
    )
    returning event_id into v_world_tick_event_id;

    if p_cause_event_id is not null then
      insert into public.event_edges (cause_event_id, effect_event_id, edge_type)
      values (p_cause_event_id, v_world_tick_event_id, 'world_tick')
      on conflict do nothing;
    end if;
  end if;

  return jsonb_build_object(
    'state_upserts', v_state_upserts,
    'relation_upserts', v_relation_upserts,
    'quest_upserts', v_quest_upserts,
    'event_inserts', v_event_inserts,
    'world_tick_candidates', v_world_candidates,
    'world_tick_encounters', v_world_encounters
  );
end;
$$;
