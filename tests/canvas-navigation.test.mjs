import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=readFileSync(new URL('../src/reading-mode.ts',import.meta.url),'utf8');
function setup({visible=true,zoom=.3}={}) {
  const effects=[],listeners=new Map();
  class Canvas {}
  const surface={addEventListener:(name,fn,options)=>listeners.set(name,{fn,options}),
    removeEventListener:(name,fn)=>{assert.equal(listeners.get(name)?.fn,fn);listeners.delete(name);}};
  let app={zoom:{value:zoom},scrollX:120,scrollY:-70,offsetLeft:40,offsetTop:80,width:1000,height:700};
  const updates=[];
  const editor={current:{getAppState:()=>app,updateScene:({appState})=>{updates.push(appState);app={...app,...appState};}}};
  const react={useRef:value=>({current:value}),useState:value=>[value,()=>{}],useCallback:fn=>fn,
    useEffect:(fn,deps)=>effects.push({fn,deps})};
  const exports={};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require:name=>{assert.equal(name,'react');return react;},HTMLCanvasElement:Canvas});
  const reader=exports.useReadingMode(editor,7,visible);
  reader.shell.current={querySelector:()=>surface};
  const effect=effects.find(e=>e.deps.includes(7));
  const cleanup=effect.fn();
  function wheel(deltaY,target=new Canvas(),deltaMode=0) {
    let prevented=false,stopped=false;
    listeners.get('wheel')?.fn({target,deltaY,deltaMode,clientX:300,clientY:240,
      preventDefault:()=>{prevented=true;},stopPropagation:()=>{stopped=true;}});
    return {prevented,stopped};
  }
  return {wheel,updates,listeners,cleanup,effect,app:()=>app};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('ordinary canvas wheel zooms around the pointer and consumes the native pan event',()=>{
  const q=setup(),before=q.app();
  const point={x:(300-before.offsetLeft)/before.zoom.value-before.scrollX,
    y:(240-before.offsetTop)/before.zoom.value-before.scrollY};
  assert.deepEqual(q.wheel(-80),{prevented:true,stopped:true});
  const after=q.app();assert.ok(after.zoom.value>before.zoom.value);
  near((300-after.offsetLeft)/after.zoom.value-after.scrollX,point.x);
  near((240-after.offsetTop)/after.zoom.value-after.scrollY,point.y);
  q.wheel(80);near(q.app().zoom.value,.3);
});

test('menus, text inputs and horizontal-only wheel retain their native behavior',()=>{
  const q=setup();
  assert.deepEqual(q.wheel(-100,{}),{prevented:false,stopped:false});
  assert.deepEqual(q.wheel(0),{prevented:false,stopped:false});
  assert.equal(q.updates.length,0);
});

test('zoom stays within 10–300% even at the limits',()=>{
  const low=setup({zoom:.1}),high=setup({zoom:3});
  assert.equal(low.wheel(100).prevented,true);assert.equal(low.updates.length,0);
  assert.equal(high.wheel(-100).prevented,true);assert.equal(high.updates.length,0);
});

test('line and page wheel units are normalized to the same pixel zoom',()=>{
  const pixels=setup(),lines=setup(),page=setup();
  pixels.wheel(-16);lines.wheel(-1,undefined,1);near(pixels.app().zoom.value,lines.app().zoom.value);
  page.wheel(-1,undefined,2);near(page.app().zoom.value,.3*Math.exp(.2));
});

test('board mount identity controls listener binding, and leaving the editor cleans it up',()=>{
  const q=setup();
  assert.equal(q.listeners.get('wheel').options.passive,false);
  assert.equal(q.listeners.get('wheel').options.capture,true);
  assert.equal(q.effect.deps[1],7);assert.equal(q.effect.deps[2],true);
  q.cleanup();assert.equal(q.listeners.size,0);
  const library=setup({visible:false});assert.equal(library.listeners.size,0);
});
