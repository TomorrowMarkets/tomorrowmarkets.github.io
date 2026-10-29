-- Run on an isolated Supabase database after BOTH migrations. All changes roll back.
begin;
do $$ declare old_key text; new_key text; category jsonb; rejected boolean:=false; begin
 category:='{"version":2,"challenge":"trading","strategy":"discretionary","source":"simulated","sessionDays":5,"barMinutes":5,"durationMinutes":20,"playMode":"single","roundDays":5,"datasetId":"simulation-v2"}';
 old_key:=tm_private.board_key(category);
 if old_key<>'2|trading|discretionary|simulated|5|5|20|single|5|simulation-v2' then raise exception 'Previous boards changed'; end if;
 category:=category||'{"version":3,"sessionDays":60,"durationMinutes":120,"datasetId":"simulation-v3","roundSeconds":0}';
 new_key:=tm_private.board_key(category);
 if new_key=old_key then raise exception 'New rules mixed with previous rules'; end if;
 category:=category||'{"challenge":"portfolio","source":"historical","sessionDays":365,"barMinutes":0,"durationMinutes":0,"roundSeconds":30}';
 new_key:=tm_private.board_key(category);
 if new_key=tm_private.board_key(category||'{"roundSeconds":60}') then raise exception 'Portfolio clocks were mixed'; end if;
 begin perform tm_private.board_key(category||'{"roundSeconds":5}'); exception when others then rejected:=true; end;
 if not rejected then raise exception 'A short allocation clock was accepted'; end if;
end $$;
insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000301','tm-qa-301@example.invalid') on conflict do nothing;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000301',true);
create temporary table tm_v3_test_run(id uuid);
insert into tm_v3_test_run select public.tm_start_run_v2('{"version":3,"challenge":"portfolio","strategy":"discretionary","source":"historical","sessionDays":365,"barMinutes":0,"durationMinutes":0,"playMode":"single","roundDays":5,"roundSeconds":30,"datasetId":"demo-portfolio"}');
do $$ declare rejected boolean:=false; begin
 begin perform public.tm_finish_run_v2((select id from tm_v3_test_run),'Alice',0,0,0); exception when others then rejected:=true; end;
 if not rejected then raise exception 'An immediate portfolio score was accepted'; end if;
end $$;
update public.tm_runs_v2 set started_at=clock_timestamp()-interval '1 hour' where id=(select id from tm_v3_test_run);
select public.tm_finish_run_v2((select id from tm_v3_test_run),'Alice',0,0,0);
rollback;
