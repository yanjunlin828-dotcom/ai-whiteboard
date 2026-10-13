import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {BoardStore,blankBoard} from '../server/store.mjs';
import {EditorBridge,describeBoard} from '../server/bridge.mjs';
import {aliasMaps,mutationInput} from '../server/agent-results.mjs';
import {validateDiagram} from '../shared/diagram.mjs';
import {applyEdits} from '../shared/edits.mjs';
import {createBoardServer} from '../server/http.mjs';

const parent=resolve('../中间过程/AI讲解白板/mcp-optimization-20261012/tests');
await mkdir(parent,{recursive:true});
const text=(id,x=0)=>({id,type:'text',x,y:0,width:100,height:35,fontSize:28,text:'中文说明',originalText:'中文说明',locked:false});
async function setup(t,options={}){
  const directory=await mkdtemp(join(parent,'run-')),store=new BoardStore(directory,options);await store.load();
  const bridge=new EditorBridge(store,{allowEdits:true});t.after(()=>bridge.close());return {store,bridge,directory};
}
test('precise reads include labels and related edges, project fields, and reject missing IDs',()=>{
  const node={id:'node',type:'rectangle',x:0,y:0,width:200,height:100,boundElements:[{id:'label',type:'text'},{id:'edge',type:'arrow'}]},
    label={...text('label'),containerId:'node'},other={...node,id:'other',x:500,boundElements:[]},edge={id:'edge',type:'arrow',x:210,y:50,width:280,height:0,startBinding:{elementId:'node'},endBinding:{elementId:'other'}};
  const board={...blankBoard(),scene:{...blankBoard().scene,elements:[node,label,other,edge]}};
  const full=describeBoard(board,[],{elementIds:['node'],includeRelated:true});assert.equal(full.total,4);
  const compact=describeBoard(board,[],{elementIds:['label'],detail:'text'});assert.equal(compact.elements[0].text,'中文说明');assert.equal(compact.elements[0].x,undefined);assert.equal(compact.coverage.detail,'text');
  const paged=describeBoard(board,[],{elementIds:['node'],includeRelated:true,limit:2});assert.equal(paged.truncated,true);assert.equal(paged.nextOffset,2);
  assert.throws(()=>describeBoard(board,[],{elementIds:['missing']}),{code:'TARGET_MISSING'});
  assert.throws(()=>describeBoard(board,[],{elementIds:['node','node']}),{code:'INVALID_READ'});
});
test('rich receipt gives verified IDs and changed content, survives restart, keeps legacy hash',async t=>{
  const {store,bridge,directory}=await setup(t),requestId=randomUUID(),input={baseRevision:0,requestId,items:[{id:'note',type:'text',x:0,y:0,text:'中文说明'}]},added=text(`ai-${requestId}-note`);
  const pending=bridge.invoke('patch',{...input,returnElements:true,includeRelated:true}),job=bridge.poll('editor');
  await bridge.commit('editor',job.id,{elements:[added]});bridge.result('editor',job.id,{revision:1,timings:{generateMs:3}});
  const result=await pending;assert.equal(result.idMap.note,added.id);assert.equal(result.changes.elements[0].text,'中文说明');assert.equal(result.saved,true);assert.equal(result.applied,true);assert.ok(result.timings.queueMs>=0);assert.equal(result.timings.browser.generateMs,3);
  const legacyParsed={...input,items:[{...input.items[0],fontSize:28}]};
  assert.equal(store.aiTransactions.get(requestId).hash,createHash('sha256').update(JSON.stringify(legacyParsed)).digest('hex'));
  const restored=new BoardStore(directory);await restored.load();const next=new EditorBridge(restored);t.after(()=>next.close());
  assert.equal((await next.invoke('patch',input)).idMap.note,added.id);assert.equal(restored.board.revision,1);
  assert.throws(()=>next.invoke('patch',{...input,items:[{...input.items[0],text:'不同内容'}]}),{code:'REQUEST_REUSED'});
});
test('alias maps use actual generated objects, flow step IDs and bound labels',()=>{
  const requestId=randomUUID(),id=`ai-${requestId}-step-0`,node={id,boundElements:[{id:'label',type:'text'}]};
  assert.deepEqual(aliasMaps({requestId,flow:{steps:[{id:'user-step'}]}},[node,{id:'label'}]),{idMap:{'user-step':id},labelMap:{[id]:['label']}});
  assert.deepEqual(mutationInput({baseRevision:1,returnElements:true,includeRelated:true}),{baseRevision:1});
});

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8H0AAAAASUVORK5CYII=';
async function preview(bridge,input,elements,selectedIds=[]){
  const pending=bridge.invoke('preview',input),job=bridge.poll('editor');await bridge.preview('editor',job.id,{elements,selectedIds});bridge.result('editor',job.id,{revision:input.baseRevision,png});return pending;
}
test('prepared commit reuses verified candidate and combines exact saved verification and PNG',async t=>{
  const {store,bridge}=await setup(t),input={baseRevision:0,requestId:randomUUID(),items:[{id:'note',type:'text',x:0,y:0,text:'中文说明'}]},added=text(`ai-${input.requestId}-note`);
  const result=await preview(bridge,input,[added]);assert.equal(store.board.revision,0);assert.ok(result.previewId);
  const pending=bridge.invoke('patch',{...input,previewId:result.previewId,returnElements:true,verification:{validate:true,render:true}}),job=bridge.poll('editor');
  const committed=await bridge.commit('editor',job.id,{selectedIds:[]});assert.deepEqual(committed.renderIds,[added.id]);
  bridge.result('editor',job.id,{revision:1,png});const receipt=await pending;
  assert.equal(receipt.timings.preparedCacheHit,true);assert.equal(receipt.verification.coverage.revision,1);assert.equal(receipt.verification.coverage.source,'saved');assert.equal(receipt.png,png);assert.equal(receipt.changes.elements[0].id,added.id);
  assert.equal((await bridge.invoke('patch',input)).duplicate,true);assert.equal(store.board.revision,1);
});
test('expired, mismatched and switched-session candidates never save',async t=>{
  const {store,bridge}=await setup(t),input={baseRevision:0,requestId:randomUUID(),editorSessionId:randomUUID(),items:[{id:'note',type:'text',x:0,y:0,text:'中文说明'}]},added=text(`ai-${input.requestId}-note`),result=await preview(bridge,input,[added]);
  for(const change of [{editorSessionId:randomUUID()},{items:[{...input.items[0],text:'篡改内容'}]}]){
    const pending=bridge.invoke('patch',{...input,...change,previewId:result.previewId}),job=bridge.poll('editor');
    await assert.rejects(bridge.commit('editor',job.id,{selectedIds:[]}),{code:'PREVIEW_MISMATCH'});bridge.result('editor',job.id,{error:{code:'PREVIEW_MISMATCH'}});await pending;
  }
  await store.save({baseRevision:0,requestId:randomUUID(),title:'人工改动',scene:store.board.scene});
  const pending=bridge.invoke('patch',{...input,previewId:result.previewId}),job=bridge.poll('editor');await assert.rejects(bridge.commit('editor',job.id,{}),{code:'PREVIEW_EXPIRED'});bridge.result('editor',job.id,{error:{code:'PREVIEW_EXPIRED'}});await pending;assert.equal(store.board.revision,1);
});
test('render failure after commit reports saved and applied, never retries the write',async t=>{
  const {store,bridge}=await setup(t),input={baseRevision:0,requestId:randomUUID(),items:[{id:'note',type:'text',x:0,y:0,text:'中文说明'}],verification:{validate:true,render:true}},added=text(`ai-${input.requestId}-note`),pending=bridge.invoke('patch',input),job=bridge.poll('editor');
  await bridge.commit('editor',job.id,{elements:[added]});bridge.result('editor',job.id,{revision:1,renderError:{code:'RENDER_FAILED'}});
  const result=await pending;assert.equal(result.saved,true);assert.equal(result.applied,true);assert.equal(result.verification.renderError.code,'RENDER_FAILED');assert.equal(bridge.status(input.requestId).transaction.revision,1);assert.equal((await bridge.invoke('patch',input)).duplicate,true);assert.equal(store.board.revision,1);
});
test('scoped saved validation catches overlap with outside neighbor and incoming crossing edge',()=>{
  const target=text('target'),overlap=text('neighbor',50),edge={id:'unrelated-edge',type:'arrow',x:-50,y:15,width:250,height:0,points:[[0,0],[250,0]]};
  const report=validateDiagram([target,overlap,edge],{elementIds:['target']});assert.equal(report.checked,1);assert.ok(report.issues.some(i=>i.code==='CONTENT_OVERLAP'));assert.ok(report.issues.some(i=>i.code==='EDGE_CROSSING'));
});
test('saved reads bypass editor jobs but require pinned identity/revision and never return live selection',async t=>{
  const {store,bridge}=await setup(t),session=randomUUID();await store.save({baseRevision:0,requestId:randomUUID(),title:'假数据',scene:{...store.board.scene,elements:[text('n')]}});
  const result=await bridge.invoke('read',{boardId:'main',editorSessionId:session,revision:1,source:'saved',elementIds:['n']});
  assert.equal(result.source,'saved');assert.equal(result.liveSelection,false);assert.equal(result.timings.queueMs,0);assert.equal(bridge.active,null);assert.equal(result.elements[0].id,'n');
  assert.throws(()=>bridge.invoke('read',{boardId:'main',editorSessionId:session,revision:0,source:'saved'}),{code:'REVISION_CONFLICT'});
  assert.throws(()=>bridge.invoke('read',{boardId:'main',editorSessionId:session,revision:1,source:'saved',scope:'selection'}),{code:'INVALID_READ'});
});
test('long poll wakes on a task, has a single owner, cleans up aborted and closing waiters',async t=>{
  const {bridge}=await setup(t),abort=new AbortController();const waiting=bridge.wait(5000,abort.signal);assert.equal(bridge.waiters.size,1);
  const pending=bridge.invoke('read',{});await waiting;assert.equal(bridge.waiters.size,0);const job=bridge.poll('one');assert.equal(bridge.poll('two'),null);bridge.result('one',job.id,{revision:0,selectedIds:[]});await pending;
  const cancelled=bridge.wait(5000,abort.signal);abort.abort();await cancelled;assert.equal(bridge.waiters.size,0);
  const closed=bridge.wait(5000);bridge.close();await closed;assert.equal(bridge.waiters.size,0);
});
test('prepared $selection rejects a changed selection and TTL expiry preserves the original scene',async t=>{
  const {store,bridge}=await setup(t);await store.save({baseRevision:0,requestId:randomUUID(),title:'假数据',scene:{...store.board.scene,elements:[{...text('n'),angle:0,version:1}]}});
  const input={baseRevision:1,requestId:randomUUID(),selectionIds:['n'],edits:[{op:'move',target:'$selection',dx:100,dy:0}]},candidate=applyEdits(store.board.scene.elements,input,['n']);
  const p=await preview(bridge,input,candidate.elements,['n']),pending=bridge.invoke('patch',{...input,previewId:p.previewId}),job=bridge.poll('editor');
  await assert.rejects(bridge.commit('editor',job.id,{selectedIds:[]}),{code:'SELECTION_CHANGED'});bridge.result('editor',job.id,{error:{code:'SELECTION_CHANGED'}});await pending;
  bridge.previews.get(p.previewId).expiresAt=Date.now()-1;
  const next=bridge.invoke('patch',{...input,previewId:p.previewId}),job2=bridge.poll('editor');await assert.rejects(bridge.commit('editor',job2.id,{selectedIds:['n']}),{code:'PREVIEW_EXPIRED'});bridge.result('editor',job2.id,{error:{code:'PREVIEW_EXPIRED'}});await next;assert.equal(store.board.scene.elements[0].x,0);
});
test('HTTP long poll wakes promptly and saved-read output carries the active session',async t=>{
  const {store,bridge,directory}=await setup(t),server=createBoardServer({store,bridge,bridgeToken:'fake-test-key',root:directory,assets:directory});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/`;
  const post=async(path,data,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token??'fake-test-key'}`},body:JSON.stringify(data)});return {status:r.status,...await r.json()};};
  const session=await post('session',{clientId:'optimization-qa'});
  const polling=post('jobs/poll',{waitMs:4500},session.token);
  while(!bridge.waiters.size)await new Promise(r=>setTimeout(r,5));
  const started=performance.now(),pending=bridge.invoke('read',{}),response=await polling;
  assert.equal(response.waitSupported,true);assert.ok(response.job);assert.ok(performance.now()-started<1000);bridge.result(session.token,response.job.id,{revision:0});await pending;
  assert.equal((await post('agent/read',{boardId:'main',editorSessionId:randomUUID(),revision:0,source:'saved'})).source,'saved');
  await post('heartbeat',{editorState:'input_active'},session.token);
  assert.equal((await post('agent/read',{})).code,'EDITOR_NOT_READY');
  assert.equal((await post('agent/read',{boardId:'main',editorSessionId:randomUUID(),revision:0,source:'saved'})).source,'saved');
});
test('precise validation refuses missing objects instead of reporting an empty successful check',async t=>{
  const {bridge}=await setup(t),pending=bridge.invoke('validate',{revision:0,elementIds:['missing']}),job=bridge.poll('editor');
  assert.throws(()=>bridge.result('editor',job.id,{revision:0}),{code:'TARGET_MISSING'});bridge.result('editor',job.id,{error:{code:'TARGET_MISSING'}});assert.equal((await pending).error.code,'TARGET_MISSING');
});
