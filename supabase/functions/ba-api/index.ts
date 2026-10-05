import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LINE_LOGIN_CHANNEL_ID = Deno.env.get('LINE_LOGIN_CHANNEL_ID')!;
const ADMIN_API_KEY = Deno.env.get('ADMIN_API_KEY')!;
const EXTERNAL_SESSION_SECRET = Deno.env.get('EXTERNAL_SESSION_SECRET') || SERVICE_KEY;
const GOOGLE_SYNC_URL = Deno.env.get('GOOGLE_SYNC_URL') || '';
const GOOGLE_SYNC_SECRET = Deno.env.get('GOOGLE_SYNC_SECRET') || '';
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {auth:{persistSession:false}});
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-admin-key,x-external-token,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
const json = (body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8','X-BA-Version':'4.6.4'}});
const fail=(m:string,s=400)=>json({success:false,message:m},s);
const thaiDate=(d=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(d);
const thaiMonth=()=>thaiDate().slice(0,7);
const mins=(a:string,b:string)=>Math.max(0,Math.round((new Date(b).getTime()-new Date(a).getTime())/60000));
function distance(lat1:number,lon1:number,lat2:number,lon2:number){const R=6371000,p1=lat1*Math.PI/180,p2=lat2*Math.PI/180,dp=(lat2-lat1)*Math.PI/180,dl=(lon2-lon1)*Math.PI/180;const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))}
const DEFAULT_ATTENDANCE_GPS_ACCURACY_METERS=200;
const MAX_RADIUS_AWARE_GPS_ACCURACY_METERS=2500;

function allowedAccuracyForOffice(office:any){
  const radius=Number(office?.radius_meters||0);
  if(!Number.isFinite(radius)||radius<=0)return DEFAULT_ATTENDANCE_GPS_ACCURACY_METERS;
  return Math.min(
    MAX_RADIUS_AWARE_GPS_ACCURACY_METERS,
    Math.max(DEFAULT_ATTENDANCE_GPS_ACCURACY_METERS,radius)
  );
}

function cleanShiftReference(value:any){
  let text=String(value||'').trim();
  text=text.replace(/::[a-z_][a-z0-9_]*$/i,'').trim();
  text=text.replace(/^['"]+|['"]+$/g,'').trim();
  return text;
}


function base64UrlEncode(bytes:Uint8Array){
  let binary='';
  for(const b of bytes)binary+=String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64UrlDecode(value:string){
  const s=value.replace(/-/g,'+').replace(/_/g,'/');
  const padded=s+'='.repeat((4-s.length%4)%4);
  const binary=atob(padded);
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
async function hmacSign(value:string){
  const key=await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(EXTERNAL_SESSION_SECRET),
    {name:'HMAC',hash:'SHA-256'},
    false,
    ['sign','verify']
  );
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(sig));
}
function externalSessionExpiry(){
  const now=new Date();
  const bangkokNow=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));
  const expiryBangkok=new Date(
    bangkokNow.getFullYear(),
    bangkokNow.getMonth(),
    bangkokNow.getDate()+1,
    3,0,0,0
  );
  const offsetMs=7*60*60*1000;
  return Math.floor((expiryBangkok.getTime()-offsetMs)/1000);
}
async function createExternalToken(employee:any){
  const payload={
    employee_id:employee.id,
    line_user_id:employee.line_user_id,
    role:'EMPLOYEE',
    exp:externalSessionExpiry(),
    nonce:crypto.randomUUID()
  };
  const encoded=base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature=await hmacSign(encoded);
  return `${encoded}.${signature}`;
}
async function verifyExternalToken(token:string){
  const [encoded,signature]=String(token||'').split('.');
  if(!encoded||!signature)throw new Error('ลิงก์ลงเวลาไม่ถูกต้อง');
  const expected=await hmacSign(encoded);
  if(expected!==signature)throw new Error('ลิงก์ลงเวลาไม่ถูกต้อง');
  const payload=JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  if(payload.role!=='EMPLOYEE')throw new Error('ลิงก์นี้ใช้สำหรับ BA เท่านั้น');
  if(Number(payload.exp||0)<Math.floor(Date.now()/1000))throw new Error('ลิงก์ลงเวลาหมดอายุ กรุณาเปิดใหม่จาก LINE');
  return payload;
}

const LINE_VERIFY_URL='https://api.line.me/oauth2/v2.1/verify';
const LINE_VERIFY_MAX_ATTEMPTS=3;
const LINE_VERIFY_TIMEOUT_MS=8000;

function sleep(ms:number){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

async function verifyLineIdToken(token:string){
  const encodedBody=new URLSearchParams({
    id_token:token,
    client_id:LINE_LOGIN_CHANNEL_ID
  }).toString();

  let lastNetworkError:unknown=null;

  for(let attempt=1;attempt<=LINE_VERIFY_MAX_ATTEMPTS;attempt++){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),LINE_VERIFY_TIMEOUT_MS);

    try{
      const response=await fetch(LINE_VERIFY_URL,{
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:encodedBody,
        signal:controller.signal
      });

      // 400/401 หมายถึง Token ไม่ถูกต้องจริง ไม่ควร retry
      if(response.status===400||response.status===401){
        throw new Error('LINE_SESSION_INVALID');
      }

      // LINE rate limit หรือ server error ให้ลองใหม่
      if(response.status===429||response.status>=500){
        lastNetworkError=new Error(`LINE_VERIFY_HTTP_${response.status}`);
      }else if(!response.ok){
        throw new Error('LINE_SESSION_INVALID');
      }else{
        const profile=await response.json() as {sub?:string,name?:string,picture?:string};
        if(!profile?.sub)throw new Error('LINE_SESSION_INVALID');
        return profile as {sub:string,name?:string,picture?:string};
      }
    }catch(error){
      if((error as Error)?.message==='LINE_SESSION_INVALID')throw error;
      lastNetworkError=error;
    }finally{
      clearTimeout(timeout);
    }

    if(attempt<LINE_VERIFY_MAX_ATTEMPTS){
      await sleep(attempt===1?400:900);
    }
  }

  console.error('LINE ID token verification unavailable after retries',lastNetworkError);
  throw new Error('ไม่สามารถตรวจสอบบัญชี LINE ได้ชั่วคราว กรุณากดรีเฟรชแล้วลองใหม่');
}

async function lineUser(req:Request){
  const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/,'');
  if(!token)throw new Error('ไม่พบ LINE ID Token กรุณาปิดแล้วเปิดหน้าใน LINE ใหม่');

  try{
    return await verifyLineIdToken(token);
  }catch(error){
    if((error as Error)?.message==='LINE_SESSION_INVALID'){
      throw new Error('เซสชัน LINE หมดอายุหรือไม่ถูกต้อง กรุณาปิดแล้วเปิดหน้าใน LINE ใหม่');
    }
    throw error;
  }
}
async function identity(req:Request){
  const externalToken=req.headers.get('X-External-Token');
  if(externalToken){
    const payload=await verifyExternalToken(externalToken);
    const {data:e,error}=await sb.from('employees')
      .select('*,offices(*)')
      .eq('id',payload.employee_id)
      .eq('line_user_id',payload.line_user_id)
      .eq('active',true)
      .maybeSingle();
    if(error)throw error;
    if(!e)throw new Error('ไม่พบพนักงานสำหรับลิงก์นี้');
    return {role:'EMPLOYEE',ref:e,profile:{sub:e.line_user_id,name:e.display_name},auth_mode:'EXTERNAL'};
  }

  const p=await lineUser(req);
  const {data:s}=await sb.from('supervisors').select('*').eq('line_user_id',p.sub).eq('active',true).maybeSingle();
  if(s)return {role:'SUPERVISOR',ref:s,profile:p,auth_mode:'LINE'};
  const {data:e}=await sb.from('employees').select('*,offices(*)').eq('line_user_id',p.sub).eq('active',true).maybeSingle();
  if(e)return {role:'EMPLOYEE',ref:e,profile:p,auth_mode:'LINE'};

  const {data:pending,error:pendingError}=await sb.from('ba_registration_requests')
    .select('*')
    .eq('line_user_id',p.sub)
    .in('status',['PENDING','APPROVED'])
    .order('created_at',{ascending:false})
    .limit(1)
    .maybeSingle();
  if(pendingError)throw pendingError;
  if(pending)return {role:'UNREGISTERED',ref:pending,profile:p,auth_mode:'LINE'};

  return {role:'UNREGISTERED',ref:null,profile:p,auth_mode:'LINE'};
}
function ensureSupervisor(id:any){if(id.role!=='SUPERVISOR')throw new Error('ไม่มีสิทธิ์ Supervisor')}
function ensureEmployee(id:any){if(id.role!=='EMPLOYEE')throw new Error('ไม่มีสิทธิ์พนักงาน')}

async function attachEmployeesToOfficeLocationRequests(rows:any[]){
  const source=rows||[];
  const employeeIds=[...new Set(source.map((x:any)=>x.employee_id).filter(Boolean))];
  if(!employeeIds.length){
    return source.map((x:any)=>({...x,employees:null}));
  }

  const {data,error}=await sb.from('employees')
    .select('id,employee_code,display_name,phone')
    .in('id',employeeIds);
  if(error)throw error;

  const employeeMap=new Map((data||[]).map((x:any)=>[x.id,x]));
  return source.map((x:any)=>({
    ...x,
    employees:employeeMap.get(x.employee_id)||null
  }));
}
async function teamEmployee(supervisorId:string,employeeId:string){const {data}=await sb.from('employees').select('*,offices(*)').eq('id',employeeId).eq('supervisor_id',supervisorId).maybeSingle();if(!data)throw new Error('ไม่พบ BA ในทีมของคุณ');return data}
async function audit(actor:any,action:string,entityType:string,entityId:string,before:any,after:any,reason:string){
  if(!String(reason||'').trim())throw new Error('ต้องระบุเหตุผล');
  const {error}=await sb.from('audit_logs').insert({
    actor_line_user_id:actor.profile?.sub||null,
    actor_role:actor.role,
    actor_ref_id:actor.ref?.id||null,
    action,
    entity_type:entityType,
    entity_id:entityId,
    before_data:before,
    after_data:after,
    reason:String(reason).trim()
  });
  if(error)throw new Error(`บันทึก Audit Log ไม่สำเร็จ: ${error.message}`);
}
async function sync(date:string,employeeId?:string){if(!GOOGLE_SYNC_URL)return;try{await fetch(GOOGLE_SYNC_URL,{method:'POST',headers:{'Content-Type':'application/json','X-Sync-Secret':GOOGLE_SYNC_SECRET},body:JSON.stringify({action:'SYNC_DATE',date,employee_id:employeeId||null})})}catch(_){}}

async function allowed(emp:any,events:any[]){
  // v4.6.3 atomic attendance ordering
  // State ของปุ่มลงเวลาต้องอ้างอิง attendance_events จริงเท่านั้น
  // ห้ามใช้ daily_summaries.break_minutes หรือค่าพัก 60 นาทีที่ระบบปัดเพื่อการคำนวณ
  // Event จาก ADMIN และ LIFF มีผลต่อ state เหมือนกันทุกประการ

  const sorted=(events||[])
    .filter((x:any)=>x && x.event_type && !x.deleted_at)
    .sort((a:any,b:any)=>{
      const at=new Date(a.occurred_at||0).getTime();
      const bt=new Date(b.occurred_at||0).getTime();
      return at-bt || new Date(a.created_at||0).getTime()-new Date(b.created_at||0).getTime() || String(a.id||'').localeCompare(String(b.id||''));
    });

  const types=sorted.map((x:any)=>String(x.event_type||'').toUpperCase());
  const last=types.at(-1)||null;
  const completedBreak=types.includes('BREAK_OUT')&&types.includes('BREAK_IN');

  // กันข้อมูลพนักงานเก่าที่ ba_mode ว่าง/สะกดไม่ตรง:
  // หากไม่ใช่ MULTI_BRANCH หรือ STOCK_REFILL ให้ถือเป็น FIXED_BRANCH
  const rawMode=String(emp?.ba_mode||'FIXED_BRANCH').trim().toUpperCase();
  const mode=rawMode==='MULTI_BRANCH'
    ?'MULTI_BRANCH'
    :rawMode==='STOCK_REFILL'
      ?'STOCK_REFILL'
      :'FIXED_BRANCH';

  if(mode==='FIXED_BRANCH'){
    const sequence=['IN','BREAK_OUT','BREAK_IN','OUT'];
    // Invalid legacy/corrected histories require privileged correction, never a new IN.
    if(types.length>sequence.length||types.some((type,i)=>type!==sequence[i]))return [];
    return types.length<sequence.length?[sequence[types.length]]:[];
  }

  if(mode==='MULTI_BRANCH'){
    if(!last)return ['DAY_IN'];
    if(last==='DAY_IN')return ['BRANCH_IN'];

    if(last==='BRANCH_IN'){
      return completedBreak?['BRANCH_OUT']:['BREAK_OUT','BRANCH_OUT'];
    }

    if(last==='BREAK_OUT')return ['BREAK_IN'];
    if(last==='BREAK_IN')return ['BRANCH_OUT'];

    if(last==='BRANCH_OUT'){
      return completedBreak?['BRANCH_IN','DAY_OUT']:['BRANCH_IN'];
    }

    return [];
  }

  if(mode==='STOCK_REFILL'){
    // Preserve refill visits before/after work, but never restart an orphaned work history.
    let stage=0,refilling=false;
    for(const raw of types){
      const type=raw==='IN'?'WORK_IN':raw==='OUT'?'WORK_OUT':raw;
      if(type==='REFILL_IN'&&(stage===0||stage===4)&&!refilling){refilling=true;continue}
      if(type==='REFILL_OUT'&&refilling){refilling=false;continue}
      if(!refilling&&type===['WORK_IN','BREAK_OUT','BREAK_IN','WORK_OUT'][stage]){stage++;continue}
      return [];
    }
    const workStarted=types.includes('WORK_IN')||types.includes('IN');
    const workEnded=types.includes('WORK_OUT')||types.includes('OUT');
    const working=workStarted&&!workEnded;
    const normalizedLast=last==='IN'?'WORK_IN':last==='OUT'?'WORK_OUT':last;

    if(normalizedLast==='REFILL_IN')return ['REFILL_OUT'];

    if(working){
      if(normalizedLast==='BREAK_OUT')return ['BREAK_IN'];
      if(normalizedLast==='BREAK_IN')return ['WORK_OUT'];

      // ถ้าเข้างานแล้วแต่ยังไม่มีพักจริง ต้องออกพักก่อนออกงาน
      if((normalizedLast==='WORK_IN'||normalizedLast==='REFILL_OUT')&&!completedBreak){
        return ['BREAK_OUT'];
      }

      if(completedBreak)return ['WORK_OUT'];
      return [];
    }

    if(!workStarted)return ['REFILL_IN','WORK_IN'];
    if(workEnded)return ['REFILL_IN'];
    return [];
  }

  return [];
}
function dateCompare(a:string,b:string){return String(a).localeCompare(String(b))}
function monthBounds(month:string){
  const [y,m]=month.split('-').map(Number);
  const last=new Date(Date.UTC(y,m,0)).getUTCDate();
  const start=`${month}-01`;
  const end=`${month}-${String(last).padStart(2,'0')}`;
  const nextMonthDate=new Date(Date.UTC(y,m,1));
  const next=`${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth()+1).padStart(2,'0')}-01`;
  return {start,end,next,last};
}
function employeeActiveOn(emp:any,date:string){
  if(emp.start_date&&dateCompare(date,emp.start_date)<0)return false;
  if(emp.end_date&&dateCompare(date,emp.end_date)>0)return false;
  return emp.active!==false;
}
function normalizeShiftKey(v:any){
  return String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
}
function effectiveShiftId(employee:any,schedule:any=null){
  if(schedule?.schedule_status==='OFF')return null;
  if(schedule?.source && schedule.source!=='LEGACY' && schedule?.shift_id)return cleanShiftReference(schedule.shift_id);
  if(schedule?.source==='LEGACY' && schedule?.shift_id && String(schedule?.note||'').trim())return cleanShiftReference(schedule.shift_id);
  return cleanShiftReference(employee.default_shift_id || schedule?.shift_id || null) || null;
}
async function resolveShift(employee:any,date:string,schedule:any=null){
  if(schedule?.schedule_status==='OFF'){
    return {id:null,shift_id:null,shift_name:'หยุดงาน',start_time:null,end_time:null,required_minutes:0,break_minutes:0,grace_minutes:0};
  }
  const requestedId=effectiveShiftId(employee,schedule);
  if(!requestedId){
    return {id:null,shift_id:null,shift_name:'ยังไม่ได้ตั้ง Default Shift',start_time:null,end_time:null,required_minutes:Number(schedule?.required_minutes??480),break_minutes:60,grace_minutes:0};
  }

  const {data:shifts,error}=await sb.from('shift_templates').select('*').eq('active',true);
  if(error)throw error;

  const wanted=normalizeShiftKey(requestedId);
  const matched=(shifts||[]).find((s:any)=>{
    const keys=[
      normalizeShiftKey(s.id),
      normalizeShiftKey(s.shift_name),
      normalizeShiftKey(String(s.start_time||'').slice(0,5)),
      normalizeShiftKey(String(s.start_time||'').slice(0,2))
    ];
    if(keys.includes(wanted))return true;
    if(wanted==='FLEX9' || wanted==='FLEX09'){
      return keys.includes('FLEX9') || keys.includes('FLEX09') || String(s.start_time||'').startsWith('09:');
    }
    return false;
  });

  if(matched)return matched;

  return {
    id:requestedId,
    shift_id:requestedId,
    shift_name:`${requestedId} (ไม่พบใน Shift Templates)`,
    start_time:null,
    end_time:null,
    required_minutes:Number(schedule?.required_minutes??480),
    break_minutes:60,
    grace_minutes:0
  };
}
function shiftStartIso(date:string,time:string|null){return time?new Date(`${date}T${String(time).slice(0,8)}+07:00`).toISOString():null}
function firstWorkEvent(emp:any,events:any[]){
  const targets=emp.ba_mode==='MULTI_BRANCH'
    ?['DAY_IN']
    :emp.ba_mode==='STOCK_REFILL'
      ?['WORK_IN','IN']
      :['IN'];
  return events.find((x:any)=>targets.includes(x.event_type))?.occurred_at||null;
}
function scheduledSpanMinutes(startTime:any,endTime:any,fallback:any=480){
  if(!startTime||!endTime)return Number(fallback||480);
  const [sh,sm]=String(startTime).slice(0,5).split(':').map(Number);
  const [eh,em]=String(endTime).slice(0,5).split(':').map(Number);
  if([sh,sm,eh,em].some((x:any)=>!Number.isFinite(x)))return Number(fallback||480);
  let value=(eh*60+em)-(sh*60+sm);
  if(value<=0)value+=24*60;
  return value;
}
function roundedBreakMinutes(actual:number,hasCompletedBreak:boolean){
  if(!hasCompletedBreak)return 0;
  if(actual<=0)return 60;
  return actual<60?60:actual;
}

async function recalc(employeeId:string,date:string){
  const rpcResult=await sb.rpc('ba_recalculate_daily',{
    p_employee_id:employeeId,
    p_work_date:date
  });

  if(!rpcResult.error){
    const {data:summary,error:summaryError}=await sb.from('daily_summaries')
      .select('*')
      .eq('employee_id',employeeId)
      .eq('work_date',date)
      .maybeSingle();
    if(summaryError)throw summaryError;
    await sync(date,employeeId);
    return summary;
  }

  const rpcMessage=String(rpcResult.error?.message||'');
  const rpcMissing=rpcMessage.includes('ba_recalculate_daily')
    ||rpcMessage.includes('function')
    ||rpcMessage.includes('schema cache');

  if(!rpcMissing)throw rpcResult.error;

  const {start:monthStart,end:monthEnd,next:nextMonth}=monthBounds(date.slice(0,7));
  const dayStart=`${date}T00:00:00+07:00`;
  const nextDay=new Date(`${date}T00:00:00+07:00`);
  nextDay.setDate(nextDay.getDate()+1);
  const dayEnd=nextDay.toISOString();

  const [{data:emp,error:empError},{data:events,error:eventError},{data:leave,error:leaveError},{data:sched,error:schedError}]=await Promise.all([
    sb.from('employees').select('*').eq('id',employeeId).single(),
    sb.from('attendance_events').select('*,offices(office_name)').eq('employee_id',employeeId).is('deleted_at',null).gte('occurred_at',dayStart).lt('occurred_at',dayEnd).order('occurred_at'),
    sb.from('leave_requests').select('*').eq('employee_id',employeeId).eq('leave_date',date).eq('status','APPROVED').maybeSingle(),
    sb.from('employee_schedules').select('*').eq('employee_id',employeeId).eq('work_date',date).maybeSingle()
  ]);
  if(empError)throw empError;
  if(eventError)throw eventError;
  if(leaveError)throw leaveError;
  if(schedError)throw schedError;

  const shift=await resolveShift(emp,date,sched);
  const ev=events||[];
  const branches:string[]=[];
  for(const e of ev){
    if(e.offices?.office_name&&!branches.includes(e.offices.office_name))branches.push(e.offices.office_name);
  }

  const startTypes=emp.ba_mode==='MULTI_BRANCH'
    ?['DAY_IN']
    :emp.ba_mode==='STOCK_REFILL'
      ?['WORK_IN','IN']
      :['IN'];
  const endTypes=emp.ba_mode==='MULTI_BRANCH'
    ?['DAY_OUT']
    :emp.ba_mode==='STOCK_REFILL'
      ?['WORK_OUT','OUT']
      :['OUT'];

  const firstStart=ev.find((e:any)=>startTypes.includes(e.event_type))?.occurred_at||null;
  const endEvents=ev.filter((e:any)=>endTypes.includes(e.event_type));
  const lastEnd=endEvents.length?endEvents[endEvents.length-1].occurred_at:null;

  let breakMinutes=0;
  let breakOpen:string|null=null;
  let refillMinutes=0;
  let refillOpen:string|null=null;

  for(const e of ev){
    if(e.event_type==='BREAK_OUT'&&!breakOpen)breakOpen=e.occurred_at;
    if(e.event_type==='BREAK_IN'&&breakOpen){
      breakMinutes+=mins(breakOpen,e.occurred_at);
      breakOpen=null;
    }
    if(e.event_type==='REFILL_IN'&&!refillOpen)refillOpen=e.occurred_at;
    if(e.event_type==='REFILL_OUT'&&refillOpen){
      refillMinutes+=mins(refillOpen,e.occurred_at);
      refillOpen=null;
    }
  }

  const actualElapsedMinutes=(firstStart&&lastEnd)?mins(firstStart,lastEnd):0;
  const plannedStartIso=shiftStartIso(date,shift?.start_time||null);
  const effectiveWorkStart=(firstStart&&plannedStartIso&&new Date(firstStart)<new Date(plannedStartIso))
    ?plannedStartIso
    :firstStart;
  const elapsedWork=(effectiveWorkStart&&lastEnd)?mins(effectiveWorkStart,lastEnd):0;

  const completedBreakCount=ev.filter((e:any)=>e.event_type==='BREAK_IN').length;
  const hasCompletedBreak=completedBreakCount>0;
  const displayBreakMinutes=roundedBreakMinutes(breakMinutes,hasCompletedBreak);
  const requiredMinutes=(sched?.schedule_status==='OFF')
    ?0
    :scheduledSpanMinutes(shift?.start_time,shift?.end_time,shift?.required_minutes??sched?.required_minutes??480);

  // มาก่อนเวลาไม่นับเป็นชั่วโมงเกิน:
  // ใช้เวลาเริ่มกะเป็นจุดเริ่มคำนวณ หากพนักงานกดเข้าก่อนเวลา
  const workMinutes=elapsedWork;
  const creditedMinutes=elapsedWork;
  const excessBreak=Math.max(0,displayBreakMinutes-60);

  const today=thaiDate();
  let status='OFF';
  if(leave)status=leave.leave_type;
  else if(sched?.schedule_status==='OFF')status='OFF';
  else if(firstStart&&lastEnd)status='COMPLETED';
  else if(firstStart&&!lastEnd)status='WORKING';
  else if(dateCompare(date,today)>0)status='FUTURE';
  else if(date===today)status='NOT_STARTED';
  else status='ABSENT';

  const baseShort=(status==='COMPLETED')?Math.max(0,requiredMinutes-elapsedWork):0;
  const missingBreakPenalty=(status==='COMPLETED'&&!hasCompletedBreak)?60:0;
  const shortMinutes=(status==='COMPLETED')?baseShort+excessBreak+missingBreakPenalty:0;
  const overMinutes=(status==='COMPLETED')?Math.max(0,elapsedWork-requiredMinutes):0;
  const netMinutes=overMinutes-shortMinutes;

  const plannedStart=plannedStartIso;
  let lateMinutes=0;
  if(firstStart&&plannedStart){
    const raw=Math.max(0,mins(plannedStart,firstStart));
    lateMinutes=raw>Number(shift?.grace_minutes||0)?raw:0;
  }

  const issues:string[]=[];
  if(firstStart&&!lastEnd)issues.push('ลืมกดออกงาน');
  if(breakOpen)issues.push('ออกพักแต่ยังไม่กลับจากพัก');
  if(refillOpen)issues.push('เข้าเติมของแต่ยังไม่ออกจากเติมของ');
  if(status==='COMPLETED'&&!hasCompletedBreak)issues.push('ไม่พบการพักอย่างน้อย 1 รอบ');
  if(excessBreak>0)issues.push(`พักเกิน 1 ชั่วโมง ${excessBreak} นาที`);
  if(status==='ABSENT')issues.push('ขาดงาน');

  const row={
    employee_id:employeeId,
    work_date:date,
    status,
    first_in:firstStart,
    last_out:lastEnd,
    work_minutes:workMinutes,
    refill_minutes:refillMinutes,
    break_minutes:displayBreakMinutes,
    credited_minutes:creditedMinutes,
    required_minutes:requiredMinutes,
    short_minutes:shortMinutes,
    over_minutes:overMinutes,
    makeup_minutes:0,
    net_minutes:netMinutes,
    branch_names:branches,
    issue:issues.length?issues.join(', '):null,
    shift_id:shift?.id||shift?.shift_id||null,
    shift_start:shift?.start_time||null,
    shift_end:shift?.end_time||null,
    late_minutes:lateMinutes,
    calculated_at:new Date().toISOString()
  };

  const {error:dailyError}=await sb.from('daily_summaries').upsert(row,{onConflict:'employee_id,work_date'});
  if(dailyError)throw dailyError;

  const {data:days,error:daysError}=await sb.from('daily_summaries')
    .select('*')
    .eq('employee_id',employeeId)
    .gte('work_date',monthStart)
    .lt('work_date',nextMonth);
  if(daysError)throw daysError;

  const agg=(days||[]).reduce((a:any,x:any)=>{
    a.work_days+=['COMPLETED','WORKING'].includes(x.status)?1:0;
    a.off_days+=x.status==='OFF'?1:0;
    a.sick_leave_days+=x.status==='SICK_LEAVE'?1:0;
    a.business_leave_days+=x.status==='BUSINESS_LEAVE'?1:0;
    a.vacation_days+=x.status==='VACATION'?1:0;
    a.late_days+=Number(x.late_minutes||0)>0?1:0;
    a.late_minutes+=Number(x.late_minutes||0);
    for(const k of ['work_minutes','refill_minutes','short_minutes','over_minutes','makeup_minutes','net_minutes'])a[k]+=Number(x[k]||0);
    return a;
  },{
    employee_id:employeeId,month_start:monthStart,
    work_days:0,off_days:0,sick_leave_days:0,business_leave_days:0,vacation_days:0,
    late_days:0,late_minutes:0,work_minutes:0,refill_minutes:0,short_minutes:0,
    over_minutes:0,makeup_minutes:0,net_minutes:0,calculated_at:new Date().toISOString()
  });

  const {error:monthError}=await sb.from('monthly_summaries').upsert(agg,{onConflict:'employee_id,month_start'});
  if(monthError)throw monthError;

  await sync(date,employeeId);
  return row;
}

function fmtTimeTH(value:string|null|undefined){
  if(!value)return null;
  return new Date(value).toLocaleTimeString('en-GB',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit'});
}
function daysInMonth(month:string){
  const [y,m]=month.split('-').map(Number);
  return new Date(y,m,0).getDate();
}
function datesOfMonth(month:string){
  const total=daysInMonth(month);
  return Array.from({length:total},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);
}
function eventLabel(type:string){
  const map:any={IN:'เข้างาน',OUT:'ออกงาน',BREAK_OUT:'ออกพัก',BREAK_IN:'กลับจากพัก',DAY_IN:'เริ่มวัน',DAY_OUT:'จบวัน',BRANCH_IN:'เข้าสาขา',BRANCH_OUT:'ออกสาขา',WORK_IN:'เข้างาน',WORK_OUT:'ออกงาน',REFILL_IN:'เข้าเติมของ',REFILL_OUT:'ออกจากเติมของ'};
  return map[type]||type;
}
async function relevantEmployeeDates(employeeId:string,month:string){
  const {start,end,next}=monthBounds(month);
  const [{data:events},{data:schedules},{data:leaves},{data:summaries}]=await Promise.all([
    sb.from('attendance_events').select('occurred_at').eq('employee_id',employeeId).is('deleted_at',null).gte('occurred_at',`${start}T00:00:00+07:00`).lt('occurred_at',`${next}T00:00:00+07:00`),
    sb.from('employee_schedules').select('work_date').eq('employee_id',employeeId).gte('work_date',start).lte('work_date',end),
    sb.from('leave_requests').select('leave_date').eq('employee_id',employeeId).gte('leave_date',start).lte('leave_date',end),
    sb.from('daily_summaries').select('work_date').eq('employee_id',employeeId).gte('work_date',start).lte('work_date',end)
  ]);
  const set=new Set<string>();
  for(const x of events||[])set.add(thaiDate(new Date(x.occurred_at)));
  for(const x of schedules||[])set.add(x.work_date);
  for(const x of leaves||[])set.add(x.leave_date);
  for(const x of summaries||[])set.add(x.work_date);
  return [...set].sort();
}
async function recalcRelevantEmployeeMonth(employeeId:string,month:string){
  const dates=await relevantEmployeeDates(employeeId,month);
  for(const d of dates)await recalc(employeeId,d);
}
async function recalcTeamDate(supervisorId:string,date:string){
  const {data:team}=await sb.from('employees').select('id').eq('supervisor_id',supervisorId).eq('active',true);
  for(const e of team||[])await recalc(e.id,date);
}


function attendanceRequestCutoffIso(){
  const cutoff=new Date();
  cutoff.setDate(cutoff.getDate()-3);
  return cutoff.toISOString();
}
async function expireOldAttendanceCorrectionRequests(){
  const cutoff=attendanceRequestCutoffIso();
  const {data:expired,error}=await sb.from('attendance_correction_requests')
    .update({
      status:'REJECTED',
      reviewer_note:'หมดอายุอัตโนมัติ เนื่องจากคำขอเกิน 3 วัน',
      reviewed_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    })
    .eq('status','PENDING')
    .lt('created_at',cutoff)
    .select('id');
  if(error)throw error;
  return expired||[];
}

function canonicalAttendanceEventTypes(baMode:string,side:'IN'|'OUT'){
  if(baMode==='MULTI_BRANCH')return side==='IN'?['DAY_IN']:['DAY_OUT'];
  if(baMode==='STOCK_REFILL')return side==='IN'?['WORK_IN','IN']:['WORK_OUT','OUT'];
  return side==='IN'?['IN']:['OUT'];
}
function canonicalAttendanceEventType(baMode:string,side:'IN'|'OUT'){
  if(baMode==='MULTI_BRANCH')return side==='IN'?'DAY_IN':'DAY_OUT';
  if(baMode==='STOCK_REFILL')return side==='IN'?'WORK_IN':'WORK_OUT';
  return side==='IN'?'IN':'OUT';
}
function shiftBoundaryIso(workDate:string,startTime:any,endTime:any,side:'IN'|'OUT'){
  if(!startTime||!endTime)throw new Error('Shift ไม่มีเวลาเริ่มหรือเลิกงาน');
  const start=String(startTime).slice(0,5),end=String(endTime).slice(0,5);
  if(side==='IN')return new Date(`${workDate}T${start}:00+07:00`).toISOString();
  const d=new Date(`${workDate}T00:00:00+07:00`);
  const [sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number);
  if((eh*60+em)<=(sh*60+sm))d.setDate(d.getDate()+1);
  const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
  return new Date(`${y}-${m}-${day}T${end}:00+07:00`).toISOString();
}

async function handler(req:Request){if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return fail('Method not allowed',405);const body=await req.json().catch(()=>({}));const action=body.action,p=body.payload||{};const isAdmin=req.headers.get('X-Admin-Key')===ADMIN_API_KEY;
if(String(action).startsWith('admin_')){if(!isAdmin)return fail('Admin Key ไม่ถูกต้อง',401);if(action==='admin_bootstrap')return json({success:true});


if(action==='admin_review_attendance_correction_request'){
 const {data:r,error}=await sb.from('attendance_correction_requests').select('*,employees(*)').eq('id',p.request_id).single();if(error)throw error;
 let shift:any=null;
 if(p.status==='APPROVED'){
 const {data:sc,error:se}=await sb.from('employee_schedules').select('*').eq('employee_id',r.employee_id).eq('work_date',r.request_date).maybeSingle();if(se)throw se;
 shift=await resolveShift(r.employees,r.request_date,sc);
 if(!shift?.start_time||!shift?.end_time)return fail('ไม่พบกะทำงานของวันดังกล่าว');
 }
 const {data,error:reviewError}=await sb.rpc('ba_admin_review_attendance_correction',{p_request_id:r.id,p_status:p.status,p_reason:String(p.reviewer_note||'').trim(),p_shift_start:shift?.start_time||null,p_shift_end:shift?.end_time||null});
 if(reviewError)return fail(reviewError.message,409);
 return json({success:true,...data});
}

if(action==='admin_mobile_bootstrap'){
  const [{data:offices,error:officeError},{data:supervisors,error:supervisorError},{data:pending,error:pendingError},{data:employees,error:employeeError}]=await Promise.all([
    sb.from('offices').select('id,office_code,office_name,region,active').eq('active',true).order('office_name'),
    sb.from('supervisors').select('id,supervisor_code,supervisor_name,active,line_user_id').eq('active',true).order('supervisor_name'),
    sb.from('ba_registration_requests').select('*').eq('status','PENDING').order('created_at'),
    sb.from('employees').select('id,employee_code,display_name,full_name,phone,line_user_id,ba_mode,assigned_office_id,supervisor_id,active,offices(office_name),supervisors(supervisor_name)').order('employee_code')
  ]);
  if(officeError)throw officeError;if(supervisorError)throw supervisorError;if(pendingError)throw pendingError;if(employeeError)throw employeeError;
  return json({success:true,offices:offices||[],supervisors:supervisors||[],pending_registrations:pending||[],employees:employees||[]});
}

if(action==='admin_registration_requests'){
  const status=String(p.status||'PENDING');
  const {data,error}=await sb.from('ba_registration_requests')
    .select('*')
    .eq('status',status)
    .order('created_at');
  if(error)throw error;
  return json({success:true,rows:data||[]});
}

if(action==='admin_review_ba_registration'){
  const requestId=String(p.request_id||'');
  const decision=String(p.decision||'');
  const note=String(p.note||'').trim();
  if(!requestId)return fail('ไม่พบคำขอลงทะเบียน');
  if(!['APPROVED','REJECTED'].includes(decision))return fail('decision ไม่ถูกต้อง');
  if(!note)return fail('กรุณาระบุเหตุผล/หมายเหตุ');

  const {data:reqData,error:reqError}=await sb.from('ba_registration_requests')
    .select('*')
    .eq('id',requestId)
    .eq('status','PENDING')
    .maybeSingle();
  if(reqError)throw reqError;
  if(!reqData)return fail('ไม่พบคำขอ หรือคำขอนี้ถูกดำเนินการแล้ว');

  let employee:any=null;
  if(decision==='APPROVED'){
    const employeeCode=String(p.employee_code||reqData.employee_code||'').trim();
    const displayName=String(p.display_name||reqData.display_name||'').trim();
    const phone=String(p.phone||reqData.phone||'').trim();
    const baMode=String(p.ba_mode||'FIXED_BRANCH');
    const officeId=String(p.assigned_office_id||'');
    const supervisorId=String(p.supervisor_id||'');

    if(!displayName)return fail('กรุณาระบุชื่อพนักงาน');
    if(!phone)return fail('กรุณาระบุเบอร์โทร');
    if(!['FIXED_BRANCH','MULTI_BRANCH','STOCK_REFILL'].includes(baMode))return fail('ประเภท BA ไม่ถูกต้อง');
    if(!officeId)return fail('กรุณาเลือกสาขา');
    if(!supervisorId)return fail('กรุณาเลือก Supervisor');

    const patch={
      employee_code:employeeCode||null,
      display_name:displayName,
      full_name:String(p.full_name||reqData.full_name||displayName).trim()||displayName,
      phone,
      line_user_id:reqData.line_user_id,
      ba_mode:baMode,
      assigned_office_id:officeId,
      supervisor_id:supervisorId,
      active:true,
      profile_completed:true
    };

    const {data:existing,error:existingError}=await sb.from('employees')
      .select('*')
      .eq('line_user_id',reqData.line_user_id)
      .maybeSingle();
    if(existingError)throw existingError;

    if(existing){
      const {data,error}=await sb.from('employees').update(patch).eq('id',existing.id).select().single();
      if(error)throw error;
      employee=data;
      await sb.from('audit_logs').insert({actor_role:'ADMIN',action:'APPROVE_REGISTRATION_UPDATE_EMPLOYEE',entity_type:'employees',entity_id:existing.id,before_data:existing,after_data:data,reason:note});
    }else{
      const {data,error}=await sb.from('employees').insert({...patch,employee_code:null}).select().single();
      if(error)throw error;
      employee=data;
      await sb.from('audit_logs').insert({actor_role:'ADMIN',action:'APPROVE_REGISTRATION_CREATE_EMPLOYEE',entity_type:'employees',entity_id:data.id,before_data:reqData,after_data:data,reason:note});
    }
  }

  const {data:updated,error:updateError}=await sb.from('ba_registration_requests')
    .update({
      status:decision,
      reviewed_at:new Date().toISOString(),
      reviewed_note:note,
      approved_employee_id:employee?.id||null,
      updated_at:new Date().toISOString()
    })
    .eq('id',requestId)
    .select()
    .single();
  if(updateError)throw updateError;

  await sb.from('audit_logs').insert({actor_role:'ADMIN',action:`${decision}_BA_REGISTRATION`,entity_type:'ba_registration_requests',entity_id:requestId,before_data:reqData,after_data:updated,reason:note});

  return json({success:true,request:updated,employee});
}

if(action==='admin_mobile_update_employee'){
  if(!p.id)return fail('ไม่พบ Employee ID');
  const reason=String(p.reason||'Mobile Admin').trim();
  const {data:old,error:oldError}=await sb.from('employees').select('*').eq('id',p.id).single();
  if(oldError)throw oldError;
  const patch={
    employee_code:String(p.employee_code||old.employee_code||'').trim(),
    display_name:String(p.display_name||old.display_name||'').trim(),
    full_name:String(p.full_name||old.full_name||'').trim()||null,
    phone:String(p.phone||old.phone||'').trim()||null,
    line_user_id:String(p.line_user_id||old.line_user_id||'').trim()||null,
    ba_mode:String(p.ba_mode||old.ba_mode||'FIXED_BRANCH'),
    assigned_office_id:p.assigned_office_id||old.assigned_office_id||null,
    supervisor_id:p.supervisor_id||old.supervisor_id||null,
    active:p.active!==false,
    profile_completed:Boolean(p.display_name||old.display_name)
  };
  const {data,error}=await sb.from('employees').update(patch).eq('id',p.id).select().single();
  if(error)throw error;
  await sb.from('audit_logs').insert({actor_role:'ADMIN',action:'MOBILE_UPDATE_EMPLOYEE',entity_type:'employees',entity_id:p.id,before_data:old,after_data:data,reason});
  return json({success:true,employee:data});
}


if(action==='admin_export_daily'){
  const date=String(p.date||thaiDate());
  const {data,error}=await sb.from('daily_summaries')
    .select('*,employees(employee_code,display_name,full_name,supervisors(supervisor_name))')
    .eq('work_date',date)
    .order('employee_id');
  if(error)throw error;
  return json({success:true,date,rows:data||[]});
}

if(action==='admin_export_monthly'){
  const month=String(p.month||thaiMonth());
  const startDate=`${month}-01`;
  const lastDate=new Date(new Date(`${month}-01T00:00:00+07:00`).getFullYear(),new Date(`${month}-01T00:00:00+07:00`).getMonth()+1,0).toISOString().slice(0,10);
  const yesterdayDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(new Date(Date.now()-86400000));
  const endDate=yesterdayDate.startsWith(month)?yesterdayDate:lastDate;
  const {data,error}=await sb.from('daily_summaries')
    .select('*,employees(employee_code,display_name,full_name,supervisors(supervisor_name))')
    .gte('work_date',startDate)
    .lte('work_date',endDate)
    .order('work_date');
  if(error)throw error;
  return json({success:true,month,start_date:startDate,end_date:endDate,rows:data||[]});
}

if(action==='admin_list_employees'){const {data}=await sb.from('employees').select('id,employee_code,display_name,full_name,phone,line_user_id,ba_mode,assigned_office_id,supervisor_id,active,profile_completed,offices(office_name,region),supervisors(supervisor_name)').order('employee_code');return json({success:true,rows:data||[]})}if(action==='admin_list_offices'){const {data}=await sb.from('offices').select('*').order('office_code');return json({success:true,rows:data||[]})}if(action==='admin_list_supervisors'){const {data}=await sb.from('supervisors').select('*').order('supervisor_code');return json({success:true,rows:data||[]})}if(action==='admin_update_employee'){if(!p.id)return fail('ไม่พบ Employee ID');const {data:old}=await sb.from('employees').select('*').eq('id',p.id).single();const patch={display_name:p.display_name,full_name:p.full_name||null,phone:p.phone||null,line_user_id:p.line_user_id||null,ba_mode:p.ba_mode||null,assigned_office_id:p.assigned_office_id||null,supervisor_id:p.supervisor_id||null,active:p.active!==false,profile_completed:Boolean(p.display_name&&p.phone&&p.ba_mode&&p.assigned_office_id&&p.supervisor_id)};const {data,error}=await sb.from('employees').update(patch).eq('id',p.id).select().single();if(error)throw error;await sb.from('audit_logs').insert({actor_role:'ADMIN',action:'UPDATE',entity_type:'employees',entity_id:p.id,before_data:old,after_data:data,reason:p.reason||'Desktop Admin'});return json({success:true})}
if(action==='admin_update_office'){if(!p.id)return fail('ไม่พบ Office ID');const {data:old}=await sb.from('offices').select('*').eq('id',p.id).single();const patch={office_name:p.office_name,region:p.region,latitude:Number(p.latitude),longitude:Number(p.longitude),radius_meters:Number(p.radius_meters),active:p.active!==false};const {data,error}=await sb.from('offices').update(patch).eq('id',p.id).select().single();if(error)throw error;await sb.from('audit_logs').insert({actor_role:'ADMIN',action:'UPDATE',entity_type:'offices',entity_id:p.id,before_data:old,after_data:data,reason:p.reason||'Desktop Admin'});return json({success:true})}
if(action==='admin_update_supervisor'){if(!p.id)return fail('ไม่พบ Supervisor ID');const {data:old}=await sb.from('supervisors').select('*').eq('id',p.id).single();const patch={supervisor_name:p.supervisor_name,phone:p.phone||null,line_user_id:p.line_user_id||null,active:p.active!==false};const {data,error}=await sb.from('supervisors').update(patch).eq('id',p.id).select().single();if(error)throw error;await sb.from('audit_logs').insert({actor_role:'ADMIN',action:'UPDATE',entity_type:'supervisors',entity_id:p.id,before_data:old,after_data:data,reason:p.reason||'Desktop Admin'});return json({success:true})}
if(action==='admin_audit'){const {data}=await sb.from('audit_logs').select('*').order('created_at',{ascending:false}).limit(300);return json({success:true,rows:data||[]})}if(action==='admin_sync_now'){await sync(thaiDate());return json({success:true,message:'ส่งคำขอ Sync แล้ว'})}return fail('ไม่รู้จัก Admin action')}


if(action==='public_registration_options'){
  await lineUser(req);
  const {data:supervisors,error}=await sb.from('supervisors')
    .select('id,supervisor_code,supervisor_name')
    .eq('active',true)
    .order('supervisor_name');
  if(error)throw error;
  return json({success:true,supervisors:supervisors||[]});
}

if(action==='public_ba_registration_status'){
  const pLine=await lineUser(req);
  const {data:reqRow,error:reqError}=await sb.from('ba_registration_requests')
    .select('*')
    .eq('line_user_id',pLine.sub)
    .order('created_at',{ascending:false})
    .limit(1)
    .maybeSingle();
  if(reqError)throw reqError;
  const {data:emp,error:empError}=await sb.from('employees')
    .select('id,employee_code,display_name,active')
    .eq('line_user_id',pLine.sub)
    .maybeSingle();
  if(empError)throw empError;
  return json({success:true,profile:pLine,request:reqRow,employee:emp});
}

if(action==='public_submit_ba_registration'){
  const pLine=await lineUser(req);
  const displayName=String(p.display_name||pLine.name||'').trim();
  const fullName=String(p.full_name||displayName).trim();
  const phone=String(p.phone||'').trim();
  const note=String(p.note||'').trim();
  const requestedSupervisorId=String(p.supervisor_id||'').trim();

  if(!displayName)return fail('กรุณากรอกชื่อเล่น/ชื่อที่ใช้ในงาน');
  if(!phone)return fail('กรุณากรอกเบอร์โทร');
  if(!requestedSupervisorId)return fail('กรุณาเลือก Supervisor');

  const {data:existingEmp,error:empError}=await sb.from('employees')
    .select('id,employee_code,display_name,active')
    .eq('line_user_id',pLine.sub)
    .maybeSingle();
  if(empError)throw empError;
  if(existingEmp?.active)return json({success:true,already_employee:true,employee:existingEmp});

  const {data:existingReq,error:reqError}=await sb.from('ba_registration_requests')
    .select('*')
    .eq('line_user_id',pLine.sub)
    .in('status',['PENDING'])
    .maybeSingle();
  if(reqError)throw reqError;
  if(existingReq)return json({success:true,request:existingReq,already_pending:true});

  const {data,error}=await sb.from('ba_registration_requests').insert({
    line_user_id:pLine.sub,
    line_display_name:pLine.name||null,
    line_picture_url:(pLine as any).picture||null,
    employee_code:null,
    display_name:displayName,
    full_name:fullName||displayName,
    phone,
    note,
    requested_supervisor_id:requestedSupervisorId,
    status:'PENDING'
  }).select().single();
  if(error)throw error;
  return json({success:true,request:data});
}


const id=await identity(req);


if(action==='employee_office_location_requests'){
  ensureEmployee(id);
  const {data,error}=await sb.from('office_location_requests')
    .select('*')
    .eq('employee_id',id.ref.id)
    .order('created_at',{ascending:false})
    .limit(20);
  if(error)throw error;
  return json({success:true,rows:data||[]});
}

if(action==='employee_submit_office_location_request'){
  ensureEmployee(id);
  const officeName=String(p.office_name||'').trim();
  const region=String(p.region||'').trim();
  const note=String(p.note||'').trim();
  const latitude=Number(p.latitude);
  const longitude=Number(p.longitude);
  const accuracy=Number(p.accuracy||0);
  const radiusMeters=Math.max(50,Math.min(1000,Number(p.radius_meters||300)));

  if(!officeName)return fail('กรุณากรอกชื่อออฟฟิศ/สาขา');
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return fail('ไม่พบพิกัด Location');
  if(accuracy>500)return fail(`ความแม่นยำ Location ต่ำเกินไป (${Math.round(accuracy)} เมตร)`);
  if(!id.ref.supervisor_id)return fail('บัญชีนี้ยังไม่ได้ผูก Supervisor');

  const {data:existing,error:existingError}=await sb.from('office_location_requests')
    .select('*')
    .eq('employee_id',id.ref.id)
    .eq('status','PENDING')
    .maybeSingle();
  if(existingError)throw existingError;
  if(existing)return fail('คุณมีคำขอเพิ่มออฟฟิศที่รออนุมัติอยู่แล้ว');

  const payload={
    employee_id:id.ref.id,
    supervisor_id:id.ref.supervisor_id,
    requested_office_name:officeName,
    requested_region:region||null,
    latitude,
    longitude,
    accuracy_meters:accuracy||null,
    radius_meters:radiusMeters,
    employee_note:note||null,
    status:'PENDING'
  };
  const {data,error}=await sb.from('office_location_requests').insert(payload).select().single();
  if(error)throw error;
  await audit(id,'SUBMIT','office_location_requests',data.id,null,data,note||'ขอเพิ่มออฟฟิศใหม่');
  return json({success:true,request:data});
}

if(action==='supervisor_registration_requests'){
  ensureSupervisor(id);
  const {data,error}=await sb.from('ba_registration_requests')
    .select('*')
    .eq('requested_supervisor_id',id.ref.id)
    .eq('status','PENDING')
    .order('created_at');
  if(error)throw error;
  return json({success:true,rows:data||[]});
}

if(action==='supervisor_review_ba_registration'){
  ensureSupervisor(id);
  const requestId=String(p.request_id||'');
  const decision=String(p.decision||'');
  const note=String(p.note||'').trim();
  if(!requestId)return fail('ไม่พบคำขอลงทะเบียน');
  if(!['APPROVED','REJECTED'].includes(decision))return fail('สถานะไม่ถูกต้อง');
  if(!note)return fail('กรุณาระบุเหตุผล/หมายเหตุ');

  const {data:reqData,error:reqError}=await sb.from('ba_registration_requests')
    .select('*')
    .eq('id',requestId)
    .eq('requested_supervisor_id',id.ref.id)
    .eq('status','PENDING')
    .maybeSingle();
  if(reqError)throw reqError;
  if(!reqData)return fail('ไม่พบคำขอ หรือไม่มีสิทธิ์อนุมัติ');

  let employee:any=null;
  if(decision==='APPROVED'){
    const officeId=String(p.assigned_office_id||'');
    const baMode=String(p.ba_mode||'FIXED_BRANCH');
    if(!officeId)return fail('กรุณาเลือกออฟฟิศ');
    if(!['FIXED_BRANCH','MULTI_BRANCH','STOCK_REFILL'].includes(baMode))return fail('ประเภท BA ไม่ถูกต้อง');

    const patch={
      display_name:String(reqData.display_name||'').trim(),
      full_name:String(reqData.full_name||reqData.display_name||'').trim()||null,
      phone:String(reqData.phone||'').trim(),
      line_user_id:reqData.line_user_id,
      ba_mode:baMode,
      assigned_office_id:officeId,
      supervisor_id:id.ref.id,
      active:true,
      profile_completed:true
    };

    const {data:existing,error:existingError}=await sb.from('employees')
      .select('*')
      .eq('line_user_id',reqData.line_user_id)
      .maybeSingle();
    if(existingError)throw existingError;

    if(existing){
      const {data,error}=await sb.from('employees').update(patch).eq('id',existing.id).select().single();
      if(error)throw error;
      employee=data;
      await audit(id,'APPROVE_REGISTRATION_UPDATE','employees',existing.id,existing,data,note);
    }else{
      const {data,error}=await sb.from('employees').insert(patch).select().single();
      if(error)throw error;
      employee=data;
      await audit(id,'APPROVE_REGISTRATION_CREATE','employees',data.id,reqData,data,note);
    }
  }

  const {data:updated,error:updateError}=await sb.from('ba_registration_requests')
    .update({
      status:decision,
      reviewed_at:new Date().toISOString(),
      reviewed_note:note,
      reviewed_by_supervisor_id:id.ref.id,
      approved_employee_id:employee?.id||null,
      updated_at:new Date().toISOString()
    })
    .eq('id',requestId)
    .select()
    .single();
  if(updateError)throw updateError;
  await audit(id,decision==='APPROVED'?'APPROVE':'REJECT','ba_registration_requests',requestId,reqData,updated,note);
  return json({success:true,request:updated,employee});
}


if(action==='supervisor_office_location_requests'){
  ensureSupervisor(id);
  const {data,error}=await sb.from('office_location_requests')
    .select('*')
    .eq('supervisor_id',id.ref.id)
    .eq('status','PENDING')
    .order('created_at');
  if(error)throw error;
  const rows=await attachEmployeesToOfficeLocationRequests(data||[]);
  return json({success:true,rows});
}

if(action==='supervisor_review_office_location_request'){
  ensureSupervisor(id);
  const requestId=String(p.request_id||'');
  const decision=String(p.decision||'');
  const reviewerNote=String(p.reviewer_note||'').trim();
  if(!requestId)return fail('ไม่พบคำขอ Location');
  if(!['APPROVED','REJECTED'].includes(decision))return fail('สถานะไม่ถูกต้อง');
  if(!reviewerNote)return fail('กรุณาระบุเหตุผล/หมายเหตุ');

  const {data:reqData,error:reqError}=await sb.from('office_location_requests')
    .select('*')
    .eq('id',requestId)
    .eq('supervisor_id',id.ref.id)
    .eq('status','PENDING')
    .maybeSingle();
  if(reqError)throw reqError;
  if(!reqData)return fail('ไม่พบคำขอ หรือไม่มีสิทธิ์อนุมัติ');

  let office:any=null;
  if(decision==='APPROVED'){
    const officeCode=String(p.office_code||'').trim();
    const officeName=String(p.office_name||reqData.requested_office_name||'').trim();
    const region=String(p.region||reqData.requested_region||'').trim();
    const radiusMeters=Math.max(50,Math.min(1000,Number(p.radius_meters||reqData.radius_meters||300)));
    if(!officeCode)return fail('กรุณากรอกรหัสออฟฟิศ');
    if(!officeName)return fail('กรุณากรอกชื่อออฟฟิศ');

    const officePayload={
      office_code:officeCode,
      office_name:officeName,
      region:region||null,
      latitude:Number(reqData.latitude),
      longitude:Number(reqData.longitude),
      radius_meters:radiusMeters,
      active:true,
      created_by_supervisor_id:id.ref.id
    };
    const {data,error}=await sb.from('offices').insert(officePayload).select().single();
    if(error)throw error;
    office=data;
    await audit(id,'APPROVE_CREATE_OFFICE','offices',data.id,reqData,data,reviewerNote);
  }

  const {data:updated,error:updateError}=await sb.from('office_location_requests')
    .update({
      status:decision,
      reviewed_at:new Date().toISOString(),
      reviewed_by_supervisor_id:id.ref.id,
      reviewer_note:reviewerNote,
      approved_office_id:office?.id||null,
      updated_at:new Date().toISOString()
    })
    .eq('id',requestId)
    .select()
    .single();
  if(updateError)throw updateError;
  await audit(id,decision==='APPROVED'?'APPROVE':'REJECT','office_location_requests',requestId,reqData,updated,reviewerNote);
  return json({success:true,request:updated,office});
}

if(action==='supervisor_inactive_employee'){
  ensureSupervisor(id);
  const employeeId=String(p.employee_id||'');
  const reason=String(p.reason||'').trim();
  if(!reason)return fail('กรุณาระบุเหตุผล');
  const employee=await teamEmployee(id.ref.id,employeeId);
  const {data,error}=await sb.from('employees')
    .update({active:false})
    .eq('id',employeeId)
    .select()
    .single();
  if(error)throw error;
  await audit(id,'INACTIVE','employees',employeeId,employee,data,reason);
  return json({success:true,employee:data});
}

if(action==='supervisor_offices'){
  ensureSupervisor(id);
  const {data,error}=await sb.from('offices')
    .select('*')
    .order('active',{ascending:false})
    .order('office_name');
  if(error)throw error;
  return json({success:true,rows:data||[]});
}

if(action==='supervisor_add_office'){
  ensureSupervisor(id);
  const officeName=String(p.office_name||'').trim();
  const officeCode=String(p.office_code||'').trim();
  const region=String(p.region||'').trim();
  const reason=String(p.reason||'').trim();
  if(!officeName||!officeCode)return fail('กรุณากรอกรหัสและชื่อออฟฟิศ');
  if(!reason)return fail('กรุณาระบุเหตุผล');
  const row={
    office_name:officeName,
    office_code:officeCode,
    region:region||null,
    latitude:Number(p.latitude||0),
    longitude:Number(p.longitude||0),
    radius_meters:Number(p.radius_meters||300),
    active:true,
    created_by_supervisor_id:id.ref.id
  };
  const {data,error}=await sb.from('offices').insert(row).select().single();
  if(error)throw error;
  await audit(id,'CREATE','offices',data.id,null,data,reason);
  return json({success:true,office:data});
}

if(action==='supervisor_inactive_office'){
  ensureSupervisor(id);
  const officeId=String(p.office_id||'');
  const reason=String(p.reason||'').trim();
  if(!reason)return fail('กรุณาระบุเหตุผล');
  const {data:old,error:oldError}=await sb.from('offices').select('*').eq('id',officeId).single();
  if(oldError)throw oldError;
  const {data,error}=await sb.from('offices').update({active:false}).eq('id',officeId).select().single();
  if(error)throw error;
  await audit(id,'INACTIVE','offices',officeId,old,data,reason);
  return json({success:true,office:data});
}

if(action==='supervisor_monthly_to_yesterday'){
  ensureSupervisor(id);
  const month=String(p.month||thaiMonth());
  const startDate=`${month}-01`;
  const yesterdayDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok'}).format(new Date(Date.now()-86400000));
  const endDate=yesterdayDate.startsWith(month)?yesterdayDate:new Date(`${month}-01T00:00:00+07:00`).toISOString().slice(0,7)===month
    ? new Date(new Date(`${month}-01T00:00:00+07:00`).getFullYear(),new Date(`${month}-01T00:00:00+07:00`).getMonth()+1,0).toISOString().slice(0,10)
    : yesterdayDate;

  const {data:team,error:teamError}=await sb.from('employees')
    .select('id,employee_code,display_name')
    .eq('supervisor_id',id.ref.id)
    .eq('active',true)
    .order('employee_code');
  if(teamError)throw teamError;
  const ids=(team||[]).map((x:any)=>x.id);
  if(!ids.length)return json({success:true,month,start_date:startDate,end_date:endDate,rows:[]});

  const {data:summaries,error:summaryError}=await sb.from('daily_summaries')
    .select('*')
    .in('employee_id',ids)
    .gte('work_date',startDate)
    .lte('work_date',endDate);
  if(summaryError)throw summaryError;

  const byEmp=new Map<string,any[]>();
  for(const s of summaries||[]){
    if(!byEmp.has(s.employee_id))byEmp.set(s.employee_id,[]);
    byEmp.get(s.employee_id)!.push(s);
  }

  const rows=(team||[]).map((e:any)=>{
    const arr=byEmp.get(e.id)||[];
    return {
      employee_id:e.id,
      employee_code:e.employee_code,
      display_name:e.display_name,
      work_days:arr.filter((x:any)=>['COMPLETED','WORKING'].includes(String(x.status))).length,
      absent_days:arr.filter((x:any)=>String(x.status)==='ABSENT').length,
      leave_days:arr.filter((x:any)=>String(x.status).includes('LEAVE')).length,
      late_days:arr.filter((x:any)=>Number(x.late_minutes||0)>0).length,
      late_minutes:arr.reduce((n:number,x:any)=>n+Number(x.late_minutes||0),0),
      short_minutes:arr.reduce((n:number,x:any)=>n+Number(x.short_minutes||0),0),
      over_minutes:arr.reduce((n:number,x:any)=>n+Number(x.over_minutes||0),0),
      refill_minutes:arr.reduce((n:number,x:any)=>n+Number(x.refill_minutes||0),0),
      forgot_checkout_days:arr.filter((x:any)=>String(x.issue||'').includes('ลืมกดออกงาน')).length
    };
  });
  return json({success:true,month,start_date:startDate,end_date:endDate,rows});
}


if(id.auth_mode==='EXTERNAL'&&!['bootstrap','employee_home','submit_attendance','gps_request_setup','submit_gps_request'].includes(String(action))){
  return fail('ลิงก์ภายนอกใช้ได้เฉพาะการลงเวลา',403);
}
if(action==='create_external_session'){
  if(id.auth_mode!=='LINE'||id.role!=='EMPLOYEE')return fail('ต้องเปิดจาก LIFF ของ BA',403);
  const token=await createExternalToken(id.ref);
  const exp=externalSessionExpiry();
  return json({
    success:true,
    token,
    expires_at:new Date(exp*1000).toISOString(),
    expires_in_seconds:Math.max(0,exp-Math.floor(Date.now()/1000))
  });
}
if(action==='bootstrap')return json({
  success:true,
  profile:{
    role:id.role,
    name:id.ref?.display_name||id.ref?.supervisor_name||id.profile?.name||'ผู้ใช้งานใหม่',
    line_user_id:id.profile?.sub||null,
    auth_mode:id.auth_mode
  }
});
if(id.role==='EMPLOYEE'){
 if(action==='employee_home'){
  const date=thaiDate();
  await recalc(id.ref.id,date);
  const [{data:events,error:eventError},{data:sched},{data:summary}]=await Promise.all([
    sb.from('attendance_events').select('*,offices(*)').eq('employee_id',id.ref.id).is('deleted_at',null).gte('occurred_at',`${date}T00:00:00+07:00`).lt('occurred_at',new Date(new Date(`${date}T00:00:00+07:00`).getTime()+86400000).toISOString()).order('occurred_at').order('created_at').order('id'),
    sb.from('employee_schedules').select('*').eq('employee_id',id.ref.id).eq('work_date',date).maybeSingle(),
    sb.from('daily_summaries').select('*').eq('employee_id',id.ref.id).eq('work_date',date).maybeSingle()
  ]);
  if(eventError)throw eventError;
  const shift=await resolveShift(id.ref,date,sched);
  const acts=await allowed(id.ref,events||[]);
  const last=(events||[]).at(-1);

  const firstStartedAt=firstWorkEvent(id.ref,events||[]);
  const endTypes=id.ref.ba_mode==='MULTI_BRANCH'
    ?['DAY_OUT']
    :id.ref.ba_mode==='STOCK_REFILL'
      ?['WORK_OUT','OUT']
      :['OUT'];
  const lastEndedAt=[...(events||[])].reverse().find((e:any)=>endTypes.includes(e.event_type))?.occurred_at||null;
  const liveWorkMinutes=firstStartedAt&&!lastEndedAt
    ?mins(firstStartedAt,new Date().toISOString())
    :Number(summary?.credited_minutes||0);
  const currentBreakMinutes=last?.event_type==='BREAK_OUT'
    ?mins(last.occurred_at,new Date().toISOString())
    :0;

  const timeline=(events||[]).map((e:any)=>({
    type:e.event_type,
    label:eventLabel(e.event_type),
    time:fmtTimeTH(e.occurred_at),
    office_name:e.offices?.office_name||null,
    latitude:e.latitude??null,
    longitude:e.longitude??null
  }));
  return json({
    success:true,
    state:{label:last?.event_type||'ยังไม่เริ่มงาน',office_name:last?.offices?.office_name},
    shift:{
      id:shift?.id||null,
      name:shift?.shift_name||'ไม่กำหนด',
      start_time:shift?.start_time||null,
      end_time:shift?.end_time||null,
      schedule_status:sched?.schedule_status||'WORK',
      late_minutes:Number(summary?.late_minutes||0)
    },
    summary:{
      first_in:fmtTimeTH(summary?.first_in),
      last_out:fmtTimeTH(summary?.last_out),
      credited_minutes:Number(summary?.credited_minutes||0),
      break_minutes:Number(summary?.break_minutes||0),
      refill_minutes:Number(summary?.refill_minutes||0),
      short_minutes:Number(summary?.short_minutes||0),
      over_minutes:Number(summary?.over_minutes||0),
      late_minutes:0,
      net_minutes:Number(summary?.net_minutes||0),
      live_work_minutes:liveWorkMinutes,
      current_break_minutes:currentBreakMinutes,
      is_working:Boolean(firstStartedAt&&!lastEndedAt),
      is_on_break:last?.event_type==='BREAK_OUT'
    },
    timeline,
    attendance_issue:(events?.length&&!acts.length&&
      (String(id.ref.ba_mode||'FIXED_BRANCH')==='STOCK_REFILL'||
       (String(id.ref.ba_mode||'FIXED_BRANCH')!=='MULTI_BRANCH'&&
        (events.length!==4||events.some((e:any,i:number)=>e.event_type!==['IN','BREAK_OUT','BREAK_IN','OUT'][i])))))
      ?'ประวัติลงเวลาวันนี้ไม่ครบหรือผิดลำดับ กรุณาติดต่อหัวหน้างานเพื่อตรวจสอบก่อนลงเวลาต่อ':null,
    allowed_actions:acts
  });
}
 if(action==='submit_attendance'){
  const eventType=String(p.type||'');
  const requestKey=String(p.request_key||'').trim();
  if(!requestKey||requestKey.length>200)return fail('INVALID_REQUEST_KEY');
  const mode=['MULTI_BRANCH','STOCK_REFILL'].includes(String(id.ref.ba_mode||'').trim().toUpperCase())?String(id.ref.ba_mode).trim().toUpperCase():'FIXED_BRANCH';
  const source=id.auth_mode==='EXTERNAL'?'EXTERNAL_WEB':'LIFF';
  // Replay before state/GPS validation: the first request may already have committed.
  const {data:replay,error:replayError}=await sb.from('attendance_events').select('*').eq('request_key',requestKey).maybeSingle();
  if(replayError)throw replayError;
  if(replay){
    if(replay.employee_id!==id.ref.id||replay.event_type!==eventType||replay.created_by_line_user_id!==id.profile.sub||replay.source!==source||replay.deleted_at)return fail('IDEMPOTENCY_CONFLICT',409);
    return json({success:true,event_id:replay.id,replayed:true});
  }
  const latitude=Number(p.latitude);
  const longitude=Number(p.longitude);
  const accuracy=Number(p.accuracy||0);

  if(!eventType||!Number.isFinite(latitude)||!Number.isFinite(longitude)){
    return fail('ข้อมูล GPS ไม่ครบ');
  }
  const date=thaiDate();
  const nextDay=new Date(`${date}T00:00:00+07:00`);
  nextDay.setDate(nextDay.getDate()+1);

  const [{data:events,error:eventError},{data:offices,error:officeError}]=await Promise.all([
    sb.from('attendance_events')
      .select('*')
      .eq('employee_id',id.ref.id)
      .is('deleted_at',null)
      .gte('occurred_at',`${date}T00:00:00+07:00`)
      .lt('occurred_at',nextDay.toISOString())
      .order('occurred_at'),
    sb.from('offices').select('*').eq('active',true)
  ]);
  if(eventError)throw eventError;
  if(officeError)throw officeError;

  const validOffices=(offices||[]).filter((o:any)=>
    Number.isFinite(Number(o.latitude))&&
    Number.isFinite(Number(o.longitude))&&
    Number(o.radius_meters)>0
  );
  if(!validOffices.length)return fail('ยังไม่มีพิกัดสาขาที่ใช้งานได้ในระบบ');

  const workOfficeEvent=(events||[]).find((e:any)=>
    mode==='MULTI_BRANCH'
      ? e.event_type==='BRANCH_IN'
      : mode==='STOCK_REFILL'
        ? ['WORK_IN','IN'].includes(e.event_type)
        : e.event_type==='IN'
  );

  let targetOffice:any=null;

  // เมื่อเข้างานที่สาขาแล้ว การพัก/กลับจากพัก/ออกงาน
  // ต้องตรวจ GPS กับสาขาเดิม ไม่ใช่เลือกสาขาที่ใกล้ที่สุดใหม่
  const mustUseOriginalOffice=
    (mode==='FIXED_BRANCH'&&['BREAK_OUT','BREAK_IN','OUT'].includes(eventType))||
    (mode==='STOCK_REFILL'&&['BREAK_OUT','BREAK_IN','WORK_OUT','OUT'].includes(eventType));

  if(mustUseOriginalOffice&&workOfficeEvent?.office_id){
    targetOffice=validOffices.find((o:any)=>o.id===workOfficeEvent.office_id)||null;
  }

  if(!targetOffice){
    let nearest:any=null;
    for(const office of validOffices){
      const metres=distance(latitude,longitude,Number(office.latitude),Number(office.longitude));
      if(!nearest||metres<nearest.distance){
        nearest={office,distance:metres};
      }
    }
    targetOffice=nearest?.office||null;
  }

  if(!targetOffice)return fail('ไม่พบสาขาที่ใช้ตรวจ Location');

  const maxAllowedAccuracy=allowedAccuracyForOffice(targetOffice);
  if(!Number.isFinite(accuracy)||accuracy<=0||accuracy>maxAllowedAccuracy){
    return json({success:false,code:'GPS_ACCURACY',office_id:targetOffice.id,message:
      `ความแม่นยำ GPS ยังต่ำเกินไป (${Math.round(accuracy||0)} เมตร) `+
      `สำหรับสาขา ${targetOffice.office_name||'-'} `+
      `(รัศมีสาขา ${Math.round(Number(targetOffice.radius_meters||0))} เมตร, `+
      `ระบบยอมรับได้ไม่เกิน ${Math.round(maxAllowedAccuracy)} เมตร)`},422);
  }

  const targetDistance=distance(
    latitude,
    longitude,
    Number(targetOffice.latitude),
    Number(targetOffice.longitude)
  );
  const allowedRadius=Number(targetOffice.radius_meters||0);

  if(targetDistance>allowedRadius){
    return json({success:false,code:'GPS_OUTSIDE',office_id:targetOffice.id,message:
      `Location ไม่ตรงกับสาขา ${targetOffice.office_name||'-'} `+
      `(ห่าง ${Math.round(targetDistance)} เมตร, ความแม่นยำ ${Math.round(accuracy)} เมตร)`},422);
  }

  let officeId=targetOffice.id;

  if(mode==='FIXED_BRANCH'){
    if(eventType==='IN'&&workOfficeEvent&&workOfficeEvent.office_id!==officeId){
      return fail('FIXED_BRANCH ทำงานได้วันละ 1 สาขา');
    }
    if(['BREAK_OUT','BREAK_IN','OUT'].includes(eventType)&&workOfficeEvent?.office_id){
      officeId=workOfficeEvent.office_id;
    }
  }

  if(mode==='STOCK_REFILL'){
    if(['BREAK_OUT','BREAK_IN','WORK_OUT','OUT'].includes(eventType)&&workOfficeEvent?.office_id){
      officeId=workOfficeEvent.office_id;
    }
  }

  const {data:inserted,error:insertError}=await sb.rpc('insert_attendance_event_guarded',{
    p_employee_id:id.ref.id,
    p_event_type:eventType,
    p_occurred_at:new Date().toISOString(),
    p_office_id:officeId,
    p_latitude:latitude,
    p_longitude:longitude,
    p_accuracy:accuracy,
    p_distance:targetDistance,
    p_source:source,
    p_created_by:id.profile.sub,
    p_request_key:requestKey
  });

  if(insertError){
    if(String(insertError.message||'').includes('DUPLICATE_ATTENDANCE_EVENT'))return fail('ระบบได้รับรายการนี้แล้ว กรุณาอย่ากดซ้ำ');
    if(/INVALID_TRANSITION|IDEMPOTENCY_CONFLICT|INVALID_ATTENDANCE_DAY/.test(insertError.message||''))return fail(insertError.message,409);
    throw insertError;
  }

  // The database trigger recalculates within the insert transaction. A response must
  // not turn a committed event into a retryable failure during a second recalculation.
  return json({success:true,event_id:inserted?.id});
}
 if(action==='my_history'){
  const month=p.month||thaiMonth();
  const {start,next}=monthBounds(month);
  const {data,error}=await sb.from('daily_summaries').select('*')
    .eq('employee_id',id.ref.id).gte('work_date',start).lt('work_date',next)
    .lte('work_date',thaiDate()).order('work_date',{ascending:false});
  if(error)throw error;
  return json({success:true,rows:data||[]});
}

 if(action==='submit_leave'){
  if(!p.leave_date||!String(p.reason||'').trim()||!['SICK_LEAVE','BUSINESS_LEAVE','VACATION'].includes(p.leave_type))return fail('กรอกข้อมูลลาให้ครบ');
  const {data:existing,error:existingError}=await sb.from('leave_requests')
    .select('*').eq('employee_id',id.ref.id).eq('leave_date',p.leave_date).maybeSingle();
  if(existingError)throw existingError;
  if(existing)return fail(`มีคำขอลาวันนี้แล้ว สถานะ ${existing.status}`);
  const payload={employee_id:id.ref.id,leave_date:p.leave_date,leave_type:p.leave_type,reason:String(p.reason).trim(),status:'PENDING'};
  const {data,error}=await sb.from('leave_requests').insert(payload).select().single();
  if(error)throw error;
  await audit(id,'CREATE','leave_requests',data.id,null,data,p.reason);
  return json({success:true});
}

}
if(action==='employee_profile'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  return json({success:true,employee:{
    id:id.ref.id,employee_code:id.ref.employee_code,display_name:id.ref.display_name,
    full_name:id.ref.full_name,phone:id.ref.phone,ba_mode:id.ref.ba_mode,
    default_shift_id:id.ref.default_shift_id,office_name:id.ref.offices?.office_name||null
  }});
}
if(action==='update_my_profile'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  if(!String(p.display_name||'').trim())return fail('กรุณากรอกชื่อ');
  if(!String(p.phone||'').trim())return fail('กรุณากรอกเบอร์โทร');
  const before=id.ref;
  const patch={display_name:String(p.display_name).trim(),phone:String(p.phone).trim(),profile_completed:true};
  const {data,error}=await sb.from('employees').update(patch).eq('id',id.ref.id).select().single();
  if(error)throw error;
  await audit(id,'UPDATE_SELF','employees',id.ref.id,before,data,'BA แก้ไขชื่อและเบอร์โทรของตนเอง');
  return json({success:true,employee:data});
}
if(action==='employee_history_detail'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  const month=p.month||thaiMonth();
  await recalcRelevantEmployeeMonth(id.ref.id,month);
  const {start,end,next}=monthBounds(month);
  const [{data:summaries},{data:events},{data:schedules},{data:shifts}]=await Promise.all([
    sb.from('daily_summaries').select('*').eq('employee_id',id.ref.id).gte('work_date',start).lte('work_date',end).order('work_date',{ascending:false}),
    sb.from('attendance_events').select('event_type,occurred_at,offices(office_name)').eq('employee_id',id.ref.id).is('deleted_at',null).gte('occurred_at',`${start}T00:00:00+07:00`).lt('occurred_at',`${next}T00:00:00+07:00`).order('occurred_at'),
    sb.from('employee_schedules').select('*').eq('employee_id',id.ref.id).gte('work_date',start).lte('work_date',end),
    sb.from('shift_templates').select('*')
  ]);

  const eventMap=new Map<string,any[]>();
  for(const e of events||[]){
    const d=thaiDate(new Date(e.occurred_at));
    if(!eventMap.has(d))eventMap.set(d,[]);
    eventMap.get(d)!.push({
      type:e.event_type,
      label:eventLabel(e.event_type),
      time:fmtTimeTH(e.occurred_at),
      office_name:e.offices?.office_name||null
    });
  }

  const summaryMap=new Map((summaries||[]).map((x:any)=>[x.work_date,x]));
  const scheduleMap=new Map((schedules||[]).map((x:any)=>[x.work_date,x]));
  const shiftMap=new Map((shifts||[]).map((x:any)=>[x.id,x]));
  const today=thaiDate();

  const allDates=datesOfMonth(month)
    .filter((date:string)=>date<=today)
    .sort()
    .reverse();

  const rows=allDates.map((date:string)=>{
    const summary:any=summaryMap.get(date);
    const schedule:any=scheduleMap.get(date);
    const dayEvents=eventMap.get(date)||[];

    const status=summary?.status
      || (schedule?.schedule_status==='WORK' ? 'NOT_STARTED' : 'OFF');

    const sid=schedule?.schedule_status==='OFF'
      ? null
      : cleanShiftReference(schedule?.shift_id||summary?.shift_id||id.ref.default_shift_id);

    const shift:any=sid?shiftMap.get(sid):null;
    const shiftName=status==='OFF'||schedule?.schedule_status==='OFF'
      ? 'หยุด'
      : (shift?.shift_name||sid||'-');

    return {
      work_date:date,
      status,
      first_in:summary?.first_in||null,
      last_out:summary?.last_out||null,
      first_in_time:fmtTimeTH(summary?.first_in),
      last_out_time:fmtTimeTH(summary?.last_out),
      late_minutes:0,
      over_minutes:Number(summary?.over_minutes||0),
      credited_minutes:Number(summary?.credited_minutes||summary?.work_minutes||0),
      work_minutes:Number(summary?.work_minutes||0),
      break_minutes:Number(summary?.break_minutes||0),
      short_minutes:Number(summary?.short_minutes||0),
      refill_minutes:Number(summary?.refill_minutes||0),
      shift_id:sid,
      shift_name:shiftName,
      events:dayEvents,
      missing_summary:!summary
    };
  });

  return json({success:true,rows});
}
if(action==='employee_shift_month'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  const month=p.month||thaiMonth(),dates=datesOfMonth(month);
  const [{data:schedules},{data:leaves},{data:shifts}]=await Promise.all([
    sb.from('employee_schedules').select('*').eq('employee_id',id.ref.id).gte('work_date',`${month}-01`).lt('work_date',monthBounds(month).next),
    sb.from('leave_requests').select('*').eq('employee_id',id.ref.id).gte('leave_date',`${month}-01`).lt('leave_date',monthBounds(month).next),
    sb.from('shift_templates').select('*')
  ]);
  const smap=new Map((schedules||[]).map((x:any)=>[x.work_date,x]));
  const lmap=new Map((leaves||[]).map((x:any)=>[x.leave_date,x]));
  const shmap=new Map((shifts||[]).map((x:any)=>[x.id,x]));
  const rows=dates.map(date=>{
    const sc:any=smap.get(date),lv:any=lmap.get(date);
    const status=lv?.status==='APPROVED'?lv.leave_type:(sc?.schedule_status||'WORK');
    const sid=status==='WORK'?effectiveShiftId(id.ref,sc):null;
    const sh:any=sid?shmap.get(sid):null;
    return {date,status,shift_id:sid,shift_name:sh?.shift_name||sid||'-',
      start_time:sh?.start_time?String(sh.start_time).slice(0,5):null,
      end_time:sh?.end_time?String(sh.end_time).slice(0,5):null,
      leave_status:lv?.status||null,leave_type:lv?.leave_type||null
    };
  });
  return json({success:true,month,rows});
}
if(action==='my_leave_history'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  const cutoffDate=new Date();
  cutoffDate.setDate(cutoffDate.getDate()-3);
  const cutoff=thaiDate(cutoffDate);
  const {data}=await sb.from('leave_requests')
    .select('*')
    .eq('employee_id',id.ref.id)
    .gte('leave_date',cutoff)
    .order('leave_date',{ascending:false});
  return json({success:true,rows:data||[],cutoff});
}


if(action==='shift_request_setup'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  await expireOldAttendanceCorrectionRequests();
  const cutoff=attendanceRequestCutoffIso();
  const [{data:shifts},{data:requests},{data:offices},{data:attendanceRequests}]=await Promise.all([
    sb.from('shift_templates').select('*').eq('active',true).order('start_time'),
    sb.from('shift_change_requests').select('*').eq('employee_id',id.ref.id).gte('request_date',thaiDate()).order('request_date'),
    sb.from('offices').select('id,office_name,office_code').eq('active',true).order('office_code'),
    sb.from('attendance_correction_requests')
      .select('*,offices(office_name)')
      .eq('employee_id',id.ref.id)
      .gte('created_at',cutoff)
      .order('created_at',{ascending:false})
  ]);
  return json({
    success:true,
    shifts:shifts||[],
    requests:requests||[],
    offices:offices||[],
    attendance_requests:attendanceRequests||[]
  });
}
if(action==='submit_shift_request'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  const requestDate=String(p.request_date||'');
  const requestType=String(p.request_type||'');
  const reason=String(p.reason||'').trim();
  if(!requestDate||requestDate<thaiDate())return fail('เลือกได้ตั้งแต่วันนี้เป็นต้นไป');
  if(requestType!=='SHIFT_CHANGE')return fail('คำขออนุมัติใช้สำหรับเปลี่ยน Shift เท่านั้น');
  if(!reason)return fail('กรุณาระบุเหตุผล');
  if(!p.requested_shift_id)return fail('กรุณาเลือก Shift ที่ต้องการ');
  const payload={
    employee_id:id.ref.id,
    supervisor_id:id.ref.supervisor_id||null,
    request_date:requestDate,
    request_type:'SHIFT_CHANGE',
    requested_shift_id:p.requested_shift_id,
    reason,
    status:'PENDING'
  };
  const {data,error}=await sb.from('shift_change_requests').insert(payload).select().single();
  if(error){
    if(String(error.message||'').includes('shift_change_requests_one_pending_idx'))return fail('มีคำขอของวันนี้รออนุมัติอยู่แล้ว');
    throw error;
  }
  await audit(id,'CREATE','shift_change_requests',data.id,null,data,reason);
  return json({success:true,request:data});
}
if(action==='my_shift_requests'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  const {data,error}=await sb.from('shift_change_requests')
    .select('*,shift_templates(shift_name,start_time,end_time)')
    .eq('employee_id',id.ref.id)
    .gte('request_date',thaiDate())
    .order('request_date');
  if(error)throw error;
  return json({success:true,rows:data||[]});
}



if(action==='gps_request_setup'){
 if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA',403);
 const [{data:offices,error:oe},{data:requests,error:re}]=await Promise.all([
 sb.from('offices').select('id,office_name').eq('active',true).order('office_name'),
 sb.from('attendance_gps_requests').select('*,offices(office_name)').eq('employee_id',id.ref.id).order('created_at',{ascending:false}).limit(30)]);
 if(oe)throw oe;if(re)throw re;return json({success:true,offices,requests,assigned_office_id:id.ref.assigned_office_id});
}
if(action==='submit_gps_request'){
 if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA',403);
 const {data,error}=await sb.rpc('ba_request_gps_attendance',{p_employee_id:id.ref.id,p_actor:id.profile.sub,p_event_type:p.type,p_office_id:p.office_id,p_reason:String(p.reason||'').trim(),p_key:String(p.request_key||''),p_latitude:p.latitude??null,p_longitude:p.longitude??null,p_accuracy:p.accuracy??null});
 if(error)return fail(error.message,409);return json({success:true,request:data});
}
if(action==='pending_gps_requests'){
 ensureSupervisor(id);
 const {data:team,error:te}=await sb.from('employees').select('id').eq('supervisor_id',id.ref.id);if(te)throw te;
 const {data,error}=await sb.from('attendance_gps_requests').select('*,employees(employee_code,display_name),offices(office_name)').in('employee_id',(team||[]).map((e:any)=>e.id)).eq('status','PENDING').order('created_at');
 if(error)throw error;return json({success:true,rows:data||[]});
}
if(action==='review_gps_request'){
 ensureSupervisor(id);
 const {data,error}=await sb.rpc('ba_review_gps_attendance',{p_id:p.request_id,p_status:p.status,p_reason:String(p.reviewer_note||'').trim(),p_supervisor_id:id.ref.id,p_actor:id.profile.sub,p_admin:false});
 if(error)return fail(error.message,409);return json({success:true,...data});
}

if(action==='submit_attendance_correction_request'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  const requestDate=String(p.request_date||''),requestSide=String(p.request_side||''),officeId=String(p.office_id||''),reason=String(p.reason||'').trim();
  if(!requestDate)return fail('กรุณาระบุวันที่');
  if(requestDate>thaiDate())return fail('ขอลงเวลาได้เฉพาะวันนี้หรือวันที่ผ่านมาแล้ว');
  if(!['IN','OUT'].includes(requestSide))return fail('กรุณาเลือกว่าลืมลงเวลาเข้า หรือออก');
  if(!officeId)return fail('กรุณาเลือกสาขา');
  if(!reason)return fail('กรุณาระบุเหตุผล');
  if(!id.ref.supervisor_id)return fail('พนักงานยังไม่ได้ผูก Supervisor');
  const {data:office,error:officeError}=await sb.from('offices').select('id,office_name,active').eq('id',officeId).maybeSingle();
  if(officeError)throw officeError;if(!office||office.active===false)return fail('ไม่พบสาขา หรือสาขาไม่ได้เปิดใช้งาน');
  const payload={employee_id:id.ref.id,supervisor_id:id.ref.supervisor_id,request_date:requestDate,request_side:requestSide,office_id:officeId,reason,status:'PENDING',updated_at:new Date().toISOString()};
  const {data,error}=await sb.from('attendance_correction_requests').insert(payload).select('*,offices(office_name)').single();
  if(error){if(String(error.message||'').includes('attendance_correction_requests_one_pending_idx'))return fail('มีคำขอประเภทนี้ของวันดังกล่าวรออนุมัติอยู่แล้ว');throw error;}
  await audit(id,'CREATE','attendance_correction_requests',data.id,null,data,reason);
  return json({success:true,request:data});
}

if(action==='set_my_day_status'){
  if(id.role!=='EMPLOYEE')return fail('เฉพาะ BA');
  const workDate=String(p.work_date||'');
  const mode=String(p.mode||'');
  const reason=String(p.reason||'').trim();
  if(!workDate||workDate<thaiDate())return fail('เลือกได้ตั้งแต่วันนี้เป็นต้นไป');
  if(!['OFF','WORK'].includes(mode))return fail('สถานะวันไม่ถูกต้อง');
  if(!reason)return fail('กรุณาระบุเหตุผล');

  const {data:before}=await sb.from('employee_schedules')
    .select('*')
    .eq('employee_id',id.ref.id)
    .eq('work_date',workDate)
    .maybeSingle();

  const payload={
    employee_id:id.ref.id,
    work_date:workDate,
    schedule_status:mode,
    shift_id:mode==='OFF'?null:(p.shift_id||id.ref.default_shift_id),
    required_minutes:mode==='OFF'?0:Number(p.required_minutes||480),
    note:reason,
    source:mode==='OFF'?'BA_DAY_OFF':'BA_WORK_DAY'
  };

  const {data,error}=await sb.from('employee_schedules')
    .upsert(payload,{onConflict:'employee_id,work_date'})
    .select()
    .single();
  if(error)throw error;

  await audit(id,'UPSERT_SELF_DAY_STATUS','employee_schedules',data.id,before,data,reason);
  await recalc(id.ref.id,workDate);
  await sync(workDate,id.ref.id);

  return json({success:true,schedule:data});
}

ensureSupervisor(id);
if(action==='supervisor_dashboard'){
  await expireOldAttendanceCorrectionRequests();const {data:team}=await sb.from('employees').select('id,profile_completed').eq('supervisor_id',id.ref.id).eq('active',true);const ids=(team||[]).map(x=>x.id),date=thaiDate();const {data:sums}=ids.length?await sb.from('daily_summaries').select('*').in('employee_id',ids).eq('work_date',date):{data:[]};return json({success:true,kpis:{working:(sums||[]).filter(x=>x.status==='WORK').length,not_started:Math.max(0,ids.length-(sums||[]).filter(x=>x.status==='WORK').length),leave:(sums||[]).filter(x=>String(x.status).includes('LEAVE')||x.status==='VACATION').length,incomplete:(team||[]).filter(x=>!x.profile_completed).length}})}
if(action==='team_list'){const {data}=await sb.from('employees').select('id,employee_code,display_name,phone,ba_mode,default_shift_id,profile_completed,offices(office_name,region)').eq('supervisor_id',id.ref.id).eq('active',true).order('employee_code');return json({success:true,rows:(data||[]).map((x:any)=>({...x,office_name:x.offices?.office_name,region:x.offices?.region}))})}
if(action==='team_employee'){const e=await teamEmployee(id.ref.id,p.employee_id);const [{data:o},{data:shifts}]=await Promise.all([sb.from('offices').select('id,office_name,region').eq('active',true).order('office_name'),sb.from('shift_templates').select('*').eq('active',true).order('start_time')]);return json({success:true,employee:e,offices:o||[],shifts:shifts||[]})}
if(action==='update_team_employee'){if(!p.reason)return fail('ต้องกรอกเหตุผล');const old=await teamEmployee(id.ref.id,p.employee_id);const patch={display_name:p.display_name,phone:p.phone,ba_mode:p.ba_mode,assigned_office_id:p.assigned_office_id,default_shift_id:p.default_shift_id||old.default_shift_id||null,profile_completed:Boolean(p.display_name&&p.phone&&p.ba_mode&&p.assigned_office_id)};const {data,error}=await sb.from('employees').update(patch).eq('id',old.id).select().single();if(error)throw error;await audit(id,'UPDATE','employees',old.id,old,data,p.reason);return json({success:true})}
if(action==='shift_setup'){const [{data:team},{data:shifts}]=await Promise.all([sb.from('employees').select('id,employee_code,display_name,default_shift_id').eq('supervisor_id',id.ref.id).eq('active',true).order('employee_code'),sb.from('shift_templates').select('*').eq('active',true).order('start_time')]);return json({success:true,employees:team||[],shifts:shifts||[]})}
if(action==='team_shift_month'){const month=p.month||thaiMonth();const {data:team}=await sb.from('employees').select('id,employee_code,display_name,default_shift_id').eq('supervisor_id',id.ref.id).eq('active',true).order('employee_code');const ids=(team||[]).map((x:any)=>x.id);const {data:schedules}=ids.length?await sb.from('employee_schedules').select('*').in('employee_id',ids).gte('work_date',`${month}-01`).lt('work_date',monthBounds(month).next).order('work_date'):{data:[]};return json({success:true,employees:team||[],schedules:schedules||[]})}
if(action==='set_daily_shift'){if(!p.employee_id||!p.work_date||!p.reason)return fail('กรอก BA วันที่ และเหตุผลให้ครบ');await teamEmployee(id.ref.id,p.employee_id);const current=thaiMonth();if(String(p.work_date).slice(0,7)<current)return fail('ไม่สามารถจัด Shift ย้อนหลังก่อนเดือนปัจจุบัน');const before=(await sb.from('employee_schedules').select('*').eq('employee_id',p.employee_id).eq('work_date',p.work_date).maybeSingle()).data;const status=p.schedule_status==='OFF'?'OFF':'WORK';const row={employee_id:p.employee_id,work_date:p.work_date,schedule_status:status,shift_id:status==='OFF'?null:p.shift_id,required_minutes:status==='OFF'?0:480,note:p.reason};const {data,error}=await sb.from('employee_schedules').upsert(row,{onConflict:'employee_id,work_date'}).select().single();if(error)throw error;await audit(id,'UPSERT','employee_schedules',data.id,before,data,p.reason);await recalc(p.employee_id,p.work_date);return json({success:true})}
if(action==='delete_daily_shift'){if(!p.employee_id||!p.work_date||!p.reason)return fail('กรอกข้อมูลและเหตุผลให้ครบ');await teamEmployee(id.ref.id,p.employee_id);const {data:before}=await sb.from('employee_schedules').select('*').eq('employee_id',p.employee_id).eq('work_date',p.work_date).maybeSingle();if(before){const {error}=await sb.from('employee_schedules').delete().eq('id',before.id);if(error)throw error;await audit(id,'DELETE','employee_schedules',before.id,before,null,p.reason);await recalc(p.employee_id,p.work_date)}return json({success:true})}
if(action==='pending_leaves'){
  const {data:team,error:teamError}=await sb.from('employees')
    .select('id,employee_code,display_name,active')
    .eq('supervisor_id',id.ref.id);
  if(teamError)throw teamError;

  const activeTeam=(team||[]).filter((x:any)=>x.active!==false);
  const map=new Map(activeTeam.map((x:any)=>[x.id,x]));
  const ids=[...map.keys()];
  if(!ids.length)return json({success:true,rows:[],message:'ยังไม่มี BA อยู่ในทีมของ Supervisor คนนี้'});

  const {data,error}=await sb.from('leave_requests')
    .select('*')
    .in('employee_id',ids)
    .eq('status','PENDING')
    .order('leave_date',{ascending:true});

  if(error)throw error;

  const rows=(data||[]).map((x:any)=>{
    const emp:any=map.get(x.employee_id);
    return {
      ...x,
      employee_code:emp?.employee_code||'',
      employee_name:emp?.display_name||'ไม่พบชื่อพนักงาน'
    };
  });

  return json({
    success:true,
    rows,
    message:rows.length?'':`ไม่มีคำขอลารออนุมัติ`
  });
}
if(action==='review_leave'){if(!['APPROVED','REJECTED'].includes(p.status))return fail('สถานะไม่ถูกต้อง');if(!String(p.reviewer_note||'').trim())return fail('กรุณาระบุเหตุผลหรือหมายเหตุ');const {data:l}=await sb.from('leave_requests').select('*').eq('id',p.leave_id).single();await teamEmployee(id.ref.id,l.employee_id);const {data,error}=await sb.from('leave_requests').update({status:p.status,reviewed_by:id.ref.id,reviewer_note:p.reviewer_note||null,reviewed_at:new Date().toISOString()}).eq('id',p.leave_id).select().single();if(error)throw error;await audit(id,'REVIEW','leave_requests',p.leave_id,l,data,p.reviewer_note||p.status);await recalc(l.employee_id,l.leave_date);return json({success:true})}
if(action==='team_daily'){const date=p.date||thaiDate();const {data:team}=await sb.from('employees').select('id,employee_code,display_name,default_shift_id').eq('supervisor_id',id.ref.id).eq('active',true);const ids=(team||[]).map(x=>x.id);const [{data:s},{data:schedules},{data:shifts}]=await Promise.all([ids.length?sb.from('daily_summaries').select('*').in('employee_id',ids).eq('work_date',date):Promise.resolve({data:[]}),ids.length?sb.from('employee_schedules').select('*').in('employee_id',ids).eq('work_date',date):Promise.resolve({data:[]}),sb.from('shift_templates').select('*').eq('active',true)]);const map=new Map((s||[]).map((x:any)=>[x.employee_id,x]));const smap=new Map((schedules||[]).map((x:any)=>[x.employee_id,x]));const shmap=new Map((shifts||[]).map((x:any)=>[x.id,x]));return json({success:true,rows:(team||[]).map((e:any)=>{const sum:any=map.get(e.id)||{status:'OFF',credited_minutes:0,late_minutes:0};const sc:any=smap.get(e.id);const sid=sc?.schedule_status==='OFF'?null:effectiveShiftId(e,sc);const sh:any=sid?shmap.get(sid):null;return {employee_id:e.id,employee_code:e.employee_code,display_name:e.display_name,shift_id:sid,shift_name:sc?.schedule_status==='OFF'?'หยุด':(sh?.shift_name||sid||'ไม่กำหนด'),shift_start:sh?.start_time||sum.shift_start||null,...sum}})})}
if(action==='attendance_timeline'){await teamEmployee(id.ref.id,p.employee_id);const {data}=await sb.from('attendance_events').select('*,offices(office_name)').eq('employee_id',p.employee_id).is('deleted_at',null).gte('occurred_at',`${p.date}T00:00:00+07:00`).lte('occurred_at',`${p.date}T23:59:59+07:00`).order('occurred_at');return json({success:true,events:(data||[]).map((e:any)=>({...e,time:new Date(e.occurred_at).toLocaleTimeString('th-TH',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit'}),office_name:e.offices?.office_name}))})}
function withinCurrentMonth(date:string){return date?.slice(0,7)===thaiMonth()}
if(action==='delete_attendance'){if(!p.reason)return fail('ต้องกรอกเหตุผล');const {data:e}=await sb.from('attendance_events').select('*').eq('id',p.event_id).single();await teamEmployee(id.ref.id,e.employee_id);const d=thaiDate(new Date(e.occurred_at));if(!withinCurrentMonth(d))return fail('Supervisor แก้ได้เฉพาะเดือนปัจจุบัน');const {data:n,error}=await sb.from('attendance_events').update({deleted_at:new Date().toISOString(),edited:true}).eq('id',p.event_id).select().single();if(error)throw error;await audit(id,'DELETE','attendance_events',p.event_id,e,n,p.reason);await recalc(e.employee_id,d);return json({success:true})}
if(action==='add_attendance'){if(!p.reason||!p.date||!p.time)return fail('กรอกข้อมูลให้ครบ');if(!withinCurrentMonth(p.date))return fail('Supervisor แก้ได้เฉพาะเดือนปัจจุบัน');await teamEmployee(id.ref.id,p.employee_id);const at=new Date(`${p.date}T${p.time}:00+07:00`).toISOString();const {data,error}=await sb.from('attendance_events').insert({employee_id:p.employee_id,event_type:p.type,occurred_at:at,source:'SUPERVISOR',created_by_line_user_id:id.profile.sub,edited:true}).select().single();if(error)throw error;await audit(id,'CREATE','attendance_events',data.id,null,data,p.reason);await recalc(p.employee_id,p.date);return json({success:true})}
if(action==='update_attendance'){if(!p.reason||!p.event_id||!p.date||!p.time||!p.type)return fail('กรอกข้อมูลให้ครบ');if(!withinCurrentMonth(p.date))return fail('Supervisor แก้ได้เฉพาะเดือนปัจจุบัน');const {data:e}=await sb.from('attendance_events').select('*').eq('id',p.event_id).single();await teamEmployee(id.ref.id,e.employee_id);const at=new Date(`${p.date}T${p.time}:00+07:00`).toISOString();const {data:n,error}=await sb.from('attendance_events').update({event_type:p.type,occurred_at:at,edited:true}).eq('id',p.event_id).select().single();if(error)throw error;await audit(id,'UPDATE','attendance_events',p.event_id,e,n,p.reason);await recalc(e.employee_id,p.date);return json({success:true})}
if(action==='team_monthly'){const ms=(p.month||thaiMonth())+'-01';const {data:team}=await sb.from('employees').select('id,employee_code,display_name').eq('supervisor_id',id.ref.id).eq('active',true);const ids=(team||[]).map(x=>x.id);const {data:s}=ids.length?await sb.from('monthly_summaries').select('*').in('employee_id',ids).eq('month_start',ms):{data:[]};const map=new Map((s||[]).map(x=>[x.employee_id,x]));return json({success:true,rows:(team||[]).map(e=>({employee_code:e.employee_code,display_name:e.display_name,...(map.get(e.id)||{})}))})}

if(action==='supervisor_dashboard_v2'){
  ensureSupervisor(id);
  const date=thaiDate();

  const {data:team,error:teamError}=await sb.from('employees')
    .select('id,employee_code,display_name,phone,profile_completed,assigned_office_id,offices(office_name)')
    .eq('supervisor_id',id.ref.id)
    .eq('active',true)
    .order('employee_code');
  if(teamError)throw teamError;

  const ids=(team||[]).map((x:any)=>x.id);

  const [{data:registrations,error:registrationError},{data:locations,error:locationError}]=await Promise.all([
    sb.from('ba_registration_requests').select('id').eq('requested_supervisor_id',id.ref.id).eq('status','PENDING'),
    sb.from('office_location_requests').select('id').eq('supervisor_id',id.ref.id).eq('status','PENDING')
  ]);
  if(registrationError)throw registrationError;
  if(locationError)throw locationError;

  let events:any[]=[];
  let summaries:any[]=[];
  let leaves:any[]=[];
  let attendanceRequests:any[]=[];
  let pendingLeaves:any[]=[];
  let pendingShifts:any[]=[];

  if(ids.length){
    const results=await Promise.all([
      sb.from('attendance_events')
        .select('employee_id,event_type,occurred_at,offices(office_name)')
        .in('employee_id',ids)
        .is('deleted_at',null)
        .gte('occurred_at',`${date}T00:00:00+07:00`)
        .lte('occurred_at',`${date}T23:59:59+07:00`)
        .order('occurred_at'),
      sb.from('daily_summaries')
        .select('employee_id,late_minutes')
        .in('employee_id',ids)
        .eq('work_date',date),
      sb.from('leave_requests')
        .select('employee_id,status,leave_date')
        .in('employee_id',ids)
        .eq('leave_date',date),
      sb.from('attendance_correction_requests').select('id').in('employee_id',ids).eq('status','PENDING'),
      sb.from('leave_requests').select('id').in('employee_id',ids).eq('status','PENDING'),
      sb.from('shift_change_requests').select('id').in('employee_id',ids).eq('status','PENDING')
    ]);
    for(const r of results){if(r.error)throw r.error;}
    events=results[0].data||[];
    summaries=results[1].data||[];
    leaves=results[2].data||[];
    attendanceRequests=results[3].data||[];
    pendingLeaves=results[4].data||[];
    pendingShifts=results[5].data||[];
  }

  const teamMap=new Map((team||[]).map((x:any)=>[x.id,x]));
  const byEmployee=new Map<string,any[]>();
  for(const e of events){
    if(!byEmployee.has(e.employee_id))byEmployee.set(e.employee_id,[]);
    byEmployee.get(e.employee_id)!.push(e);
  }

  const startTypes=new Set(['IN','DAY_IN','WORK_IN']);
  const endTypes=new Set(['OUT','DAY_OUT','WORK_OUT']);

  const lists:any={
    total:[],
    checked_in:[],
    checked_out:[],
    working:[],
    on_break:[],
    late:[],
    leave:[],
    incomplete:[]
  };

  for(const emp of team||[]){
    const evs=(byEmployee.get(emp.id)||[]).sort((a:any,b:any)=>new Date(a.occurred_at).getTime()-new Date(b.occurred_at).getTime());
    const hasIn=evs.some((e:any)=>startTypes.has(e.event_type));
    const hasOut=evs.some((e:any)=>endTypes.has(e.event_type));
    const last=evs.at(-1);
    const firstIn=evs.find((e:any)=>startTypes.has(e.event_type));
    const officeName=last?.offices?.office_name||firstIn?.offices?.office_name||emp.offices?.office_name||null;
    const base={
      employee_id:emp.id,
      employee_code:emp.employee_code,
      display_name:emp.display_name,
      phone:emp.phone,
      office_name:officeName,
      last_event:last?.event_type||null,
      last_time:last?.occurred_at?fmtTimeTH(last.occurred_at):null
    };

    lists.total.push(base);
    if(hasIn)lists.checked_in.push(base);
    if(hasOut)lists.checked_out.push(base);
    if(hasIn&&!hasOut)lists.working.push(base);
    if(last?.event_type==='BREAK_OUT'){
      lists.on_break.push({
        ...base,
        break_started_time:fmtTimeTH(last.occurred_at),
        elapsed_minutes:mins(last.occurred_at,new Date().toISOString())
      });
    }
    if(!emp.profile_completed)lists.incomplete.push(base);
  }

  const approvedLeaves=leaves.filter((x:any)=>String(x.status||'').toUpperCase()==='APPROVED');
  for(const lv of approvedLeaves){
    const emp:any=teamMap.get(lv.employee_id);
    if(emp)lists.leave.push({
      employee_id:emp.id,
      employee_code:emp.employee_code,
      display_name:emp.display_name,
      phone:emp.phone,
      office_name:emp.offices?.office_name||null
    });
  }

  const pendingAttendance=attendanceRequests.length;
  const pendingLeave=pendingLeaves.length;
  const pendingShift=pendingShifts.length;
  const pendingRegistration=(registrations||[]).length;
  const pendingLocation=(locations||[]).length;
  const pendingTotal=pendingAttendance+pendingLeave+pendingShift+pendingRegistration+pendingLocation;

  return json({success:true,kpis:{
    total:lists.total.length,
    checked_in:lists.checked_in.length,
    checked_out:lists.checked_out.length,
    working:lists.working.length,
    on_break:lists.on_break.length,
    late:0,
    leave:lists.leave.length,
    incomplete:lists.incomplete.length,
    pending_attendance:pendingAttendance,
    pending_leave:pendingLeave,
    pending_shift:pendingShift,
    pending_registration:pendingRegistration,
    pending_location:pendingLocation,
    pending_total:pendingTotal
  },lists});
}

if(action==='supervisor_employee_shift_month'){
  ensureSupervisor(id);
  const emp=await teamEmployee(id.ref.id,p.employee_id);
  const month=p.month||thaiMonth(),dates=datesOfMonth(month);
  const [{data:schedules},{data:shifts}]=await Promise.all([
    sb.from('employee_schedules').select('*').eq('employee_id',emp.id).gte('work_date',`${month}-01`).lt('work_date',monthBounds(month).next),
    sb.from('shift_templates').select('*').eq('active',true).order('start_time')
  ]);
  const smap=new Map((schedules||[]).map((x:any)=>[x.work_date,x]));
  const rows=dates.map(date=>{
    const sc:any=smap.get(date);
    return {date,schedule_status:sc?.schedule_status||'WORK',shift_id:sc?.schedule_status==='OFF'?null:effectiveShiftId(emp,sc),is_default:!sc||!String(sc?.note||'').trim()};
  });
  return json({success:true,employee:{id:emp.id,employee_code:emp.employee_code,display_name:emp.display_name,default_shift_id:emp.default_shift_id},shifts:shifts||[],rows});
}
if(action==='bulk_set_employee_shifts'){
  ensureSupervisor(id);
  if(!p.employee_id||!Array.isArray(p.dates)||!p.dates.length||!p.reason)return fail('กรอก BA วันที่ และเหตุผลให้ครบ');
  const emp=await teamEmployee(id.ref.id,p.employee_id);
  const current=thaiMonth();
  const dates=[...new Set(p.dates.map((x:any)=>String(x)))];
  if(dates.some((d:string)=>d.slice(0,7)<current))return fail('ไม่สามารถจัด Shift ย้อนหลังก่อนเดือนปัจจุบัน');
  const status=p.schedule_status==='OFF'?'OFF':'WORK';
  let required=0;
  if(status==='WORK'){
    const {data:shift,error:shiftError}=await sb.from('shift_templates').select('required_minutes').eq('id',p.shift_id).single();
    if(shiftError)throw shiftError;
    required=Number(shift.required_minutes||480);
  }
  const rows=dates.map((d:string)=>({employee_id:emp.id,work_date:d,schedule_status:status,shift_id:status==='OFF'?null:p.shift_id,required_minutes:required,note:p.reason,source:'SUPERVISOR_OVERRIDE'}));
  const {data:before}=await sb.from('employee_schedules').select('*').eq('employee_id',emp.id).in('work_date',dates);
  const {data,error}=await sb.from('employee_schedules').upsert(rows,{onConflict:'employee_id,work_date'}).select();
  if(error)throw error;
  await audit(id,'BULK_UPSERT','employee_schedules',emp.id,before,data,p.reason);
  for(const d of dates)await recalc(emp.id,d);
  return json({success:true,affected:(data||[]).length});
}
if(action==='team_daily_v2'){
  ensureSupervisor(id);
  const date=p.date||thaiDate();
  await recalcTeamDate(id.ref.id,date);
  const {data:team}=await sb.from('employees').select('id,employee_code,display_name,default_shift_id,ba_mode').eq('supervisor_id',id.ref.id).eq('active',true).order('employee_code');
  const ids=(team||[]).map((x:any)=>x.id);
  const [{data:sums},{data:events},{data:schedules},{data:shifts}]=await Promise.all([
    ids.length?sb.from('daily_summaries').select('*').in('employee_id',ids).eq('work_date',date):Promise.resolve({data:[]}),
    ids.length?sb.from('attendance_events').select('employee_id,event_type,occurred_at,offices(office_name)').in('employee_id',ids).is('deleted_at',null).gte('occurred_at',`${date}T00:00:00+07:00`).lte('occurred_at',`${date}T23:59:59+07:00`).order('occurred_at'):Promise.resolve({data:[]}),
    ids.length?sb.from('employee_schedules').select('*').in('employee_id',ids).eq('work_date',date):Promise.resolve({data:[]}),
    sb.from('shift_templates').select('*')
  ]);
  const sumMap=new Map((sums||[]).map((x:any)=>[x.employee_id,x]));
  const scMap=new Map((schedules||[]).map((x:any)=>[x.employee_id,x]));
  const shMap=new Map((shifts||[]).map((x:any)=>[x.id,x]));
  const evMap=new Map<string,any[]>();
  for(const e of events||[]){
    if(!evMap.has(e.employee_id))evMap.set(e.employee_id,[]);
    evMap.get(e.employee_id)!.push({type:e.event_type,label:eventLabel(e.event_type),time:fmtTimeTH(e.occurred_at),office_name:e.offices?.office_name||null});
  }
  const rows=(team||[]).map((e:any)=>{
    const s:any=sumMap.get(e.id)||{status:'OFF',credited_minutes:0,break_minutes:0,refill_minutes:0,short_minutes:0,over_minutes:0,late_minutes:0,net_minutes:0};
    const sc:any=scMap.get(e.id);const sid=sc?.schedule_status==='OFF'?null:effectiveShiftId(e,sc);const sh:any=sid?shMap.get(sid):null;
    return {employee_id:e.id,employee_code:e.employee_code,display_name:e.display_name,ba_mode:e.ba_mode,
      shift_id:sid,shift_name:sc?.schedule_status==='OFF'?'หยุด':(sh?.shift_name||sid||'-'),
      shift_start:sh?.start_time?String(sh.start_time).slice(0,5):null,
      shift_end:sh?.end_time?String(sh.end_time).slice(0,5):null,
      ...s,first_in_time:fmtTimeTH(s.first_in),last_out_time:fmtTimeTH(s.last_out),events:evMap.get(e.id)||[]
    };
  });
  return json({success:true,date,rows});
}
if(action==='team_monthly_v2'){
  ensureSupervisor(id);
  const month=p.month||thaiMonth();
  const today=thaiDate();
  const {start,end,next,last}=monthBounds(month);
  const totalDays=last;
  const elapsedEnd=month<today.slice(0,7)?end:(month>today.slice(0,7)?null:today);
  const elapsedDays=elapsedEnd?Number(elapsedEnd.slice(8,10)):0;

  const {data:team,error:teamError}=await sb.from('employees')
    .select('id,employee_code,display_name,default_shift_id,start_date,end_date,active')
    .eq('supervisor_id',id.ref.id).eq('active',true).order('employee_code');
  if(teamError)throw teamError;

  const ids=(team||[]).map((x:any)=>x.id);
  const [{data:sums,error:sumError},{data:schedules,error:scheduleError},{data:leaves,error:leaveError}]=await Promise.all([
    ids.length?sb.from('daily_summaries').select('*').in('employee_id',ids).gte('work_date',start).lt('work_date',next):Promise.resolve({data:[]}),
    ids.length?sb.from('employee_schedules').select('*').in('employee_id',ids).gte('work_date',start).lt('work_date',next):Promise.resolve({data:[]}),
    ids.length?sb.from('leave_requests').select('*').in('employee_id',ids).eq('status','APPROVED').gte('leave_date',start).lt('leave_date',next):Promise.resolve({data:[]})
  ]);
  if(sumError)throw sumError;
  if(scheduleError)throw scheduleError;
  if(leaveError)throw leaveError;

  const sumMap=new Map<string,any[]>();
  for(const s of sums||[]){if(!sumMap.has(s.employee_id))sumMap.set(s.employee_id,[]);sumMap.get(s.employee_id)!.push(s)}
  const scheduleMap=new Map<string,Map<string,any>>();
  for(const s of schedules||[]){
    if(!scheduleMap.has(s.employee_id))scheduleMap.set(s.employee_id,new Map());
    scheduleMap.get(s.employee_id)!.set(s.work_date,s);
  }
  const leaveMap=new Map<string,Set<string>>();
  for(const l of leaves||[]){
    if(!leaveMap.has(l.employee_id))leaveMap.set(l.employee_id,new Set());
    leaveMap.get(l.employee_id)!.add(l.leave_date);
  }

  const allDates=datesOfMonth(month);
  const rows=(team||[]).map((e:any)=>{
    const ds=sumMap.get(e.id)||[];
    const sc=scheduleMap.get(e.id)||new Map();
    const lv=leaveMap.get(e.id)||new Set();

    const scheduledDates=allDates.filter(date=>{
      if(!employeeActiveOn(e,date))return false;
      if(lv.has(date))return false;
      const row=sc.get(date);
      return row?.schedule_status!=='OFF';
    });
    const scheduledElapsed=scheduledDates.filter(d=>elapsedEnd&&d<=elapsedEnd).length;

    return {
      employee_id:e.id,employee_code:e.employee_code,display_name:e.display_name,
      elapsed_days:elapsedDays,total_days:totalDays,
      scheduled_elapsed:scheduledElapsed,scheduled_month:scheduledDates.length,
      actual_work_days:ds.filter((x:any)=>['COMPLETED','WORKING'].includes(x.status)).length,
      off_days:allDates.filter(d=>sc.get(d)?.schedule_status==='OFF').length,
      absent_days:ds.filter((x:any)=>x.status==='ABSENT').length,
      over_days:ds.filter((x:any)=>Number(x.over_minutes||0)>0).length,
      late_days:ds.filter((x:any)=>Number(x.late_minutes||0)>0).length,
      short_days:ds.filter((x:any)=>Number(x.short_minutes||0)>0).length,
      late_minutes:ds.reduce((a:number,x:any)=>a+Number(x.late_minutes||0),0),
      over_minutes:ds.reduce((a:number,x:any)=>a+Number(x.over_minutes||0),0),
      sick_leave_days:ds.filter((x:any)=>x.status==='SICK_LEAVE').length,
      business_leave_days:ds.filter((x:any)=>x.status==='BUSINESS_LEAVE').length,
      vacation_days:ds.filter((x:any)=>x.status==='VACATION').length,
      refill_days:ds.filter((x:any)=>Number(x.refill_minutes||0)>0).length,
      refill_minutes:ds.reduce((a:number,x:any)=>a+Number(x.refill_minutes||0),0),
      forgot_checkout_days:ds.filter((x:any)=>x.first_in&&!x.last_out).length
    };
  });

  return json({success:true,month,elapsed_days:elapsedDays,total_days:totalDays,rows});
}


if(action==='pending_approvals'){
  ensureSupervisor(id);
  await expireOldAttendanceCorrectionRequests();

  const [{data:team,error:teamError},{data:registrations,error:registrationError},{data:locations,error:locationError},{data:offices,error:officeError}]=await Promise.all([
    sb.from('employees').select('id').eq('supervisor_id',id.ref.id).eq('active',true),
    sb.from('ba_registration_requests')
      .select('*')
      .eq('requested_supervisor_id',id.ref.id)
      .eq('status','PENDING')
      .order('created_at'),
    sb.from('office_location_requests')
      .select('*')
      .eq('supervisor_id',id.ref.id)
      .eq('status','PENDING')
      .order('created_at'),
    sb.from('offices').select('id,office_code,office_name,region').eq('active',true).order('office_name')
  ]);
  if(teamError)throw teamError;
  if(registrationError)throw registrationError;
  if(locationError)throw locationError;
  if(officeError)throw officeError;

  const locationRows=await attachEmployeesToOfficeLocationRequests(locations||[]);
  const ids=(team||[]).map((x:any)=>x.id);
  let leaves:any[]=[];
  let shifts:any[]=[];
  let attendance:any[]=[];

  if(ids.length){
    const results=await Promise.all([
      sb.from('leave_requests')
        .select('*,employees(employee_code,display_name)')
        .in('employee_id',ids)
        .eq('status','PENDING')
        .order('leave_date'),
      sb.from('shift_change_requests')
        .select('*,employees(employee_code,display_name),shift_templates(shift_name,start_time,end_time)')
        .in('employee_id',ids)
        .eq('status','PENDING')
        .order('request_date')
        .order('created_at'),
      sb.from('attendance_correction_requests')
        .select('*,employees(employee_code,display_name,ba_mode,default_shift_id),offices(office_name)')
        .in('employee_id',ids)
        .eq('status','PENDING')
        .order('request_date')
        .order('created_at')
    ]);
    const [leaveRes,shiftRes,attendanceRes]=results;
    if(leaveRes.error)throw leaveRes.error;
    if(shiftRes.error)throw shiftRes.error;
    if(attendanceRes.error)throw attendanceRes.error;
    leaves=leaveRes.data||[];
    shifts=shiftRes.data||[];
    attendance=attendanceRes.data||[];
  }

  const counts={
    registration:(registrations||[]).length,
    location:locationRows.length,
    leave:leaves.length,
    shift:shifts.length,
    attendance:attendance.length,
    total:(registrations||[]).length+locationRows.length+leaves.length+shifts.length+attendance.length
  };

  return json({
    success:true,
    counts,
    registrations:registrations||[],
    locations:locationRows,
    offices:offices||[],
    leaves,
    shifts,
    attendance
  });
}

if(action==='pending_attendance_correction_requests'){
  ensureSupervisor(id);
  await expireOldAttendanceCorrectionRequests();
  const {data:team,error:teamError}=await sb.from('employees').select('id').eq('supervisor_id',id.ref.id).eq('active',true);if(teamError)throw teamError;
  const ids=(team||[]).map((x:any)=>x.id);if(!ids.length)return json({success:true,rows:[]});
  const {data,error}=await sb.from('attendance_correction_requests').select('*,employees(employee_code,display_name,ba_mode,default_shift_id,supervisor_id),offices(office_name)').in('employee_id',ids).eq('status','PENDING').order('request_date').order('created_at');
  if(error)throw error;return json({success:true,rows:data||[]});
}
if(action==='review_attendance_correction_request'){
  ensureSupervisor(id);
  await expireOldAttendanceCorrectionRequests();
  const status=String(p.status||''),note=String(p.reviewer_note||'').trim();
  if(!['APPROVED','REJECTED'].includes(status))return fail('สถานะไม่ถูกต้อง');if(!note)return fail('กรุณาระบุเหตุผลหรือหมายเหตุ');
  const {data:reqData,error:reqError}=await sb.from('attendance_correction_requests').select('*,employees(*),offices(*)').eq('id',p.request_id).maybeSingle();
  if(reqError)throw reqError;if(!reqData)return fail('ไม่พบคำขอ หรือคำขอนี้ถูกดำเนินการแล้ว');if(reqData.employees?.supervisor_id!==id.ref.id)return fail('ไม่มีสิทธิ์จัดการคำขอนี้');
  let shift:any=null;
  if(status==='APPROVED'){
    const {data:schedule,error:scheduleError}=await sb.from('employee_schedules').select('*').eq('employee_id',reqData.employee_id).eq('work_date',reqData.request_date).maybeSingle();
    if(scheduleError)throw scheduleError;
    shift=await resolveShift(reqData.employees,reqData.request_date,schedule);
    if(!shift?.start_time||!shift?.end_time)return fail('ไม่พบเวลาเริ่ม–เลิกของ Shift วันดังกล่าว');
  }
  const {data:review,error:reviewError}=await sb.rpc('ba_review_attendance_correction',{
    p_request_id:reqData.id,p_supervisor_id:id.ref.id,p_actor:id.profile.sub,
    p_status:status,p_reason:note,p_shift_start:shift?.start_time||null,p_shift_end:shift?.end_time||null
  });
  if(reviewError)throw reviewError;
  if(status==='APPROVED')await sync(reqData.request_date,reqData.employee_id);
  return json({success:true,...review});
}

if(action==='pending_shift_requests'){
  ensureSupervisor(id);
  const {data:team}=await sb.from('employees').select('id').eq('supervisor_id',id.ref.id).eq('active',true);
  const ids=(team||[]).map((x:any)=>x.id);
  if(!ids.length)return json({success:true,rows:[]});
  const {data,error}=await sb.from('shift_change_requests')
    .select('*,employees(employee_code,display_name),shift_templates(shift_name,start_time,end_time)')
    .in('employee_id',ids)
    .eq('status','PENDING')
    .order('request_date');
  if(error)throw error;
  return json({success:true,rows:data||[]});
}
if(action==='review_shift_request'){
  ensureSupervisor(id);
  const status=String(p.status||'');
  if(!['APPROVED','REJECTED'].includes(status))return fail('สถานะไม่ถูกต้อง');
  const {data:reqData,error:reqError}=await sb.from('shift_change_requests')
    .select('*,employees(*)')
    .eq('id',p.request_id)
    .eq('status','PENDING')
    .maybeSingle();
  if(reqError)throw reqError;
  if(!reqData)return fail('ไม่พบคำขอ หรือคำขอนี้ถูกดำเนินการแล้ว');
  if(reqData.employees?.supervisor_id!==id.ref.id)return fail('ไม่มีสิทธิ์จัดการคำขอนี้');
  const note=String(p.reviewer_note||'').trim();
  if(!note)return fail('กรุณาระบุเหตุผลหรือหมายเหตุ');
  if(status==='APPROVED'){
    const schedule={
      employee_id:reqData.employee_id,
      work_date:reqData.request_date,
      schedule_status:reqData.request_type==='DAY_OFF'?'OFF':'WORK',
      shift_id:reqData.request_type==='DAY_OFF'?null:reqData.requested_shift_id,
      required_minutes:reqData.request_type==='DAY_OFF'?0:480,
      note:`อนุมัติคำขอ: ${reqData.reason}`,source:'SHIFT_REQUEST_APPROVED'
    };
    const {error:scheduleError}=await sb.from('employee_schedules')
      .upsert(schedule,{onConflict:'employee_id,work_date'});
    if(scheduleError)throw scheduleError;
    await recalc(reqData.employee_id,reqData.request_date);
    await sync(reqData.request_date,reqData.employee_id);
  }
  const before=reqData;
  const {data:updated,error:updateError}=await sb.from('shift_change_requests')
    .update({status,reviewer_note:note,reviewed_at:new Date().toISOString(),supervisor_id:id.ref.id})
    .eq('id',reqData.id).select().single();
  if(updateError)throw updateError;
  await audit(id,'REVIEW','shift_change_requests',reqData.id,before,updated,note);
  return json({success:true,request:updated});
}


if(action==='team_on_break'){
  ensureSupervisor(id);
  const date=thaiDate();

  const {data:team,error:teamError}=await sb.from('employees')
    .select('id,employee_code,display_name')
    .eq('supervisor_id',id.ref.id)
    .eq('active',true)
    .order('employee_code');
  if(teamError)throw teamError;

  const ids=(team||[]).map((x:any)=>x.id);
  if(!ids.length)return json({success:true,rows:[]});

  const {data:events,error:eventError}=await sb.from('attendance_events')
    .select('employee_id,event_type,occurred_at,offices(office_name)')
    .in('employee_id',ids)
    .is('deleted_at',null)
    .gte('occurred_at',`${date}T00:00:00+07:00`)
    .lte('occurred_at',`${date}T23:59:59+07:00`)
    .order('occurred_at');
  if(eventError)throw eventError;

  const empMap=new Map((team||[]).map((x:any)=>[x.id,x]));
  const byEmployee=new Map<string,any[]>();

  for(const e of events||[]){
    if(!byEmployee.has(e.employee_id))byEmployee.set(e.employee_id,[]);
    byEmployee.get(e.employee_id)!.push(e);
  }

  const now=Date.now();
  const rows:any[]=[];

  for(const [employeeId,evs] of byEmployee.entries()){
    const sorted=evs.sort((a:any,b:any)=>new Date(a.occurred_at).getTime()-new Date(b.occurred_at).getTime());
    const last=sorted.at(-1);
    if(last?.event_type!=='BREAK_OUT')continue;

    const emp:any=empMap.get(employeeId);
    const startedAt=new Date(last.occurred_at);
    rows.push({
      employee_id:employeeId,
      employee_code:emp?.employee_code||'',
      display_name:emp?.display_name||'ไม่พบชื่อ',
      office_name:last.offices?.office_name||'ไม่ระบุสาขา',
      break_started_time:fmtTimeTH(last.occurred_at),
      elapsed_minutes:Math.max(0,Math.floor((now-startedAt.getTime())/60000))
    });
  }

  rows.sort((a,b)=>b.elapsed_minutes-a.elapsed_minutes);
  return json({success:true,rows});
}

return fail('ไม่รู้จัก action');}
Deno.serve(async req=>{try{return await handler(req)}catch(e){console.error(e);return fail((e as Error)?.message||String(e),500)}});
