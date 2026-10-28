-- Run against an isolated Supabase database AFTER the migration.
-- All fixtures roll back. This does not contact Yahoo or send authentication emails.
begin;
do $$ begin
 if has_function_privilege('authenticated','public.tm_ingest_live_feed(jsonb)','execute') then raise exception 'Client can ingest market data'; end if;
 if has_function_privilege('authenticated','public.tm_settle_all_live()','execute') then raise exception 'Client can settle other accounts'; end if;
 if has_table_privilege('authenticated','public.tm_live_allocations','INSERT') then raise exception 'Client can bypass allocation RPC'; end if;
 if has_function_privilege('anon','public.tm_live_state()','execute') then raise exception 'Unauthenticated caller can read live state'; end if;
 if tm_private.valid_vector('[1,1]'::jsonb,true) then raise exception 'Invalid vector accepted'; end if;
end $$;

insert into auth.users(id,email) values('00000000-0000-0000-0000-000000000101','tm-qa-101@example.invalid'),('00000000-0000-0000-0000-000000000102','tm-qa-102@example.invalid') on conflict do nothing;
insert into public.tm_live_periods(session_date,previous_date,cutoff_at,valuation_at) values
 ('2001-01-03','2001-01-02','2001-01-02T21:00:00Z','2001-01-03T21:00:00Z'),
 ('2001-01-04','2001-01-03','2001-01-03T21:00:00Z','2001-01-04T21:00:00Z') on conflict do nothing;
insert into public.tm_live_accounts(user_id,handle,start_session) values
 ('00000000-0000-0000-0000-000000000101','Alice','2001-01-03'),
 ('00000000-0000-0000-0000-000000000102','Bob','2001-01-03');
insert into public.tm_live_allocations(user_id,session_date,weights,submitted_at) values
 ('00000000-0000-0000-0000-000000000101','2001-01-03','[0.5,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]','2001-01-02T20:00:00Z');
insert into public.tm_live_returns(session_date,ratios) values
 ('2001-01-03','[1.2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]'),
 ('2001-01-04','[1.1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]') on conflict do nothing;
do $$ declare n numeric; settled integer; begin
 settled:=tm_private.settle_live('00000000-0000-0000-0000-000000000101');
 if settled<>2 then raise exception 'Wrong number of settled periods'; end if;
 select nav into n from public.tm_live_accounts where handle='Alice' and user_id='00000000-0000-0000-0000-000000000101';
 if abs(n-11550)>0.000001 then raise exception 'Compounding or carried allocation is wrong: %',n; end if;
 settled:=tm_private.settle_live('00000000-0000-0000-0000-000000000101');
 if settled<>0 then raise exception 'Settlement is not idempotent'; end if;
 perform tm_private.settle_live('00000000-0000-0000-0000-000000000102');
 select nav into n from public.tm_live_accounts where user_id='00000000-0000-0000-0000-000000000102';
 if n<>10000 then raise exception 'An all-cash portfolio changed value'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000101',true);
set local role authenticated;
do $$ declare state jsonb; rejected boolean:=false; begin
 state:=public.tm_live_state();
 if state->'account'->>'handle'<>'Alice' then raise exception 'Account ownership failure'; end if;
 begin
  perform public.tm_submit_live('2001-01-03','[1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]');
 exception when others then rejected:=true; end;
 if not rejected then raise exception 'A past allocation deadline was accepted'; end if;
end $$;
reset role;
rollback;
