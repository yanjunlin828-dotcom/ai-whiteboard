import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {BoardLibrary} from '../server/library.mjs';
import {createBoardServer} from '../server/http.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const parent=resolve(project,'../中间过程/AI讲解白板/stage7-qa');await mkdir(parent,{recursive:true});
const directory=process.env.STAGE7_RUN_DIR?resolve(process.env.STAGE7_RUN_DIR):await mkdtemp(resolve(parent,'run-'));
if(!directory.startsWith(parent+'\\'))throw Error('QA directory outside stage7-qa');
let fail=false,offset=0;
const library=new BoardLibrary(resolve(directory,'boards/main/revisions'),{beforeWrite:async()=>{if(fail)throw Error('QA simulated disk failure');}});await library.load();
const port=48769,bridgeToken='stage7-isolated-test-key';
const vite=await createServer({root:project,configFile:false,server:{middlewareMode:true,hmr:false,allowedHosts:['127.0.0.1','localhost']},appType:'spa'});
const server=createBoardServer({store:library.get('main'),library,bridgeToken,clock:()=>Date.now()+offset,root:resolve(project,'dist'),assets:resolve(project,'node_modules/@excalidraw/excalidraw/dist/prod'),middleware:vite.middlewares});
const base=server.listeners('request')[0];server.removeListener('request',base);
server.on('request',async(req,res)=>{
 if(req.headers.host!==`127.0.0.1:${port}`)return base(req,res);
 if(req.url==='/qa/state'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({directory,fail,boards:library.list()}));}
 if(req.url==='/qa/control'&&req.method==='POST'){
  if(req.headers.origin!==`http://127.0.0.1:${port}`){res.writeHead(403);return res.end();}
  let raw='';for await(const c of req){raw+=c;if(raw.length>1000){res.writeHead(413);return res.end();}}
  try{const {action,report}=JSON.parse(raw);if(action==='fail-on')fail=true;else if(action==='fail-off')fail=false;else if(action==='expire-test-lease')offset+=31000;else if(action==='report')await writeFile(resolve(directory,`report-${randomUUID()}.json`),JSON.stringify(report,null,2),{flag:'wx'});else throw Error('Invalid');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({fail}));}catch{res.writeHead(400);res.end();}return;
 }
 if(req.url==='/qa/stage7.html'){
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>阶段7隔离验收</title><style>body{margin:0;font:14px sans-serif}header{padding:8px;background:#edf3fb}button{margin-left:12px}iframe{width:100%;height:calc(100vh - 45px);border:0}</style><header>独立测试白板<button data-action="fail-on">模拟保存失败</button><button data-action="fail-off">恢复磁盘</button><span id="status"></span></header><iframe title="多白板测试" src="/"></iframe><script>document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{const r=await fetch('/qa/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.action})});document.querySelector('#status').textContent=JSON.stringify(await r.json())});</script></html>`);
 }
 return base(req,res);
});
server.on('error',e=>{console.error(e.code);void vite.close();process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}/qa/stage7.html`,directory,pid:process.pid})));
async function close(){server.closeAllConnections();server.close();await vite.close();}process.on('SIGINT',close);process.on('SIGTERM',close);
