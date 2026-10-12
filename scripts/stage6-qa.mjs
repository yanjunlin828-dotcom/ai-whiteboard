// Isolated stage 6 server. Uses only fresh QA revisions; never opens the main store for writing.
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BoardStore} from '../server/store.mjs';
import {EditorBridge} from '../server/bridge.mjs';
import {createBoardServer} from '../server/http.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const parent=resolve(project,'../中间过程/AI讲解白板/stage6-qa');
await mkdir(parent,{recursive:true});
const directory=process.env.STAGE6_RUN_DIR?resolve(process.env.STAGE6_RUN_DIR):await mkdtemp(resolve(parent,'run-'));
if(!directory.startsWith(parent+ '/'.replace('/',process.platform==='win32'?'\\':'/')))throw new Error('QA directory must stay within stage6-qa');
const port=48765;
// Reuse the already configured local MCP credential, without displaying or changing it.
const bridgeToken=(await readFile(resolve(project,'.local/bridge-48765.key'),'utf8')).trim();
let fail=false;
const store=new BoardStore(resolve(directory,'revisions'),{beforeWrite:async()=>{if(fail)throw new Error('Simulated QA disk failure');}});
await store.load();
const bridge=new EditorBridge(store,{allowEdits:true});
const server=createBoardServer({store,bridge,bridgeToken,root:resolve(project,'dist'),assets:resolve(project,'node_modules/@excalidraw/excalidraw/dist/prod')});
const base=server.listeners('request')[0];server.removeListener('request',base);
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
server.on('request',async(req,res)=>{
 if(req.headers.host!==`127.0.0.1:${port}`)return base(req,res);
 // Test-only CSP denies all external requests, while keeping the real local app usable.
 res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src 'self' data: blob:");
 if(req.url==='/qa/state'&&req.method==='GET')return reply(res,200,{directory,fail,board:store.read()});
 if(req.url==='/qa/control'&&req.method==='POST'){
  if(req.headers.origin!==`http://127.0.0.1:${port}`)return reply(res,403,{error:'QA requires same origin'});
  try{
   let raw='';for await(const c of req){raw+=c;if(raw.length>1000)throw new Error('Too large');}
   const {action}=JSON.parse(raw);
   if(action==='fail-on')fail=true;else if(action==='fail-off')fail=false;
   else if(action==='snapshot')await writeFile(resolve(directory,`snapshot-${store.board.revision}-${randomUUID()}.json`),JSON.stringify(store.read()),{flag:'wx'});
   else throw new Error('Unknown action');
   return reply(res,200,{ok:true,fail,revision:store.board.revision});
  }catch(e){return reply(res,400,{error:e.message});}
 }
 if(req.url==='/qa/stage6.html'){
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>阶段6隔离验收</title><style>body{margin:0;font:15px sans-serif}header{padding:10px;background:#edf3fb;color:#294d79}button{margin-left:12px}iframe{border:0;width:100%;height:calc(100vh - 55px)}</style><header>阶段 6 · 独立测试数据<button data-action="fail-on">模拟保存失败</button><button data-action="fail-off">恢复磁盘</button><button data-action="snapshot">记录快照</button><span id="status">外部网络已由测试策略禁止</span></header><iframe title="测试白板" src="/"></iframe><script>document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{const r=await fetch('/qa/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.action})});document.querySelector('#status').textContent=JSON.stringify(await r.json())});</script></html>`);
 }
 return base(req,res);
});
server.on('error',e=>{console.error(e.code);process.exitCode=1});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}/qa/stage6.html`,directory,pid:process.pid,revision:store.board.revision})));
function close(){server.closeAllConnections();server.close();}
process.on('SIGINT',close);process.on('SIGTERM',close);
