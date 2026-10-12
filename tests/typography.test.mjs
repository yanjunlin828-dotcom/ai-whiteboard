import test from 'node:test';
import assert from 'node:assert/strict';
import {isFormula,editedNoteFont} from '../shared/typography.mjs';
import {applyEdits} from '../shared/edits.mjs';
import {typographyPlugin} from '../scripts/typography-plugin.mjs';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

test('mathematical content is recognized without converting ordinary bilingual labels',()=>{
  for(const text of ['p_i = exp(s_i) / ∑ exp(s_j)','∇θ L','h_i','h₁','x² ≈ 0.5'])assert.ok(isFormula(text));
  for(const text of ['LayerNorm','Softmax','① 输入装配','共享评分器：向量 → 分数 → 概率','2026年10月'])assert.ok(!isFormula(text));
});
test('AI text edits use the same font policy and preserve explicit alternative fonts',()=>{
  const e={id:'t',type:'text',text:'Softmax',originalText:'Softmax',fontFamily:10,fontSize:24,lineHeight:1.25,
    x:100,y:100,width:240,height:30,version:1,versionNonce:1};
  const text='p = 0.8', input={requestId:'test',edits:[{op:'set_text',target:'t',text}]};
  const out=applyEdits([e],input,[],{t:{text,width:110,height:30}});
  assert.equal(out.elements[0].fontFamily,11);assert.equal(e.fontFamily,10);
  assert.equal(out.elements[0].x,100);assert.equal(out.elements[0].originalText,text);
  assert.equal(editedNoteFont(11,'Softmax'),10);assert.equal(editedNoteFont(3,text),3);
});
test('font adapter matches the pinned dependency and refuses an incompatible source',()=>{
  const root=process.cwd(),p=typographyPlugin(root);
  const path=resolve(root,'node_modules/@excalidraw/excalidraw/dist/dev/chunk-4FTI6OG3.js');
  const source=readFileSync(path,'utf8');
  const result=p.transform(source,path);
  assert.ok(result.code.includes('init("NoteMath"'));assert.ok(result.code.includes('init("NoteHand"'));
  assert.throws(()=>p.transform(source.replace('  "Liberation Sans": 9','changed'),path),/anchor changed/);
});
