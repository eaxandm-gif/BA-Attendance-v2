begin;
-- Only the authenticated admin-api service client can call this explicit override.
create or replace function public.insert_attendance_event_admin(
 p_employee_id uuid,p_event_type public.attendance_event_type,p_occurred_at timestamptz,
 p_office_id uuid,p_request_key text,p_reason text)
returns public.attendance_events language plpgsql security definer set search_path=public as $$
declare r public.attendance_events;
begin
 if nullif(trim(p_reason),'') is null or nullif(trim(p_request_key),'') is null or p_occurred_at is null then
   raise exception 'ADMIN_CORRECTION_REASON_REQUIRED';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('ba-attendance:'||p_employee_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('ba-request:'||p_request_key,0));
 select * into r from public.attendance_events where request_key=p_request_key;
 if found then
   if r.employee_id is distinct from p_employee_id or r.event_type is distinct from p_event_type
      or r.occurred_at is distinct from p_occurred_at or r.office_id is distinct from p_office_id
      or r.source<>'ADMIN' or r.deleted_at is not null then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return r;
 end if;
 if exists(select 1 from public.attendance_events where employee_id=p_employee_id and event_type=p_event_type
   and deleted_at is null and occurred_at between p_occurred_at-interval '10 seconds' and p_occurred_at+interval '10 seconds') then
   raise exception 'DUPLICATE_ATTENDANCE_EVENT';
 end if;
 insert into public.attendance_events(employee_id,event_type,occurred_at,office_id,source,created_by_line_user_id,edited,request_key)
 values(p_employee_id,p_event_type,p_occurred_at,p_office_id,'ADMIN','ADMIN_WEB',true,p_request_key) returning * into r;
 insert into public.audit_logs(actor_role,action,entity_type,entity_id,before_data,after_data,reason)
 values('ADMIN','CREATE','attendance_events',r.id::text,null,to_jsonb(r),p_reason);
 return r;
end $$;
revoke all on function public.insert_attendance_event_admin(uuid,public.attendance_event_type,timestamptz,uuid,text,text) from public,anon,authenticated;
grant execute on function public.insert_attendance_event_admin(uuid,public.attendance_event_type,timestamptz,uuid,text,text) to service_role;
commit;
