begin;
create or replace function public.ba_geofence_distance(a double precision,b double precision,c double precision,d double precision)
returns double precision language sql immutable strict set search_path=public as $$
 select 6371000*2*asin(sqrt(least(1.0,greatest(0.0,power(sin(radians(c-a)/2),2)+cos(radians(a))*cos(radians(c))*power(sin(radians(d-b)/2),2)))));
$$;
create or replace function public.insert_attendance_event_geofenced(
 p_employee_id uuid,p_event_type public.attendance_event_type,p_occurred_at timestamptz,
 p_office_id uuid,p_latitude numeric,p_longitude numeric,p_accuracy numeric,p_distance numeric,
 p_source text,p_created_by text,p_request_key text,p_fix_at timestamptz)
returns public.attendance_events language plpgsql security definer set search_path=public as $$
declare
 e public.employees; o public.offices; previous public.attendance_events; result public.attendance_events;
 mode text; anchor_types text[]:=array[]::text[]; anchor uuid; metres double precision;
 ts timestamptz; day_start timestamptz; day_end timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('ba-attendance:'||p_employee_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('ba-request:'||p_request_key,0));
 select * into previous from public.attendance_events where request_key=p_request_key;
 if found then
  -- The existing guard checks identity, source, type and deleted state on replay.
  return public.insert_attendance_event_guarded(p_employee_id,p_event_type,p_occurred_at,p_office_id,p_latitude,p_longitude,p_accuracy,p_distance,p_source,p_created_by,p_request_key);
 end if;
 select * into e from public.employees where id=p_employee_id and active and line_user_id=p_created_by for share;
 if not found then raise exception 'INVALID_EMPLOYEE';end if;
 mode:=coalesce(e.ba_mode::text,'FIXED_BRANCH');
 ts:=clock_timestamp();
 if p_fix_at is null or p_fix_at<ts-interval '60 seconds' or p_fix_at>ts+interval '5 seconds' then raise exception 'GPS_STALE';end if;
 if p_latitude is null or p_longitude is null or p_latitude::text in ('NaN','Infinity','-Infinity') or p_longitude::text in ('NaN','Infinity','-Infinity') or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then raise exception 'GPS_INVALID';end if;
 if p_accuracy is null or p_accuracy::text in ('NaN','Infinity','-Infinity') or p_accuracy<=0 then raise exception 'GPS_ACCURACY';end if;
 day_start:=((ts at time zone 'Asia/Bangkok')::date)::timestamp at time zone 'Asia/Bangkok';
 day_end:=day_start+interval '1 day';
 if mode not in ('MULTI_BRANCH','STOCK_REFILL') and p_event_type::text in ('BREAK_OUT','BREAK_IN','OUT') then anchor_types:=array['IN'];end if;
 if mode='MULTI_BRANCH' and p_event_type::text in ('BREAK_OUT','BREAK_IN','BRANCH_OUT') then anchor_types:=array['BRANCH_IN'];end if;
 if mode='STOCK_REFILL' and p_event_type::text in ('BREAK_OUT','BREAK_IN','WORK_OUT','OUT') then anchor_types:=array['WORK_IN','IN'];end if;
 if mode='STOCK_REFILL' and p_event_type::text='REFILL_OUT' then anchor_types:=array['REFILL_IN'];end if;
 if cardinality(anchor_types)>0 then
  select office_id into anchor from public.attendance_events where employee_id=p_employee_id and deleted_at is null and occurred_at>=day_start and occurred_at<day_end and event_type::text=any(anchor_types) order by occurred_at desc,created_at desc,id desc limit 1;
  if anchor is null then raise exception 'INVALID_TRANSITION';end if;
  if anchor is distinct from p_office_id then raise exception 'ATTENDANCE_OFFICE_CHANGED';end if;
 end if;
 select * into o from public.offices where id=p_office_id for share;
 if not found then raise exception 'GPS_OFFICE_UNAVAILABLE';end if;
 if o.active is not true or o.latitude is null or o.longitude is null or o.latitude not between -90 and 90 or o.longitude not between -180 and 180 or o.radius_meters is null or o.radius_meters<=0 or o.radius_meters::text in ('NaN','Infinity','-Infinity') then raise exception 'GPS_OFFICE_UNAVAILABLE';end if;
 if p_accuracy>least(2500,greatest(200,o.radius_meters)) then raise exception 'GPS_ACCURACY';end if;
 metres:=public.ba_geofence_distance(p_latitude::double precision,p_longitude::double precision,o.latitude::double precision,o.longitude::double precision);
 if metres>o.radius_meters then raise exception 'GPS_OUTSIDE';end if;
 -- Never trust the client/API distance. The original state guard runs under the same locks.
 result:=public.insert_attendance_event_guarded(p_employee_id,p_event_type,p_occurred_at,p_office_id,p_latitude,p_longitude,p_accuracy,metres::numeric,p_source,p_created_by,p_request_key);
 return result;
end $$;
revoke all on function public.ba_geofence_distance(double precision,double precision,double precision,double precision) from public,anon,authenticated;
revoke all on function public.insert_attendance_event_geofenced(uuid,public.attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.insert_attendance_event_geofenced(uuid,public.attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text,timestamptz) to service_role;
-- Keep the old guard callable by its owner for reviewed/internal paths only.
revoke execute on function public.insert_attendance_event_guarded(uuid,public.attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text) from service_role;
commit;
