import {BoardController} from '../src/controller';
const controller=new BoardController('archive-qa-controller');
const output=document.querySelector('#state')!;
const render=()=>{
  const s=controller.getSnapshot();
  output.textContent=JSON.stringify({title:s.title,revision:s.revision,status:s.status,writable:s.writable,archivePending:s.archivePending,archived:s.board?.archived??false,message:s.message},null,2);
};
controller.subscribe(render);void controller.start();
document.querySelector('#draft')!.addEventListener('click',()=>controller.title('归档验收 · 最近修改已保留'));
for(const [id,action] of [['fail','fail-on'],['recover','fail-off']])document.querySelector(`#${id}`)!.addEventListener('click',async()=>{
  const response=await fetch('/qa/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
  if(!response.ok)output.textContent='隔离测试控制失败';
});
