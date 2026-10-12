import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {patchShape,previewShape,patchSchema,previewSchema} from '../server/authoring-schema.mjs';

test('advertised patch and preview coordinate arrays use homogeneous items schemas',()=>{
  for(const shape of [patchShape,previewShape]){
    const schema=z.toJSONSchema(z.object(shape),{target:'draft-7',io:'input'});
    let viaCount=0;
    function walk(value){
      if(!value||typeof value!=='object')return;
      if(value.type==='array')assert.ok(!Array.isArray(value.items),'Array-valued items is a positional tuple schema');
      if(value.properties?.via){
        const via=value.properties.via;viaCount++;
        assert.equal(via.maxItems,8);assert.equal(via.items.type,'array');
        assert.equal(via.items.minItems,2);assert.equal(via.items.maxItems,2);
        assert.equal(via.items.items.type,'number');
        assert.equal(via.items.items.minimum,-100000);assert.equal(via.items.items.maximum,100000);
      }
      for(const child of Object.values(value))walk(child);
    }
    walk(schema);assert.equal(viaCount,3);
  }
});

test('coordinate validation remains strict for new arrows, connect and reroute',()=>{
  const factories=[
    via=>({items:[{id:'a',type:'rectangle',x:0,y:0},{id:'b',type:'rectangle',x:400,y:200},{id:'ab',type:'arrow',from:'a',to:'b',via}]}),
    via=>({edits:[{op:'connect',id:'ab',from:'existing-a',to:'existing-b',via}]}),
    via=>({edits:[{op:'reroute',target:'existing-edge',via}]})
  ];
  const invalid=[[[1]],[[1,2,3]],[[1,'2']],[[null,2]],[[NaN,2]],[[Infinity,2]],[[100001,2]],Array.from({length:9},()=>[1,2])];
  for(const schema of [patchSchema,previewSchema])for(const factory of factories){
    const valid={baseRevision:0,requestId:randomUUID(),...factory([[-100000,100000],[0,0]])};
    const parsed=schema.parse(valid);assert.deepEqual(parsed.items?.at(-1).via??parsed.edits[0].via,[[-100000,100000],[0,0]]);
    for(const via of invalid)assert.equal(schema.safeParse({...valid,...factory(via)}).success,false);
  }
});
