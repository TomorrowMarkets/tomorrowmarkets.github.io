-- Optional: public historical MARKET DATA only. Apply after v2/v3.
-- No user accounts or allocations are placed in this bucket.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('tm-market-data','tm-market-data',true,6291456,array['application/json'])
on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from storage.buckets where id='tm-market-data' and public) then
  raise exception 'tm-market-data exists but is private; inspect it before changing its visibility';
 end if;
end $$;
-- Restrictive policies prevent browser writes to this bucket even if another
-- application has created permissive policies covering all storage objects.
-- Other buckets are unaffected. The server service_role bypasses RLS.
drop policy if exists tm_market_data_no_client_insert on storage.objects;
create policy tm_market_data_no_client_insert on storage.objects as restrictive
 for insert to anon,authenticated with check(bucket_id <> 'tm-market-data');
drop policy if exists tm_market_data_no_client_update on storage.objects;
create policy tm_market_data_no_client_update on storage.objects as restrictive
 for update to anon,authenticated using(bucket_id <> 'tm-market-data') with check(bucket_id <> 'tm-market-data');
drop policy if exists tm_market_data_no_client_delete on storage.objects;
create policy tm_market_data_no_client_delete on storage.objects as restrictive
 for delete to anon,authenticated using(bucket_id <> 'tm-market-data');
commit;
