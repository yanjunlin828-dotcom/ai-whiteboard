import {BoardController} from '../src/controller';
const result=document.querySelector('#result')!;
const check=(ok:unknown,message:string)=>{if(!ok)throw new Error(message)};
const control=async(action:string,report?:unknown)=>{const r=await fetch('/qa/recovery-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,report})});if(!r.ok)throw new Error('QA control failed');return r.json()};
const key='stage6-recovery-checkpoint';
async function run(resume=false){
 const c=new BoardController('stage6-recovery-isolated');
 try{
  await c.start();check(c.getSnapshot().writable,'独立编辑会话未取得');
  if(!resume){
   c.title('磁盘完整版本');await c.flush();check(c.getSnapshot().status==='saved','基线未保存');
   const before=c.getSnapshot().revision;
   await control('fail');c.title('刷新后恢复中文草稿 α');await c.flush();
   check(c.getSnapshot().status==='error','保存失败误报成功');
   const disk=await control('resume');check(disk.revision===before&&disk.title==='磁盘完整版本','失败改变磁盘');
   sessionStorage.setItem(key,JSON.stringify({before}));
   // Remove this test controller's navigation guard before deliberately simulating a page interruption.
   c.stop();location.reload();return;
  }
  const {before}=JSON.parse(sessionStorage.getItem(key)!);
  check(c.getSnapshot().recovery?.title==='刷新后恢复中文草稿 α','刷新后没有发现草稿');
  check(c.getSnapshot().revision===before,'磁盘版本被草稿覆盖');
  await control('healthy');c.recover();await c.flush();
  check(c.getSnapshot().status==='saved'&&c.getSnapshot().title==='刷新后恢复中文草稿 α','草稿恢复未保存');
  const report={passed:true,realPageReload:true,saveFailureVisible:true,priorDiskPreserved:true,draftDetected:true,draftRecovered:true,revision:c.getSnapshot().revision};
  await control('report',report);sessionStorage.setItem(key,JSON.stringify({done:true}));result.textContent=JSON.stringify(report,null,2);
 }catch(error){result.textContent=String(error);await control('report',{passed:false,error:String(error)});}finally{c.stop();}
}
document.querySelector('#start')!.addEventListener('click',()=>{result.textContent='验收中…';void run()});
const pending=sessionStorage.getItem(key);if(pending&&!JSON.parse(pending).done)void run(true);
