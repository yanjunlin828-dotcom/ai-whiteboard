import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {BoardStore} from '../server/store.mjs';
import {createBoardServer} from '../server/http.mjs';
const project=process.cwd(),parent=resolve(project,'../中间过程/AI讲解白板/stage6-recovery');
await mkdir(parent,{recursive:true});const directory=await mkdtemp(resolve(parent,'run-'));
let fail=false,offset=0;
const store=new BoardStore(resolve(directory,'revisions'),{beforeWrite:async()=>{if(fail)throw new Error('QA disk failure')}});await store.load();
const vite=await createServer({root:project,configFile:false,define:{'process.env.IS_PREACT':'false'},server:{middlewareMode:true,hmr:false,allowedHosts:['127.0.0.1']},appType:'mpa'});
const server=createBoardServer({store,root:directory,assets:resolve(project,'node_modules/@excalidraw/excalidraw/dist/prod'),middleware:vite.middlewares,clock:()=>Date.now()+offset});
const handler=server.listeners('request')[0];server.removeListener('request',handler);
server.on('request',async(req,res)=>{
 if(req.url!=='/qa/recovery-control')return handler(req,res);
 if(req.method!=='POST'||req.headers.host!=='127.0.0.1:48768'||req.headers.origin!=='http://127.0.0.1:48768'){res.writeHead(403);return res.end();}
 try{let raw='';for await(const c of req){raw+=c;if(raw.length>8000)throw new Error('Too large');}const x=JSON.parse(raw);
  if(x.action==='fail')fail=true;else if(x.action==='resume')offset+=31000;else if(x.action==='healthy')fail=false;
  else if(x.action==='report'){await writeFile(resolve(directory,`report-${randomUUID()}.json`),JSON.stringify(x.report,null,2),{flag:'wx'});console.log(JSON.stringify(x.report));}
  else throw new Error('Unknown action');
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({revision:store.board.revision,title:store.board.title}));
 }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
});
server.listen(48768,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:48768/qa/stage6-recovery.html',directory,pid:process.pid})));
const close=async()=>{server.closeAllConnections();server.close();await vite.close()};process.on('SIGINT',close);process.on('SIGTERM',close);
