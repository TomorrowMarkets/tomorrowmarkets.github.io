-- Apply AFTER 20261028_markets_v2.sql. Keeps all existing run tickets and boards.
begin;
create or replace function tm_private.board_key(d jsonb)
returns text language plpgsql immutable set search_path='' as $$
begin
 if d is null or jsonb_typeof(d)<>'object'
  or not (d ?& array['version','challenge','strategy','source','sessionDays','barMinutes','durationMinutes','playMode','roundDays','datasetId'])
  or exists(select 1 from jsonb_each(d) e where e.key=any(array['version','challenge','strategy','source','sessionDays','barMinutes','durationMinutes','playMode','roundDays','datasetId']) and jsonb_typeof(e.value)='null')
 then raise exception 'Incomplete leaderboard category'; end if;
 if (d->>'version') not in ('2','3') or d->>'challenge' not in ('trading','portfolio','backtest','arena')
  or d->>'strategy' not in ('discretionary','algorithmic','simple','rl')
  or d->>'source' not in ('simulated','historical') or d->>'playMode' not in ('single','multi')
  or d->>'sessionDays' not in ('1','5','10','20','60','365') or d->>'barMinutes' not in ('0','0.25','5','10','15')
  or d->>'durationMinutes' not in ('0','10','15','20','30','45','60','90','120') or d->>'roundDays' not in ('1','5')
  or coalesce(d->>'datasetId','') !~ '^[A-Za-z0-9_.-]{1,100}$'
  or not (d ?& array['version','challenge','strategy','source','sessionDays','barMinutes','durationMinutes','playMode','roundDays','datasetId'])
 then raise exception 'Invalid leaderboard category'; end if;
 if (d->>'challenge'='backtest' and (d->>'source'<>'historical' or d->>'playMode'<>'single' or d->>'durationMinutes'<>'0'))
  or (d->>'challenge'<>'backtest' and not (d->>'version'='3' and d->>'challenge'='portfolio') and d->>'durationMinutes'='0')
  or (d->>'challenge'='portfolio' and (d->>'sessionDays'<>'365' or d->>'barMinutes'<>'0'))
  or (d->>'challenge'<>'portfolio' and (d->>'sessionDays'='365' or d->>'barMinutes'='0'))
 then raise exception 'Inconsistent leaderboard category'; end if;
 if d->>'version'='2' and (d->>'sessionDays' not in ('1','5','365') or d->>'durationMinutes' not in ('0','10','15','20')) then raise exception 'Invalid previous category'; end if;
 if d->>'version'='3' then
  if not(d ? 'roundSeconds') or d->>'roundSeconds' is null
    or (d->>'challenge'='portfolio' and (d->>'roundSeconds' not in ('30','45','60','90') or d->>'durationMinutes'<>'0' or d->>'source'<>'historical' or d->>'strategy'<>'discretionary'))
    or (d->>'challenge'<>'portfolio' and d->>'roundSeconds'<>'0')
  then raise exception 'Invalid allocation clock'; end if;
 end if;
 return concat_ws('|',d->>'version',d->>'challenge',d->>'strategy',d->>'source',d->>'sessionDays',d->>'barMinutes',d->>'durationMinutes',d->>'playMode',d->>'roundDays',d->>'datasetId')
   || case when d->>'version'='3' then '|'||(d->>'roundSeconds') else '' end;
end $$;

create or replace function public.tm_finish_run_v2(p_run_id uuid,p_handle text,p_return_pct numeric,p_pnl numeric,p_max_drawdown numeric,p_metadata jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.tm_runs_v2; position integer; minimum_seconds numeric;
begin
 select * into r from public.tm_runs_v2 where id=p_run_id and user_id=auth.uid() for update;
 if not found or r.finished_at is not null then raise exception 'Unknown or finished run'; end if;
 if p_handle is null or char_length(trim(p_handle)) not between 1 and 16 or p_handle ~ '[[:cntrl:]]'
  or p_return_pct is null or p_return_pct::text in ('NaN','Infinity','-Infinity') or abs(p_return_pct)>1e7
  or p_pnl is null or p_pnl::text in ('NaN','Infinity','-Infinity') or abs(p_pnl)>1e9
  or p_max_drawdown is null or p_max_drawdown::text in ('NaN','Infinity','-Infinity') or p_max_drawdown<0 or p_max_drawdown>100
  or p_metadata is null or jsonb_typeof(p_metadata)<>'object' or length(p_metadata::text)>4096
 then raise exception 'Invalid score'; end if;
 minimum_seconds:=case when r.dimensions->>'challenge'='backtest' then 0
  when r.dimensions->>'version'='3' and r.dimensions->>'challenge'='portfolio' then floor(200/(r.dimensions->>'roundDays')::numeric)*(r.dimensions->>'roundSeconds')::numeric*0.9 else (r.dimensions->>'durationMinutes')::numeric*60*0.9 end;
 if clock_timestamp()<r.started_at+make_interval(secs=>minimum_seconds::double precision) then raise exception 'Session has not run long enough'; end if;
 update public.tm_runs_v2 set finished_at=clock_timestamp(),handle=trim(p_handle),return_pct=p_return_pct,pnl=p_pnl,max_drawdown=p_max_drawdown,metadata=p_metadata where id=r.id;
 select count(*)+1 into position from (select max(return_pct) score from public.tm_runs_v2 where board_key=r.board_key and finished_at is not null group by user_id) x where x.score>p_return_pct;
 return jsonb_build_object('rank',position,'board_size',1000);
end $$;

commit;
