-- Phrase Phone: run this in the SQL editor of a dedicated Supabase project.
create table if not exists public.pp_rooms (
  code text primary key,
  state jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.pp_rooms enable row level security;
revoke all on public.pp_rooms from anon, authenticated;

create or replace function public.pp_create_room(p_name text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c text; n text := btrim(p_name);
begin
 if length(n) not between 1 and 18 or length(p_token)<20 then raise exception 'invalid_player'; end if;
 loop c:=upper(substr(md5(random()::text||clock_timestamp()::text),1,6)); exit when not exists(select 1 from public.pp_rooms where code=c); end loop;
 insert into public.pp_rooms(code,state) values(c,jsonb_build_object('status','lobby','host_token',p_token,'turn_index',0,'previous_phrase',null,'players',jsonb_build_array(jsonb_build_object('name',n,'token',p_token)),'history','[]'::jsonb));
 return jsonb_build_object('code',c);
end $$;

create or replace function public.pp_join_room(p_code text,p_name text,p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s jsonb; n text:=btrim(p_name);
begin
 select state into s from public.pp_rooms where code=upper(p_code) for update;
 if not found then raise exception 'room_not_found'; end if;
 if exists(select 1 from jsonb_array_elements(s->'players') as x(p) where x.p->>'token'=p_token) then return jsonb_build_object('ok',true); end if;
 if s->>'status'<>'lobby' then raise exception 'room_started'; end if;
 if jsonb_array_length(s->'players')>=12 then raise exception 'room_full'; end if;
 if length(n) not between 1 and 18 or length(p_token)<20 then raise exception 'invalid_player'; end if;
 if exists(select 1 from jsonb_array_elements(s->'players') as x(p) where lower(x.p->>'name')=lower(n)) then raise exception 'already_joined'; end if;
 update public.pp_rooms set state=jsonb_set(s,'{players}',(s->'players')||jsonb_build_array(jsonb_build_object('name',n,'token',p_token))) where code=upper(p_code);
 return jsonb_build_object('ok',true);
end $$;

create or replace function public.pp_start_room(p_code text,p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s jsonb;
begin
 select state into s from public.pp_rooms where code=upper(p_code) for update;
 if not found then raise exception 'room_not_found'; end if;
 if s->>'host_token'<>p_token then raise exception 'not_host'; end if;
 if s->>'status'<>'lobby' then raise exception 'room_already_started'; end if;
 if jsonb_array_length(s->'players')<2 then raise exception 'need_players'; end if;
 update public.pp_rooms set state=jsonb_set(s,'{status}','"playing"') where code=upper(p_code);
 return jsonb_build_object('ok',true);
end $$;

create or replace function public.pp_get_room(p_code text,p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s jsonb; players jsonb; history jsonb; myturn boolean;
begin
 select state into s from public.pp_rooms where code=upper(p_code);
 if not found then raise exception 'room_not_found'; end if;
 if not exists(select 1 from jsonb_array_elements(s->'players') as x(p) where x.p->>'token'=p_token) then raise exception 'not_a_player'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('name',p->>'name') order by ord),'[]'::jsonb) into players from jsonb_array_elements(s->'players') with ordinality t(p,ord);
 history:=case when s->>'status'='finished' then s->'history' else '[]'::jsonb end;
 myturn:=false;
 if s->>'status'='playing' then myturn:=(s->'players'->((s->>'turn_index')::int)->>'token')=p_token; end if;
 return jsonb_build_object('status',s->>'status','players',players,'turn_index',(s->>'turn_index')::int,'previous_phrase',s->'previous_phrase','history',history,'is_host',s->>'host_token'=p_token,'is_my_turn',myturn);
end $$;

create or replace function public.pp_submit_turn(p_code text,p_token text,p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s jsonb; idx int; players jsonb; hist jsonb; phrase text:=btrim(p_text); next_status text:='playing';
begin
 if length(phrase) not between 1 and 240 then raise exception 'invalid_phrase'; end if;
 select state into s from public.pp_rooms where code=upper(p_code) for update;
 if not found then raise exception 'room_not_found'; end if;
 if s->>'status'<>'playing' then raise exception 'room_not_waiting'; end if;
 idx:=(s->>'turn_index')::int; players:=s->'players';
 if players->idx->>'token'<>p_token then raise exception 'not_your_turn'; end if;
 hist:=(s->'history')||jsonb_build_array(jsonb_build_object('name',players->idx->>'name','text',phrase));
 idx:=idx+1; if idx>=jsonb_array_length(players) then next_status:='finished'; end if;
 update public.pp_rooms set state=jsonb_set(jsonb_set(jsonb_set(jsonb_set(s,'{history}',hist),'{previous_phrase}',to_jsonb(phrase)),'{turn_index}',to_jsonb(idx)),'{status}',to_jsonb(next_status)) where code=upper(p_code);
 return jsonb_build_object('ok',true);
end $$;

revoke all on function public.pp_create_room(text,text) from public;
revoke all on function public.pp_join_room(text,text,text) from public;
revoke all on function public.pp_start_room(text,text) from public;
revoke all on function public.pp_get_room(text,text) from public;
revoke all on function public.pp_submit_turn(text,text,text) from public;
grant execute on function public.pp_create_room(text,text) to anon,authenticated;
grant execute on function public.pp_join_room(text,text,text) to anon,authenticated;
grant execute on function public.pp_start_room(text,text) to anon,authenticated;
grant execute on function public.pp_get_room(text,text) to anon,authenticated;
grant execute on function public.pp_submit_turn(text,text,text) to anon,authenticated;
