import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {renderFormula} from '../server/formula.mjs';
import {formulaElement,planFormulaPatch} from '../shared/formulas.mjs';
import {BoardStore,blankBoard} from '../server/store.mjs';
import {EditorBridge,describeBoard} from '../server/bridge.mjs';

const latex=String.raw`p_i=\frac{\exp(z_i/T)}{\sum_{j=1}^{K}\exp(z_j/T)}`;
test('Fira fractions, Greek and matrices produce deterministic standalone vector paths',async()=>{
  for(const source of [latex,String.raw`\begin{bmatrix}\alpha&1\\0&\beta\end{bmatrix}`,String.raw`\nabla_\theta L=\sum_{i=1}^{N}g_i`]){
    const r=await renderFormula({latex:source,fontSize:30,color:'#35639c'});
    const svg=Buffer.from(r.file.dataURL.split(',')[1],'base64').toString();
    assert.match(svg,/<path/);assert.doesNotMatch(svg,/<text|currentColor|foreignObject|<image/);
    assert.ok(r.width>0&&r.height>0);assert.deepEqual(await renderFormula({latex:source,fontSize:30,color:'#35639c'}),r);
  }
});
test('invalid syntax, unsafe commands and unsupported inputs fail without poisoning later renders',async()=>{
  for(const source of [String.raw`\frac{1}{`,String.raw`\require{html}`,String.raw`\href{https://example.com}{x}`,'中文','', 'x'.repeat(2001)])await assert.rejects(renderFormula({latex:source}));
  assert.ok((await renderFormula({latex:'x^2'})).file.id);
});
const original=()=>({id:'math',type:'text',x:10,y:20,width:300,height:38,fontSize:30,fontFamily:11,text:'p_i = exp(z_i)/sum(exp(z_j))',originalText:'p_i = exp(z_i)/sum(exp(z_j))',strokeColor:'#35639c',version:1,versionNonce:10,updated:1,angle:0,locked:false,groupIds:[],boundElements:[]});
const request=()=>({baseRevision:1,requestId:randomUUID(),edits:[{op:'set_text',target:'math',text:'$$'+latex+'$$'}]});
test('replacement preserves original source, unrelated objects, native resizing and rejects bound targets',async()=>{
  const scene={...blankBoard().scene,elements:[original(),{...original(),id:'note',y:200,text:'keep'}]};
  const before=structuredClone(scene),r=await planFormulaPatch(scene,request(),[],renderFormula);
  assert.deepEqual(scene,before);assert.deepEqual(r.elements[1],before.elements[1]);
  assert.equal(r.elements[0].id,'math');assert.equal(r.elements[0].customData.formulaOriginalText,original().text);
  assert.equal(r.elements[0].customData.formula.latex,latex);
  const old={...r.elements[0],width:r.elements[0].width*2,height:r.elements[0].height*2};
  const next=await renderFormula({latex:'x^2'});
  assert.equal(formulaElement(old,next).width,next.width*2);
  for(const change of [{locked:true},{containerId:'box'},{frameId:'frame'},{boundElements:[{id:'arrow',type:'arrow'}]},{angle:1}])await assert.rejects(planFormulaPatch({...scene,elements:[{...original(),...change}]},request(),[],renderFormula));
});
test('AI commit verifies geometry, persists only server generated SVG, and reloads editable source',async t=>{
  const root=resolve('../中间过程/AI讲解白板/tests');await mkdir(root,{recursive:true});
  const dir=await mkdtemp(join(root,'formulas-')),store=new BoardStore(dir);await store.load();
  await store.save({baseRevision:0,requestId:randomUUID(),title:'公式隔离测试',scene:{...blankBoard().scene,elements:[original()]}});
  const bridge=new EditorBridge(store,{allowEdits:true});t.after(()=>bridge.close());
  const req=request(),pending=bridge.invoke('patch',req),job=bridge.poll('editor');
  const candidate=await planFormulaPatch(store.read().scene,req,[],renderFormula);
  const forged=structuredClone(candidate);forged.elements[0].x=999;
  await assert.rejects(bridge.commit('editor',job.id,forged),{code:'OUT_OF_SCOPE'});assert.equal(store.read().revision,1);
  await bridge.commit('editor',job.id,{...candidate,files:{evil:{dataURL:'data:image/svg+xml;base64,evil'}}});
  bridge.result('editor',job.id,{revision:2});assert.equal((await pending).applied,true);
  const reload=new BoardStore(dir);await reload.load();
  assert.deepEqual(reload.read().scene.files,candidate.files);
  assert.equal(describeBoard(reload.read()).elements[0].formula.latex,latex);
});
