async function allowed(emp:any,events:any[]){
  // v4.6.0
  // State ของปุ่มลงเวลาต้องอ้างอิง attendance_events จริงเท่านั้น
  // ห้ามใช้ daily_summaries.break_minutes หรือค่าพัก 60 นาทีที่ระบบปัดเพื่อการคำนวณ
  // Event จาก ADMIN และ LIFF มีผลต่อ state เหมือนกันทุกประการ

  const sorted=(events||[])
    .filter((x:any)=>x && x.event_type)
    .sort((a:any,b:any)=>{
      const at=new Date(a.occurred_at||0).getTime();
      const bt=new Date(b.occurred_at||0).getTime();
      return at-bt;
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
    const hasIn=types.includes('IN');
    const hasBreakOut=types.includes('BREAK_OUT');
    const hasBreakIn=types.includes('BREAK_IN');
    const hasOut=types.includes('OUT');

    if(!hasIn)return ['IN'];
    if(hasOut)return [];

    // มี IN จริงแล้ว แต่ยังไม่มี BREAK_OUT จริง -> ต้องเห็นปุ่มออกพัก
    if(!hasBreakOut)return ['BREAK_OUT'];

    // ออกพักจริงแล้ว แต่ยังไม่มี BREAK_IN จริง -> ต้องเห็นปุ่มกลับจากพัก
    if(hasBreakOut&&!hasBreakIn)return ['BREAK_IN'];

    // พักครบจริงแล้วจึงอนุญาตให้ออกงาน
    if(hasBreakOut&&hasBreakIn)return ['OUT'];

    return [];
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
function dateCompare() {}
