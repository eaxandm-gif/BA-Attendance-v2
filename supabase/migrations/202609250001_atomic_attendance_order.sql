begin;
-- v4.6.3. No historical events are rewritten. Invalid fixed histories fail closed.
create or replace function public.ba_allowed_event_types(p_mode text, p_types text[])
returns text[] language plpgsql immutable set search_path=public as $$
declare
 t text[]:=coalesce(p_types,array[]::text[]);
 seq text[]:=array['IN','BREAK_OUT','BREAK_IN','OUT'];
 n integer:=cardinality(t);
 last_type text:=t[cardinality(t)];
 completed boolean:=t @> array['BREAK_OUT','BREAK_IN'];
 started boolean:=t && array['WORK_IN','IN'];
 ended boolean:=t && array['WORK_OUT','OUT'];
 work_stage integer:=0;
 refilling boolean:=false;
 event text;
 mode text:=upper(trim(coalesce(p_mode,'FIXED_BRANCH')));
begin
 if mode not in ('MULTI_BRANCH','STOCK_REFILL') then
   if n>4 then return array[]::text[]; end if;
   for i in 1..n loop
     if t[i] is distinct from seq[i] then return array[]::text[]; end if;
   end loop;
   if n=4 then return array[]::text[]; end if;
   return array[seq[n+1]];
 elsif mode='MULTI_BRANCH' then
   if n=0 then return array['DAY_IN']; end if;
   if last_type='DAY_IN' then return array['BRANCH_IN']; end if;
   if last_type='BRANCH_IN' then
     if completed then return array['BRANCH_OUT']; end if;
     return array['BREAK_OUT','BRANCH_OUT'];
   end if;
   if last_type='BREAK_OUT' then return array['BREAK_IN']; end if;
   if last_type='BREAK_IN' then return array['BRANCH_OUT']; end if;
   if last_type='BRANCH_OUT' then
     if completed then return array['BRANCH_IN','DAY_OUT']; end if;
     return array['BRANCH_IN'];
   end if;
 elsif mode='STOCK_REFILL' then
   foreach event in array t loop
     if event='IN' then event:='WORK_IN'; elsif event='OUT' then event:='WORK_OUT'; end if;
     if event='REFILL_IN' and work_stage in (0,4) and not refilling then refilling:=true;
     elsif event='REFILL_OUT' and refilling then refilling:=false;
     elsif not refilling and event=(array['WORK_IN','BREAK_OUT','BREAK_IN','WORK_OUT'])[work_stage+1] then work_stage:=work_stage+1;
     else return array[]::text[];
     end if;
   end loop;
   if last_type='IN' then last_type:='WORK_IN'; end if;
   if last_type='OUT' then last_type:='WORK_OUT'; end if;
   if last_type='REFILL_IN' then return array['REFILL_OUT']; end if;
   if started and not ended then
     if last_type='BREAK_OUT' then return array['BREAK_IN']; end if;
     if last_type='BREAK_IN' then return array['WORK_OUT']; end if;
     if last_type in ('WORK_IN','REFILL_OUT') and not completed then return array['BREAK_OUT']; end if;
     if completed then return array['WORK_OUT']; end if;
     return array[]::text[];
   end if;
   if not started then return array['REFILL_IN','WORK_IN']; end if;
   if ended then return array['REFILL_IN']; end if;
 end if;
 return array[]::text[];
end $$;

-- All correction writers participate in the same lock, including ADMIN and
-- SUPERVISOR direct writes. Their existing authenticated/audited correction
-- endpoints remain the privileged override; employee RPC never accepts override.
create or replace function public.ba_lock_attendance_writer()
returns trigger language plpgsql security definer set search_path=public as $$
declare old_id uuid; new_id uuid; employee uuid;
begin
 if tg_op<>'INSERT' then old_id:=old.employee_id; end if;
 if tg_op<>'DELETE' then new_id:=new.employee_id; end if;
 for employee in select distinct x from unnest(array[old_id,new_id]) x where x is not null order by x loop
   perform pg_advisory_xact_lock(hashtextextended('ba-attendance:'||employee::text,0));
 end loop;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger ba_attendance_writer_lock before insert or update or delete
on public.attendance_events for each row execute function public.ba_lock_attendance_writer();

create or replace function public.insert_attendance_event_guarded(
 p_employee_id uuid,p_event_type public.attendance_event_type,p_occurred_at timestamptz,
 p_office_id uuid,p_latitude numeric,p_longitude numeric,p_accuracy numeric,p_distance numeric,
 p_source text,p_created_by text,p_request_key text)
returns public.attendance_events language plpgsql security definer set search_path=public as $$
declare
 v_row public.attendance_events;
 v_mode text;
 v_now timestamptz;
 v_date date;
 v_start timestamptz;
 v_end timestamptz;
 v_types text[];
 v_office uuid;
 v_latest timestamptz;
begin
 if p_employee_id is null or p_event_type is null or nullif(trim(p_request_key),'') is null or length(p_request_key)>200 then
   raise exception 'INVALID_REQUEST_KEY';
 end if;
 if p_source is null or p_source not in ('LIFF','EXTERNAL_WEB') or nullif(p_created_by,'') is null then
   raise exception 'INVALID_EMPLOYEE_SOURCE';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('ba-attendance:'||p_employee_id::text,0));
 -- Serialize equal keys too, including accidental cross-employee collisions.
 perform pg_advisory_xact_lock(hashtextextended('ba-request:'||p_request_key,0));
 select * into v_row from public.attendance_events where request_key=p_request_key;
 if found then
   if v_row.employee_id is distinct from p_employee_id or v_row.event_type is distinct from p_event_type
      or v_row.source is distinct from p_source or v_row.created_by_line_user_id is distinct from p_created_by
      or v_row.deleted_at is not null then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return v_row;
 end if;
 select coalesce(ba_mode::text,'FIXED_BRANCH') into v_mode from public.employees
 where id=p_employee_id and active and line_user_id=p_created_by;
 if not found then raise exception 'INVALID_EMPLOYEE'; end if;
 v_now:=clock_timestamp();
 v_date:=(v_now at time zone 'Asia/Bangkok')::date;
 if p_occurred_at is null or (p_occurred_at at time zone 'Asia/Bangkok')::date<>v_date then
   raise exception 'INVALID_ATTENDANCE_DAY';
 end if;
 v_start:=v_date::timestamp at time zone 'Asia/Bangkok';
 v_end:=(v_date+1)::timestamp at time zone 'Asia/Bangkok';
 select coalesce(array_agg(event_type::text order by occurred_at,created_at,id),array[]::text[]),max(occurred_at)
 into v_types,v_latest from public.attendance_events
 where employee_id=p_employee_id and deleted_at is null and occurred_at>=v_start and occurred_at<v_end;
 if not (p_event_type::text=any(public.ba_allowed_event_types(v_mode,v_types))) or v_latest>v_now then
   raise exception 'INVALID_TRANSITION';
 end if;
 if p_event_type::text='BREAK_OUT' and 'BREAK_IN'=any(v_types) then raise exception 'INVALID_TRANSITION'; end if;
 if p_event_type::text in ('OUT','DAY_OUT','WORK_OUT') and not (v_types @> array['BREAK_OUT','BREAK_IN']) then
   raise exception 'INVALID_TRANSITION';
 end if;
 if v_mode not in ('MULTI_BRANCH','STOCK_REFILL') or v_mode='STOCK_REFILL' then
   select office_id into v_office from public.attendance_events
   where employee_id=p_employee_id and deleted_at is null and occurred_at>=v_start and occurred_at<v_end
     and event_type::text=any(case when v_mode='STOCK_REFILL' then array['WORK_IN','IN'] else array['IN'] end)
   order by occurred_at,created_at,id limit 1;
   if p_event_type::text in ('BREAK_OUT','BREAK_IN','OUT','WORK_OUT') and v_office is not null
      and v_office is distinct from p_office_id then raise exception 'ATTENDANCE_OFFICE_CHANGED'; end if;
 end if;
 if exists(select 1 from public.attendance_events where employee_id=p_employee_id and event_type=p_event_type
   and deleted_at is null and occurred_at between v_now-interval '10 seconds' and v_now+interval '10 seconds') then
   raise exception 'DUPLICATE_ATTENDANCE_EVENT';
 end if;
 -- Server timestamp is assigned AFTER locking, so concurrent requests cannot reverse time.
 insert into public.attendance_events(employee_id,event_type,occurred_at,office_id,latitude,longitude,
 gps_accuracy_meters,distance_meters,source,created_by_line_user_id,request_key)
 values(p_employee_id,p_event_type,v_now,p_office_id,p_latitude,p_longitude,p_accuracy,p_distance,
 p_source,p_created_by,p_request_key) returning * into v_row;
 return v_row;
end $$;
revoke all on function public.ba_allowed_event_types(text,text[]) from public,anon,authenticated;
revoke all on function public.ba_lock_attendance_writer() from public,anon,authenticated;
revoke all on function public.insert_attendance_event_guarded(uuid,public.attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text) from public,anon,authenticated;
grant execute on function public.ba_allowed_event_types(text,text[]) to service_role;
grant execute on function public.insert_attendance_event_guarded(uuid,public.attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text) to service_role;
commit;
