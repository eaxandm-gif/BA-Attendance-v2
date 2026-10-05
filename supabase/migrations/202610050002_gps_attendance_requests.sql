begin;
-- Requests are evidence for a human reviewer, never proof of presence.
create table public.attendance_gps_requests(
 id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.employees(id),
 office_id uuid not null references public.offices(id),event_type public.attendance_event_type not null,
 requested_at timestamptz not null default clock_timestamp(),reason text not null,
 latitude numeric,longitude numeric,accuracy_meters numeric,
 request_key text not null unique,status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED')),
 reviewer_note text,reviewed_at timestamptz,reviewer_role text,reviewer_id uuid,
 applied_event_id uuid references public.attendance_events(id),created_at timestamptz not null default now()
);
create unique index attendance_gps_one_pending on public.attendance_gps_requests(employee_id) where status='PENDING';
alter table public.attendance_gps_requests enable row level security;
revoke all on public.attendance_gps_requests from anon,authenticated;
grant select,insert,update on public.attendance_gps_requests to service_role;

create function public.ba_request_gps_attendance(p_employee_id uuid,p_actor text,p_event_type public.attendance_event_type,p_office_id uuid,p_reason text,p_key text,p_latitude numeric,p_longitude numeric,p_accuracy numeric)
returns public.attendance_gps_requests language plpgsql security definer set search_path=public as $$
declare e public.employees; r public.attendance_gps_requests; ts timestamptz; day_start timestamptz; types text[]; original_office uuid;
begin
 select * into e from public.employees where id=p_employee_id and active and line_user_id=p_actor;
 if not found then raise exception 'INVALID_EMPLOYEE'; end if;
 if nullif(trim(p_reason),'') is null or length(p_reason)>1000 or nullif(trim(p_key),'') is null or length(p_key)>200 then raise exception 'INVALID_REQUEST'; end if;
 if p_latitude is not null and (p_latitude not between -90 and 90 or p_longitude is null or p_longitude not between -180 and 180 or p_accuracy is null or p_accuracy<=0 or p_accuracy>100000) then raise exception 'INVALID_GPS'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ba-attendance:'||p_employee_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('ba-gps-request:'||p_key,0));
 select * into r from public.attendance_gps_requests where request_key=p_key;
 if found then
  if r.employee_id<>p_employee_id or r.event_type<>p_event_type or r.office_id<>p_office_id then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return r;
 end if;
 if exists(select 1 from public.attendance_gps_requests where employee_id=e.id and status='PENDING') then raise exception 'GPS_REQUEST_PENDING'; end if;
 if not exists(select 1 from public.offices where id=p_office_id and active) then raise exception 'INVALID_OFFICE'; end if;
 ts:=clock_timestamp();day_start:=((ts at time zone 'Asia/Bangkok')::date)::timestamp at time zone 'Asia/Bangkok';
 select coalesce(array_agg(event_type::text order by occurred_at,created_at,id),array[]::text[]) into types from public.attendance_events where employee_id=e.id and deleted_at is null and occurred_at>=day_start and occurred_at<day_start+interval '1 day';
 if not (p_event_type::text=any(public.ba_allowed_event_types(e.ba_mode::text,types))) then raise exception 'INVALID_TRANSITION'; end if;
 if (e.ba_mode::text='FIXED_BRANCH' and p_event_type::text in ('BREAK_OUT','BREAK_IN','OUT')) or (e.ba_mode::text='STOCK_REFILL' and p_event_type::text in ('BREAK_OUT','BREAK_IN','WORK_OUT','OUT')) then
 select office_id into original_office from public.attendance_events where employee_id=e.id and deleted_at is null and event_type::text in ('IN','WORK_IN') and occurred_at>=day_start and occurred_at<day_start+interval '1 day' order by occurred_at limit 1;
 if original_office is distinct from p_office_id then raise exception 'OFFICE_MISMATCH'; end if;
 end if;
 insert into public.attendance_gps_requests(employee_id,office_id,event_type,requested_at,reason,request_key,latitude,longitude,accuracy_meters) values(e.id,p_office_id,p_event_type,ts,p_reason,p_key,p_latitude,p_longitude,p_accuracy) returning * into r;
 insert into public.audit_logs(actor_role,actor_line_user_id,action,entity_type,entity_id,after_data,reason) values('EMPLOYEE',p_actor,'CREATE','attendance_gps_requests',r.id::text,to_jsonb(r),p_reason);
 return r;
end $$;

create function public.ba_review_gps_attendance(p_id uuid,p_status text,p_reason text,p_supervisor_id uuid,p_actor text,p_admin boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.attendance_gps_requests; updated public.attendance_gps_requests; e public.employees; ev public.attendance_events; item record; types text[]:=array[]::text[]; day_start timestamptz; original_office uuid;
begin
 if p_status is null or p_status not in ('APPROVED','REJECTED') or nullif(trim(p_reason),'') is null or p_admin is null then raise exception 'INVALID_REVIEW'; end if;
 select * into r from public.attendance_gps_requests where id=p_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ba-attendance:'||r.employee_id::text,0));
 select * into e from public.employees where id=r.employee_id;
 if not p_admin and (e.supervisor_id is distinct from p_supervisor_id or not exists(select 1 from public.supervisors where id=p_supervisor_id and active and line_user_id=p_actor)) then raise exception 'INVALID_SUPERVISOR'; end if;
 if r.status<>'PENDING' then
  if r.status=p_status then return jsonb_build_object('request',to_jsonb(r),'replayed',true); end if;
  raise exception 'ALREADY_REVIEWED';
 end if;
 if p_status='APPROVED' then
  if not e.active then raise exception 'INACTIVE_EMPLOYEE'; end if;
  day_start:=((r.requested_at at time zone 'Asia/Bangkok')::date)::timestamp at time zone 'Asia/Bangkok';
  -- Validate every transition including events recorded after the request. Never replace history.
  for item in select event_type::text as t,occurred_at,created_at,id from public.attendance_events where employee_id=e.id and deleted_at is null and occurred_at>=day_start and occurred_at<day_start+interval '1 day'
    union all select r.event_type::text,r.requested_at,r.created_at,r.id order by occurred_at,created_at,id loop
   if not(item.t=any(public.ba_allowed_event_types(e.ba_mode::text,types))) then raise exception 'HISTORY_CHANGED_REVIEW_REQUIRED'; end if;
   types:=array_append(types,item.t);
  end loop;
  if (e.ba_mode::text='FIXED_BRANCH' and r.event_type::text in ('BREAK_OUT','BREAK_IN','OUT')) or (e.ba_mode::text='STOCK_REFILL' and r.event_type::text in ('BREAK_OUT','BREAK_IN','WORK_OUT','OUT')) then
   select office_id into original_office from public.attendance_events where employee_id=e.id and deleted_at is null and event_type::text in ('IN','WORK_IN') and occurred_at>=day_start and occurred_at<day_start+interval '1 day' order by occurred_at limit 1;
   if original_office is distinct from r.office_id then raise exception 'OFFICE_MISMATCH'; end if;
  end if;
  insert into public.attendance_events(employee_id,event_type,occurred_at,office_id,source,created_by_line_user_id,edited,request_key,latitude,longitude,gps_accuracy_meters)
  values(e.id,r.event_type,r.requested_at,r.office_id,case when p_admin then 'ADMIN_APPROVED_GPS' else 'SUPERVISOR_APPROVED_GPS' end,p_actor,true,'GPS-REQUEST-'||r.id::text,r.latitude,r.longitude,r.accuracy_meters) returning * into ev;
  insert into public.audit_logs(actor_role,actor_line_user_id,actor_ref_id,action,entity_type,entity_id,after_data,reason) values(case when p_admin then 'ADMIN' else 'SUPERVISOR' end,p_actor,p_supervisor_id,'CREATE','attendance_events',ev.id::text,to_jsonb(ev),p_reason);
 end if;
 update public.attendance_gps_requests set status=p_status,reviewer_note=p_reason,reviewed_at=clock_timestamp(),reviewer_role=case when p_admin then 'ADMIN' else 'SUPERVISOR' end,reviewer_id=p_supervisor_id,applied_event_id=ev.id where id=r.id returning * into updated;
 insert into public.audit_logs(actor_role,actor_line_user_id,actor_ref_id,action,entity_type,entity_id,before_data,after_data,reason) values(case when p_admin then 'ADMIN' else 'SUPERVISOR' end,p_actor,p_supervisor_id,'REVIEW','attendance_gps_requests',r.id::text,to_jsonb(r),to_jsonb(updated),p_reason);
 return jsonb_build_object('request',to_jsonb(updated));
end $$;
revoke all on function public.ba_request_gps_attendance(uuid,text,public.attendance_event_type,uuid,text,text,numeric,numeric,numeric) from public,anon,authenticated;
revoke all on function public.ba_review_gps_attendance(uuid,text,text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.ba_request_gps_attendance(uuid,text,public.attendance_event_type,uuid,text,text,numeric,numeric,numeric) to service_role;
grant execute on function public.ba_review_gps_attendance(uuid,text,text,uuid,text,boolean) to service_role;
commit;
