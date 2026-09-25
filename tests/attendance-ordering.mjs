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
const employee=async(mode='FIXED_BRANCH')=>{const id=randomUUID();await db.query('insert into employees values($1,$2,true,$3)',[id,mode,id]);return id;};
const office=randomUUID();
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
console.log(`${passed} test groups passed`);
}finally{if(db)await db.end();await pg.stop();}
