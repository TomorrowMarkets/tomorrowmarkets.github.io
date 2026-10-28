-- Additive migration. Existing start_run/finish_run and legacy boards remain.
begin;
create schema if not exists tm_private;
revoke all on schema tm_private from public, anon, authenticated;

create or replace function tm_private.valid_vector(v jsonb, weights boolean)
returns boolean language plpgsql immutable set search_path='' as $$
declare x jsonb; n numeric; total numeric:=0;
begin
 if v is null or jsonb_typeof(v)<>'array' or length(v::text)>10000 then return false; end if;
 if jsonb_array_length(v)<>30 then return false; end if;
 for x in select value from jsonb_array_elements(v) loop
  if jsonb_typeof(x)<>'number' then return false; end if;
  n:=(x#>>'{}')::numeric;
  if n::text in ('NaN','Infinity','-Infinity') or (weights and (n<0 or n>1)) or (not weights and (n<=0 or n>1e12)) then return false; end if;
  total:=total+n;
 end loop;
 return not weights or total<=1.000000001;
exception when others then return false;
end $$;

create table if not exists public.tm_runs_v2 (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 dimensions jsonb not null, board_key text not null, started_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz, handle text, return_pct numeric, pnl numeric, max_drawdown numeric, metadata jsonb
);
create index if not exists tm_runs_v2_board on public.tm_runs_v2(board_key,return_pct desc) where finished_at is not null;
alter table public.tm_runs_v2 enable row level security;
revoke all on public.tm_runs_v2 from anon,authenticated;

create or replace function tm_private.board_key(d jsonb)
returns text language plpgsql immutable set search_path='' as $$
begin
 if d is null or jsonb_typeof(d)<>'object'
  or not (d ?& array['version','challenge','strategy','source','sessionDays','barMinutes','durationMinutes','playMode','roundDays','datasetId'])
  or exists(select 1 from jsonb_each(d) e where e.key=any(array['version','challenge','strategy','source','sessionDays','barMinutes','durationMinutes','playMode','roundDays','datasetId']) and jsonb_typeof(e.value)='null')
 then raise exception 'Incomplete leaderboard category'; end if;
 if (d->>'version')<>'2' or d->>'challenge' not in ('trading','portfolio','backtest','arena')
  or d->>'strategy' not in ('discretionary','algorithmic','simple','rl')
  or d->>'source' not in ('simulated','historical') or d->>'playMode' not in ('single','multi')
  or d->>'sessionDays' not in ('1','5','365') or d->>'barMinutes' not in ('0','0.25','5','10','15')
  or d->>'durationMinutes' not in ('0','10','15','20') or d->>'roundDays' not in ('1','5')
  or coalesce(d->>'datasetId','') !~ '^[A-Za-z0-9_.-]{1,100}$'
  or not (d ?& array['version','challenge','strategy','source','sessionDays','barMinutes','durationMinutes','playMode','roundDays','datasetId'])
 then raise exception 'Invalid leaderboard category'; end if;
 if (d->>'challenge'='backtest' and (d->>'source'<>'historical' or d->>'playMode'<>'single' or d->>'durationMinutes'<>'0'))
  or (d->>'challenge'<>'backtest' and d->>'durationMinutes'='0')
  or (d->>'challenge'='portfolio' and (d->>'sessionDays'<>'365' or d->>'barMinutes'<>'0'))
  or (d->>'challenge'<>'portfolio' and (d->>'sessionDays'='365' or d->>'barMinutes'='0'))
 then raise exception 'Inconsistent leaderboard category'; end if;
 return concat_ws('|',d->>'version',d->>'challenge',d->>'strategy',d->>'source',d->>'sessionDays',d->>'barMinutes',d->>'durationMinutes',d->>'playMode',d->>'roundDays',d->>'datasetId');
end $$;

create or replace function public.tm_start_run_v2(p_dimensions jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; uid uuid:=auth.uid(); key text;
begin
 if uid is null then raise exception 'Sign in required'; end if;
 key:=tm_private.board_key(p_dimensions);
 if (select count(*) from public.tm_runs_v2 where user_id=uid and started_at>clock_timestamp()-interval '1 hour')>=60 then raise exception 'Too many runs. Try later.'; end if;
 insert into public.tm_runs_v2(user_id,dimensions,board_key) values(uid,p_dimensions,key) returning id into result;
 return result;
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
 minimum_seconds:=case when r.dimensions->>'challenge'='backtest' then 0 else (r.dimensions->>'durationMinutes')::numeric*60*0.9 end;
 if clock_timestamp()<r.started_at+make_interval(secs=>minimum_seconds::double precision) then raise exception 'Session has not run long enough'; end if;
 update public.tm_runs_v2 set finished_at=clock_timestamp(),handle=trim(p_handle),return_pct=p_return_pct,pnl=p_pnl,max_drawdown=p_max_drawdown,metadata=p_metadata where id=r.id;
 select count(*)+1 into position from (select max(return_pct) score from public.tm_runs_v2 where board_key=r.board_key and finished_at is not null group by user_id) x where x.score>p_return_pct;
 return jsonb_build_object('rank',position,'board_size',1000);
end $$;

create or replace function public.tm_board_v2(p_dimensions jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare key text;
begin
 key:=tm_private.board_key(p_dimensions);
 return coalesce((select jsonb_agg(to_jsonb(r) order by r.rank) from (
  select row_number() over(order by b.return_pct desc,b.finished_at,b.id) rank,b.handle,b.return_pct,b.pnl,b.max_drawdown,b.finished_at achieved_at,b.metadata
  from (select distinct on(user_id) * from public.tm_runs_v2 where board_key=key and finished_at is not null order by user_id,return_pct desc,finished_at,id) b
  order by b.return_pct desc,b.finished_at,b.id limit 1000
 ) r),'[]'::jsonb);
end $$;

create table if not exists public.tm_live_assets(position smallint primary key check(position between 0 and 29),symbol text unique not null,name text not null);
create table if not exists public.tm_live_periods(session_date date primary key,previous_date date not null,cutoff_at timestamptz not null,valuation_at timestamptz not null,
 check(previous_date<session_date and cutoff_at<valuation_at));
create table if not exists public.tm_live_prices(price_date date primary key,prices jsonb not null check(tm_private.valid_vector(prices,false)),published_at timestamptz not null default clock_timestamp());
-- A return vector is frozen from ONE feed snapshot, so later dividend/split
-- adjustments to older Yahoo prices cannot create inconsistent price ratios.
create table if not exists public.tm_live_returns(session_date date primary key references public.tm_live_periods(session_date),ratios jsonb not null check(tm_private.valid_vector(ratios,false)),published_at timestamptz not null default clock_timestamp());
create table if not exists public.tm_live_accounts(user_id uuid primary key references auth.users(id),handle text not null,
 nav numeric not null default 10000 check(nav>=0 and nav<1e16),peak numeric not null default 10000,max_drawdown numeric not null default 0,
 start_session date not null references public.tm_live_periods(session_date),last_settled date,joined_at timestamptz not null default clock_timestamp());
create table if not exists public.tm_live_allocations(user_id uuid not null references public.tm_live_accounts(user_id),session_date date not null references public.tm_live_periods(session_date),
 weights jsonb not null check(tm_private.valid_vector(weights,true)),submitted_at timestamptz not null default clock_timestamp(),primary key(user_id,session_date));
create table if not exists public.tm_live_results(user_id uuid not null references public.tm_live_accounts(user_id),session_date date not null references public.tm_live_periods(session_date),
 nav numeric not null,period_return numeric not null,weights jsonb not null,settled_at timestamptz not null default clock_timestamp(),primary key(user_id,session_date));

do $$ declare t text; begin
 foreach t in array array['tm_live_assets','tm_live_periods','tm_live_prices','tm_live_returns','tm_live_accounts','tm_live_allocations','tm_live_results'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

create or replace function tm_private.settle_live(p_user uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare a public.tm_live_accounts; p record; weights jsonb; ratios jsonb; factor numeric; new_nav numeric; i integer; settled integer:=0;
begin
 select * into a from public.tm_live_accounts where user_id=p_user for update;
 if not found then return 0; end if;
 for p in select * from public.tm_live_periods where session_date>=a.start_session and (a.last_settled is null or session_date>a.last_settled) and valuation_at<=clock_timestamp() order by session_date limit 400 loop
  select r.ratios into ratios from public.tm_live_returns r where r.session_date=p.session_date;
  if ratios is null then exit; end if; -- never skip a missing return period
  select x.weights into weights from public.tm_live_allocations x where x.user_id=p_user and x.session_date<=p.session_date order by x.session_date desc limit 1;
  weights:=coalesce(weights,'[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]'::jsonb);
  factor:=1;
  for i in 0..29 loop factor:=factor+(weights->>i)::numeric*((ratios->>i)::numeric-1); end loop;
  new_nav:=a.nav*factor;
  insert into public.tm_live_results(user_id,session_date,nav,period_return,weights) values(p_user,p.session_date,new_nav,(factor-1)*100,weights);
  a.nav:=new_nav;a.peak:=greatest(a.peak,new_nav);a.max_drawdown:=greatest(a.max_drawdown,case when a.peak>0 then (a.peak-new_nav)/a.peak*100 else 0 end);a.last_settled:=p.session_date;
  update public.tm_live_accounts set nav=a.nav,peak=a.peak,max_drawdown=a.max_drawdown,last_settled=a.last_settled where user_id=p_user;
  settled:=settled+1;
 end loop;
 return settled;
end $$;

create or replace function public.tm_live_join(p_handle text)
returns boolean language plpgsql security definer set search_path='' as $$
declare next_session date; uid uuid:=auth.uid();
begin
 if uid is null then raise exception 'Sign in required'; end if;
 if char_length(trim(coalesce(p_handle,''))) not between 1 and 16 or p_handle ~ '[[:cntrl:]]' then raise exception 'Choose a handle of 1–16 characters'; end if;
 select session_date into next_session from public.tm_live_periods where cutoff_at>clock_timestamp() order by cutoff_at limit 1;
 if next_session is null then raise exception 'The next trading period is not available yet'; end if;
 insert into public.tm_live_accounts(user_id,handle,start_session) values(uid,trim(p_handle),next_session)
 on conflict(user_id) do update set handle=excluded.handle;
 return true;
end $$;

create or replace function public.tm_submit_live(p_session_date date,p_weights jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare p public.tm_live_periods; uid uuid:=auth.uid(); target date;
begin
 if uid is null or not tm_private.valid_vector(p_weights,true) then raise exception 'Invalid allocation'; end if;
 perform 1 from public.tm_live_accounts where user_id=uid for update;
 if not found then raise exception 'Join the daily challenge first'; end if;
 select session_date into target from public.tm_live_periods where cutoff_at>clock_timestamp() order by cutoff_at limit 1;
 select * into p from public.tm_live_periods where session_date=p_session_date for share;
 if p.session_date is null or p_session_date is distinct from target or clock_timestamp()>=p.cutoff_at then raise exception 'That allocation deadline has passed. Refresh for the next trading period.'; end if;
 insert into public.tm_live_allocations(user_id,session_date,weights) values(uid,p_session_date,p_weights)
 on conflict(user_id,session_date) do update set weights=excluded.weights,submitted_at=clock_timestamp();
 return true;
end $$;

create or replace function public.tm_live_state()
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); a public.tm_live_accounts; next_period public.tm_live_periods; price_row public.tm_live_prices; weights jsonb;
begin
 if uid is null then raise exception 'Sign in required'; end if;
 perform tm_private.settle_live(uid);
 select * into a from public.tm_live_accounts where user_id=uid;
 select * into next_period from public.tm_live_periods where cutoff_at>clock_timestamp() order by cutoff_at limit 1;
 select * into price_row from public.tm_live_prices order by price_date desc limit 1;
 select x.weights into weights from public.tm_live_allocations x where user_id=uid and session_date<=coalesce(next_period.session_date,'infinity'::date) order by session_date desc limit 1;
 return jsonb_build_object('joined',a.user_id is not null,'serverNow',extract(epoch from clock_timestamp())*1000,
  'account',case when a.user_id is null then null else jsonb_build_object('handle',a.handle,'capital',a.nav,'returnPct',(a.nav/10000-1)*100,'maxDrawdown',a.max_drawdown,'startSession',a.start_session,'lastSettled',a.last_settled) end,
  'nextPeriod',case when next_period.session_date is null then null else jsonb_build_object('date',next_period.session_date,'previousDate',next_period.previous_date,'cutoff',next_period.cutoff_at,'valuation',next_period.valuation_at) end,
  'priceDate',price_row.price_date,'prices',price_row.prices,'weights',coalesce(weights,'[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]'::jsonb),
  'assets',(select coalesce(jsonb_agg(jsonb_build_object('symbol',symbol,'name',name) order by position),'[]'::jsonb) from public.tm_live_assets),
  'history',(select coalesce(jsonb_agg(to_jsonb(h) order by h.session_date),'[]'::jsonb) from (select session_date,nav,period_return from public.tm_live_results where user_id=uid order by session_date desc limit 400) h));
end $$;

create or replace function public.tm_live_board()
returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x) order by x.rank),'[]'::jsonb) from (
  select row_number() over(order by nav desc,joined_at,user_id) rank,handle,(nav/10000-1)*100 return_pct,max_drawdown,start_session,last_settled from public.tm_live_accounts order by nav desc,joined_at,user_id limit 1000
 ) x;
$$;

create or replace function public.tm_ingest_live_feed(p_payload jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; p record; opening jsonb; closing jsonb; ratios jsonb; expected jsonb; created integer:=0;
begin
 select jsonb_agg(symbol order by position) into expected from public.tm_live_assets;
 if p_payload->>'version'<>'1' or p_payload->'assets' is distinct from expected or jsonb_typeof(p_payload->'periods')<>'array' or jsonb_typeof(p_payload->'prices')<>'array' then raise exception 'Feed universe or format mismatch'; end if;
 for item in select value from jsonb_array_elements(p_payload->'periods') loop
  insert into public.tm_live_periods(session_date,previous_date,cutoff_at,valuation_at) values((item->>'sessionDate')::date,(item->>'previousDate')::date,(item->>'cutoff')::timestamptz,(item->>'valuation')::timestamptz) on conflict do nothing;
 end loop;
 for item in select value from jsonb_array_elements(p_payload->'prices') loop
  if (item->>'date')::date>current_date or not tm_private.valid_vector(item->'values',false) then raise exception 'Invalid price vector'; end if;
  insert into public.tm_live_prices(price_date,prices) values((item->>'date')::date,item->'values')
   on conflict(price_date) do update set prices=excluded.prices,published_at=clock_timestamp();
 end loop;
 for p in select * from public.tm_live_periods where valuation_at<=clock_timestamp() and not exists(select 1 from public.tm_live_returns r where r.session_date=tm_live_periods.session_date) order by session_date loop
  -- Both sides must come from this same incoming adjustment snapshot.
  select value->'values' into opening from jsonb_array_elements(p_payload->'prices') where value->>'date'=p.previous_date::text;
  select value->'values' into closing from jsonb_array_elements(p_payload->'prices') where value->>'date'=p.session_date::text;
  if opening is null or closing is null then continue; end if;
  select jsonb_agg((closing->>i)::numeric/(opening->>i)::numeric order by i) into ratios from generate_series(0,29) i;
  insert into public.tm_live_returns(session_date,ratios) values(p.session_date,ratios) on conflict do nothing;
  if found then created:=created+1; end if;
 end loop;
 return created;
end $$;

create or replace function public.tm_settle_all_live()
returns integer language plpgsql security definer set search_path='' as $$
declare uid uuid; total integer:=0;
begin for uid in select user_id from public.tm_live_accounts loop total:=total+tm_private.settle_live(uid); end loop; return total; end $$;

revoke all on all functions in schema tm_private from public,anon,authenticated;
revoke all on function public.tm_start_run_v2(jsonb),public.tm_finish_run_v2(uuid,text,numeric,numeric,numeric,jsonb),public.tm_board_v2(jsonb),public.tm_live_join(text),public.tm_submit_live(date,jsonb),public.tm_live_state(),public.tm_live_board(),public.tm_ingest_live_feed(jsonb),public.tm_settle_all_live() from public,anon,authenticated;
grant execute on function public.tm_start_run_v2(jsonb),public.tm_finish_run_v2(uuid,text,numeric,numeric,numeric,jsonb),public.tm_board_v2(jsonb),public.tm_live_join(text),public.tm_submit_live(date,jsonb),public.tm_live_state(),public.tm_live_board() to authenticated;
grant execute on function public.tm_ingest_live_feed(jsonb),public.tm_settle_all_live() to service_role;
grant all on public.tm_runs_v2 to service_role;
-- Stable universe: matches data/portfolio/universe.json.
insert into public.tm_live_assets(position,symbol,name) values(0,'AAPL','Apple') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(1,'MSFT','Microsoft') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(2,'AMZN','Amazon') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(3,'GOOGL','Alphabet') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(4,'META','Meta Platforms') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(5,'NVDA','NVIDIA') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(6,'JPM','JPMorgan Chase') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(7,'BAC','Bank of America') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(8,'GS','Goldman Sachs') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(9,'XOM','Exxon Mobil') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(10,'CVX','Chevron') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(11,'JNJ','Johnson & Johnson') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(12,'UNH','UnitedHealth Group') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(13,'PG','Procter & Gamble') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(14,'KO','Coca-Cola') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(15,'WMT','Walmart') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(16,'HD','Home Depot') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(17,'CAT','Caterpillar') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(18,'NKE','Nike') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(19,'SPY','SPDR S&P 500 ETF') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(20,'QQQ','Invesco QQQ ETF') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(21,'IWM','iShares Russell 2000 ETF') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(22,'EFA','iShares MSCI EAFE ETF') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(23,'EEM','iShares MSCI Emerging Markets ETF') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(24,'VNQ','Vanguard Real Estate ETF') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(25,'GLD','SPDR Gold Shares') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(26,'SLV','iShares Silver Trust') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(27,'TLT','iShares 20+ Year Treasury Bond ETF') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(28,'IEF','iShares 7-10 Year Treasury Bond ETF') on conflict do nothing;
insert into public.tm_live_assets(position,symbol,name) values(29,'LQD','iShares Investment Grade Corporate Bond ETF') on conflict do nothing;

commit;
