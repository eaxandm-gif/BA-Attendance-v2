import {JSDOM} from 'jsdom';import fs from 'node:fs';import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),read=n=>fs.readFileSync(new URL(n,root),'utf8');
const dom=new JSDOM('<main><select id="status"><option>APPROVED</option><option value="SICK_LEAVE">SICK_LEAVE</option></select><div class="field"><label>เหตุผล</label><input id="reason"></div></main>',{runScripts:'outside-only',pretendToBeVisual:true,url:'https://example.test'});
dom.window.eval(read('ui.js'));assert.equal(dom.window.document.querySelector('option').value,'APPROVED');assert.equal(dom.window.document.querySelector('option').textContent,'อนุมัติแล้ว');assert.equal(dom.window.document.querySelector('label').htmlFor,'reason');assert.equal(dom.window.BA_UI.label('SICK_LEAVE'),'ลาป่วย');dom.window.document.body.insertAdjacentHTML('beforeend','<button data-request-category="attendance">คำขอ</button>');dom.window.BA_UI.registerRequests('attendance',[{id:'one',status:'PENDING'},{id:'two',status:'PENDING'}]);assert.equal(dom.window.document.querySelectorAll('.unread-dot').length,1);dom.window.BA_UI.markRead('one');assert.equal(dom.window.document.querySelectorAll('.unread-dot').length,1);dom.window.BA_UI.markRead('two');assert.equal(dom.window.document.querySelectorAll('.unread-dot').length,0);
await new Promise(resolve=>setTimeout(resolve,50));dom.window.dispatchEvent(new dom.window.Event('beforeunload'));dom.window.close();
console.log('PASS Thai display labels preserve internal option values and associate form labels');
const index=read('index.html'),source=[...index.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n');
assert.doesNotMatch(index,/<dt>พักรวม/);
assert.match(index,/<dt>ออกพัก<\/dt>/);
assert.match(index,/<dt>กลับจากพัก<\/dt>/);
const summaryMarkup=index.split('<dl class="summary-details">')[1].split('</dl>')[0];
assert.deepEqual([...summaryMarkup.matchAll(/<dt>(.*?)<\/dt>/g)].slice(0,8).map(x=>x[1]),[
 'เข้างาน','ออกงาน','ออกพัก','กลับจากพัก',
 'ทำงาน (ชั่วโมง:นาที)','เติมสินค้า (ชั่วโมง:นาที)',
 'เวลาเกิน (ชั่วโมง:นาที)','เวลาขาด (ชั่วโมง:นาที)'
]);
const home=new JSDOM('<main id="employeeView"></main>',{runScripts:'outside-only',pretendToBeVisual:true,url:'https://example.test'});home.window.eval(read('ui.js'));home.window.eval(source.replace("window.addEventListener('load',init)",''));
for(const [mode,actions] of [['FIXED_BRANCH',['BREAK_OUT']],['MULTI_BRANCH',['BRANCH_IN','DAY_OUT']],['STOCK_REFILL',['REFILL_IN','WORK_OUT']]]){home.window.eval(`paintEmployeeHome(${JSON.stringify({state:{label:'IN'},allowed_actions:actions,timeline:[],summary:{credited_minutes:0}})})`);assert.equal(home.window.document.querySelectorAll('#actionGrid button').length,actions.length);}
home.window.eval("paintEmployeeHome({state:{label:'OUT'},allowed_actions:[],timeline:[]})");assert.equal(home.window.document.querySelectorAll('#actionGrid button').length,0);assert.match(home.window.document.body.textContent,/ยังไม่มีข้อมูล/);await new Promise(resolve=>setTimeout(resolve,50));home.window.dispatchEvent(new home.window.Event('beforeunload'));home.window.close();
console.log('PASS redesigned home preserves server actions for all three modes and unknown summary values');
const luminance=hex=>{const c=hex.match(/\w\w/g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
for(const [fg,bg] of [['54233A','F0ADC5'],['736775','FFFFFF'],['332B35','FAF8FA'],['675C69','ECE5EB'],['223452','FFFFFF']]){const a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);assert.ok(ratio>=4.5,`${fg}/${bg} contrast ${ratio}`);}
console.log('PASS primary, muted, body, disabled and secondary text contrast meets 4.5:1');
