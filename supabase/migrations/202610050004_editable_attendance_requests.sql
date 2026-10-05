begin;
alter table public.attendance_correction_requests add column proposed_events jsonb, add column reviewed_events jsonb, add column applied_event_ids uuid[], add column request_key text, add column reviewer_role text;
create unique index attendance_correction_request_key on public.attendance_correction_requests(request_key) where request_key is not null;
alter table public.attendance_gps_requests add column reviewed_events jsonb, add column applied_event_ids uuid[];
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.attendance_correction_requests'::regclass and contype='c' and pg_get_constraintdef(oid) like '%request_side%' loop
 execute format('alter table public.attendance_correction_requests drop constraint %I',c.conname);
 end loop;
end $$;
alter table public.attendance_correction_requests add constraint attendance_request_side_v2 check(request_side in ('IN','OUT','BREAK_OUT','BREAK_IN','BREAK_BOTH'));

-- Server-side parsing shared by submission and review. Original input is retained separately.
create function public.ba_parse_requested_events(p_events jsonb,p_date date,p_mode text,p_employee uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare x jsonb; result jsonb:='[]'; t text; ts timestamptz; office uuid; target uuid;
begin
 if p_events is null or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events) not between 1 and 2 then raise exception 'กรุณาระบุรายการที่ต้องการแก้ 1–2 รายการ'; end if;
 for x in select value from jsonb_array_elements(p_events) loop
  t:=x->>'event_type';
  if t in ('IN','OUT') and p_mode='STOCK_REFILL' then t:='WORK_'||t; elsif t in ('IN','OUT') and p_mode='MULTI_BRANCH' then t:='DAY_'||t; end if;
  if t is null or t not in ('IN','OUT','BREAK_OUT','BREAK_IN','WORK_IN','WORK_OUT','DAY_IN','DAY_OUT','BRANCH_IN','BRANCH_OUT','REFILL_IN','REFILL_OUT') then raise exception 'ประเภทลงเวลาไม่ถูกต้อง'; end if;
  if coalesce(x->>'occurred_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$' then raise exception 'กรุณาระบุวันเวลาและเขตเวลาให้ครบ'; end if;
  ts:=(x->>'occurred_at')::timestamptz;office:=(x->>'office_id')::uuid;target:=nullif(x->>'replace_event_id','')::uuid;
  if ts is null or (ts at time zone 'Asia/Bangkok')::date is distinct from p_date or ts>clock_timestamp() then raise exception 'เวลาต้องอยู่ในวันที่ขอและไม่เป็นเวลาอนาคต'; end if;
  if office is null or not exists(select 1 from public.offices where id=office) then raise exception 'ไม่พบสาขา'; end if;
  if target is not null and not exists(select 1 from public.attendance_events where id=target and employee_id=p_employee and deleted_at is null and (occurred_at at time zone 'Asia/Bangkok')::date=p_date) then raise exception 'รายการที่เลือกแก้ไม่ใช่ของพนักงานหรือวันที่นี้'; end if;
  result:=result||jsonb_build_array(jsonb_build_object('event_type',t,'occurred_at',ts,'office_id',office,'replace_event_id',target));
 end loop;
 if (select count(*)<>count(distinct value->>'occurred_at') from jsonb_array_elements(result)) then raise exception 'เวลาแต่ละรายการต้องไม่ซ้ำกัน'; end if;
 if (select count(*)<>count(distinct value->>'replace_event_id') from jsonb_array_elements(result) where value->>'replace_event_id' is not null) then raise exception 'ห้ามเลือกแก้รายการเดิมซ้ำ'; end if;
 return result;
end $$;

create function public.ba_submit_attendance_request_v2(p_employee uuid,p_actor text,p_date date,p_side text,p_events jsonb,p_reason text,p_key text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.employees;r public.attendance_correction_requests;parsed jsonb;
begin
 select * into e from public.employees where id=p_employee and active and line_user_id=p_actor;
 if not found then raise exception 'ไม่มีสิทธิ์ส่งคำขอ'; end if;
 if p_date is null or p_date>(clock_timestamp() at time zone 'Asia/Bangkok')::date or p_side is null or p_side not in ('IN','OUT','BREAK_OUT','BREAK_IN','BREAK_BOTH') or nullif(trim(p_reason),'') is null or length(p_reason)>1000 or nullif(p_key,'') is null or length(p_key)>200 then raise exception 'ข้อมูลคำขอไม่ครบหรือไม่ถูกต้อง'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ba-correction-key:'||p_key,0));
 select * into r from public.attendance_correction_requests where request_key=p_key;
 if found then
  if r.employee_id<>e.id or r.request_date<>p_date or r.request_side<>p_side or r.proposed_events is distinct from p_events or r.reason<>p_reason then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return to_jsonb(r);
 end if;
 parsed:=public.ba_parse_requested_events(p_events,p_date,e.ba_mode::text,e.id);
 if exists(select 1 from jsonb_array_elements(p_events) x where nullif(x->>'replace_event_id','') is not null) then raise exception 'BA ขอเพิ่มเวลาที่ลืมได้ ผู้อนุมัติเท่านั้นที่เลือกแก้รายการเดิมได้'; end if;
 if p_side='BREAK_BOTH' then
  if jsonb_array_length(p_events)<>2 or p_events->0->>'event_type'<>'BREAK_OUT' or p_events->1->>'event_type'<>'BREAK_IN' or (parsed->0->>'occurred_at')::timestamptz >= (parsed->1->>'occurred_at')::timestamptz then raise exception 'ระบุเวลาออกพักก่อนเวลากลับจากพัก'; end if;
 else
  if jsonb_array_length(p_events)<>1 or p_events->0->>'event_type' is distinct from p_side then raise exception 'ประเภทคำขอไม่ตรงกับรายการ'; end if;
 end if;
 insert into public.attendance_correction_requests(employee_id,supervisor_id,request_date,request_side,office_id,reason,status,proposed_events,request_key)
 values(e.id,e.supervisor_id,p_date,p_side,(parsed->0->>'office_id')::uuid,p_reason,'PENDING',p_events,p_key) returning * into r;
 insert into public.audit_logs(actor_role,actor_line_user_id,action,entity_type,entity_id,after_data,reason) values('EMPLOYEE',p_actor,'CREATE','attendance_correction_requests',r.id::text,to_jsonb(r),p_reason);
 return to_jsonb(r);
end $$;

create function public.ba_attendance_review_context_v2(p_kind text,p_id uuid,p_supervisor uuid,p_actor text,p_admin boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r jsonb;e public.employees;d date;ev jsonb;offices jsonb;
begin
 if p_admin is null or p_kind is null or p_kind not in ('correction','gps') then raise exception 'INVALID_REVIEW'; end if;
 if p_kind='correction' then select to_jsonb(req) into r from public.attendance_correction_requests req where id=p_id;
 else select to_jsonb(req) into r from public.attendance_gps_requests req where id=p_id;end if;
 if r is null then raise exception 'ไม่พบคำขอ'; end if;
 select * into e from public.employees where id=(r->>'employee_id')::uuid;
 if not p_admin and (e.supervisor_id is distinct from p_supervisor or not exists(select 1 from public.supervisors where id=p_supervisor and active and line_user_id=p_actor)) then raise exception 'ไม่มีสิทธิ์จัดการคำขอของพนักงานนี้'; end if;
 d:=case when p_kind='correction' then (r->>'request_date')::date else ((r->>'requested_at')::timestamptz at time zone 'Asia/Bangkok')::date end;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.occurred_at,x.created_at,x.id),'[]') into ev from (select id,event_type,occurred_at,office_id,created_at,updated_at from public.attendance_events where employee_id=e.id and deleted_at is null and (occurred_at at time zone 'Asia/Bangkok')::date=d) x;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'office_name',office_name) order by office_name),'[]') into offices from public.offices;
 return jsonb_build_object('request',r,'kind',p_kind,'date',d,'employee',jsonb_build_object('employee_code',e.employee_code,'display_name',e.display_name,'ba_mode',e.ba_mode),'events',ev,'offices',offices,'history_version',md5(ev::text));
end $$;

create function public.ba_review_attendance_request_v2(p_kind text,p_id uuid,p_status text,p_reason text,p_events jsonb,p_history_version text,p_supervisor uuid,p_actor text,p_admin boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r jsonb;updated jsonb;ctx jsonb;e public.employees;d date;parsed jsonb;replaced uuid[];new_ids uuid[]:=array[]::uuid[];item record;x jsonb;types text[]:=array[]::text[];old_event public.attendance_events;changed public.attendance_events;new_event public.attendance_events;work_office uuid;actor_role public.audit_logs.actor_role%type;table_name text;
begin
 if p_status is null or p_status not in ('APPROVED','REJECTED') or nullif(trim(p_reason),'') is null or length(p_reason)>2000 or p_admin is null or p_kind is null or p_kind not in ('correction','gps') then raise exception 'กรุณาระบุผลตรวจสอบและเหตุผล'; end if;
 if p_kind='correction' then select to_jsonb(req) into r from public.attendance_correction_requests req where id=p_id for update;table_name:='attendance_correction_requests';
 else select to_jsonb(req) into r from public.attendance_gps_requests req where id=p_id for update;table_name:='attendance_gps_requests'; end if;
 if r is null then raise exception 'ไม่พบคำขอ'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ba-attendance:'||(r->>'employee_id'),0));
 ctx:=public.ba_attendance_review_context_v2(p_kind,p_id,p_supervisor,p_actor,p_admin);
 select * into e from public.employees where id=(r->>'employee_id')::uuid;
 actor_role:=case when p_admin then 'ADMIN' else 'SUPERVISOR' end;d:=(ctx->>'date')::date;
 if r->>'status'<>'PENDING' then
  if r->>'status'=p_status and r->>'reviewer_note'=p_reason and (p_status='REJECTED' or r->'reviewed_events'=p_events) then return jsonb_build_object('request',r,'replayed',true);end if;
  raise exception 'คำขอนี้ถูกดำเนินการแล้ว กรุณาโหลดใหม่';
 end if;
 if p_status='APPROVED' then
  if not e.active then raise exception 'พนักงานไม่ได้เปิดใช้งาน';end if;
  if p_kind='correction' and (r->>'created_at')::timestamptz<clock_timestamp()-interval '3 days' then raise exception 'คำขอหมดอายุ กรุณาให้ BA ส่งใหม่';end if;
  if p_history_version is distinct from ctx->>'history_version' then raise exception 'ประวัติเปลี่ยนแล้ว กรุณาโหลดและตรวจสอบใหม่ก่อนอนุมัติ';end if;
  parsed:=public.ba_parse_requested_events(p_events,d,e.ba_mode::text,e.id);
  select coalesce(array_agg((value->>'replace_event_id')::uuid) filter(where value->>'replace_event_id' is not null),array[]::uuid[]) into replaced from jsonb_array_elements(parsed);
  -- Evaluate the complete projected day BEFORE any write. No implicit replacement.
  for item in select event_type::text as t,occurred_at as ts,office_id from public.attendance_events where employee_id=e.id and deleted_at is null and (occurred_at at time zone 'Asia/Bangkok')::date=d and not(id=any(replaced))
   union all select value->>'event_type',(value->>'occurred_at')::timestamptz,(value->>'office_id')::uuid from jsonb_array_elements(parsed) order by ts,t loop
   if not(item.t=any(public.ba_allowed_event_types(e.ba_mode::text,types))) then raise exception 'ลำดับเวลาไม่ถูกต้องหรือมีรายการซ้ำ กรุณาตรวจประวัติและเพิ่มรายการที่ขาดให้ครบ';end if;
   if item.t in ('IN','WORK_IN') then work_office:=item.office_id;end if;
   if e.ba_mode::text in ('FIXED_BRANCH','STOCK_REFILL') and item.t in ('BREAK_OUT','BREAK_IN','OUT','WORK_OUT') and item.office_id is distinct from work_office then raise exception 'สาขาของรายการพักหรือออกงานต้องตรงกับเข้างาน';end if;
   types:=array_append(types,item.t);
  end loop;
  if exists(select 1 from (select occurred_at ts from public.attendance_events where employee_id=e.id and deleted_at is null and (occurred_at at time zone 'Asia/Bangkok')::date=d and not(id=any(replaced)) union all select (value->>'occurred_at')::timestamptz from jsonb_array_elements(parsed)) q group by ts having count(*)>1) then raise exception 'เวลาซ้ำกับรายการเดิม กรุณาตรวจสอบ';end if;
  for old_event in select * from public.attendance_events where id=any(replaced) for update loop
   update public.attendance_events set deleted_at=clock_timestamp(),edited=true where id=old_event.id returning * into changed;
   insert into public.audit_logs(actor_role,actor_line_user_id,actor_ref_id,action,entity_type,entity_id,before_data,after_data,reason) values(actor_role,p_actor,p_supervisor,'OVERRIDE_DELETE','attendance_events',old_event.id::text,to_jsonb(old_event),to_jsonb(changed),p_reason);
  end loop;
  for x in select value from jsonb_array_elements(parsed) order by (value->>'occurred_at')::timestamptz loop
   insert into public.attendance_events(employee_id,event_type,occurred_at,office_id,source,created_by_line_user_id,edited,request_key)
   values(e.id,(x->>'event_type')::public.attendance_event_type,(x->>'occurred_at')::timestamptz,(x->>'office_id')::uuid,actor_role||'_REVIEWED_REQUEST',p_actor,true,'REVIEW-'||p_kind||'-'||p_id::text||'-'||cardinality(new_ids)) returning * into new_event;
   new_ids:=array_append(new_ids,new_event.id);
   insert into public.audit_logs(actor_role,actor_line_user_id,actor_ref_id,action,entity_type,entity_id,after_data,reason) values(actor_role,p_actor,p_supervisor,'OVERRIDE_CREATE','attendance_events',new_event.id::text,to_jsonb(new_event),p_reason);
  end loop;
 end if;
 if p_kind='correction' then
  update public.attendance_correction_requests set status=p_status,reviewer_note=p_reason,reviewed_at=clock_timestamp(),reviewed_by_supervisor_id=p_supervisor,reviewer_role=actor_role,reviewed_events=case when p_status='APPROVED' then p_events else null end,applied_event_ids=new_ids,applied_event_id=new_ids[1],updated_at=clock_timestamp() where id=p_id returning to_jsonb(attendance_correction_requests.*) into updated;
 else
  update public.attendance_gps_requests set status=p_status,reviewer_note=p_reason,reviewed_at=clock_timestamp(),reviewer_id=p_supervisor,reviewer_role=actor_role,reviewed_events=case when p_status='APPROVED' then p_events else null end,applied_event_ids=new_ids,applied_event_id=new_ids[1] where id=p_id returning to_jsonb(attendance_gps_requests.*) into updated;
 end if;
 insert into public.audit_logs(actor_role,actor_line_user_id,actor_ref_id,action,entity_type,entity_id,before_data,after_data,reason) values(actor_role,p_actor,p_supervisor,'REVIEW',table_name,p_id::text,r,updated,p_reason);
 return jsonb_build_object('request',updated);
end $$;
revoke all on function public.ba_parse_requested_events(jsonb,date,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.ba_submit_attendance_request_v2(uuid,text,date,text,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.ba_attendance_review_context_v2(text,uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.ba_review_attendance_request_v2(text,uuid,text,text,jsonb,text,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.ba_submit_attendance_request_v2(uuid,text,date,text,jsonb,text,text) to service_role;
grant execute on function public.ba_attendance_review_context_v2(text,uuid,uuid,text,boolean) to service_role;
grant execute on function public.ba_review_attendance_request_v2(text,uuid,text,text,jsonb,text,uuid,text,boolean) to service_role;
commit;
