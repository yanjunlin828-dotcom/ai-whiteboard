import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BoardLibrary} from '../server/library.mjs';
import {blankBoard} from '../server/store.mjs';
import {createBoardServer} from '../server/http.mjs';
const parent=resolve('../中间过程/AI讲解白板/stage7-tests');await mkdir(parent,{recursive:true});
async function setup(options){const root=await mkdtemp(join(parent,'run-'));const lib=new BoardLibrary(join(root,'main/revisions'),options);await lib.load();return {root,lib};}
const scene=text=>({...blankBoard().scene,elements:[{id:'same-id',type:'text',x:10,y:20,width:120,height:30,text}]});
test('directory discovery restores independent boards, titles, archive and copies without a catalog',async()=>{
 const {root,lib}=await setup();const original=lib.get('main').read();
 const a=await lib.create({title:'同名',scene:scene('A')}),b=await lib.create({title:'同名',scene:scene('B')});
 assert.notEqual(a.boardId,b.boardId);assert.equal(a.revision,b.revision);
 const copy=await lib.create({title:'副本',scene:a.scene});
 await lib.get(copy.boardId).save({baseRevision:1,requestId:randomUUID(),title:'副本',scene:scene('副本改字')});
 assert.equal(lib.get(a.boardId).board.scene.elements[0].text,'A');
 await lib.change(b.boardId,{baseRevision:1,archived:true,title:'已归档'});
 const fresh=new BoardLibrary(join(root,'main/revisions'));await fresh.load();
 assert.equal(fresh.list().length,4);assert.equal(fresh.get(b.boardId).board.archived,true);
 assert.equal(fresh.get(copy.boardId).board.scene.elements[0].text,'副本改字');assert.deepEqual(fresh.get('main').read(),original);
 await fresh.change(b.boardId,{baseRevision:2,archived:false});
 assert.equal(fresh.get(b.boardId).board.scene.elements[0].text,'B');
 const files=await readdir(join(root,b.boardId,'revisions'));assert.equal(files.length,3);
 for(const name of files)assert.equal(JSON.parse(await readFile(join(root,b.boardId,'revisions',name),'utf8')).board.boardId,b.boardId);
});
test('invalid or failed imports never appear as partially created boards; IDs cannot traverse paths',async()=>{
 let fail=false;const {root,lib}=await setup({beforeWrite:async()=>{if(fail)throw Error('QA disk failure');}});
 await assert.rejects(lib.create({title:'invalid',scene:{...scene('x'),elements:[...scene('x').elements,...scene('x').elements]}}));
 assert.equal((await readdir(root)).length,1);assert.throws(()=>lib.get('../main'));assert.throws(()=>lib.get('nonexistent'));
 fail=true;await assert.rejects(lib.create({title:'failure'}));assert.equal(lib.list().length,1);
 const fresh=new BoardLibrary(join(root,'main/revisions'));await fresh.load();assert.equal(fresh.list().length,1);assert.equal(fresh.warnings.length,1);
});
async function httpSetup(t){
 const {root,lib}=await setup();const server=createBoardServer({store:lib.get('main'),library:lib,bridgeToken:'qa-key',root,assets:root});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,data,session)=>{
  const response=await fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(session?{Authorization:`Bearer ${session.token}`,'X-Whiteboard-Board':session.boardId,'X-Whiteboard-Session':session.epoch}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  return {status:response.status,...await response.json()};
 };
 const session=async(clientId)=>{const x=await request('session',{clientId});return {token:x.token,boardId:x.board.boardId,epoch:x.editorSessionId};};
 const agent=async(kind,data)=>{const response=await fetch(base+'/api/agent/'+kind,{method:'POST',headers:{Authorization:'Bearer qa-key','Content-Type':'application/json'},body:JSON.stringify(data)});return {status:response.status,...await response.json()};};
 return {lib,request,session,agent};
}
test('sessions pin saves and backups; switching rotates identity and rejects stale or old clients',async t=>{
 const {lib,request,session}=await httpSetup(t);const s=await session('writer'),other=await session('reader');
 const b=await lib.create({title:'B'});
 const parallel=await request('boards/open',{boardId:b.boardId},other);
 assert.equal(parallel.writable,true);
 await request('release',{}, {...other,boardId:b.boardId,epoch:parallel.editorSessionId});
 const opened=await request('boards/open',{boardId:b.boardId},s);const next={...s,boardId:b.boardId,epoch:opened.editorSessionId};
 assert.notEqual(next.epoch,s.epoch);
 const data={baseRevision:1,requestId:randomUUID(),title:'B changed',scene:scene('B only')};
 assert.equal((await request('board',data,s)).code,'BOARD_MISMATCH');
 assert.equal((await request('board',data,{...next,boardId:undefined,epoch:undefined})).code,'BOARD_MISMATCH');
 assert.equal((await request('board',data,next)).status,200);assert.equal(lib.get('main').board.revision,0);
 const backup=await request('backup',{format:'excalidraw',title:'B',revision:2,draft:false,scene:scene('B only')},next);
 assert.ok(backup.path.includes(b.boardId));assert.equal(JSON.parse(await readFile(backup.path,'utf8')).whiteboard.boardId,b.boardId);
 await request('boards/change',{boardId:b.boardId,baseRevision:2,archived:true},next);
 assert.equal((await request('board',{...data,requestId:randomUUID(),baseRevision:3},next)).code,'READ_ONLY');
 assert.equal((await request('heartbeat',{},next)).writable,false);
});
test('late AI cannot land on another board or a new visit to the same board; queued jobs cancel and owned jobs block switching',async t=>{
 const {lib,request,session,agent}=await httpSetup(t);let s=await session('writer');const b=await lib.create({title:'B'});
 const patch={boardId:'main',editorSessionId:s.epoch,baseRevision:0,requestId:randomUUID(),items:[{id:'txt',type:'text',x:0,y:0,text:'A only'}]};
 assert.equal((await agent('patch',{baseRevision:0,requestId:randomUUID(),items:patch.items})).code,'BOARD_REQUIRED');
 const delayed=agent('patch',patch);
 while(!lib.bridge('main').active)await new Promise(r=>setTimeout(r,5));
 const opened=await request('boards/open',{boardId:b.boardId},s);s={...s,boardId:b.boardId,epoch:opened.editorSessionId};
 assert.equal((await delayed).code,'EDITOR_OFFLINE');assert.equal((await agent('patch',patch)).code,'BOARD_MISMATCH');
 assert.equal((await request('jobs/poll',{},s)).job,null);
 const back=await request('boards/open',{boardId:'main'},s);s={...s,boardId:'main',epoch:back.editorSessionId};
 assert.equal((await agent('patch',patch)).code,'BOARD_MISMATCH');
 const pending=agent('patch',{...patch,editorSessionId:s.epoch});
 while(!lib.bridge('main').active)await new Promise(r=>setTimeout(r,5));
 const {job}=await request('jobs/poll',{},s);
 assert.equal((await request('boards/open',{boardId:b.boardId},s)).code,'EDITOR_BUSY');
 await request('jobs/result',{id:job.id,error:{code:'QA_CANCEL',message:'test complete'}},s);assert.equal((await pending).code,'QA_CANCEL');
 assert.equal(lib.get('main').board.revision,0);assert.equal(lib.get(b.boardId).board.revision,1);
});
test('MCP receipts stay scoped to their board and survive restart; preview requires both identities',async t=>{
 const {lib,request,session,agent}=await httpSetup(t);const s=await session('writer');
 const p={boardId:'main',editorSessionId:s.epoch,baseRevision:0,requestId:randomUUID(),items:[{id:'txt',type:'text',x:0,y:0,text:'A'}]};
 const pending=agent('patch',p);while(!lib.bridge('main').active)await new Promise(r=>setTimeout(r,5));
 const {job}=await request('jobs/poll',{},s);await request('jobs/commit',{id:job.id,elements:scene('A').elements},s);await request('jobs/result',{id:job.id,revision:1},s);
 assert.equal((await pending).boardId,'main');assert.equal((await agent('patch',p)).duplicate,true);
 assert.equal((await agent('render',{revision:1})).code,'BOARD_REQUIRED');
 const b=await lib.create({title:'B'});assert.equal((await request(`status?boardId=${b.boardId}&requestId=${p.requestId}`)).transaction,null);
 assert.ok((await request(`status?boardId=main&requestId=${p.requestId}`)).transaction);
 const fresh=new BoardLibrary(lib.mainDirectory);await fresh.load();assert.ok(fresh.get('main').aiTransactions.has(p.requestId));assert.equal(fresh.get(b.boardId).aiTransactions.size,0);
});
