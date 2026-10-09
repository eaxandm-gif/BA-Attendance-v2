// Regression checks against the actual submit handler.
// Uses synthetic branches and a mocked RPC; never contacts production.
import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';import assert from 'node:assert/strict';
const src=fs.readFileSync(new URL('../supabase/functions/ba-api/index.ts',import.meta.url),'utf8');
const helpers=src.slice(src.indexOf('function distance('),src.indexOf('function cleanShiftReference'));
const block=src.slice(src.indexOf(" if(action==='submit_attendance'){"),src.indexOf(" if(action==='my_history'){"));
const A={id:'branch-A',office_name:'Synthetic A',latitude:13,longitude:100,radius_meters:200},B={...A,id:'branch-B',office_name:'Synthetic B',longitude:100.1};
async function simulate(mode,events,offices,p){let inserted=null;const sb={from(name){let replay=false;const q={select(){return q},eq(key){if(key==='request_key')replay=true;return q},is(){return q},gte(){return q},lt(){return q},order(){return q},maybeSingle(){return q},then(resolve){resolve({data:name==='offices'?offices:replay?null:events,error:null})}};return q},async rpc(name,args){inserted=args;return {data:{id:'fake'},error:null}}};const c=vm.createContext({sb,id:{ref:{id:'synthetic-employee',ba_mode:mode},profile:{sub:'synthetic-actor'},auth_mode:'LINE'},json:(body,status=200)=>({body,status}),fail:(message,status=400)=>({body:{message},status}),thaiDate:()=> '2026-10-09'});vm.runInContext(stripTypeScriptTypes(helpers+'\nasync function run(p){const action="submit_attendance";'+block+'}'),c);const response=await c.run({request_key:'synthetic-key',location_timestamp:Date.now(),latitude:13,longitude:100.1,accuracy:10,...p});return {response,inserted};}
const ev=(event_type,office_id='branch-A')=>({event_type,office_id});

let r=await simulate('MULTI_BRANCH',[ev('DAY_IN'),ev('BRANCH_IN')],[A,B],{type:'BRANCH_OUT'});assert.equal(r.response.body.code,'GPS_OUTSIDE');assert.equal(r.inserted,null);
r=await simulate('STOCK_REFILL',[ev('REFILL_IN')],[A,B],{type:'REFILL_OUT'});assert.equal(r.response.body.code,'GPS_OUTSIDE');assert.equal(r.inserted,null);
r=await simulate('FIXED_BRANCH',[ev('IN'),ev('BREAK_OUT'),ev('BREAK_IN')],[B],{type:'OUT'});assert.equal(r.response.body.code,'GPS_OFFICE_UNAVAILABLE');assert.equal(r.inserted,null);
for(const coords of [{longitude:460},{latitude:91},{latitude:null},{longitude:''}]){r=await simulate('FIXED_BRANCH',[],[A],{type:'IN',longitude:100,...coords});assert.equal(r.inserted,null);assert.equal(r.response.status,400);}
const near={...A,radius_meters:50,latitude:13+80/111195},far={...B,radius_meters:200,longitude:100,latitude:13+120/111195};
r=await simulate('FIXED_BRANCH',[],[near,far],{type:'IN',longitude:100});assert.equal(r.inserted?.p_office_id,'branch-B');
for(const timestamp of [undefined,Date.now()-61000,Date.now()+10000]){r=await simulate('FIXED_BRANCH',[],[A],{type:'IN',longitude:100,location_timestamp:timestamp});assert.equal(r.response.body.code,'GPS_STALE');}
r=await simulate('MULTI_BRANCH',[ev('DAY_IN'),ev('BRANCH_IN'),ev('BRANCH_OUT'),ev('BRANCH_IN','branch-B')],[A,B],{type:'BREAK_OUT'});assert.equal(r.inserted?.p_office_id,'branch-B');
r=await simulate('STOCK_REFILL',[ev('REFILL_IN')],[A,B],{type:'REFILL_OUT',longitude:100});assert.equal(r.inserted?.p_office_id,'branch-A');
console.log('PASS geofence API: all five audited bugs, stale/missing/future fixes, current multi-branch visit and valid refill exit');
