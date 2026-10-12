import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {patchSchema,describeBoard,EditorBridge} from '../server/bridge.mjs';
import {blankBoard,BoardStore} from '../server/store.mjs';
import {checkNewCollisions,itemMetadata,assignRoute,validateDiagram,regionMembers} from '../shared/diagram.mjs';
import {planDiagramEdits} from '../shared/diagram-edits.mjs';
import {planFormulaPatch} from '../shared/formulas.mjs';
import {teachingRegions} from '../shared/teaching.mjs';
import {orderAppended} from '../shared/element-order.mjs';
import {noteTokens} from '../shared/typography.mjs';

const region=(id,order=0,kind='main',parentId)=>({id,title:id,kind,order,parentId,lessonId:'demo'});
const node=(id,x=100,y=100,width=180,height=90)=>({id,type:'rectangle',x,y,width,height,angle:0,boundElements:[],strokeColor:'#35639c',version:1});
const outer=(id='stage',x=0,y=0)=>({...node('box-'+id,x,y,900,650),customData:itemMetadata({region:region(id)})});
const ink={id:'manual',type:'freedraw',x:1000,y:1000,width:10,height:10,points:[[0,0],[10,10]],pressures:[0.1,0.7]};
const text=(id,x,y,value='短标题')=>({id,type:'text',x,y,width:84,height:35,fontSize:28,fontFamily:10,lineHeight:1.25,text:value,originalText:value,angle:0,textAlign:'center',verticalAlign:'middle',version:1});
const measure=async(e,width)=>{const raw=e.originalText??e.text;const per=Math.max(1,Math.floor(width/e.fontSize));const rows=raw.match(new RegExp(`.{1,${per}}`,'g'))??[''];return {text:rows.join('\n'),width:Math.min(width,Math.max(...rows.map(x=>x.length))*e.fontSize),height:rows.length*e.fontSize*(e.lineHeight??1.25)};};
const patch=edits=>({baseRevision:1,requestId:randomUUID(),edits});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8H0AAAAASUVORK5CYII=';
const parent=resolve('../中间过程/AI讲解白板/mcp-authoring-20261012/tests');await mkdir(parent,{recursive:true});
async function setup(t,elements){const directory=await mkdtemp(join(parent,'run-')),store=new BoardStore(directory);await store.load();await store.save({baseRevision:0,requestId:randomUUID(),title:'Authoring QA',scene:{...blankBoard().scene,elements}});const bridge=new EditorBridge(store,{allowEdits:true});t.after(()=>bridge.close());return {store,bridge,directory};}

test('node typography survives parsing; unsupported nested fields fail instead of disappearing',()=>{
 const i={id:'box',type:'rectangle',x:10,y:10,text:'大字号',fontSize:48,padding:16,backgroundColor:'#ffffff'};
 const parsed=patchSchema.parse({baseRevision:0,requestId:randomUUID(),items:[i]});assert.equal(parsed.items[0].fontSize,48);
 assert.equal(patchSchema.safeParse({...parsed,items:[{...i,unknownOption:true}]}).success,false);
 assert.equal(patchSchema.safeParse({...parsed,items:[{...i,region:region('r')}]}).success,false);
});
test('explicit containment allows incremental nodes and formulas but still rejects actual collisions',async()=>{
 const frame=outer(),n={...node('n'),customData:itemMetadata({regionId:'stage'})};checkNewCollisions([frame],[n]);
 assert.throws(()=>checkNewCollisions([frame],[{...n,customData:undefined}]),{code:'CONTENT_COLLISION'});
 assert.throws(()=>checkNewCollisions([frame,n],[{...n,id:'other'}]),{code:'CONTENT_COLLISION'});
 const scene={...blankBoard().scene,elements:[frame,n]};
 const rendered=async()=>({latex:'x=1',width:160,height:60,fontSize:32,color:'#35639c',file:{id:'mock',dataURL:'mock'}});
 const r=await planFormulaPatch(scene,{requestId:randomUUID(),items:[{id:'eq',type:'text',x:100,y:250,text:'$$x=1$$',regionId:'stage'}]},[],rendered);
 assert.equal(r.elements.at(-1).customData.whiteboard.regionId,'stage');
 assert.equal(r.elements.at(-1).customData.formula.latex,'x=1');assert.equal(regionMembers(r.elements,'stage').length,3);
});
test('orthogonal ports are exact and route around intervening content',()=>{
 const a=node('a',0,100),b=node('b',550,230),obstacle=node('obstacle',240,90,150,280),arrow={id:'edge',type:'arrow'};
 assignRoute(arrow,a,b,{fromPort:'right',toPort:'left'},[a,b,obstacle]);
 const points=arrow.points.map(p=>[p[0]+arrow.x,p[1]+arrow.y]);assert.deepEqual(points[0],[192,145]);assert.deepEqual(points.at(-1),[538,275]);
 assert.ok(points.slice(1).every((p,i)=>p[0]===points[i][0]||p[1]===points[i][1]));
 assert.equal(validateDiagram([a,b,obstacle,arrow]).issues.some(i=>i.code==='EDGE_CROSSING'),false);
 assert.throws(()=>assignRoute({...arrow},a,b,{via:[[300,145],[300,275]]},[a,b,obstacle]),{code:'ROUTE_BLOCKED'});
});
test('guide lines have no arrowhead and preserve route declarations after moving a member',async()=>{
 const a=node('a',0,0),b=node('b',420,80),arrow={id:'edge',type:'arrow',strokeStyle:'dashed'};
 assignRoute(arrow,a,b,{endArrowhead:'none'},[a,b]);
 const initial=[a,b,arrow,ink],r=await planDiagramEdits(initial,patch([{op:'move',target:'a',dx:30,dy:20}]),[],measure);
 const next=r.elements.find(e=>e.id==='edge');assert.equal(next.endArrowhead,null);assert.equal(next.strokeStyle,'dashed');
 assert.deepEqual(r.elements.at(-1),ink);assert.equal(validateDiagram(r.elements).issues.some(i=>['PORT_OFFSET','DIAGONAL_ROUTE'].includes(i.code)),false);
});
test('set_style measures large labels and resizing preserves ink and rejects insufficient height',async()=>{
 const a=node('a'),label={...text('label',148,127.5),containerId:'a'};a.boundElements=[{id:'label',type:'text'}];
 const r=await planDiagramEdits([a,label,ink],patch([{op:'set_style',target:'a',style:{fontSize:42,color:'#6b55a1'}}]),[],measure);
 assert.equal(r.elements[1].fontSize,42);assert.equal(r.elements[1].strokeColor,'#6b55a1');assert.deepEqual(r.elements[2],ink);
 await assert.rejects(planDiagramEdits(r.elements,patch([{op:'resize',target:'a',width:80,height:40}]),[],measure),{code:'TEXT_OVERFLOW'});
 const resized=await planDiagramEdits(r.elements,patch([{op:'resize',target:'a',width:250,height:120}]),[],measure);assert.equal(resized.elements[0].width,250);
});
test('region membership spans batches; more than three main stages are navigable',async()=>{
 const frames=Array.from({length:4},(_,i)=>({...outer('stage'+i,i*1000,0),customData:itemMetadata({region:region('stage'+i,i)})}));
 const n={...node('later',100,120),customData:itemMetadata({regionId:'stage0'})};
 assert.equal(teachingRegions([...frames,n]).length,4);assert.ok(teachingRegions([...frames,n])[0].elementIds.includes(n.id));
 const r=await planDiagramEdits([...frames,n,ink],patch([{op:'move_region',regionId:'stage0',dx:40,dy:60}]),[],measure);
 assert.equal(r.elements[0].x,40);assert.equal(r.elements[4].x,140);assert.deepEqual(r.elements[5],ink);
});
test('region cycles, missing IDs and locked members reject the whole transaction',async()=>{
 const f=outer();await assert.rejects(planDiagramEdits([f],patch([{op:'set_region',target:f.id,region:region('stage',0,'main','stage')}]),[],measure),{code:'REGION_CYCLE'});
 await assert.rejects(planDiagramEdits([f,{...node('n'),locked:true,customData:itemMetadata({regionId:'stage'})}],patch([{op:'move_region',regionId:'stage',dx:20,dy:0}]),[],measure),{code:'LOCKED'});
 assert.equal(f.x,0);
});
test('formula move and aspect-preserving resize are supported without losing source',async()=>{
 const eq={id:'eq',type:'image',x:50,y:50,width:200,height:60,angle:0,customData:{formula:{latex:'x=1'}}};
 const r=await planDiagramEdits([eq,ink],patch([{op:'move',target:'eq',dx:50,dy:30},{op:'resize',target:'eq',width:300,height:90}]),[],measure);
 assert.equal(r.elements[0].x,100);assert.equal(r.elements[0].customData.formula.latex,'x=1');assert.deepEqual(r.elements[1],ink);
 await assert.rejects(planDiagramEdits([eq],patch([{op:'resize',target:'eq',width:300,height:40}]),[],measure),{code:'FORMULA_ASPECT'});
});
test('pagination returns every element and pins revision; summary and region reads stay compact',()=>{
 const scene=[outer(),...Array.from({length:600},(_,i)=>({...text('t'+i,100,100+i*40),customData:itemMetadata({regionId:'stage'})}))];
 const board={...blankBoard(),revision:4,scene:{...blankBoard().scene,elements:scene}};
 const first=describeBoard(board,[],{limit:500,offset:0,revision:4}),last=describeBoard(board,[],{limit:500,offset:first.nextOffset,revision:4});
 assert.equal(first.nextOffset,500);assert.equal(last.nextOffset,null);assert.equal(new Set([...first.elements,...last.elements].map(e=>e.id)).size,601);
 const summary=describeBoard(board,[],{summary:true,regionId:'stage'});assert.equal(summary.elements.length,0);assert.equal(summary.regions[0].count,601);assert.deepEqual(summary.bounds,[0,0,900,100+599*40+35]);
 assert.throws(()=>describeBoard(board,[],{revision:3}),{code:'REVISION_CONFLICT'});
});
test('quality report names exact IDs for small text, nested content overlap and shifted ports',()=>{
 const a=node('a'),b=node('b',500),small={...text('small',120,120),fontSize:18,width:100,height:30},edge={id:'edge',type:'arrow',x:290,y:123,width:198,height:0,points:[[0,0],[198,0]],startBinding:{elementId:'a',gap:12},endBinding:{elementId:'b',gap:12}};
 const r=validateDiagram([a,b,small,edge]);assert.ok(r.issues.some(i=>i.code==='SMALL_TEXT'&&i.elementIds.includes('small')));assert.ok(r.issues.some(i=>i.code==='CONTENT_OVERLAP'));assert.ok(r.issues.some(i=>i.code==='PORT_OFFSET'));
});
test('unassigned bound labels are not mistaken for members of the first region',()=>{
 const f=outer(),a={...node('a'),customData:itemMetadata({regionId:'stage'})},label={...text('label',148,127.5),containerId:'a'};
 assert.equal(validateDiagram([f,a,label]).issues.some(i=>i.code==='REGION_OVERFLOW'),false);
});
test('appended batches receive stable layer order without changing earlier elements',()=>{
 const original=[{...node('a'),index:'a0'},{...node('b'),index:'a1'}],snapshot=structuredClone(original),added=[{...node('c'),index:'a0'},node('d')];
 orderAppended(original,added);assert.deepEqual(original,snapshot);assert.ok(added[0].index>'a1');assert.ok(added[1].index>added[0].index);
});
test('Chinese closing punctuation stays with the preceding token and decimals remain intact',()=>{
 const tokens=noteTokens('概率约0.731。结果如下：');assert.ok(tokens.includes('0.731。'));assert.ok(!tokens.includes('。'));assert.equal(tokens.join(''),'概率约0.731。结果如下：');
});
test('candidate preview validates through server without adding disk revisions or receipts',async t=>{
 const {store,bridge,directory}=await setup(t,[node('a'),ink]),before=store.read(),files=await readdir(directory),input=patch([{op:'set_style',target:'a',style:{color:'#6b55a1'}}]);
 const pending=bridge.invoke('preview',input),job=bridge.poll('browser');const candidate=await planDiagramEdits(before.scene.elements,input,[],measure);
 const preview=await bridge.preview('browser',job.id,candidate);assert.equal(preview.scene.elements[0].strokeColor,'#6b55a1');
 bridge.result('browser',job.id,{revision:1,png});assert.equal((await pending).saved,false);assert.deepEqual(store.read(),before);assert.deepEqual(await readdir(directory),files);assert.equal(store.aiTransactions.size,0);
});
test('server rejects forged advanced styles and metadata, then commits exactly the declared changes',async t=>{
 const {store,bridge}=await setup(t,[node('a'),ink]),input=patch([{op:'set_style',target:'a',style:{color:'#6b55a1'}}]);
 const candidate=await planDiagramEdits(store.read().scene.elements,input,[],measure),pending=bridge.invoke('patch',input),job=bridge.poll('browser');
 const forged=structuredClone(candidate);forged.elements[1].pressures=[0,0];await assert.rejects(bridge.commit('browser',job.id,forged),{code:'OUT_OF_SCOPE'});
 await bridge.commit('browser',job.id,candidate);bridge.result('browser',job.id,{revision:2});assert.equal((await pending).applied,true);assert.deepEqual(store.read().scene.elements[1],ink);
});
test('declared connection metadata roundtrips through server reconstruction; injected metadata fails',async t=>{
 const {store,bridge}=await setup(t,[node('a',0,0),node('b',500,100)]),input=patch([{op:'connect',id:'link',from:'a',to:'b',fromPort:'right',toPort:'left',strokeStyle:'dashed',endArrowhead:'none'}]);
 const template={id:`ai-${input.requestId}-link`,type:'arrow',x:0,y:0,width:100,height:0,points:[[0,0],[100,0]],angle:0};
 const planned=await planDiagramEdits(store.read().scene.elements,input,[],measure,[template]),pending=bridge.invoke('patch',input),job=bridge.poll('browser');
 const forged=structuredClone(planned);forged.elements.at(-1).customData.unrequested='not allowed';await assert.rejects(bridge.commit('browser',job.id,forged),{code:'OUT_OF_SCOPE'});
 await bridge.commit('browser',job.id,planned);bridge.result('browser',job.id,{revision:2});assert.equal((await pending).applied,true);assert.equal(store.read().scene.elements.at(-1).endArrowhead,null);
});
test('stale preview and malformed text measurement cannot be committed or rendered',async t=>{
 const {store,bridge}=await setup(t,[node('a'),{...text('label',120,120),containerId:'a'}]);
 const input=patch([{op:'set_style',target:'a',style:{fontSize:40}}]),pending=bridge.invoke('preview',input),job=bridge.poll('browser');
 await assert.rejects(bridge.preview('browser',job.id,{elements:store.read().scene.elements,layouts:{}}),{code:'INVALID_LAYOUT'});
 await store.save({baseRevision:1,requestId:randomUUID(),title:'changed',scene:store.read().scene});
 await assert.rejects(bridge.preview('browser',job.id,{elements:store.read().scene.elements}),{code:'REVISION_CONFLICT'});
 bridge.result('browser',job.id,{error:{code:'REVISION_CONFLICT'}});await pending;
});
