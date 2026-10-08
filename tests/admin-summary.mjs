import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../admin.html',import.meta.url),'utf8');const start=html.indexOf('function bangkokDateKey('),end=html.indexOf('function buildMonthlyMatrix(',start);
const DATA={daily:[],schedules:[],leaves:[],attendance:[],shifts:[]},ctx=vm.createContext({DATA,Intl,Date,Set,Map});vm.runInContext(html.slice(start,end),ctx);
const date='2026-09-24',emp={id:'test',ba_mode:'STOCK_REFILL'};
const event=(event_type,time)=>({employee_id:emp.id,event_type,occurred_at:`${date}T${time}:00+07:00`});
DATA.attendance=[event('REFILL_IN','09:40'),event('REFILL_OUT','11:15'),event('WORK_IN','11:55')];DATA.daily=[{employee_id:emp.id,work_date:date,first_in:`${date}T11:55:00+07:00`,last_out:null,status:'WORKING'}];
let r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.first_in,'11:55');assert.equal(r.last_out,'');assert.equal(r.status,'WORKING');
DATA.daily=[];r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.first_in,'11:55');assert.equal(r.last_out,'');assert.equal(r.credited_minutes,0);
DATA.attendance.push(event('WORK_OUT','20:00'),event('REFILL_IN','21:00'),event('REFILL_OUT','22:00'));r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.last_out,'20:00');
console.log('PASS refill before/after work never becomes shift boundary, with or without summary');
emp.ba_mode='MULTI_BRANCH';DATA.attendance=[event('DAY_IN','09:00'),event('BRANCH_IN','10:00'),event('BRANCH_OUT','11:00')];r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.first_in,'09:00');assert.equal(r.last_out,'');DATA.attendance.push(event('DAY_OUT','20:00'));assert.equal(ctx.summaryForEmployeeDate(emp,date).last_out,'20:00');
console.log('PASS branch exit does not mean day checkout');
emp.ba_mode='FIXED_BRANCH';DATA.attendance=[event('IN','11:00'),event('BREAK_OUT','12:00'),event('BREAK_IN','13:00'),event('OUT','20:00')];r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.first_in,'11:00');assert.equal(r.last_out,'20:00');
DATA.daily=[{employee_id:emp.id,work_date:date,first_in:null,last_out:null,status:'NOT_STARTED'}];r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.first_in,'');assert.equal(r.last_out,'');
console.log('PASS fixed branch unaffected; null summary boundaries are authoritative');
emp.ba_mode='STOCK_REFILL';DATA.daily=[];DATA.attendance=[event('REFILL_IN','09:00'),event('REFILL_OUT','10:00')];const map=new Map([[`${emp.id}:${date}`,DATA.attendance]]);assert.equal(ctx.matrixStatusForDate(emp,date,map),'INC');
console.log('PASS historical monthly matrix does not treat refill pair as completed work');
emp.ba_mode='MULTI_BRANCH';emp.default_shift_id="'Noon12'::text";
DATA.daily=[];DATA.attendance=[event('DAY_IN','10:50'),event('BREAK_OUT','15:15'),event('BREAK_IN','16:13'),event('DAY_OUT','21:01')];
r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.over_minutes,0);assert.equal(r.credited_minutes,0);assert.match(r.issue,/รอคำนวณ/);
DATA.daily=[{employee_id:emp.id,work_date:date,status:'COMPLETED',required_minutes:540,credited_minutes:611,over_minutes:71,short_minutes:0,net_minutes:71,break_minutes:60}];
r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.over_minutes,71);assert.equal(r.credited_minutes,611);
DATA.daily[0].credited_minutes=0;DATA.daily[0].work_minutes=611;DATA.daily[0].over_minutes=0;DATA.daily[0].net_minutes=0;
r=ctx.summaryForEmployeeDate(emp,date);assert.equal(r.credited_minutes,0);assert.equal(r.over_minutes,0);assert.equal(r.net_minutes,0);
console.log('PASS missing daily summary never turns full workday into OT; actual early arrival and explicit zero values are preserved');
DATA.attendance=[];DATA.schedules=[];DATA.daily=[{employee_id:emp.id,work_date:date,status:'ABSENT',over_minutes:0}];
for(const leave_type of ['SICK_LEAVE','BUSINESS_LEAVE','VACATION']){
 DATA.leaves=[{employee_id:emp.id,leave_date:date,status:'APPROVED',leave_type}];assert.equal(ctx.summaryForEmployeeDate(emp,date).status,leave_type);
 DATA.daily=[];assert.equal(ctx.summaryForEmployeeDate(emp,date).status,leave_type);
 DATA.daily=[{employee_id:emp.id,work_date:date,status:'ABSENT'}];
}
for(const status of ['PENDING','REJECTED']){DATA.leaves=[{employee_id:emp.id,leave_date:date,status,leave_type:'SICK_LEAVE'}];assert.equal(ctx.summaryForEmployeeDate(emp,date).status,'ABSENT');}
DATA.leaves=[{employee_id:'someone-else',leave_date:date,status:'APPROVED',leave_type:'SICK_LEAVE'}];assert.equal(ctx.summaryForEmployeeDate(emp,date).status,'ABSENT');
console.log('PASS approved leave overrides stale ABSENT or missing summaries; pending/rejected and other employees do not');
