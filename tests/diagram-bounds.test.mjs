import test from 'node:test';
import assert from 'node:assert/strict';
import {bounds,assignRoute,validateDiagram} from '../shared/diagram.mjs';
import {describeBoard} from '../server/bridge.mjs';
const node=(id,x,y)=>({id,type:'rectangle',x,y,width:180,height:90,angle:0});

test('leftward upward feedback uses its actual path extent in board summaries',()=>{
  const from=node('execution',2160,1280),to=node('state',100,250);
  const edge={id:'feedback',type:'arrow',angle:0};
  assignRoute(edge,from,to,{fromPort:'bottom',toPort:'top',route:'orthogonal',via:[[2250,1500],[2700,1500],[2700,160],[190,160]]},[from,to]);
  const elements=[from,to,edge],before=structuredClone(elements);
  assert.deepEqual(bounds(elements),[100,160,2700,1500]);
  assert.deepEqual(validateDiagram(elements).bounds,[100,160,2700,1500]);
  const board={boardId:'main',title:'Feedback',revision:1,savedAt:null,scene:{elements}};
  assert.deepEqual(describeBoard(board,[],{summary:true}).bounds,[100,160,2700,1500]);
  assert.deepEqual(elements,before);
});

test('linear paths include all negative turns and ignore deleted elements',()=>{
  const line={id:'line',type:'line',x:300,y:300,width:400,height:250,points:[[0,0],[-400,0],[-400,-250],[-10,-250]],angle:0};
  const ink={id:'ink',type:'freedraw',x:30,y:20,width:20,height:20,points:[[0,0],[-20,20]],angle:0};
  const removed={...node('removed',-1000,-1000),isDeleted:true};
  assert.deepEqual(bounds([line,ink,removed]),[-100,20,300,300]);
  assert.equal(bounds([removed]),null);
});

test('basic shapes and linear elements without point data keep their former bounds',()=>{
  assert.deepEqual(bounds([node('n',10,20)]),[10,20,190,110]);
  assert.deepEqual(bounds([{id:'old',type:'arrow',x:10,y:20,width:200,height:80}]),[10,20,210,100]);
});
