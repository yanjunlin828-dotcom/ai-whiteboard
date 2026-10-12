import test from 'node:test';
import assert from 'node:assert/strict';
import {scaleTeachingElements,teachingHierarchyPlan,enlargeTeachingDetails} from '../shared/teaching-layout.mjs';

const a={id:'a',type:'rectangle',x:10,y:20,width:100,height:80,boundElements:[{id:'text',type:'text'},{id:'arrow',type:'arrow'}]};
const b={id:'b',type:'rectangle',x:210,y:20,width:100,height:80,boundElements:[{id:'arrow',type:'arrow'}]};
const text={id:'text',type:'text',containerId:'a',text:'保留公式',originalText:'保留公式',fontSize:26,x:20,y:40,width:70,height:32.5};
const arrow={id:'arrow',type:'arrow',x:120,y:60,width:80,height:0,points:[[0,0],[80,0]],startBinding:{elementId:'a',gap:10,focus:0},endBinding:{elementId:'b',gap:10,focus:0}};
const ink={id:'user-ink',type:'freedraw',x:0,y:0,width:20,height:20};
const elements=[a,b,text,arrow,ink], ids=['a','b','text','arrow'];
test('scaling preserves all content and bindings while transforming text and arrow geometry together',()=>{
  const next=scaleTeachingElements(elements,ids,{x:10,y:20},{x:100,y:200},.6);
  assert.equal(next[0].width,60); assert.equal(next[2].fontSize,15.6);
  assert.equal(next[2].text,text.text); assert.equal(next[2].containerId,'a');
  assert.deepEqual(next[3].points,[[0,0],[48,0]]);
  assert.equal(next[3].startBinding.gap,6); assert.equal(next[3].endBinding.elementId,'b');
  assert.equal(next[4],ink); assert.equal(elements[0],a); assert.equal(a.width,100);
});
test('locked, rotated, external bindings and partial selections cannot be silently transformed',()=>{
  assert.throws(()=>scaleTeachingElements(elements,['a'],{x:0,y:0},{x:0,y:0},.6),/外部绑定/);
  for(const change of [{locked:true},{angle:1},{frameId:'frame'}]) {
    assert.throws(()=>scaleTeachingElements([{...a,...change},b,text,arrow],ids,{x:0,y:0},{x:0,y:0},.6),/不支持/);
  }
});
test('ordinary documents do not match the specialized teaching layout',()=>{
  assert.equal(teachingHierarchyPlan(elements),null);
});

test('larger callouts keep all six leader attachment points, content and main diagram unchanged; repeated use is a no-op',()=>{
  const p='ai-12345678-1234-1234-1234-123456789abc-';
  const main=[1,2,3].flatMap(n=>[{id:p+`teach-${n}-title`,type:'text',text:'主阶段',x:n*2000,y:0},
    {id:p+`teach-${n}-frame`,type:'rectangle',x:n*2000,y:0,width:1920,height:1280}]);
  const details=[1,2,3,4,5,6].flatMap(n=>[
    {id:p+`detail-${n}-frame`,type:'rectangle',x:n*1000,y:2000,width:n===1?480:720,height:480},
    {id:p+`detail-${n}-title`,type:'text',text:'公式不变',originalText:'公式不变',x:n*1000+24,y:2024,width:150,height:25.5,fontSize:20.4}]);
  const guide={id:p+'hierarchy-A-mark',type:'ellipse',x:0,y:0,width:100,height:100};
  const initial=[...main,...details,guide,ink], plan=enlargeTeachingDetails(initial);
  assert.ok(plan);
  for(const e of [...main,guide,ink])assert.deepEqual(plan.elements.find(v=>v.id===e.id),e);
  for(let i=0;i<6;i++){
    const old=details[i*2],next=plan.elements.find(e=>e.id===old.id);
    const anchor=(e)=>i===0||i===2?[e.x+e.width,e.y+e.height/2]:i===1?[e.x+e.width/2,e.y+e.height]:i===5?[e.x,e.y+e.height/2]:[e.x+e.width/2,e.y];
    assert.deepEqual(anchor(next),anchor(old)); assert.equal(next.height,600);
    const text=plan.elements.find(e=>e.id===details[i*2+1].id);
    assert.equal(text.originalText,'公式不变');assert.equal(text.fontSize,25.5);
  }
  assert.equal(enlargeTeachingDetails(plan.elements),null);
});
