import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const runtime=process.env.BA_TEST_RUNTIME||fileURLToPath(new URL('../node_modules',import.meta.url));
const {default:EmbeddedPostgres}=await import(pathToFileURL(runtime+'/embedded-postgres/dist/index.js'));
const {stripTypeScriptTypes}=await import('node:module');
const root=new URL('../',import.meta.url);
const source=fs.readFileSync(new URL('supabase/functions/ba-api/index.ts',root),'utf8');
const original=fs.readFileSync(new URL('tests/fixtures/production-allowed-before.ts',root),'utf8');
function policy(s){const a=s.indexOf('async function allowed('),b=s.indexOf('\nfunction dateCompare',a);return vm.runInNewContext(stripTypeScriptTypes(s.slice(a,b))+';allowed');}
const allowed=policy(source),oldAllowed=original?policy(original):null;
function events(types){return types.map((event_type,i)=>({event_type,occurred_at:new Date(1700000000000+i*1000).toISOString(),source:i%2?'ADMIN':'LIFF'}));}
let passed=0;
async function check(name,f){await f();passed++;console.log('PASS',name);}
const pg=new EmbeddedPostgres({databaseDir:'/private/tmp/ba-pg-'+process.pid,user:'postgres',password:'local-tests-only',port:55439,persistent:false,postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog:()=>{},onError:()=>{}});
let db;
try{
await pg.initialise();await pg.start();db=pg.getPgClient();await db.connect();
await db.query(`create role anon;create role authenticated;create role service_role;
create type ba_mode as enum('FIXED_BRANCH','MULTI_BRANCH','STOCK_REFILL');
create type attendance_event_type as enum('IN','BREAK_OUT','BREAK_IN','OUT','DAY_IN','DAY_OUT','BRANCH_IN','BRANCH_OUT','WORK_IN','WORK_OUT','REFILL_IN','REFILL_OUT');
create table employees(id uuid primary key,ba_mode ba_mode,active boolean default true,line_user_id text);
create table attendance_events(id uuid primary key default gen_random_uuid(),employee_id uuid references employees,event_type attendance_event_type,occurred_at timestamptz,office_id uuid,latitude numeric,longitude numeric,gps_accuracy_meters numeric,distance_meters numeric,source text,created_by_line_user_id text,request_key text,deleted_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),edited boolean default false);
create unique index attendance_events_request_key_uidx on attendance_events(request_key) where request_key is not null;`);
await db.query(fs.readFileSync(new URL('supabase/migrations/202609250001_atomic_attendance_order.sql',root),'utf8'));
await db.query(`alter table employees add column supervisor_id uuid;
create table supervisors(id uuid primary key,line_user_id text,active boolean default true);
create table attendance_correction_requests(id uuid primary key default gen_random_uuid(),employee_id uuid,supervisor_id uuid,request_date date,request_side text,office_id uuid,reason text,status text default 'PENDING',reviewer_note text,reviewed_at timestamptz,reviewed_by_supervisor_id uuid,applied_event_id uuid,created_at timestamptz default now(),updated_at timestamptz default now());
create table audit_logs(id bigint generated always as identity,actor_line_user_id text,actor_role text,actor_ref_id uuid,action text,entity_type text,entity_id text,before_data jsonb,after_data jsonb,reason text,created_at timestamptz default now());`);
await db.query(fs.readFileSync(new URL('supabase/migrations/202609250002_atomic_attendance_correction.sql',root),'utf8'));
await db.query(fs.readFileSync(new URL('supabase/migrations/202609250003_admin_attendance_override.sql',root),'utf8'));
await db.query('create table offices(id uuid primary key,active boolean default true)');
for(const f of ['202610050001_admin_correction_review.sql','202610050002_gps_attendance_requests.sql','202610050003_legacy_break_request_guard.sql'])await db.query(fs.readFileSync(new URL('supabase/migrations/'+f,root),'utf8'));
await db.query('alter table employees add column employee_code text, add column display_name text; alter table offices add column office_name text');
const employee=async(mode='FIXED_BRANCH')=>{const id=randomUUID();await db.query('insert into employees values($1,$2,true,$3)',[id,mode,id]);return id;};
const office=randomUUID();await db.query('insert into offices(id) values($1)',[office]);
async function submit(id,type,key=randomUUID(),client=db,extra={}){const q=await client.query('select (public.insert_attendance_event_guarded($1,$2,clock_timestamp(),$3,13,100,20,10,$4,$5,$6)).*',[id,type,extra.office||office,extra.source||'LIFF',extra.actor||id,key]);return q.rows[0];}
async function reject(id,type,error='INVALID_TRANSITION'){await assert.rejects(()=>submit(id,type),new RegExp(error));}
await check('fixed valid prefixes and all invalid permutations; SQL/JS agreement',async()=>{
 const alphabet=['IN','BREAK_OUT','BREAK_IN','OUT','REFILL_IN'];const cases=[[]];let layer=[[]];for(let d=0;d<4;d++){layer=layer.flatMap(a=>alphabet.map(t=>[...a,t]));cases.push(...layer);}
 const sql=(await db.query('select public.ba_allowed_event_types(\'FIXED_BRANCH\',array(select jsonb_array_elements_text(value))) as actions from jsonb_array_elements($1::jsonb)',[JSON.stringify(cases)])).rows;
 for(let i=0;i<cases.length;i++){const t=cases[i],seq=['IN','BREAK_OUT','BREAK_IN','OUT'];const expected=t.every((x,j)=>x===seq[j])&&t.length<4?[seq[t.length]]:[];assert.deepEqual([...await allowed({ba_mode:'FIXED_BRANCH'},events(t))],expected);assert.deepEqual(sql[i].actions,expected);}
});
await check('MULTI_BRANCH and STOCK_REFILL preserve production allowed() behavior',async()=>{
 const alphabet=['IN','OUT','BREAK_OUT','BREAK_IN','DAY_IN','DAY_OUT','BRANCH_IN','BRANCH_OUT','WORK_IN','WORK_OUT','REFILL_IN','REFILL_OUT'];
 const cases=[[]];let layer=[[]];for(let d=0;d<3;d++){layer=layer.flatMap(a=>alphabet.map(t=>[...a,t]));cases.push(...layer);}
 for(const mode of ['MULTI_BRANCH','STOCK_REFILL']){const sql=(await db.query('select public.ba_allowed_event_types($1,array(select jsonb_array_elements_text(value))) as actions from jsonb_array_elements($2::jsonb)',[mode,JSON.stringify(cases)])).rows;for(let i=0;i<cases.length;i++){const current=[...await allowed({ba_mode:mode},events(cases[i]))];assert.deepEqual(sql[i].actions,current);if(oldAllowed&&mode==='MULTI_BRANCH')assert.deepEqual(current,[...await oldAllowed({ba_mode:mode},events(cases[i]))]);}}
});
await check('all reachable STOCK_REFILL prefixes preserve legitimate production rules',async()=>{
 let layer=[[]];for(let depth=0;depth<10;depth++){const next=[];for(const types of layer){const current=[...await allowed({ba_mode:'STOCK_REFILL'},events(types))];if(oldAllowed)assert.deepEqual(current,[...await oldAllowed({ba_mode:'STOCK_REFILL'},events(types))]);for(const type of current)next.push([...types,type]);}layer=next;}
 const id=await employee('STOCK_REFILL');await db.query("insert into attendance_events(employee_id,event_type,occurred_at,source)values($1,'BREAK_OUT',clock_timestamp(),'LIFF')",[id]);await reject(id,'WORK_IN');await reject(id,'REFILL_IN');
});
await check('strict full fixed cycle, no skip/reverse/duplicate/second break/new IN',async()=>{const id=await employee();for(const good of ['IN','BREAK_OUT','BREAK_IN','OUT']){for(const bad of ['IN','BREAK_OUT','BREAK_IN','OUT'].filter(x=>x!==good))await reject(id,bad);await submit(id,good);}for(const type of ['IN','BREAK_OUT','BREAK_IN','OUT'])await reject(id,type);});
await check('invalid legacy history fails closed and ADMIN state is counted',async()=>{const id=await employee();await db.query("insert into attendance_events(employee_id,event_type,occurred_at,source)values($1,'BREAK_OUT',clock_timestamp(),'ADMIN')",[id]);await reject(id,'IN');const id2=await employee();await db.query("insert into attendance_events(employee_id,event_type,occurred_at,source)values($1,'IN',clock_timestamp(),'ADMIN')",[id2]);await reject(id2,'IN');await submit(id2,'BREAK_OUT');});
await check('same key retries return original after state advanced; conflicting identity/type/source fail',async()=>{const id=await employee(),key=randomUUID(),first=await submit(id,'IN',key);await submit(id,'BREAK_OUT');assert.equal((await submit(id,'IN',key)).id,first.id);await assert.rejects(()=>submit(id,'BREAK_OUT',key),/IDEMPOTENCY_CONFLICT/);const other=await employee();await assert.rejects(()=>submit(other,'IN',key),/IDEMPOTENCY_CONFLICT/);await assert.rejects(()=>submit(id,'IN',key,db,{source:'EXTERNAL_WEB'}),/IDEMPOTENCY_CONFLICT/);});
await check('MULTI_BRANCH full two-branch cycle and only one break',async()=>{const id=await employee('MULTI_BRANCH');for(const t of ['DAY_IN','BRANCH_IN','BREAK_OUT','BREAK_IN','BRANCH_OUT'])await submit(id,t);await db.query("update attendance_events set occurred_at=occurred_at-interval '15 seconds' where employee_id=$1",[id]);await submit(id,'BRANCH_IN');await reject(id,'BREAK_OUT');await submit(id,'BRANCH_OUT');await submit(id,'DAY_OUT');await reject(id,'DAY_IN');});
await check('STOCK_REFILL before and after work; no refill during work; legacy IN/OUT',async()=>{const id=await employee('STOCK_REFILL');await submit(id,'REFILL_IN');await reject(id,'WORK_IN');await submit(id,'REFILL_OUT');await submit(id,'WORK_IN');await reject(id,'REFILL_IN');await reject(id,'WORK_OUT');for(const t of ['BREAK_OUT','BREAK_IN','WORK_OUT'])await submit(id,t);await db.query("update attendance_events set occurred_at=occurred_at-interval '15 seconds' where employee_id=$1",[id]);await submit(id,'REFILL_IN');await submit(id,'REFILL_OUT');await reject(id,'WORK_IN');const legacy=await employee('STOCK_REFILL');await db.query("insert into attendance_events(employee_id,event_type,occurred_at,source)values($1,'IN',clock_timestamp(),'ADMIN')",[legacy]);await submit(legacy,'BREAK_OUT');await submit(legacy,'BREAK_IN');await submit(legacy,'WORK_OUT');});
await check('office correction invalidates stale office and future correction fails closed',async()=>{const id=await employee();await submit(id,'IN');await assert.rejects(()=>submit(id,'BREAK_OUT',randomUUID(),db,{office:randomUUID()}),/ATTENDANCE_OFFICE_CHANGED/);await db.query("update attendance_events set occurred_at=clock_timestamp()+interval '10 minutes' where employee_id=$1",[id]);await reject(id,'BREAK_OUT');});
await check('soft-deleted history excluded; replay of removed event rejected',async()=>{const id=await employee(),key=randomUUID();await submit(id,'IN',key);await db.query('update attendance_events set deleted_at=now() where employee_id=$1',[id]);await assert.rejects(()=>submit(id,'IN',key),/IDEMPOTENCY_CONFLICT/);await submit(id,'IN');});
async function correctionFixture(side='IN',mode='STOCK_REFILL'){
 const id=await employee(mode),supervisor=randomUUID(),request=randomUUID();
 await db.query('insert into supervisors values($1::uuid,$1::text,true)',[supervisor]);
 await db.query('update employees set supervisor_id=$2 where id=$1',[id,supervisor]);
 await db.query("insert into attendance_correction_requests(id,employee_id,supervisor_id,request_date,request_side,office_id,reason)values($1,$2,$3,'2026-09-24',$4,$5,'test')",[request,id,supervisor,side,office]);
 return {id,supervisor,request};
}
async function review(f,start='11:00',end='20:00',client=db){return (await client.query("select public.ba_review_attendance_correction($1,$2::uuid,$2::text,'APPROVED','test correction',$3,$4) as result",[f.request,f.supervisor,start,end])).rows[0].result;}
await check('Previous-day correction regression: yesterday IN correction leaves today IN and break untouched',async()=>{
 const f=await correctionFixture();
 await db.query("insert into attendance_events(employee_id,event_type,occurred_at,source)values($1,'WORK_IN','2026-09-24 11:42+07','LIFF'),($1,'WORK_IN','2026-09-25 11:46+07','LIFF'),($1,'BREAK_OUT','2026-09-25 14:37+07','LIFF')",[f.id]);
 const first=await review(f);const q=await db.query("select event_type,occurred_at::text,deleted_at from attendance_events where employee_id=$1 order by occurred_at",[f.id]);assert.equal(q.rows.filter(x=>x.deleted_at).length,1);assert.equal(q.rows.filter(x=>!x.deleted_at).length,3);assert.equal(q.rows.at(-2).deleted_at,null);assert.equal(q.rows.at(-1).deleted_at,null);const again=await review(f);assert.equal(again.applied_event.id,first.applied_event.id);assert.equal(again.replayed,true);
});
await check('overnight OUT correction excludes next shift checkout',async()=>{
 const f=await correctionFixture('OUT','FIXED_BRANCH');await db.query("insert into attendance_events(employee_id,event_type,occurred_at,source)values($1,'OUT','2026-09-25 06:15+07','LIFF'),($1,'OUT','2026-09-25 23:00+07','LIFF')",[f.id]);await review(f,'22:00','06:00');const q=await db.query("select occurred_at::text,deleted_at from attendance_events where employee_id=$1 order by occurred_at",[f.id]);assert.equal(q.rows.length,3);assert.ok(q.rows[1].deleted_at);assert.equal(q.rows[2].deleted_at,null);
});
await check('correction failure rolls back replacements, audit and request status',async()=>{
 const f=await correctionFixture();await db.query("insert into attendance_events(employee_id,event_type,occurred_at,source,request_key)values($1,'WORK_IN','2026-09-24 11:00+07','LIFF',$2)",[f.id,'ATTENDANCE-REQUEST-'+f.request]);await assert.rejects(()=>review(f),/duplicate key/);assert.equal((await db.query('select deleted_at from attendance_events where employee_id=$1',[f.id])).rows[0].deleted_at,null);assert.equal((await db.query('select status from attendance_correction_requests where id=$1',[f.request])).rows[0].status,'PENDING');assert.equal((await db.query('select count(*)::int as n from audit_logs where actor_ref_id=$1',[f.supervisor])).rows[0].n,0);
});
await check('correction rejects unauthorized supervisor and employee RPC cannot claim ADMIN',async()=>{
 const f=await correctionFixture();await assert.rejects(()=>db.query("select public.ba_review_attendance_correction($1,$2,'wrong','APPROVED','test','11:00','20:00')",[f.request,f.supervisor]),/INVALID_SUPERVISOR/);await assert.rejects(()=>submit(f.id,'IN',randomUUID(),db,{source:'ADMIN'}),/INVALID_EMPLOYEE_SOURCE/);
});
await check('privileged admin insert supports historical correction, audit and idempotency',async()=>{
 const id=await employee(),key=randomUUID();const args=[id,'IN','2026-09-24 11:00+07',office,key,'correct start'];
 const sql='select (public.insert_attendance_event_admin($1,$2,$3,$4,$5,$6)).*';const first=(await db.query(sql,args)).rows[0];const second=(await db.query(sql,args)).rows[0];assert.equal(first.id,second.id);assert.equal(first.source,'ADMIN');assert.equal(first.edited,true);assert.equal((await db.query('select count(*)::int n from audit_logs where entity_id=$1',[first.id])).rows[0].n,1);
 await assert.rejects(()=>db.query(sql,[id,'OUT','2026-09-24 20:00+07',office,randomUUID(),'']),/ADMIN_CORRECTION_REASON_REQUIRED/);
 const grants=(await db.query("select has_function_privilege('anon','public.insert_attendance_event_admin(uuid,attendance_event_type,timestamptz,uuid,text,text)','execute') a,has_function_privilege('authenticated','public.ba_review_attendance_correction(uuid,uuid,text,text,text,time,time)','execute') b")).rows[0];assert.deepEqual(grants,{a:false,b:false});
});
const clients=await Promise.all(Array.from({length:8},async()=>{const c=pg.getPgClient();await c.connect();return c;}));
try{
await check('8 concurrent different-key IN requests insert exactly once',async()=>{const id=await employee();const results=await Promise.allSettled(clients.map(c=>submit(id,'IN',randomUUID(),c)));assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await db.query('select count(*)::int as n from attendance_events where employee_id=$1',[id])).rows[0].n,1);});
await check('8 concurrent same-key retries all succeed with one event',async()=>{const id=await employee(),key=randomUUID();const rows=await Promise.all(clients.map(c=>submit(id,'IN',key,c)));assert.equal(new Set(rows.map(x=>x.id)).size,1);});
await check('concurrent requests never produce an invalid prefix',async()=>{const id=await employee();await Promise.allSettled(clients.map((c,i)=>submit(id,['BREAK_IN','OUT','IN','BREAK_OUT'][i%4],randomUUID(),c)));const types=(await db.query('select event_type from attendance_events where employee_id=$1 order by occurred_at,created_at,id',[id])).rows.map(x=>x.event_type);assert.deepEqual(types,['IN','BREAK_OUT','BREAK_IN','OUT'].slice(0,types.length));});
await check('ADMIN correction lock blocks submit until latest corrected state is visible',async()=>{const id=await employee();await submit(id,'IN');const c=clients[0];await c.query('begin');await c.query("update attendance_events set event_type='BREAK_OUT',source='ADMIN' where employee_id=$1",[id]);let done=false;const pending=submit(id,'BREAK_OUT',randomUUID(),clients[1]).then(()=>{done=true;throw Error('Unexpected success')},e=>{done=true;assert.match(e.message,/INVALID_TRANSITION/);});await new Promise(r=>setTimeout(r,100));assert.equal(done,false);await c.query('commit');await pending;});
}finally{await Promise.all(clients.map(c=>c.end()));}
await check('RPC and helper unavailable to anon/authenticated',async()=>{const q=await db.query("select has_function_privilege('anon','public.insert_attendance_event_guarded(uuid,attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text)','execute') a,has_function_privilege('authenticated','public.insert_attendance_event_guarded(uuid,attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text)','execute') b");assert.deepEqual(q.rows[0],{a:false,b:false});});

const gps=async(id,type,key=randomUUID(),c=db)=> (await c.query('select (ba_request_gps_attendance($1::uuid,$1::text,$2,$3,$4,$5,13,100,2000)).*',[id,type,office,'Indoor GPS',key])).rows[0];
const reviewGps=async(id,status='APPROVED',c=db)=> (await c.query("select ba_review_gps_attendance($1,$2,'Verified at counter',null,'ADMIN_WEB',true) r",[id,status])).rows[0].r;
await check('GPS request does not insert attendance; approved request uses original server receipt time with audit',async()=>{const id=await employee();await submit(id,'IN');const req=await gps(id,'BREAK_OUT');assert.equal((await db.query('select count(*)::int n from attendance_events where employee_id=$1',[id])).rows[0].n,1);const out=await reviewGps(req.id);assert.equal(out.request.status,'APPROVED');const ev=(await db.query('select * from attendance_events where id=$1',[out.request.applied_event_id])).rows[0];assert.equal(+ev.occurred_at,+req.requested_at);assert.equal(ev.source,'ADMIN_APPROVED_GPS');assert.equal((await reviewGps(req.id)).replayed,true);await assert.rejects(()=>reviewGps(req.id,'REJECTED'),/ALREADY_REVIEWED/);});
await check('GPS requests reject skips, duplicate pending, wrong actor and repeated key for another event',async()=>{const id=await employee();await assert.rejects(()=>gps(id,'BREAK_OUT'),/INVALID_TRANSITION/);const key=randomUUID();const req=await gps(id,'IN',key);assert.equal((await gps(id,'IN',key)).id,req.id);await assert.rejects(()=>gps(id,'IN'),/GPS_REQUEST_PENDING/);await assert.rejects(()=>gps(id,'OUT',key),/IDEMPOTENCY_CONFLICT/);await assert.rejects(()=>db.query("select ba_request_gps_attendance($1,'someone-else','IN',$2,'reason','key',null,null,null)",[id,office]),/INVALID_EMPLOYEE/);});
await check('GPS approval rejects a changed history without deleting or duplicating any events',async()=>{const id=await employee();const req=await gps(id,'IN');await submit(id,'IN');await assert.rejects(()=>reviewGps(req.id),/HISTORY_CHANGED/);assert.equal((await db.query('select status from attendance_gps_requests where id=$1',[req.id])).rows[0].status,'PENDING');await reviewGps(req.id,'REJECTED');assert.equal((await db.query('select count(*)::int n from attendance_events where employee_id=$1',[id])).rows[0].n,1);});
await check('GPS review enforces supervisor ownership and functions have no public execute',async()=>{const id=await employee(),req=await gps(id,'IN');await assert.rejects(()=>db.query("select ba_review_gps_attendance($1,'APPROVED','test',$2,'actor',false)",[req.id,randomUUID()]),/INVALID_SUPERVISOR/);for(const role of ['anon','authenticated']){const q=await db.query("select has_function_privilege($1,'ba_review_gps_attendance(uuid,text,text,uuid,text,boolean)','execute') ok",[role]);assert.equal(q.rows[0].ok,false);}const q=await db.query("select has_function_privilege('service_role','ba_review_attendance_correction_core(uuid,uuid,text,text,text,time,time,boolean)','execute') ok");assert.equal(q.rows[0].ok,false);});
await check('admin can approve existing correction requests without impersonating a supervisor',async()=>{const id=await employee();const req=(await db.query("insert into attendance_correction_requests(employee_id,request_date,request_side,office_id,reason) values($1,current_date,'IN',$2,'test') returning id",[id,office])).rows[0];const q=(await db.query("select ba_admin_review_attendance_correction($1,'APPROVED','Verified','09:00','18:00') r",[req.id])).rows[0].r;assert.equal(q.request.status,'APPROVED');assert.equal(q.applied_event.source,'ADMIN_APPROVED_REQUEST');assert.equal((await db.query("select actor_role from audit_logs where entity_id=$1 and action='REVIEW'",[req.id])).rows[0].actor_role,'ADMIN');});
await check('concurrent GPS approvals create exactly one audited event',async()=>{const id=await employee(),req=await gps(id,'IN'),cs=Array.from({length:8},()=>pg.getPgClient());try{await Promise.all(cs.map(c=>c.connect()));const results=await Promise.all(cs.map(c=>reviewGps(req.id,'APPROVED',c)));assert.equal(new Set(results.map(x=>x.request.applied_event_id)).size,1);assert.equal((await db.query('select count(*)::int n from attendance_events where employee_id=$1',[id])).rows[0].n,1);}finally{await Promise.all(cs.map(c=>c.end()));}});
await check('legacy break requests cannot overwrite shift start/end through admin approval',async()=>{const id=await employee();const req=(await db.query("insert into attendance_correction_requests(employee_id,request_date,request_side,office_id,reason) values($1,current_date,'IN',$2,'ลืมกดกลับจากพัก') returning id",[id,office])).rows[0];await assert.rejects(()=>db.query("select ba_admin_review_attendance_correction($1,'APPROVED','Verified','09:00','18:00')",[req.id]),/ประเภทเป็นเข้า/);assert.equal((await db.query('select count(*)::int n from attendance_events where employee_id=$1',[id])).rows[0].n,0);assert.equal((await db.query('select status from attendance_correction_requests where id=$1',[req.id])).rows[0].status,'PENDING');});

await db.query("create type user_role as enum('EMPLOYEE','SUPERVISOR','ADMIN');alter table audit_logs alter column actor_role type user_role using actor_role::user_role");
await db.query(fs.readFileSync(new URL('supabase/migrations/202610050004_editable_attendance_requests.sql',root),'utf8'));
const day='2026-09-24';
const proposed=(type,time,replace=null)=>({event_type:type,occurred_at:`${day}T${time}:00+07:00`,office_id:office,replace_event_id:replace});
async function requestV2(id,side,events,key=randomUUID()){return (await db.query('select ba_submit_attendance_request_v2($1::uuid,$1::text,$2,$3,$4,$5,$6) r',[id,day,side,JSON.stringify(events),'Forgot break',key])).rows[0].r;}
async function contextV2(id,kind='correction',supervisor=null){return (await db.query('select ba_attendance_review_context_v2($1,$2,$3,$4,$5) r',[kind,id,supervisor,supervisor||'ADMIN_WEB',!supervisor])).rows[0].r;}
async function reviewV2(id,events,version,client=db,supervisor=null,kind='correction'){return (await client.query("select ba_review_attendance_request_v2($1,$2,'APPROVED','Verified actual time',$3,$4,$5,$6,$7) r",[kind,id,JSON.stringify(events),version,supervisor,supervisor||'ADMIN_WEB',!supervisor])).rows[0].r;}
async function startDay(id,type='IN'){await db.query("insert into attendance_events(employee_id,event_type,occurred_at,office_id,source)values($1,$2,'2026-09-24 09:00+07',$3,'LIFF')",[id,type,office]);}
await check('employee can request a single break or both with original times and idempotency',async()=>{
 const id=await employee(),pair=[proposed('BREAK_OUT','12:00'),proposed('BREAK_IN','13:00')],key=randomUUID();
 const r=await requestV2(id,'BREAK_BOTH',pair,key);assert.deepEqual(r.proposed_events,pair);assert.equal((await requestV2(id,'BREAK_BOTH',pair,key)).id,r.id);
 await assert.rejects(()=>requestV2(id,'BREAK_IN',[pair[1]],key),/IDEMPOTENCY_CONFLICT/);
 await requestV2(id,'BREAK_OUT',[pair[0]]);await requestV2(id,'BREAK_IN',[pair[1]]);
 await assert.rejects(()=>requestV2(id,'BREAK_BOTH',pair.toReversed()),/ออกพักก่อน/);
 await assert.rejects(()=>requestV2(id,'IN',[pair[0]]),/ประเภทคำขอ/);
 assert.equal((await db.query('select count(*)::int n from attendance_events where employee_id=$1',[id])).rows[0].n,0);
});
await check('admin repairs a mistyped legacy request into both break events without replacing IN',async()=>{
 const f=await correctionFixture('IN','FIXED_BRANCH');await startDay(f.id);const ctx=await contextV2(f.request),pair=[proposed('BREAK_OUT','12:00'),proposed('BREAK_IN','13:00')];
 const result=await reviewV2(f.request,pair,ctx.history_version);assert.equal(result.request.request_side,'IN');assert.equal(result.request.reason,'test');assert.deepEqual(result.request.reviewed_events,pair);assert.equal(result.request.applied_event_ids.length,2);
 assert.deepEqual((await db.query('select event_type from attendance_events where employee_id=$1 and deleted_at is null order by occurred_at',[f.id])).rows.map(x=>x.event_type),['IN','BREAK_OUT','BREAK_IN']);
 assert.equal((await reviewV2(f.request,pair,ctx.history_version)).replayed,true);
 await assert.rejects(()=>reviewV2(f.request,[pair[0]],ctx.history_version),/ดำเนินการแล้ว/);
});
await check('supervisor can approve own team only and explicit replacement retains audit',async()=>{
 const f=await correctionFixture('BREAK_OUT','FIXED_BRANCH');await startDay(f.id);await db.query("insert into attendance_events(employee_id,event_type,occurred_at,office_id,source)values($1,'BREAK_OUT','2026-09-24 12:00+07',$2,'LIFF')",[f.id,office]);
 await assert.rejects(()=>contextV2(f.request,'correction',randomUUID()),/ไม่มีสิทธิ์/);
 const ctx=await contextV2(f.request,'correction',f.supervisor),target=ctx.events[1].id;
 await reviewV2(f.request,[proposed('BREAK_OUT','12:15',target)],ctx.history_version,db,f.supervisor);
 assert.ok((await db.query('select deleted_at from attendance_events where id=$1',[target])).rows[0].deleted_at);
 assert.equal((await db.query("select count(*)::int n from audit_logs where entity_id=$1 and action='OVERRIDE_DELETE'",[target])).rows[0].n,1);
});
await check('stale review, wrong order and duplicate break leave request and attendance untouched',async()=>{
 const id=await employee();await startDay(id);const pair=[proposed('BREAK_OUT','12:00'),proposed('BREAK_IN','13:00')],r=await requestV2(id,'BREAK_BOTH',pair),ctx=await contextV2(r.id);
 await assert.rejects(()=>reviewV2(r.id,[pair[1]],ctx.history_version),/ลำดับเวลา/);
 await assert.rejects(()=>reviewV2(r.id,pair,'stale'),/ประวัติเปลี่ยน/);
 await assert.rejects(()=>reviewV2(r.id,[proposed('BREAK_OUT','08:00')],ctx.history_version),/ลำดับเวลา/);
 assert.equal((await contextV2(r.id)).request.status,'PENDING');assert.equal((await contextV2(r.id)).events.length,1);
});
await check('concurrent edited approvals create a single pair',async()=>{
 const id=await employee();await startDay(id);const pair=[proposed('BREAK_OUT','12:00'),proposed('BREAK_IN','13:00')],r=await requestV2(id,'BREAK_BOTH',pair),ctx=await contextV2(r.id),cs=Array.from({length:6},()=>pg.getPgClient());
 try{await Promise.all(cs.map(c=>c.connect()));const results=await Promise.all(cs.map(c=>reviewV2(r.id,pair,ctx.history_version,c)));assert.equal(new Set(results.map(x=>x.request.applied_event_ids.join(','))).size,1);assert.equal((await contextV2(r.id)).events.length,3);}finally{await Promise.all(cs.map(c=>c.end()));}
});
await check('editable review preserves STOCK_REFILL and MULTI_BRANCH break rules',async()=>{
 for(const mode of ['STOCK_REFILL','MULTI_BRANCH']){const id=await employee(mode);await startDay(id,mode==='STOCK_REFILL'?'WORK_IN':'DAY_IN');if(mode==='MULTI_BRANCH')await db.query("insert into attendance_events(employee_id,event_type,occurred_at,office_id,source)values($1,'BRANCH_IN','2026-09-24 10:00+07',$2,'LIFF')",[id,office]);const pair=[proposed('BREAK_OUT','12:00'),proposed('BREAK_IN','13:00')],r=await requestV2(id,'BREAK_BOTH',pair),ctx=await contextV2(r.id);await reviewV2(r.id,pair,ctx.history_version);assert.equal((await contextV2(r.id)).events.at(-1).event_type,'BREAK_IN');}
});
await check('new RPCs are service-only and invalid dates/replacement targets are rejected',async()=>{
 for(const role of ['anon','authenticated'])for(const fn of ['ba_submit_attendance_request_v2(uuid,text,date,text,jsonb,text,text)','ba_attendance_review_context_v2(text,uuid,uuid,text,boolean)','ba_review_attendance_request_v2(text,uuid,text,text,jsonb,text,uuid,text,boolean)'])assert.equal((await db.query("select has_function_privilege($1,$2,'execute') ok",[role,fn])).rows[0].ok,false);
 const id=await employee();await assert.rejects(()=>requestV2(id,'BREAK_OUT',[{...proposed('BREAK_OUT','12:00'),occurred_at:'2099-01-01T12:00:00+07:00'}]),/เวลาต้อง/);await assert.rejects(()=>requestV2(id,'BREAK_OUT',[proposed('BREAK_OUT','12:00',randomUUID())]),/รายการที่เลือกแก้/);
});

await check('new approval rolls back all events and status if auditing fails',async()=>{
 const id=await employee();await startDay(id);const pair=[proposed('BREAK_OUT','12:00'),proposed('BREAK_IN','13:00')],r=await requestV2(id,'BREAK_BOTH',pair),ctx=await contextV2(r.id);
 await db.query("create function fail_review_audit() returns trigger language plpgsql as $$begin if new.action='REVIEW' then raise exception 'TEST_AUDIT_FAILURE';end if;return new;end$$;create trigger fail_review_audit before insert on audit_logs for each row execute function fail_review_audit()");
 try{await assert.rejects(()=>reviewV2(r.id,pair,ctx.history_version),/TEST_AUDIT_FAILURE/);assert.equal((await contextV2(r.id)).request.status,'PENDING');assert.equal((await contextV2(r.id)).events.length,1);}finally{await db.query('drop trigger fail_review_audit on audit_logs;drop function fail_review_audit()');}
});
await check('GPS editable review preserves receipt and original type while recording reviewed events',async()=>{
 const id=await employee(),r=await gps(id,'IN'),ctx=await contextV2(r.id,'gps');
 const events=[{event_type:'IN',occurred_at:r.requested_at.toISOString(),office_id:office,replace_event_id:null}];
 const result=await reviewV2(r.id,events,ctx.history_version,db,null,'gps');assert.equal(result.request.event_type,'IN');assert.equal(+new Date(result.request.requested_at),+r.requested_at);assert.deepEqual(result.request.reviewed_events,events);assert.equal(result.request.applied_event_ids.length,1);
});

await db.query('alter table offices add column latitude numeric default 13, add column longitude numeric default 100, add column radius_meters numeric default 200');
await db.query(fs.readFileSync(new URL('supabase/migrations/202610090001_atomic_geofence.sql',root),'utf8'));
const geo=async(id,type,opts={})=>(await (opts.client||db).query('select * from public.insert_attendance_event_geofenced($1,$2,clock_timestamp(),$3,$4,$5,$6,999999,$7,$8,$9,$10)',[id,type,opts.office||office,opts.lat??13,opts.lon??100,opts.accuracy??20,opts.source||'LIFF',opts.actor||id,opts.key||randomUUID(),opts.fix===undefined?new Date():opts.fix])).rows[0];
await check('geofence validates raw fixes and recomputes stored distance',async()=>{
 for(const opts of [{lat:91},{lon:460},{lat:NaN},{accuracy:-1},{accuracy:NaN},{accuracy:201},{fix:null},{fix:new Date(Date.now()-61000)},{fix:new Date(Date.now()+10000)},{lon:100.1}]){const id=await employee();await assert.rejects(()=>geo(id,'IN',opts),/GPS_/);assert.equal((await db.query('select count(*)::int n from attendance_events where employee_id=$1',[id])).rows[0].n,0);}
 const id=await employee(),key=randomUUID();const event=await geo(id,'IN',{key});assert.equal(Number(event.distance_meters),0);await db.query('update offices set active=false where id=$1',[office]);try{assert.equal((await geo(id,'IN',{key,fix:null})).id,event.id);await assert.rejects(()=>geo(id,'BREAK_OUT'),/GPS_OFFICE_UNAVAILABLE/);}finally{await db.query('update offices set active=true where id=$1',[office]);}
});
await check('geofence binds multi-branch and refill exits to their active visit',async()=>{
 const other=randomUUID();await db.query('insert into offices(id,latitude,longitude,radius_meters)values($1,13,100.1,200)',[other]);
 const m=await employee('MULTI_BRANCH');await geo(m,'DAY_IN');await geo(m,'BRANCH_IN');await assert.rejects(()=>geo(m,'BRANCH_OUT',{office:other,lon:100.1}),/ATTENDANCE_OFFICE_CHANGED/);await assert.rejects(()=>geo(m,'BREAK_OUT',{office:other,lon:100.1}),/ATTENDANCE_OFFICE_CHANGED/);await geo(m,'BREAK_OUT');await geo(m,'BREAK_IN');await geo(m,'BRANCH_OUT');
 const r=await employee('STOCK_REFILL');await geo(r,'REFILL_IN');await assert.rejects(()=>geo(r,'REFILL_OUT',{office:other,lon:100.1}),/ATTENDANCE_OFFICE_CHANGED/);await geo(r,'REFILL_OUT');await geo(r,'WORK_IN');
 const f=await employee();await geo(f,'IN');await db.query('update offices set active=false where id=$1',[office]);try{await assert.rejects(()=>geo(f,'BREAK_OUT',{office:other,lon:100.1}),/ATTENDANCE_OFFICE_CHANGED/);await assert.rejects(()=>geo(f,'BREAK_OUT'),/GPS_OFFICE_UNAVAILABLE/);}finally{await db.query('update offices set active=true where id=$1',[office]);}
});
await check('new geofence RPC restricts privileges and old service bypass is closed',async()=>{
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'public.insert_attendance_event_geofenced(uuid,attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text,timestamptz)','execute') ok",[role])).rows[0].ok,false);
 assert.equal((await db.query("select has_function_privilege('service_role','public.insert_attendance_event_guarded(uuid,attendance_event_type,timestamptz,uuid,numeric,numeric,numeric,numeric,text,text,text)','execute') ok")).rows[0].ok,false);
});
await check('geofenced concurrent retries insert once and distinct double clicks reject',async()=>{
 const id=await employee(),key=randomUUID(),cs=Array.from({length:6},()=>pg.getPgClient());
 try{await Promise.all(cs.map(c=>c.connect()));const results=await Promise.all(cs.map(client=>geo(id,'IN',{key,client})));assert.equal(new Set(results.map(x=>x.id)).size,1);
 const attempts=await Promise.allSettled(cs.map(client=>geo(id,'BREAK_OUT',{client})));assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await db.query('select count(*)::int n from attendance_events where employee_id=$1',[id])).rows[0].n,2);
 }finally{await Promise.all(cs.map(c=>c.end()));}
});
await check('geofenced insert rechecks office configuration after concurrent update',async()=>{
 const id=await employee(),c=pg.getPgClient();await c.connect();
 try{await c.query('begin');await c.query('update offices set active=false where id=$1',[office]);
 const pending=geo(id,'IN').then(()=>null,e=>e);await c.query('commit');assert.match(String(await pending),/GPS_OFFICE_UNAVAILABLE/);
 assert.equal((await db.query('select count(*)::int n from attendance_events where employee_id=$1',[id])).rows[0].n,0);
 }finally{await c.query('rollback');await c.end();await db.query('update offices set active=true where id=$1',[office]);}
});
console.log(`${passed} test groups passed`);
}finally{if(db)await db.end();await pg.stop();}
