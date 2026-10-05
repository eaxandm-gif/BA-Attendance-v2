/* Shared administrator/supervisor editor. The server authorizes and validates every write. */
(() => {
 const names={IN:'เข้างาน',OUT:'ออกงาน',BREAK_OUT:'ออกพัก',BREAK_IN:'กลับจากพัก',BREAK_BOTH:'ออกพักและกลับจากพัก',DAY_IN:'เริ่มวัน',DAY_OUT:'จบวัน',WORK_IN:'เข้างาน',WORK_OUT:'ออกงาน',BRANCH_IN:'เข้าสาขา',BRANCH_OUT:'ออกสาขา',REFILL_IN:'เข้าเติมของ',REFILL_OUT:'ออกจากเติมของ'};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const time=v=>v?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(v)):'';
 function choices(mode){return mode==='MULTI_BRANCH'?['DAY_IN','BRANCH_IN','BREAK_OUT','BREAK_IN','BRANCH_OUT','DAY_OUT']:mode==='STOCK_REFILL'?['WORK_IN','BREAK_OUT','BREAK_IN','WORK_OUT','REFILL_IN','REFILL_OUT']:['IN','BREAK_OUT','BREAK_IN','OUT'];}
 function canonical(t,mode){return ['IN','OUT'].includes(t)?mode==='STOCK_REFILL'?'WORK_'+t:mode==='MULTI_BRANCH'?'DAY_'+t:t:t;}
 async function open({kind,id,request,mount,onDone,decision='APPROVED'}){
  mount('<div class="item">กำลังโหลดคำขอและประวัติ...</div>');
  try{
   const ctx=await request('attendance_review_context',{kind,request_id:id}),r=ctx.request,mode=ctx.employee.ba_mode;
   const original=Array.isArray(r.proposed_events)?r.proposed_events:kind==='gps'?[{event_type:r.event_type,occurred_at:r.requested_at,office_id:r.office_id}]:[{event_type:r.request_side,office_id:r.office_id}];
   mount(`<div class="title"><b>ตรวจแก้ก่อนอนุมัติ · ${esc(ctx.employee.employee_code)} ${esc(ctx.employee.display_name)}</b></div><div class="item"><b>คำขอต้นฉบับ · ${esc(ctx.date)}</b><br>${original.map(x=>`${esc(names[x.event_type]||x.event_type)} ${esc(time(x.occurred_at)||'ยังไม่ระบุเวลาจริง')} · ${esc(ctx.offices.find(o=>o.id===x.office_id)?.office_name||'-')}`).join('<br>')}<br>เหตุผล: ${esc(r.reason)}</div><div class="item"><b>ประวัติของวันนั้น</b>${ctx.events.map(x=>`<div>${esc(time(x.occurred_at))} · ${esc(names[x.event_type])} · ${esc(ctx.offices.find(o=>o.id===x.office_id)?.office_name||'-')}</div>`).join('')||'<div>ยังไม่มีรายการ</div>'}</div><p>ระบุเวลาจริงที่ตรวจสอบแล้วตามเวลาไทย วันที่ ${esc(ctx.date)} หากแก้รายการที่มีอยู่ ต้องเลือก “แก้รายการเดิม” ให้ตรงรายการ ระบบจะเก็บประวัติเดิมไว้</p><div id="reviewRows"></div><button id="reviewAdd">เพิ่มอีก 1 รายการ เช่น กลับจากพัก</button><div class="field"><label>ผลตรวจสอบ</label><select id="reviewStatus"><option value="APPROVED">อนุมัติตามข้อมูลที่ตรวจแก้</option><option value="REJECTED">ปฏิเสธคำขอ</option></select></div><div class="field"><label>เหตุผลการอนุมัติ/สิ่งที่แก้ไข</label><textarea id="reviewReason" maxlength="2000"></textarea></div><label><input id="reviewConfirmed" type="checkbox"> ตรวจสอบวัน เวลา สาขา และประวัติแล้ว</label><div id="reviewError" role="alert" class="error"></div><div class="grid"><button class="primary" id="reviewSave">ยืนยันข้อมูลและบันทึกผล</button><button id="reviewBack">กลับรายการคำขอ</button></div>`);
   const $=id=>document.getElementById(id);let count=0,busy=false;
   function addRow(x={}){
    if(count>=2)return;const n=count++,row=document.createElement('div');row.className='item';row.dataset.reviewRow=String(n);
    const t=canonical(x.event_type||choices(mode)[0],mode);
    row.innerHTML=`<b>รายการที่ ${n+1}</b><div class="field"><label>เพิ่มหรือแก้รายการ</label><select data-field="replace"><option value="">เพิ่มรายการที่ขาด</option>${ctx.events.map(e=>`<option value="${esc(e.id)}">แก้รายการเดิม: ${esc(time(e.occurred_at))} ${esc(names[e.event_type])}</option>`).join('')}</select></div><div class="field"><label>ประเภท</label><select data-field="type">${choices(mode).map(v=>`<option value="${v}" ${v===t?'selected':''}>${names[v]}</option>`).join('')}</select></div><div class="field"><label>เวลาจริง (เวลาไทย)</label><input data-field="time" type="time" step="1" value="${esc(time(x.occurred_at))}"></div><div class="field"><label>สาขา</label><select data-field="office">${ctx.offices.map(o=>`<option value="${esc(o.id)}" ${o.id===(x.office_id||r.office_id)?'selected':''}>${esc(o.office_name)}</option>`).join('')}</select></div>${n?'<button data-remove>ลบรายการที่ 2</button>':''}`;
    row.querySelector('[data-field="replace"]').onchange=ev=>{const item=ctx.events.find(e=>e.id===ev.target.value);if(item){row.querySelector('[data-field="type"]').value=canonical(item.event_type,mode);row.querySelector('[data-field="time"]').value=time(item.occurred_at);row.querySelector('[data-field="office"]').value=item.office_id;}};
    row.querySelector('[data-remove]')?.addEventListener('click',()=>{row.remove();count--;$('reviewAdd').disabled=false;});
    $('reviewRows').appendChild(row);$('reviewAdd').disabled=count>=2;
   }
   original.slice(0,2).forEach(addRow);$('reviewStatus').value=decision;
   $('reviewAdd').onclick=()=>addRow({event_type:'BREAK_IN'});$('reviewBack').onclick=()=>{if(!busy)onDone();};
   $('reviewSave').onclick=async()=>{
    if(busy)return;$('reviewError').textContent='';
    try{
     const status=$('reviewStatus').value,reason=$('reviewReason').value.trim();
     if(!reason)throw Error('กรุณาระบุเหตุผลหรือสิ่งที่ตรวจแก้');
     if(!$('reviewConfirmed').checked)throw Error('กรุณายืนยันว่าได้ตรวจสอบข้อมูลแล้ว');
     const events=status==='APPROVED'?Array.from($('reviewRows').children).map(row=>{
      const val=n=>row.querySelector(`[data-field="${n}"]`).value,tm=val('time');if(!tm)throw Error('กรุณาระบุเวลาจริงทุกรายการ');
      return {event_type:val('type'),occurred_at:`${ctx.date}T${tm.length===5?tm+':00':tm}+07:00`,office_id:val('office'),replace_event_id:val('replace')||null};
     }):null;
     busy=true;$('reviewSave').disabled=true;
     await request('review_attendance_request',{kind,request_id:id,status,reason,events,history_version:ctx.history_version});
     mount('<div class="item">บันทึกผลแล้ว กำลังโหลดรายการ...</div>');await onDone();
    }catch(e){const box=$('reviewError');if(box)box.textContent=e.message;busy=false;const btn=$('reviewSave');if(btn)btn.disabled=false;}
   };
  }catch(e){mount(`<div class="item error">${esc(e.message)}</div><button id="reviewBack">กลับรายการคำขอ</button>`);document.getElementById('reviewBack').onclick=onDone;}
 }
 window.AttendanceReview={open,names,choices,canonical};
})();
