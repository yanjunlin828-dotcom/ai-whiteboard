import {BoardController} from '../src/controller';
const output=document.querySelector('#result')!;
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const control=async(action:string,report?:unknown)=>{const r=await fetch('/qa/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,report})});if(!r.ok)throw Error('QA control failed');};
const key='stage7-controller-checkpoint';
async function run(resume=false){
 const c=new BoardController('stage7-controller-drafts');
 try{
  await c.start();check(c.getSnapshot().writable,'未取得测试编辑权');
  if(!resume){
   const a=(await c.createBoard()).board,b=(await c.createBoard()).board;
   await c.leaveEditor(a.boardId);c.title('草稿 A 基线');await c.flush();
   await control('fail-on');c.title('草稿 A 失败');await c.flush();
   check(c.getSnapshot().status==='error','失败没有提示');
   let prevented=false;try{await c.leaveEditor(b.boardId);}catch{prevented=true;}
   check(prevented&&c.getSnapshot().board?.boardId===a.boardId,'保存失败没有阻止切板');
   // Regression: returning exactly to the baseline must not strand a pending failed save.
   c.title('草稿 A 基线');await control('fail-off');await c.flush();await c.flush();
   check(c.getSnapshot().status==='saved','改回原名后待保存请求未解决');
   await c.leaveEditor(b.boardId);c.title('草稿 B 内容');await c.flush();
   await c.leaveEditor(a.boardId);check(c.getSnapshot().title==='草稿 A 基线'&&!c.getSnapshot().recovery,'切回 A 混入 B 草稿');
   await control('fail-on');c.title('草稿 A 刷新恢复');await c.flush();
   sessionStorage.setItem(key,JSON.stringify({a:a.boardId,b:b.boardId}));
   await control('fail-off');await control('expire-test-lease');c.stop();location.reload();return;
  }
  const {a,b}=JSON.parse(sessionStorage.getItem(key)!);
  check(c.getSnapshot().board?.boardId===a&&c.getSnapshot().recovery?.title==='草稿 A 刷新恢复','刷新没有找到 A 的独立草稿');
  c.recover();await c.flush();check(c.getSnapshot().status==='saved','恢复后未保存');
  await c.leaveEditor(b);check(c.getSnapshot().title==='草稿 B 内容'&&!c.getSnapshot().recovery,'恢复 A 改变了 B');
  await c.leaveEditor(a);check(c.getSnapshot().title==='草稿 A 刷新恢复','返回 A 未保留恢复内容');
  const report={passed:true,switchFailureBlocked:true,baselineRetryFixed:true,perBoardDrafts:true,realReloadRecovery:true,a,b};
  await control('report',report);output.textContent=JSON.stringify(report,null,2);sessionStorage.setItem(key,JSON.stringify({done:true}));
 }catch(e){output.textContent=String(e);await control('report',{passed:false,error:String(e)});}finally{c.stop();}
}
document.querySelector('#start')!.addEventListener('click',()=>{output.textContent='验收中…';void run();});
const pending=sessionStorage.getItem(key);if(pending&&!JSON.parse(pending).done)void run(true);
