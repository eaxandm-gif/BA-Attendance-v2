// v4.6.3 explicit attendance correction override
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_API_KEY = Deno.env.get('ADMIN_API_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {auth:{persistSession:false}});

const cors = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'content-type,x-admin-key',
  'Access-Control-Allow-Methods':'POST,OPTIONS'
};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8','X-BA-Version':'4.6.5'}});
const fail=(m:string,s=400)=>json({success:false,message:m},s);
const now=()=>new Date().toISOString();

async function audit(action:string,entityType:string,entityId:string|null,before:any,after:any,reason:string){
  if(!String(reason||'').trim())throw new Error('ต้องระบุเหตุผล');
  const {error}=await sb.from('audit_logs').insert({
    actor_line_user_id:'ADMIN_WEB',
    actor_role:'ADMIN',
    actor_ref_id:null,
    action,
    entity_type:entityType,
    entity_id:entityId,
    before_data:before,
    after_data:after,
    reason:String(reason).trim()
  });
  if(error)throw new Error(`บันทึก Audit Log ไม่สำเร็จ: ${error.message}`);
}
async function one(table:string,id:string){
  const {data,error}=await sb.from(table).select('*').eq('id',id).maybeSingle();
  if(error) throw error;
  return data;
}

async function defaultOfficeAndShift(){
  const [{data:office},{data:shift}]=await Promise.all([
    sb.from('offices').select('id').eq('active',true).order('office_code').limit(1).maybeSingle(),
    sb.from('shift_templates').select('id').order('start_time').limit(1).maybeSingle()
  ]);
  return {office_id:office?.id||null,shift_id:shift?.id||null};
}

async function attachSupervisorsToRegistrations(rows:any[]){
  const source=rows||[];
  const supervisorIds=[...new Set(source.map((x:any)=>x.requested_supervisor_id).filter(Boolean))];
  if(!supervisorIds.length){
    return source.map((x:any)=>({...x,supervisors:null}));
  }

  const {data,error}=await sb.from('supervisors')
    .select('id,supervisor_code,supervisor_name,phone,line_user_id,active')
    .in('id',supervisorIds);
  if(error)throw error;

  const supervisorMap=new Map((data||[]).map((x:any)=>[x.id,x]));
  return source.map((x:any)=>({
    ...x,
    supervisors:supervisorMap.get(x.requested_supervisor_id)||null
  }));
}
function requiredReason(p:any){
  if(!String(p?.reason||'').trim()) throw new Error('กรุณาระบุเหตุผลการแก้ไข');
}
async function listAll(){
  const [
    employees, offices, supervisors, shifts, schedules, leaves, attendance,
    daily, monthly, audits, lineLogs, registrations
  ] = await Promise.all([
    sb.from('employees').select('*,offices(office_name,region),supervisors(supervisor_name)').order('employee_code'),
    sb.from('offices').select('*').order('office_code'),
    sb.from('supervisors').select('*').order('supervisor_code'),
    sb.from('shift_templates').select('*').order('start_time'),
    sb.from('employee_schedules').select('*,employees(employee_code,display_name)').order('work_date',{ascending:false}).limit(5000),
    sb.from('leave_requests').select('*,employees(employee_code,display_name),supervisors(supervisor_name)').order('leave_date',{ascending:false}).limit(5000),
    sb.from('attendance_events').select('*,employees(employee_code,display_name),offices(office_name)').is('deleted_at',null).order('occurred_at',{ascending:false}).limit(10000),
    sb.from('daily_summaries').select('*,employees(employee_code,display_name)').order('work_date',{ascending:false}).limit(5000),
    sb.from('monthly_summaries').select('*,employees(employee_code,display_name)').order('month_start',{ascending:false}).limit(1000),
    sb.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(500),
    sb.from('line_report_logs').select('*,supervisors(supervisor_name)').order('report_date',{ascending:false}).limit(500),
    sb.from('ba_registration_requests').select('*').order('created_at',{ascending:false}).limit(500)
  ]);
  for(const r of [employees,offices,supervisors,shifts,schedules,leaves,attendance,daily,monthly,audits,lineLogs,registrations]){
    if(r.error) throw r.error;
  }
  const registrationRows=await attachSupervisorsToRegistrations(registrations.data||[]);
  return {
    employees:employees.data||[], offices:offices.data||[], supervisors:supervisors.data||[],
    shifts:shifts.data||[], schedules:schedules.data||[], leaves:leaves.data||[],
    attendance:attendance.data||[], daily:daily.data||[], monthly:monthly.data||[],
    audits:audits.data||[], line_logs:lineLogs.data||[], registrations:registrationRows
  };
}

Deno.serve(async req=>{
  try{
    if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
    if(req.method!=='POST') return fail('Method not allowed',405);
    if(!ADMIN_API_KEY||req.headers.get('X-Admin-Key')!==ADMIN_API_KEY) return fail('Admin Key ไม่ถูกต้อง',401);

    const body=await req.json().catch(()=>({}));
    const action=body.action;
    const p=body.payload||{};

    if(action==='attendance_requests'){
 const status=String(p.status||'PENDING');if(!['PENDING','APPROVED','REJECTED'].includes(status))return fail('สถานะไม่ถูกต้อง');
 const [{data:corrections,error:ce},{data:gps,error:ge}]=await Promise.all([
 sb.from('attendance_correction_requests').select('*,employees(employee_code,display_name),offices(office_name)').eq('status',status).order('created_at').limit(1000),
 sb.from('attendance_gps_requests').select('*,employees(employee_code,display_name),offices(office_name)').eq('status',status).order('created_at').limit(1000)]);
 if(ce)throw ce;if(ge)throw ge;return json({success:true,corrections,gps});
}
if(action==='attendance_review_context'||action==='review_attendance_request'){
 const args:any={p_kind:p.kind,p_id:p.request_id,p_supervisor:null,p_actor:'ADMIN_WEB',p_admin:true};
 if(action==='review_attendance_request')Object.assign(args,{p_status:p.status,p_reason:String(p.reason||'').trim(),p_events:p.events??null,p_history_version:p.history_version??null});
 const {data,error}=await sb.rpc(action==='attendance_review_context'?'ba_attendance_review_context_v2':'ba_review_attendance_request_v2',args);
 if(error)return fail(error.message,409);return json({success:true,...data});
}
if(action==='review_gps_request'||action==='review_attendance_correction_request')return fail('กรุณาเปิดหน้าใหม่ แล้วตรวจแก้ข้อมูลก่อนอนุมัติ',409);
if(action==='bootstrap'){
      return json({success:true,data:await listAll()});
    }

    if(action==='list_attendance'){
      const startDate=String(p.start_date||'').trim();
      const endDate=String(p.end_date||'').trim();
      const datePattern=/^\d{4}-\d{2}-\d{2}$/;
      if(!datePattern.test(startDate)||!datePattern.test(endDate)){
        return fail('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
      }
      if(startDate>endDate)return fail('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
      const maxRows=Math.min(10000,Math.max(1,Number(p.limit||5000)));
      const pageSize=1000;
      const attendanceRows:any[]=[];
      for(let from=0;from<maxRows;from+=pageSize){
        const to=Math.min(from+pageSize-1,maxRows-1);
        const {data,error}=await sb.from('attendance_events')
          .select('*,employees(employee_code,display_name),offices(office_name)')
          .is('deleted_at',null)
          .gte('occurred_at',startDate+'T00:00:00+07:00')
          .lte('occurred_at',endDate+'T23:59:59.999+07:00')
          .order('occurred_at',{ascending:false})
          .order('id',{ascending:true})
          .range(from,to);
        if(error)throw error;
        const page=data||[];
        attendanceRows.push(...page);
        if(page.length<pageSize)break;
      }
      return json({success:true,data:{attendance:attendanceRows}});
    }

    if(action==='save_employee'){
      requiredReason(p);
      const payload={
        employee_code:p.employee_code,
        display_name:p.display_name,
        full_name:p.full_name||null,
        phone:p.phone||null,
        line_user_id:p.line_user_id||null,
        ba_mode:p.ba_mode||null,
        assigned_office_id:p.assigned_office_id||null,
        supervisor_id:p.supervisor_id||null,
        default_shift_id:p.default_shift_id||'SHIFT12',
        active:p.active!==false,
        start_date:p.start_date||null,
        end_date:p.end_date||null,
        note:p.note||null,
        profile_completed:Boolean(p.display_name&&p.phone&&p.ba_mode&&p.assigned_office_id&&p.supervisor_id)
      };
      if(p.id){
        const before=await one('employees',p.id);
        const {data,error}=await sb.from('employees').update(payload).eq('id',p.id).select().single();
        if(error) throw error; await audit('UPDATE','employees',p.id,before,data,p.reason);
      }else{
        const {data,error}=await sb.from('employees').insert(payload).select().single();
        if(error) throw error; await audit('CREATE','employees',data.id,null,data,p.reason);
      }
      return json({success:true});
    }

    if(action==='delete_employee'){
      requiredReason(p);
      const before=await one('employees',p.id);
      const {error}=await sb.from('employees').delete().eq('id',p.id);
      if(error) throw error; await audit('DELETE','employees',p.id,before,null,p.reason);
      return json({success:true});
    }

    if(action==='save_supervisor'){
      requiredReason(p);
      const payload={supervisor_code:p.supervisor_code,supervisor_name:p.supervisor_name,phone:p.phone||null,line_user_id:p.line_user_id||null,active:p.active!==false,note:p.note||null};
      if(p.id){
        const before=await one('supervisors',p.id);
        const {data,error}=await sb.from('supervisors').update(payload).eq('id',p.id).select().single();
        if(error) throw error; await audit('UPDATE','supervisors',p.id,before,data,p.reason);
      }else{
        const {data,error}=await sb.from('supervisors').insert(payload).select().single();
        if(error) throw error; await audit('CREATE','supervisors',data.id,null,data,p.reason);
      }
      return json({success:true});
    }

    if(action==='delete_supervisor'){
      requiredReason(p);
      const before=await one('supervisors',p.id);
      const {error}=await sb.from('supervisors').delete().eq('id',p.id);
      if(error) throw error; await audit('DELETE','supervisors',p.id,before,null,p.reason);
      return json({success:true});
    }

    if(action==='save_office'){
      requiredReason(p);
      const payload={office_code:p.office_code,office_name:p.office_name,region:p.region,latitude:Number(p.latitude),longitude:Number(p.longitude),radius_meters:Number(p.radius_meters||100),active:p.active!==false,note:p.note||null};
      if(p.id){
        const before=await one('offices',p.id);
        const {data,error}=await sb.from('offices').update(payload).eq('id',p.id).select().single();
        if(error) throw error; await audit('UPDATE','offices',p.id,before,data,p.reason);
      }else{
        const {data,error}=await sb.from('offices').insert(payload).select().single();
        if(error) throw error; await audit('CREATE','offices',data.id,null,data,p.reason);
      }
      return json({success:true});
    }

    if(action==='delete_office'){
      requiredReason(p);
      const before=await one('offices',p.id);
      const {error}=await sb.from('offices').delete().eq('id',p.id);
      if(error) throw error; await audit('DELETE','offices',p.id,before,null,p.reason);
      return json({success:true});
    }

    if(action==='save_shift'){
      requiredReason(p);
      const payload={id:p.id,shift_name:p.shift_name,start_time:p.start_time,end_time:p.end_time,required_minutes:Number(p.required_minutes||480),break_minutes:Number(p.break_minutes||60),grace_minutes:Number(p.grace_minutes||0),active:p.active!==false,updated_at:now()};
      const before=await one('shift_templates',p.id);
      const {data,error}=await sb.from('shift_templates').upsert(payload).select().single();
      if(error) throw error; await audit(before?'UPDATE':'CREATE','shift_templates',p.id,before,data,p.reason);
      return json({success:true});
    }

    if(action==='delete_shift'){
      requiredReason(p);
      const before=await one('shift_templates',p.id);
      const {error}=await sb.from('shift_templates').delete().eq('id',p.id);
      if(error) throw error; await audit('DELETE','shift_templates',p.id,before,null,p.reason);
      return json({success:true});
    }

    if(action==='save_schedule'){
      requiredReason(p);
      const payload={employee_id:p.employee_id,work_date:p.work_date,schedule_status:p.schedule_status||'WORK',required_minutes:Number(p.required_minutes||480),shift_id:p.shift_id||null,note:p.note||null,source:'ADMIN_OVERRIDE'};
      if(p.id){
        const before=await one('employee_schedules',p.id);
        const {data,error}=await sb.from('employee_schedules').update(payload).eq('id',p.id).select().single();
        if(error) throw error; await audit('UPDATE','employee_schedules',p.id,before,data,p.reason);
      }else{
        const {data,error}=await sb.from('employee_schedules').upsert(payload,{onConflict:'employee_id,work_date'}).select().single();
        if(error) throw error; await audit('UPSERT','employee_schedules',data.id,null,data,p.reason);
      }
      return json({success:true});
    }


    if(action==='bulk_save_schedule_cells'){
      requiredReason(p);

      const cells = Array.isArray(p.cells) ? p.cells : [];
      if(!cells.length) throw new Error('ไม่มีช่องวันที่ที่เลือก');
      if(cells.length > 1500) throw new Error('เลือกได้ไม่เกิน 1,500 ช่องต่อครั้ง');

      const scheduleStatus = p.schedule_status || 'WORK';
      const rows = cells.map((c:any)=>({
        employee_id:c.employee_id,
        work_date:c.work_date,
        schedule_status:scheduleStatus,
        required_minutes:Number(p.required_minutes||480),
        shift_id:scheduleStatus==='WORK' ? (p.shift_id||null) : null,
        note:p.note||null,
        source:'ADMIN_OVERRIDE'
      }));

      const employeeIds=[...new Set(rows.map((r:any)=>r.employee_id))];
      const dates=rows.map((r:any)=>r.work_date).sort();
      const minDate=dates[0];
      const maxDate=dates[dates.length-1];

      const {data:beforeRows,error:beforeError}=await sb
        .from('employee_schedules')
        .select('*')
        .in('employee_id',employeeIds)
        .gte('work_date',minDate)
        .lte('work_date',maxDate);
      if(beforeError) throw beforeError;

      const selectedKeys=new Set(rows.map((r:any)=>`${r.employee_id}:${r.work_date}`));
      const relevantBefore=(beforeRows||[]).filter((r:any)=>selectedKeys.has(`${r.employee_id}:${r.work_date}`));

      const {data,error}=await sb
        .from('employee_schedules')
        .upsert(rows,{onConflict:'employee_id,work_date'})
        .select();
      if(error) throw error;

      await audit(
        'BULK_CELL_UPSERT',
        'employee_schedules',
        null,
        {previous_rows:relevantBefore},
        {
          affected_rows:(data||[]).length,
          schedule_status:scheduleStatus,
          shift_id:p.shift_id||null,
          required_minutes:Number(p.required_minutes||480),
          selected_cells:cells
        },
        p.reason
      );

      return json({success:true,affected:(data||[]).length});
    }

    if(action==='bulk_save_schedules'){
      requiredReason(p);

      const employeeIds = Array.isArray(p.employee_ids) ? p.employee_ids.filter(Boolean) : [];
      if(!employeeIds.length) throw new Error('กรุณาเลือกพนักงานอย่างน้อย 1 คน');
      if(!p.start_date || !p.end_date) throw new Error('กรุณาระบุวันที่เริ่มและวันที่สิ้นสุด');

      const start = new Date(`${p.start_date}T00:00:00+07:00`);
      const end = new Date(`${p.end_date}T00:00:00+07:00`);
      if(Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
      if(end < start) throw new Error('วันที่สิ้นสุดต้องไม่น้อยกว่าวันที่เริ่ม');
      const maxDays = 93;
      const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
      if(days > maxDays) throw new Error(`เลือกช่วงวันได้ไม่เกิน ${maxDays} วันต่อครั้ง`);

      const weekdays = Array.isArray(p.weekdays) && p.weekdays.length
        ? p.weekdays.map((x:any)=>Number(x))
        : [0,1,2,3,4,5,6];

      const rows:any[] = [];
      for(let d=new Date(start); d<=end; d=new Date(d.getTime()+86400000)){
        const weekday = d.getUTCDay();
        if(!weekdays.includes(weekday)) continue;
        const workDate = new Intl.DateTimeFormat('en-CA',{
          timeZone:'Asia/Bangkok',
          year:'numeric',month:'2-digit',day:'2-digit'
        }).format(d);

        for(const employeeId of employeeIds){
          rows.push({
            employee_id:employeeId,
            work_date:workDate,
            schedule_status:p.schedule_status||'WORK',
            required_minutes:Number(p.required_minutes||480),
            shift_id:(p.schedule_status||'WORK')==='WORK' ? (p.shift_id||null) : null,
            note:p.note||null
          });
        }
      }

      if(!rows.length) throw new Error('ไม่มีวันที่ตรงกับเงื่อนไขที่เลือก');

      const beforeMap:any = {};
      const employeeChunks = employeeIds;
      const {data:beforeRows,error:beforeError} = await sb
        .from('employee_schedules')
        .select('*')
        .in('employee_id', employeeChunks)
        .gte('work_date', p.start_date)
        .lte('work_date', p.end_date);
      if(beforeError) throw beforeError;
      for(const r of beforeRows||[]) beforeMap[`${r.employee_id}:${r.work_date}`]=r;

      const {data,error}=await sb
        .from('employee_schedules')
        .upsert(rows,{onConflict:'employee_id,work_date'})
        .select();
      if(error) throw error;

      await audit(
        'BULK_UPSERT',
        'employee_schedules',
        null,
        {
          range:{start_date:p.start_date,end_date:p.end_date},
          previous_count:(beforeRows||[]).length
        },
        {
          employee_ids:employeeIds,
          weekdays,
          schedule_status:p.schedule_status||'WORK',
          shift_id:p.shift_id||null,
          required_minutes:Number(p.required_minutes||480),
          affected_rows:(data||[]).length
        },
        p.reason
      );

      return json({success:true,affected:(data||[]).length});
    }

    if(action==='delete_schedule'){
      requiredReason(p);
      const before=await one('employee_schedules',p.id);
      const {error}=await sb.from('employee_schedules').delete().eq('id',p.id);
      if(error) throw error; await audit('DELETE','employee_schedules',p.id,before,null,p.reason);
      return json({success:true});
    }

    if(action==='save_attendance'){
      requiredReason(p);

      const employeeId=String(p.employee_id||'').trim();
      const eventType=String(p.event_type||'').trim();
      const date=String(p.date||'').trim();
      const time=String(p.time||'').trim();
      const officeId=String(p.office_id||'').trim()||null;

      if(!employeeId)return fail('กรุณาเลือกพนักงาน');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return fail('วันที่ไม่ถูกต้อง');
      if(!/^\d{2}:\d{2}$/.test(time))return fail('เวลาไม่ถูกต้อง');
      if(!['IN','OUT','BREAK_OUT','BREAK_IN','DAY_IN','DAY_OUT','BRANCH_IN','BRANCH_OUT','WORK_IN','WORK_OUT','REFILL_IN','REFILL_OUT'].includes(eventType)){
        return fail('ประเภท Event ไม่ถูกต้อง');
      }

      const occurred=new Date(`${date}T${time}:00+07:00`);
      if(Number.isNaN(occurred.getTime()))return fail('วันที่หรือเวลาไม่ถูกต้อง');
      const occurred_at=occurred.toISOString();

      const {data:employee,error:employeeError}=await sb.from('employees')
        .select('id,display_name,ba_mode')
        .eq('id',employeeId)
        .maybeSingle();
      if(employeeError)throw employeeError;
      if(!employee)return fail('ไม่พบพนักงาน');

      if(officeId){
        const {data:office,error:officeError}=await sb.from('offices')
          .select('id')
          .eq('id',officeId)
          .maybeSingle();
        if(officeError)throw officeError;
        if(!office)return fail('ไม่พบสาขา');
      }

      const payload={
        employee_id:employeeId,
        event_type:eventType,
        occurred_at,
        office_id:officeId,
        source:'ADMIN',
        created_by_line_user_id:'ADMIN_WEB',
        edited:true
      };

      let saved:any=null;

      if(p.id){
        const before=await one('attendance_events',p.id);
        const {data,error}=await sb.from('attendance_events')
          .update(payload)
          .eq('id',p.id)
          .select()
          .single();
        if(error)throw error;
        saved=data;
        await audit('UPDATE','attendance_events',p.id,before,data,p.reason);
      }else{
        const requestKey=`ADMIN-${crypto.randomUUID()}`;
        const {data,error}=await sb.rpc('insert_attendance_event_admin',{
          p_employee_id:employeeId,
          p_event_type:eventType,
          p_occurred_at:occurred_at,
          p_office_id:officeId,
          p_request_key:requestKey,
          p_reason:String(p.reason||'').trim()
        });

        if(error){
          if(String(error.message||'').includes('DUPLICATE_ATTENDANCE_EVENT')){
            return fail('มี Event ประเภทเดียวกันในช่วงเวลาใกล้เคียงอยู่แล้ว');
          }
          throw error;
        }

        saved=Array.isArray(data)?data[0]:data;
        // Creation and its audit are committed together by the privileged RPC.
      }

      const syncPayload={
        employee_id:employeeId,
        work_date:date,
        reason:String(p.reason||'').trim()
      };

      const {error:queueError}=await sb.from('sync_queue').insert({
        employee_id:employeeId,
        work_date:date,
        action:'RECALCULATE',
        payload:syncPayload,
        status:'PENDING'
      });

      // Older schemas may not have the same sync_queue columns.
      // Attendance must still be saved; the UI can refresh summaries later.
      if(queueError && !String(queueError.message||'').includes('column')){
        console.error('sync_queue insert failed',queueError);
      }

      return json({
        success:true,
        saved,
        message:'บันทึก Attendance แล้ว'
      });
    }

    if(action==='delete_attendance'){
      requiredReason(p);
      const before=await one('attendance_events',p.id);
      const {data,error}=await sb.from('attendance_events').update({deleted_at:now(),edited:true}).eq('id',p.id).select().single();
      if(error) throw error; await audit('DELETE','attendance_events',p.id,before,data,p.reason);
      return json({success:true});
    }

    if(action==='save_leave'){
      requiredReason(p);
      const payload={employee_id:p.employee_id,leave_date:p.leave_date,leave_type:p.leave_type,reason:p.leave_reason,status:p.status||'PENDING',reviewed_by:p.reviewed_by||null,reviewer_note:p.reviewer_note||null,reviewed_at:['APPROVED','REJECTED'].includes(p.status)?now():null};
      if(p.id){
        const before=await one('leave_requests',p.id);
        const {data,error}=await sb.from('leave_requests').update(payload).eq('id',p.id).select().single();
        if(error) throw error; await audit('UPDATE','leave_requests',p.id,before,data,p.reason);
      }else{
        const {data,error}=await sb.from('leave_requests').upsert(payload,{onConflict:'employee_id,leave_date'}).select().single();
        if(error) throw error; await audit('UPSERT','leave_requests',data.id,null,data,p.reason);
      }
      return json({success:true});
    }

    if(action==='delete_leave'){
      requiredReason(p);
      const before=await one('leave_requests',p.id);
      const {error}=await sb.from('leave_requests').delete().eq('id',p.id);
      if(error) throw error; await audit('DELETE','leave_requests',p.id,before,null,p.reason);
      return json({success:true});
    }

    
    if(action==='review_ba_registration'){
      requiredReason(p);
      const requestId=String(p.id||p.request_id||'').trim();
      const decision=String(p.decision||p.status||'').trim().toUpperCase();
      if(!requestId)return fail('ไม่พบคำขอลงทะเบียน');
      if(!['APPROVED','REJECTED'].includes(decision))return fail('สถานะไม่ถูกต้อง');

      const before=await one('ba_registration_requests',requestId);
      if(!before)return fail('ไม่พบคำขอลงทะเบียน');
      if(before.status!=='PENDING')return fail('คำขอนี้ถูกดำเนินการแล้ว');

      let employee:any=null;
      if(decision==='APPROVED'){
        const defaults=await defaultOfficeAndShift();
        const officeId=String(p.assigned_office_id||defaults.office_id||'').trim()||null;
        const shiftId=String(p.default_shift_id||defaults.shift_id||'').trim()||null;
        if(!officeId)return fail('กรุณาเลือกสาขาก่อนอนุมัติ');
        if(!shiftId)return fail('กรุณาเลือก Default Shift ก่อนอนุมัติ');

        const empPayload={
          employee_code:null,
          display_name:before.display_name||before.full_name||'',
          full_name:before.full_name||before.display_name||'',
          phone:before.phone||null,
          line_user_id:before.line_user_id||null,
          supervisor_id:p.supervisor_id||before.requested_supervisor_id||null,
          assigned_office_id:officeId,
          default_shift_id:shiftId,
          ba_mode:p.ba_mode||'FIXED_BRANCH',
          active:true,
          profile_completed:true
        };
        const {data:emp,error:empError}=await sb.from('employees').insert(empPayload).select().single();
        if(empError)throw empError;
        employee=emp;

        const {data:updated,error:updateError}=await sb.from('ba_registration_requests')
          .update({
            status:'APPROVED',
            reviewed_at:now(),
            reviewed_by_admin:true,
            approved_employee_id:employee.id,
            note:p.reason
          })
          .eq('id',requestId)
          .select()
          .single();
        if(updateError)throw updateError;
        await audit('APPROVE_BA_REGISTRATION','ba_registration_requests',requestId,before,{request:updated,employee},p.reason);
        return json({success:true,request:updated,employee});
      } else {
        const {data:updated,error:updateError}=await sb.from('ba_registration_requests')
          .update({
            status:'REJECTED',
            reviewed_at:now(),
            reviewed_by_admin:true,
            rejection_reason:p.reason,
            note:p.reason
          })
          .eq('id',requestId)
          .select()
          .single();
        if(updateError)throw updateError;
        await audit('REJECT_BA_REGISTRATION','ba_registration_requests',requestId,before,updated,p.reason);
        return json({success:true,request:updated});
      }
    }

    if(action==='list_ba_registrations'){
      const {data,error}=await sb.from('ba_registration_requests')
        .select('*')
        .order('created_at',{ascending:false})
        .limit(500);
      if(error)throw error;
      const rows=await attachSupervisorsToRegistrations(data||[]);
      return json({success:true,rows});
    }

    if(action==='send_line_report'){
      const type=p.type==='MIDDAY'?'MIDDAY':'ENDDAY';
      const date=p.date;
      const r=await fetch(`${SUPABASE_URL}/functions/v1/line-report`,{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Cron-Secret':CRON_SECRET},
        body:JSON.stringify({type,date})
      });
      const out=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(out.message||'ส่ง LINE Report ไม่สำเร็จ');
      await audit('SEND','line_report',`${date}:${type}`,null,out,p.reason||'ส่งจาก Admin');
      return json({success:true,result:out});
    }

    if(action==='recalculate_date'){
      const date=String(p.date||'').trim();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return fail('วันที่ไม่ถูกต้อง');
      const {data,error}=await sb.rpc('ba_recalculate_date',{p_work_date:date});
      if(error)throw error;
      return json({success:true,recalculated:Number(data||0),data:await listAll(),message:`คำนวณวันที่ ${date} ใหม่แล้ว`});
    }

    if(action==='recalculate_month'){
      const month=String(p.month||'').trim();
      if(!/^\d{4}-\d{2}$/.test(month))return fail('เดือนไม่ถูกต้อง');
      const {data,error}=await sb.rpc('ba_recalculate_month_range',{p_month:`${month}-01`});
      if(error)throw error;
      return json({success:true,recalculated:Number(data||0),data:await listAll(),message:`คำนวณเดือน ${month} ใหม่แล้ว`});
    }

    if(action==='refresh') return json({success:true,data:await listAll()});
    return fail('ไม่รู้จัก action');
  }catch(e){
    return fail((e as Error)?.message||String(e),500);
  }
});
