import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BoardLibrary} from '../server/library.mjs';
import {createBoardServer} from '../server/http.mjs';

async function setup(t,options={}){
  let now=1000000;
  const parent=resolve('../中间过程/AI讲解白板/archive-confirm-20261013/tests');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'run-')),library=new BoardLibrary(join(root,'main/revisions'),options);await library.load();
  const server=createBoardServer({store:library.get('main'),library,bridgeToken:'isolated-archive-test',root,assets:root,clock:()=>now});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/`;
  async function call(path,body,s){
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(s?{Authorization:`Bearer ${s.token}`,'X-Whiteboard-Board':s.boardId,'X-Whiteboard-Session':s.epoch}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  }
  async function session(page='editor',boardId='main'){
    const r=await call('session',{clientId:randomUUID(),page,boardId});return {token:r.token,boardId,epoch:r.editorSessionId,writable:r.writable};
  }
  const start=(home,boardId='main',requestId=randomUUID(),baseRevision=library.get(boardId).board.revision)=>call('boards/archive',{boardId,requestId,baseRevision},home);
  const respond=(editor,requestId,ready=true,message)=>call('archive/respond',{requestId,ready,message,revision:library.get(editor.boardId).board.revision},editor);
  const pulse=s=>call('heartbeat',{autoClaim:true,editorState:'ready'},s);
  const save=(s,title)=>call('board',{baseRevision:library.get(s.boardId).board.revision,requestId:randomUUID(),title,scene:library.get(s.boardId).read().scene},s);
  return {library,call,session,start,respond,pulse,save,advance:ms=>{now+=ms;}};
}

test('confirmed archive saves the latest edits, waits for every editor, and survives reload',async t=>{
  const q=await setup(t),owner=await q.session(),reader=await q.session(),home=await q.session('library');
  const other=await q.library.create({title:'untouched'}),before=q.library.get(other.boardId).read();
  assert.equal((await q.call('boards',undefined,home)).boards.find(b=>b.boardId==='main').openEditors,2);
  const r=await q.start(home),id=r.archive.requestId;
  assert.equal(r.archive.status,'waiting');assert.equal(q.library.get('main').board.archived,undefined);
  assert.equal((await q.pulse(owner)).archive.requestId,id);
  assert.equal((await q.save(owner,'last unsaved edit')).status,200);
  assert.equal((await q.respond(owner,id)).archive.status,'waiting');
  assert.equal((await q.save(owner,'late overwrite')).code,'ARCHIVE_BUSY');
  assert.equal((await q.respond(reader,id)).archive.status,'complete');
  assert.equal((await q.pulse(owner)).writable,false);assert.equal((await q.pulse(reader)).writable,false);
  assert.equal((await q.call('claim',{},reader)).code,'ARCHIVED');
  assert.equal(q.library.get('main').board.title,'last unsaved edit');assert.equal(q.library.get('main').board.revision,2);
  assert.deepEqual(q.library.get(other.boardId).read(),before);
  const reloaded=new BoardLibrary(q.library.mainDirectory);await reloaded.load();assert.equal(reloaded.get('main').board.archived,true);
  assert.equal((await q.start(home,'main',id)).archive.status,'complete');assert.equal(q.library.get('main').board.revision,2);
  assert.equal((await q.call('boards/change',{boardId:'main',baseRevision:2,archived:false},home)).status,200);
  assert.equal((await q.session()).writable,true);
});

test('cancel before confirmation has no request; editor refusal preserves content and editing',async t=>{
  const q=await setup(t),owner=await q.session(),home=await q.session('library'),before=q.library.get('main').read();
  assert.equal((await q.pulse(owner)).archive,null);
  const {archive}=await q.start(home);
  assert.equal((await q.respond(owner,archive.requestId,false,'有待恢复草稿，未归档')).archive.status,'failed');
  assert.deepEqual(q.library.get('main').read(),before);assert.equal((await q.pulse(owner)).writable,true);
});

test('unresponsive editors time out safely; late acknowledgements cannot archive',async t=>{
  const q=await setup(t),owner=await q.session(),home=await q.session('library');
  const {archive}=await q.start(home);q.advance(21000);
  const result=await q.call(`boards/archive-status?boardId=main&requestId=${archive.requestId}`,undefined,home);
  assert.equal(result.archive.status,'failed');assert.match(result.archive.message,/未响应/);
  assert.equal((await q.respond(owner,archive.requestId)).archive.status,'failed');assert.equal(q.library.get('main').board.revision,0);
});

test('disk failure during archive keeps the original board and editor ownership',async t=>{
  let fail=false;const q=await setup(t,{beforeWrite:async()=>{if(fail)throw Error('isolated disk failure');}}),owner=await q.session(),home=await q.session('library');
  const {archive}=await q.start(home);fail=true;
  assert.equal((await q.respond(owner,archive.requestId)).archive.status,'failed');
  assert.equal(q.library.get('main').board.revision,0);assert.equal((await q.pulse(owner)).writable,true);
  fail=false;assert.equal((await q.save(owner,'recover')).status,200);
});

test('archive requests pin board and sessions, block competing changes, and cannot close another board',async t=>{
  const q=await setup(t),owner=await q.session(),home=await q.session('library'),other=await q.library.create({title:'other'}),outsider=await q.session('editor',other.boardId);
  const {archive}=await q.start(home);
  assert.equal((await q.respond(outsider,archive.requestId)).code,'BOARD_MISMATCH');
  assert.equal((await q.start(home)).code,'ARCHIVE_BUSY');
  assert.equal((await q.call('boards/change',{boardId:'main',baseRevision:0,title:'race'},home)).code,'ARCHIVE_BUSY');
  assert.equal((await q.call('boards/open',{boardId:other.boardId},owner)).code,'ARCHIVE_BUSY');
  assert.equal((await q.call('claim',{},owner)).code,'ARCHIVE_BUSY');
  assert.equal((await q.call('session',{clientId:randomUUID(),page:'editor',boardId:'main'})).code,'ARCHIVE_BUSY');
  assert.equal((await q.respond(owner,archive.requestId)).archive.status,'complete');
  assert.equal(q.library.get(other.boardId).board.archived,undefined);
});

test('archive without open editors completes immediately and rejects stale confirmation',async t=>{
  const q=await setup(t),home=await q.session('library');
  assert.equal((await q.start(home,'main',randomUUID(),99)).code,'REVISION_CONFLICT');
  assert.equal((await q.start(home)).archive.status,'complete');assert.equal(q.library.get('main').board.archived,true);
});

test('older AI-opened pages can save and exit through the existing handoff protocol',async t=>{
  const q=await setup(t),owner=await q.session(),reader=await q.session(),home=await q.session('library');
  const {archive}=await q.start(home);
  assert.equal((await q.pulse(owner)).handoffRequested,true);
  await q.save(owner,'legacy page last edit');
  assert.equal((await q.call('handoff',{revision:0},owner)).code,'REVISION_CONFLICT');
  assert.equal((await q.call('handoff',{revision:1},owner)).writable,false);
  assert.equal((await q.pulse(owner)).writable,false);
  assert.equal((await q.respond(reader,archive.requestId)).archive.status,'complete');
  assert.equal(q.library.get('main').board.title,'legacy page last edit');
});
