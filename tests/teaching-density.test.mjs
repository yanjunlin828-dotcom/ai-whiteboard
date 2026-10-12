import test from 'node:test';
import assert from 'node:assert/strict';
import {midpointRoute,teachingDensityPlan} from '../shared/teaching-density.mjs';
const a={x:0,y:0,width:200,height:100}, b={x:400,y:180,width:100,height:80};
test('offset connectors use opposing edge midpoints and orthogonal segments',()=>{
  for(const [sa,sb,start,end] of [['right','left',[208,50],[392,220]],['bottom','top',[100,108],[450,172]]]){
    const path=midpointRoute(a,b,sa,sb);
    assert.deepEqual(path[0],start);assert.deepEqual(path.at(-1),end);
    for(let i=1;i<path.length;i++)assert.ok(path[i][0]===path[i-1][0]||path[i][1]===path[i-1][1]);
  }
});
test('fan-out and fan-in share center ports without crossed diagonal connections',()=>{
  const left={x:-150,y:220,width:100,height:80},right={x:250,y:220,width:100,height:80};
  const l=midpointRoute(a,left,'bottom','top'),r=midpointRoute(a,right,'bottom','top');
  assert.deepEqual(l[0],r[0]);assert.deepEqual(l[1],r[1]);
  const backL=midpointRoute(left,a,'top','bottom'),backR=midpointRoute(right,a,'top','bottom');
  assert.deepEqual(backL.at(-1),backR.at(-1));
});
test('ordinary boards are not modified by the specialized lesson layout',()=>{
  const original=[{id:'note',type:'text',text:'用户笔记',x:10,y:20}];
  assert.equal(teachingDensityPlan(original,()=>{throw new Error('should not measure');}),null);
  assert.equal(original[0].text,'用户笔记');
});
