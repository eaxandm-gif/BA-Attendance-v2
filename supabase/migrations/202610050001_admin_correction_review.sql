begin;
-- Explicit privileged correction path: audit, replacements and review are one transaction.
create or replace function public.ba_review_attendance_correction_core(
 p_request_id uuid,p_supervisor_id uuid,p_actor text,p_status text,p_reason text,
 p_shift_start time,p_shift_end time,p_admin boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 r public.attendance_correction_requests;
 updated_request public.attendance_correction_requests;
 e public.employees;
 old_event public.attendance_events;
 new_event public.attendance_events;
 changed_event public.attendance_events;
 types text[];
 canonical text;
 window_start timestamptz;
 window_end timestamptz;
 event_at timestamptz;
 overnight boolean;
begin
 if p_status not in ('APPROVED','REJECTED') or p_status is null or nullif(trim(p_reason),'') is null then
   raise exception 'INVALID_CORRECTION_REVIEW';
 end if;
 if not p_admin and not exists(select 1 from public.supervisors where id=p_supervisor_id and line_user_id=p_actor and active) then
   raise exception 'INVALID_SUPERVISOR';
 end if;
 select * into r from public.attendance_correction_requests where id=p_request_id for update;
 if not found then raise exception 'CORRECTION_REQUEST_NOT_FOUND'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ba-attendance:'||r.employee_id::text,0));
 select * into e from public.employees where id=r.employee_id;
 if not p_admin and e.supervisor_id is distinct from p_supervisor_id then raise exception 'INVALID_SUPERVISOR'; end if;
 if r.status<>'PENDING' then
   if r.status=p_status and r.reviewed_by_supervisor_id is not distinct from p_supervisor_id then
     select * into new_event from public.attendance_events where id=r.applied_event_id;
     return jsonb_build_object('request',to_jsonb(r),'applied_event',case when new_event.id is null then null else to_jsonb(new_event) end,'replayed',true);
   end if;
   raise exception 'CORRECTION_ALREADY_REVIEWED';
 end if;
 if r.created_at<clock_timestamp()-interval '3 days' then raise exception 'CORRECTION_EXPIRED'; end if;
 if p_status='APPROVED' then
   if p_shift_start is null or p_shift_end is null then raise exception 'INVALID_CORRECTION_SHIFT'; end if;
   overnight:=p_shift_end<=p_shift_start;
   if r.request_side='IN' then
     event_at:=(r.request_date+p_shift_start) at time zone 'Asia/Bangkok';
     -- IN always belongs to the requested calendar day, never the following day.
     window_start:=r.request_date::timestamp at time zone 'Asia/Bangkok';
     window_end:=(r.request_date+1)::timestamp at time zone 'Asia/Bangkok';
   elsif r.request_side='OUT' then
     event_at:=((r.request_date+case when overnight then 1 else 0 end)+p_shift_end) at time zone 'Asia/Bangkok';
     if overnight then
       window_start:=(r.request_date+p_shift_start) at time zone 'Asia/Bangkok';
       window_end:=((r.request_date+1)+p_shift_start) at time zone 'Asia/Bangkok';
     else
       window_start:=r.request_date::timestamp at time zone 'Asia/Bangkok';
       window_end:=(r.request_date+1)::timestamp at time zone 'Asia/Bangkok';
     end if;
   else raise exception 'INVALID_CORRECTION_SIDE';
   end if;
   canonical:=case when e.ba_mode::text='MULTI_BRANCH' then 'DAY_'||r.request_side
     when e.ba_mode::text='STOCK_REFILL' then 'WORK_'||r.request_side else r.request_side end;
   types:=case when e.ba_mode::text='STOCK_REFILL' then array[canonical,r.request_side] else array[canonical] end;
   for old_event in select * from public.attendance_events where employee_id=e.id and deleted_at is null
     and event_type::text=any(types) and occurred_at>=window_start and occurred_at<window_end for update loop
     update public.attendance_events set deleted_at=clock_timestamp(),edited=true where id=old_event.id returning * into changed_event;
     insert into public.audit_logs(actor_line_user_id,actor_role,actor_ref_id,action,entity_type,entity_id,before_data,after_data,reason)
     values(p_actor,case when p_admin then 'ADMIN' else 'SUPERVISOR' end,p_supervisor_id,'OVERRIDE_DELETE','attendance_events',old_event.id::text,to_jsonb(old_event),to_jsonb(changed_event),p_reason);
   end loop;
   insert into public.attendance_events(employee_id,event_type,occurred_at,office_id,source,created_by_line_user_id,edited,request_key)
   values(e.id,canonical::public.attendance_event_type,event_at,r.office_id,case when p_admin then 'ADMIN_APPROVED_REQUEST' else 'SUPERVISOR_APPROVED_REQUEST' end,p_actor,true,'ATTENDANCE-REQUEST-'||r.id::text)
   returning * into new_event;
   insert into public.audit_logs(actor_line_user_id,actor_role,actor_ref_id,action,entity_type,entity_id,before_data,after_data,reason)
   values(p_actor,case when p_admin then 'ADMIN' else 'SUPERVISOR' end,p_supervisor_id,'OVERRIDE_CREATE','attendance_events',new_event.id::text,null,to_jsonb(new_event),p_reason);
 end if;
 update public.attendance_correction_requests set status=p_status,reviewer_note=p_reason,reviewed_at=clock_timestamp(),
 reviewed_by_supervisor_id=p_supervisor_id,supervisor_id=coalesce(p_supervisor_id,r.supervisor_id),applied_event_id=new_event.id,updated_at=clock_timestamp()
 where id=r.id returning * into updated_request;
 insert into public.audit_logs(actor_line_user_id,actor_role,actor_ref_id,action,entity_type,entity_id,before_data,after_data,reason)
 values(p_actor,case when p_admin then 'ADMIN' else 'SUPERVISOR' end,p_supervisor_id,'REVIEW','attendance_correction_requests',r.id::text,to_jsonb(r),to_jsonb(updated_request),p_reason);
 return jsonb_build_object('request',to_jsonb(updated_request),'applied_event',case when new_event.id is null then null else to_jsonb(new_event) end);
end $$;

revoke all on function public.ba_review_attendance_correction_core(uuid,uuid,text,text,text,time,time,boolean) from public,anon,authenticated,service_role;
create or replace function public.ba_review_attendance_correction(p_request_id uuid,p_supervisor_id uuid,p_actor text,p_status text,p_reason text,p_shift_start time,p_shift_end time)
returns jsonb language sql security definer set search_path=public as $$
 select public.ba_review_attendance_correction_core(p_request_id,p_supervisor_id,p_actor,p_status,p_reason,p_shift_start,p_shift_end,false);
$$;
create or replace function public.ba_admin_review_attendance_correction(p_request_id uuid,p_status text,p_reason text,p_shift_start time,p_shift_end time)
returns jsonb language sql security definer set search_path=public as $$
 select public.ba_review_attendance_correction_core(p_request_id,null,'ADMIN_WEB',p_status,p_reason,p_shift_start,p_shift_end,true);
$$;
revoke all on function public.ba_admin_review_attendance_correction(uuid,text,text,time,time) from public,anon,authenticated;
grant execute on function public.ba_admin_review_attendance_correction(uuid,text,text,time,time) to service_role;
commit;
