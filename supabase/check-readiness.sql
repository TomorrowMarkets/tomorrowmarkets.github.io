-- READ ONLY. Run in the TomorrowMarkets project's SQL Editor as its owner.
-- This inspects objects/privileges; it does not create accounts or settle scores.
with expected(name) as (values
 ('tm_runs_v2'),('tm_live_assets'),('tm_live_periods'),('tm_live_prices'),
 ('tm_live_returns'),('tm_live_accounts'),('tm_live_allocations'),('tm_live_results'))
select e.name,
 c.oid is not null as exists,
 coalesce(c.relrowsecurity,false) as rls_enabled,
 case when c.oid is null then false else not has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') end as no_client_writes
from expected e left join pg_namespace n on n.nspname='public'
left join pg_class c on c.relnamespace=n.oid and c.relname=e.name
order by e.name;

with expected(signature,client_allowed) as (values
 ('public.tm_start_run_v2(jsonb)',true),
 ('public.tm_finish_run_v2(uuid,text,numeric,numeric,numeric,jsonb)',true),
 ('public.tm_board_v2(jsonb)',true),('public.tm_live_join(text)',true),
 ('public.tm_submit_live(date,jsonb)',true),('public.tm_live_state()',true),
 ('public.tm_live_board()',true),('public.tm_ingest_live_feed(jsonb)',false),
 ('public.tm_settle_all_live()',false))
select signature,p.oid is not null as exists,
 case when p.oid is null then false else has_function_privilege('authenticated',p.oid,'EXECUTE')=client_allowed end as client_permissions_correct,
 case when p.oid is null then false else not has_function_privilege('anon',p.oid,'EXECUTE') end as anonymous_role_blocked,
 case when p.oid is null then false when client_allowed then true else has_function_privilege('service_role',p.oid,'EXECUTE') end as server_permissions_correct
from expected left join pg_proc p on p.oid=to_regprocedure(signature)
order by signature;

select case when to_regprocedure('tm_private.board_key(jsonb)') is null then false
 else position('roundSeconds' in pg_get_functiondef(to_regprocedure('tm_private.board_key(jsonb)')))>0 end as v3_board_clock_installed;

-- The supplied schema already has these tables. Data can be empty before the first run.
select count(*) as asset_count,count(distinct position) as unique_positions from public.tm_live_assets;
select count(*) as price_dates,max(price_date) as latest_price_date from public.tm_live_prices;
select count(*) as frozen_return_dates,max(session_date) as latest_return_date from public.tm_live_returns;
select session_date,previous_date,cutoff_at,valuation_at from public.tm_live_periods
 where cutoff_at>clock_timestamp() order by cutoff_at limit 3;

-- Optional historical storage. No row means its migration has not been applied.
select id,public,file_size_limit from storage.buckets where id='tm-market-data';
select name,updated_at from storage.objects
 where bucket_id='tm-market-data' and name='portfolio/yahoo-30.json';
