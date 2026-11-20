-- Phrase Phone: run this in the SQL editor of a dedicated Supabase project.
-- Each player writes an opening, then contributes once to every other story.

create table if not exists public.pp_rooms (
  code text primary key,
  state jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.pp_rooms enable row level security;
revoke all on public.pp_rooms from anon, authenticated;

create or replace function public.pp_create_room(p_name text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_name text := btrim(p_name);
begin
  if coalesce(length(v_name), 0) not between 1 and 18 or coalesce(length(p_token), 0) < 20 then
    raise exception 'invalid_player';
  end if;

  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.pp_rooms where code = v_code);
  end loop;

  insert into public.pp_rooms(code, state)
  values (
    v_code,
    jsonb_build_object(
      'status', 'lobby',
      'host_token', p_token,
      'round_index', 0,
      'round_submissions', '[]'::jsonb,
      'players', jsonb_build_array(jsonb_build_object('name', v_name, 'token', p_token)),
      'stories', '[]'::jsonb
    )
  );
  return jsonb_build_object('code', v_code);
end;
$$;

create or replace function public.pp_join_room(p_code text, p_name text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
  v_name text := btrim(p_name);
begin
  select state into v_state
  from public.pp_rooms
  where code = upper(p_code)
  for update;

  if not found then raise exception 'room_not_found'; end if;

  if exists (
    select 1 from jsonb_array_elements(v_state->'players') as x(player)
    where x.player->>'token' = p_token
  ) then
    return jsonb_build_object('ok', true);
  end if;

  if v_state->>'status' <> 'lobby' then raise exception 'room_started'; end if;
  if jsonb_array_length(v_state->'players') >= 12 then raise exception 'room_full'; end if;
  if coalesce(length(v_name), 0) not between 1 and 18 or coalesce(length(p_token), 0) < 20 then
    raise exception 'invalid_player';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_state->'players') as x(player)
    where lower(x.player->>'name') = lower(v_name)
  ) then
    raise exception 'already_joined';
  end if;

  update public.pp_rooms
  set state = jsonb_set(
    v_state,
    '{players}',
    (v_state->'players') || jsonb_build_array(jsonb_build_object('name', v_name, 'token', p_token)),
    true
  )
  where code = upper(p_code);

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.pp_start_room(p_code text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
begin
  select state into v_state
  from public.pp_rooms
  where code = upper(p_code)
  for update;

  if not found then raise exception 'room_not_found'; end if;
  if v_state->>'host_token' is distinct from p_token then raise exception 'not_host'; end if;
  if v_state->>'status' <> 'lobby' then raise exception 'room_already_started'; end if;
  if jsonb_array_length(v_state->'players') < 2 then raise exception 'need_players'; end if;

  v_state := jsonb_set(v_state, '{status}', '"openings"'::jsonb, true);
  v_state := jsonb_set(v_state, '{stories}', '[]'::jsonb, true);
  v_state := jsonb_set(v_state, '{round_index}', '0'::jsonb, true);
  v_state := jsonb_set(v_state, '{round_submissions}', '[]'::jsonb, true);

  update public.pp_rooms set state = v_state where code = upper(p_code);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.pp_get_room(p_code text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
  v_players jsonb;
  v_stories jsonb := '[]'::jsonb;
  v_status text;
  v_player_index integer;
  v_target_token text;
  v_player_count integer;
  v_round_index integer := 0;
  v_story_index integer;
  v_submissions jsonb := '[]'::jsonb;
  v_has_submitted boolean := false;
  v_is_my_turn boolean := false;
  v_submitted_count integer := 0;
  v_previous_phrase text := null;
begin
  select state into v_state from public.pp_rooms where code = upper(p_code);
  if not found then raise exception 'room_not_found'; end if;
  if not (v_state ? 'stories') then raise exception 'old_room'; end if;

  select ordinality::integer - 1 into v_player_index
  from jsonb_array_elements(v_state->'players') with ordinality as x(player, ordinality)
  where x.player->>'token' = p_token;
  if v_player_index is null then raise exception 'not_a_player'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('name', x.player->>'name') order by x.ordinality), '[]'::jsonb)
  into v_players
  from jsonb_array_elements(v_state->'players') with ordinality as x(player, ordinality);

  v_status := v_state->>'status';
  v_player_count := jsonb_array_length(v_state->'players');
  v_round_index := coalesce((v_state->>'round_index')::integer, 0);
  v_submissions := coalesce(v_state->'round_submissions', '[]'::jsonb);

  if v_status = 'openings' then
    v_submitted_count := jsonb_array_length(v_state->'stories');
    v_has_submitted := exists (
      select 1 from jsonb_array_elements(v_state->'stories') as x(story)
      where x.story->>'owner_token' = p_token
    );
    v_is_my_turn := not v_has_submitted;
  elsif v_status = 'playing' then
    v_submitted_count := jsonb_array_length(v_submissions);
    v_has_submitted := exists (
      select 1 from jsonb_array_elements(v_submissions) as x(token)
      where x.token = to_jsonb(p_token)
    );
    v_is_my_turn := not v_has_submitted;
    if v_is_my_turn then
      v_story_index := mod(v_player_index + v_round_index + 1, v_player_count);
      v_target_token := v_state->'players'->v_story_index->>'token';
      select ordinality::integer - 1, story->>'text'
      into v_story_index, v_previous_phrase
      from jsonb_array_elements(v_state->'stories') with ordinality as x(story, ordinality)
      where x.story->>'owner_token' = v_target_token;
      if v_story_index is null then raise exception 'old_room'; end if;
    end if;
  elsif v_status = 'finished' then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'owner', x.story->>'owner',
          'lines', coalesce((
            select jsonb_agg(jsonb_build_object('name', line.value->>'name', 'text', line.value->>'text') order by line.ordinality)
            from jsonb_array_elements(coalesce(x.story->'lines', '[]'::jsonb)) with ordinality as line(value, ordinality)
          ), '[]'::jsonb)
        ) order by x.ordinality
      ),
      '[]'::jsonb
    ) into v_stories
    from jsonb_array_elements(v_state->'stories') with ordinality as x(story, ordinality);
  end if;

  return jsonb_build_object(
    'status', v_status,
    'players', v_players,
    'stories', v_stories,
    'round_number', case when v_status = 'playing' then v_round_index + 1 else 0 end,
    'round_total', greatest(v_player_count - 1, 0),
    'submitted_count', v_submitted_count,
    'previous_phrase', v_previous_phrase,
    'is_host', v_state->>'host_token' = p_token,
    'is_my_turn', v_is_my_turn,
    'has_submitted', v_has_submitted
  );
end;
$$;

create or replace function public.pp_submit_turn(p_code text, p_token text, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state jsonb;
  v_players jsonb;
  v_stories jsonb;
  v_story jsonb;
  v_lines jsonb;
  v_submissions jsonb;
  v_name text;
  v_phrase text := btrim(p_text);
  v_status text;
  v_player_index integer;
  v_target_player_index integer;
  v_target_token text;
  v_player_count integer;
  v_round_index integer;
  v_story_index integer;
begin
  if coalesce(length(v_phrase), 0) not between 1 and 240 then raise exception 'invalid_phrase'; end if;

  select state into v_state
  from public.pp_rooms
  where code = upper(p_code)
  for update;

  if not found then raise exception 'room_not_found'; end if;
  if not (v_state ? 'stories') then raise exception 'old_room'; end if;

  v_status := v_state->>'status';
  v_players := v_state->'players';
  v_player_count := jsonb_array_length(v_players);
  v_stories := coalesce(v_state->'stories', '[]'::jsonb);

  select ordinality::integer - 1, player->>'name'
  into v_player_index, v_name
  from jsonb_array_elements(v_players) with ordinality as x(player, ordinality)
  where x.player->>'token' = p_token;
  if v_player_index is null then raise exception 'not_a_player'; end if;

  if v_status = 'openings' then
    if exists (
      select 1 from jsonb_array_elements(v_stories) as x(story)
      where x.story->>'owner_token' = p_token
    ) then
      raise exception 'already_submitted';
    end if;

    v_story := jsonb_build_object(
      'owner', v_name,
      'owner_token', p_token,
      'text', v_phrase,
      'lines', jsonb_build_array(jsonb_build_object('name', v_name, 'text', v_phrase))
    );
    v_stories := v_stories || jsonb_build_array(v_story);
    v_state := jsonb_set(v_state, '{stories}', v_stories, true);
    if jsonb_array_length(v_stories) = v_player_count then
      v_state := jsonb_set(v_state, '{status}', '"playing"'::jsonb, true);
      v_state := jsonb_set(v_state, '{round_index}', '0'::jsonb, true);
      v_state := jsonb_set(v_state, '{round_submissions}', '[]'::jsonb, true);
    end if;

    update public.pp_rooms set state = v_state where code = upper(p_code);
    return jsonb_build_object('ok', true);
  end if;

  if v_status <> 'playing' then raise exception 'room_not_waiting'; end if;

  v_submissions := coalesce(v_state->'round_submissions', '[]'::jsonb);
  if exists (
    select 1 from jsonb_array_elements(v_submissions) as x(token)
    where x.token = to_jsonb(p_token)
  ) then
    raise exception 'already_submitted';
  end if;

  v_round_index := coalesce((v_state->>'round_index')::integer, 0);
  v_target_player_index := mod(v_player_index + v_round_index + 1, v_player_count);
  v_target_token := v_players->v_target_player_index->>'token';
  select ordinality::integer - 1 into v_story_index
  from jsonb_array_elements(v_stories) with ordinality as x(story, ordinality)
  where x.story->>'owner_token' = v_target_token;
  if v_story_index is null then raise exception 'old_room'; end if;
  v_story := v_stories->v_story_index;
  if v_story is null then raise exception 'old_room'; end if;

  v_lines := coalesce(v_story->'lines', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('name', v_name, 'text', v_phrase));
  v_story := jsonb_set(jsonb_set(v_story, '{lines}', v_lines, true), '{text}', to_jsonb(v_phrase), true);
  v_stories := jsonb_set(v_stories, array[v_story_index::text], v_story, true);
  v_submissions := v_submissions || to_jsonb(p_token);
  v_state := jsonb_set(v_state, '{stories}', v_stories, true);

  if jsonb_array_length(v_submissions) = v_player_count then
    if v_round_index >= v_player_count - 2 then
      v_state := jsonb_set(v_state, '{status}', '"finished"'::jsonb, true);
    else
      v_state := jsonb_set(v_state, '{round_index}', to_jsonb(v_round_index + 1), true);
      v_submissions := '[]'::jsonb;
    end if;
  end if;

  v_state := jsonb_set(v_state, '{round_submissions}', v_submissions, true);
  update public.pp_rooms set state = v_state where code = upper(p_code);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.pp_create_room(text, text) from public, anon, authenticated;
revoke all on function public.pp_join_room(text, text, text) from public, anon, authenticated;
revoke all on function public.pp_start_room(text, text) from public, anon, authenticated;
revoke all on function public.pp_get_room(text, text) from public, anon, authenticated;
revoke all on function public.pp_submit_turn(text, text, text) from public, anon, authenticated;

grant execute on function public.pp_create_room(text, text) to anon, authenticated;
grant execute on function public.pp_join_room(text, text, text) to anon, authenticated;
grant execute on function public.pp_start_room(text, text) to anon, authenticated;
grant execute on function public.pp_get_room(text, text) to anon, authenticated;
grant execute on function public.pp_submit_turn(text, text, text) to anon, authenticated;
