const fail=message=>{throw new Error(message);};
import {itemMetadata,checkNewCollisions,checkRegions} from './diagram.mjs';
import {orderAppended} from './element-order.mjs';
export const formulaSource=text=>typeof text==='string'&&text.trim().startsWith('$$')&&text.trim().endsWith('$$')?text.trim().slice(2,-2).trim():null;
export function isFormulaPatch(input,elements){
  return Boolean(input.items?.some(i=>formulaSource(i.text)!==null)||input.edits?.some(o=>o.op==='set_formula'||o.op==='set_text'&&(formulaSource(o.text)!==null||elements.find(e=>e.id===o.target)?.customData?.formula)));
}
export function formulaElement(old,rendered,id,x,y){
  if(old&&(old.locked||old.isDeleted||old.angle||old.frameId||old.containerId||old.boundElements?.length||!['text','image'].includes(old.type)))fail('公式替换仅支持未锁定、无绑定的独立文字或公式。');
  if(old?.type==='image'&&!old.customData?.formula)fail('不能将普通图片当作公式修改。');
  const scale=old?.customData?.formula?old.width/old.customData.formula.naturalWidth:1;
  return {
    id:old?.id??id,type:'image',x:old?.x??x,y:old?.y??y,width:rendered.width*scale,height:rendered.height*scale,
    angle:0,strokeColor:rendered.color,backgroundColor:'transparent',fillStyle:'solid',strokeWidth:1,strokeStyle:'solid',roughness:0,
    opacity:old?.opacity??100,groupIds:old?.groupIds??[],frameId:null,index:old?.index??null,roundness:null,seed:old?.seed??1,
    version:(old?.version??0)+1,versionNonce:(old?.versionNonce??0)+1,isDeleted:false,boundElements:[],updated:(old?.updated??0)+1,
    link:null,locked:false,fileId:rendered.file.id,status:'saved',scale:[1,1],crop:null,
    customData:{...old?.customData,formula:{version:1,latex:rendered.latex,font:'Fira Math',fontSize:rendered.fontSize,color:rendered.color,naturalWidth:rendered.width},
      ...(old?.type==='text'?{formulaOriginalText:old.originalText??old.text}:{})},
  };
}
export async function planFormulaPatch(scene,input,selectedIds,render){
  const elements=structuredClone(scene.elements),files={...scene.files},affectedIds=[],createdIds=[];
  if(input.selectionIds&&JSON.stringify([...input.selectionIds].sort())!==JSON.stringify([...selectedIds].sort()))fail('选区已变化，请重新读取。');
  if(input.flow)fail('公式请单独使用 items 或 edits。');
  const seen=new Set();
  for(const item of input.items??[]){
    const latex=formulaSource(item.text);if(item.type!=='text'||latex===null)fail('公式与普通图元请分批生成。');
    const id=`ai-${input.requestId}-${item.id}`;
    if(elements.some(e=>e.id===id)||seen.has(id))fail('公式 ID 重复。');seen.add(id);
    const rendered=await render({latex,fontSize:item.fontSize??30,color:item.color??'#35639c'});
    const element=formulaElement(null,rendered,id,item.x,item.y);
    const metadata=itemMetadata(item);if(metadata)element.customData={...element.customData,...metadata};
    checkNewCollisions(elements,[element]);
    elements.push(element);files[rendered.file.id]=rendered.file;createdIds.push(id);
  }
  for(const op of input.edits??[]){
    if(!['set_text','set_formula'].includes(op.op))fail('公式修改请单独使用 set_text 或 set_formula。');
    const id=op.target==='$selection'?(input.selectionIds&&selectedIds.length===1?selectedIds[0]:fail('请只选中一个公式。')):op.target;
    if(seen.has(id))fail('不能重复修改同一公式。');seen.add(id);
    const index=elements.findIndex(e=>e.id===id&&!e.isDeleted);if(index<0)fail('公式目标不存在。');
    const old=elements[index],latex=op.op==='set_formula'?op.latex:formulaSource(op.text);
    if(latex===null)fail('公式内容请使用 $$LaTeX$$ 格式。');
    const rendered=await render({latex,fontSize:op.fontSize??old.customData?.formula?.fontSize??old.fontSize??30,color:op.color??old.customData?.formula?.color??old.strokeColor??'#35639c'});
    elements[index]=formulaElement(old,rendered);files[rendered.file.id]=rendered.file;affectedIds.push(id);
  }
  orderAppended(scene.elements,elements.slice(scene.elements.length));checkRegions(elements);return {elements,files,affectedIds,createdIds};
}
