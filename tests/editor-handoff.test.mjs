import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {BoardLibrary} from '../server/library.mjs';
import {createBoardServer} from '../server/http.mjs';

const parent=resolve('../中间过程/AI讲解白板/editor-handoff-20261011/tests');
await mkdir(parent,{recursive:true});
async function setup(t,options={}){
  let now=1000000;
  const root=await mkdtemp(join(parent,'run-'));
  const library=new BoardLibrary(join(root,'main/revisions'),options);await library.load();
  const server=createBoardServer({store:library.get('main'),library,bridgeToken:'isolated-test-key',root,assets:root,clock:()=>now});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/`;
  async function call(path,body,s){
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(s?{Authorization:`Bearer ${s.token}`,'X-Whiteboard-Board':s.boardId,'X-Whiteboard-Session':s.epoch}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  }
  async function session(page='editor',boardId='main'){
    const result=await call('session',{clientId:randomUUID(),page,boardId});
    return {token:result.token,boardId,epoch:result.editorSessionId,writable:result.writable};
  }
  async function pulse(s,autoClaim=true){const result=await call('heartbeat',{autoClaim},s);if(result.editorSessionId)s.epoch=result.editorSessionId;return result;}
  async function claim(s){const result=await call('claim',{},s);if(result.editorSessionId)s.epoch=result.editorSessionId;return result;}
  async function agent(kind,input){const response=await fetch(base+'agent/'+kind,{method:'POST',headers:{Authorization:'Bearer isolated-test-key','Content-Type':'application/json'},body:JSON.stringify(input)});return response.json();}
  const save=(s,title)=>call('board',{baseRevision:library.get(s.boardId).board.revision,requestId:randomUUID(),title,scene:library.get(s.boardId).read().scene},s);
  return {library,call,session,pulse,claim,agent,save,server,base,advance:ms=>{now+=ms;}};
}

test('home owns no lease; separate boards edit and save independently',async t=>{
  const q=await setup(t),home=await q.session('library');
  assert.equal(home.writable,false);assert.equal((await q.pulse(home)).writable,false);
  const a=await q.session(),bBoard=await q.library.create({title:'B'}),b=await q.session('editor',bBoard.boardId);
  assert.equal(a.writable,true);assert.equal(b.writable,true);
  assert.equal((await q.save(a,'A saved')).status,200);assert.equal((await q.save(b,'B saved')).status,200);
  assert.equal((await q.call('boards/create',{title:'From home'},home)).status,200);
  assert.equal((await q.call('boards/change',{boardId:'main',baseRevision:1,title:'Conflict'},home)).code,'READ_ONLY');
  assert.equal((await q.pulse(a)).writable,true);assert.equal((await q.pulse(b)).writable,true);
});

test('handoff waits for acknowledgement and transfers the latest saved revision without ping-pong',async t=>{
  const q=await setup(t),a=await q.session(),b=await q.session();
  const stale={...b};
  assert.equal((await q.claim(b)).handoffPending,true);
  assert.equal((await q.pulse(a)).handoffRequested,true);
  assert.equal((await q.save(b,'not allowed')).code,'READ_ONLY');
  assert.equal((await q.save(a,'last edit before handoff')).status,200);
  assert.equal((await q.call('handoff',{revision:0},a)).code,'REVISION_CONFLICT');
  assert.equal((await q.call('handoff',{revision:1},a)).writable,false);
  assert.equal((await q.pulse(b)).writable,true);assert.notEqual(b.epoch,stale.epoch);
  assert.equal((await q.call('board',undefined,b)).board.title,'last edit before handoff');
  assert.equal((await q.pulse(a)).writable,false);
  assert.equal((await q.save(a,'old window')).code,'READ_ONLY');
  assert.equal((await q.save(stale,'stale identity')).code,'BOARD_MISMATCH');
  assert.equal((await q.save(b,'new window')).status,200);
});

test('returning home releases immediately; passive duplicate reclaims without a button',async t=>{
  const q=await setup(t),a=await q.session(),b=await q.session();
  const left=await q.call('boards/open',{boardId:'main',page:'library'},a);a.epoch=left.editorSessionId;
  assert.equal(left.writable,false);assert.equal((await q.pulse(a)).writable,false);
  assert.equal((await q.pulse(b)).writable,true);
  assert.equal((await q.call('release',{},b)).status,200);
  assert.equal((await q.session()).writable,true);
});

test('expired owners recover automatically, but cannot steal back from the new owner',async t=>{
  const q=await setup(t),a=await q.session(),b=await q.session();q.advance(31000);
  assert.equal((await q.pulse(b)).writable,true);assert.equal((await q.pulse(a)).writable,false);
  assert.equal((await q.save(a,'stale draft')).code,'READ_ONLY');
  assert.equal((await q.call('release',{},b)).status,200);assert.equal((await q.pulse(a)).writable,true);
});

test('handoff never interrupts an in-flight disk save; failed save remains unchanged',async t=>{
  let unblock,started,fail=false;
  const gate=new Promise(resolve=>{started=resolve;});
  const q=await setup(t,{beforeWrite:async()=>{started();await new Promise(resolve=>{unblock=resolve;});if(fail)throw Error('isolated disk failure');}});
  const a=await q.session(),b=await q.session();await q.claim(b);
  const saving=q.save(a,'pending');await gate;
  assert.equal((await q.call('handoff',{revision:0},a)).code,'EDITOR_BUSY');
  assert.equal((await q.call('boards/open',{boardId:'main',page:'library'},a)).code,'EDITOR_BUSY');
  fail=true;unblock();assert.equal((await saving).code,'SAVE_FAILED');
  assert.equal(q.library.get('main').board.revision,0);assert.equal((await q.pulse(a)).writable,true);assert.equal((await q.pulse(b)).writable,false);
});

test('owned AI work blocks handoff; stale AI identities cannot follow a handoff',async t=>{
  const q=await setup(t),a=await q.session(),b=await q.session();
  const pending=q.agent('read',{boardId:'main',editorSessionId:a.epoch});
  while(!q.library.bridge('main').active)await new Promise(r=>setTimeout(r,5));
  const {job}=await q.call('jobs/poll',{},a);await q.claim(b);
  assert.equal((await q.call('handoff',{revision:0},a)).code,'EDITOR_BUSY');
  await q.call('jobs/result',{id:job.id,revision:0,selectedIds:[]},a);assert.equal((await pending).revision,0);
  assert.equal((await q.call('handoff',{revision:0},a)).writable,false);await q.pulse(b);
  assert.equal((await q.agent('render',{boardId:'main',editorSessionId:a.epoch,revision:0})).code,'BOARD_MISMATCH');
  assert.equal((await q.call('jobs/poll',{},a)).code,'READ_ONLY');
});

test('MCP with explicit board identity reaches the correct writer with two boards open',async t=>{
  const q=await setup(t),a=await q.session(),board=await q.library.create({title:'B'}),b=await q.session('editor',board.boardId);
  const pending=q.agent('read',{boardId:'main',editorSessionId:a.epoch});
  while(!q.library.bridge('main').active)await new Promise(r=>setTimeout(r,5));
  assert.equal((await q.call('jobs/poll',{},b)).job,null);
  const {job}=await q.call('jobs/poll',{},a);assert.ok(job);
  await q.call('jobs/result',{id:job.id,revision:0,selectedIds:[]},a);
  const result=await pending;assert.equal(result.boardId,'main');assert.equal(result.editorSessionId,a.epoch);
});

test('archived boards stay readable; stale takeover requests expire',async t=>{
  const q=await setup(t),a=await q.session(),b=await q.session();await q.claim(b);
  q.advance(46000);assert.equal((await q.pulse(b)).handoffPending,false);
  await q.call('release',{},b);await q.call('release',{},a);
  await q.library.change('main',{baseRevision:0,archived:true});
  const archived=await q.session();assert.equal(archived.writable,false);
  assert.equal((await q.claim(archived)).code,'ARCHIVED');assert.equal((await q.pulse(archived)).writable,false);
});

test('a delayed save body from an earlier visit cannot write after reopening the board',async t=>{
  const q=await setup(t),a=await q.session();
  const payload=JSON.stringify({baseRevision:0,requestId:randomUUID(),title:'stale visit',scene:q.library.get('main').read().scene});
  let send;
  const received=new Promise(resolve=>q.server.once('request',resolve));
  const response=new Promise((resolve,reject)=>{
    send=http.request(q.base+'board',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${a.token}`,'X-Whiteboard-Board':a.boardId,'X-Whiteboard-Session':a.epoch}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(JSON.parse(text)));
    });
    send.on('error',reject);send.write(payload.slice(0,1));
  });
  await received;
  const opened=await q.call('boards/open',{boardId:'main',page:'editor'},a);
  assert.equal(opened.writable,true);assert.notEqual(opened.editorSessionId,a.epoch);
  send.end(payload.slice(1));
  assert.equal((await response).code,'BOARD_MISMATCH');assert.equal(q.library.get('main').board.revision,0);
});
