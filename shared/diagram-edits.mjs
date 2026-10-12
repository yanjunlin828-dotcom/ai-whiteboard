import {applyEdits,EditError} from './edits.mjs';
import {meta,checkRegions,regionMembers,assignRoute} from './diagram.mjs';
import {orderAppended} from './element-order.mjs';
import {editedNoteFont} from './typography.mjs';
const fail=(code,message)=>{throw new EditError(code,message);};
const shapes=new Set(['rectangle','ellipse','diamond']);
export function needsDiagramEdits(input,elements){return input.edits?.some(op=>!['set_text','move'].includes(op.op)||elements.some(e=>e.id===op.target&&(meta(e)||e.customData?.formula)));}
function preserved(original,wrapped){return original.replace(/\n/g,'')===wrapped.replace(/\n/g,'');}
export async function planDiagramEdits(elements,input,selectedIds=[],measure,templates=[]){
  if(input.selectionIds&&JSON.stringify([...input.selectionIds].sort())!==JSON.stringify([...selectedIds].sort()))fail('SELECTION_CHANGED','选区已变化，请重新读取。');
  let result=structuredClone(elements);const before=new Map(elements.map(e=>[e.id,e])),layouts={},seen=new Set();
  const get=id=>{
    const e=result.find(e=>e.id===id&&!e.isDeleted);if(!e)fail('TARGET_MISSING','目标不存在。');
    if(e.locked)fail('LOCKED','目标或关联对象已锁定。');
    if(e.angle||e.frameId)fail('UNSUPPORTED_TARGET','暂不修改旋转或原生框架内对象。');return e;
  };
  const targets=target=>{
    if(target!=='$selection')return [get(target)];
    if(!input.selectionIds||!selectedIds.length)fail('SELECTION_REQUIRED','使用选区须传入刚读取的非空 selectionIds。');
    return [...new Set(selectedIds.map(id=>get(id).containerId??id))].map(get);
  };
  const labelFor=e=>e.type==='text'?e:result.find(l=>!l.isDeleted&&l.type==='text'&&l.containerId===e.id);
  async function layout(label,parent,key,allowGrowth){
    get(label.id);if(parent)get(parent.id);
    const padding=meta(parent??{})?.padding??5;
    const available=parent?(parent.type==='ellipse'?Math.round(parent.width/2*Math.sqrt(2)):parent.type==='diamond'?Math.round(parent.width/2):parent.width)-2*padding:Math.max(40,Math.min(4000,meta(label)?.maxWidth??label.width??240));
    const text=label.originalText??label.text;
    const l=await measure(label,available,key);layouts[key]=l;
    const expectedHeight=l?.text?.split('\n').length*label.fontSize*(label.lineHeight??1.25);
    if(!l||typeof l.text!=='string'||!preserved(text,l.text)||!Number.isFinite(l.width)||l.width<=0||l.width>available+2||!Number.isFinite(l.height)||l.height<=0||l.height>20000||Math.abs(expectedHeight-l.height)>2)fail('INVALID_LAYOUT','真实文字测量不符合字体、宽度或行数约束。');
    Object.assign(label,{text:l.text,width:l.width,height:l.height,customData:{...label.customData,noteTypography:3}});
    if(parent){
      let interior=(parent.type==='ellipse'?Math.round(parent.height/2*Math.sqrt(2)):parent.type==='diamond'?Math.round(parent.height/2):parent.height)-2*padding;
      if(l.height>interior){if(!allowGrowth)fail('TEXT_OVERFLOW','新框体不足以容纳文字，请增高。');const h=l.height+2*padding;parent.height=parent.type==='ellipse'?Math.ceil(h/Math.sqrt(2)*2):parent.type==='diamond'?h*2:h;}
      const offset=size=>padding+(parent.type==='ellipse'?size/2*(1-Math.sqrt(2)/2):parent.type==='diamond'?size/4:0);
      const w=(parent.type==='ellipse'?Math.round(parent.width/2*Math.sqrt(2)):parent.type==='diamond'?Math.round(parent.width/2):parent.width)-2*padding;
      const h=(parent.type==='ellipse'?Math.round(parent.height/2*Math.sqrt(2)):parent.type==='diamond'?Math.round(parent.height/2):parent.height)-2*padding;
      label.x=parent.x+offset(parent.width)+(label.textAlign==='left'?0:label.textAlign==='right'?w-label.width:(w-label.width)/2);
      label.y=parent.y+offset(parent.height)+(label.verticalAlign==='top'?0:label.verticalAlign==='bottom'?h-label.height:(h-label.height)/2);
    }
  }
  for(let i=0;i<(input.edits??[]).length;i++){
    const op=input.edits[i];
    if(op.op==='move_region'){
      const members=regionMembers(result,op.regionId);for(const e of members){get(e.id);if(!['arrow','line'].includes(e.type)){e.x+=op.dx;e.y+=op.dy;}}
      continue;
    }
    if(op.op==='connect'){
      const from=get(op.from),to=get(op.to),id=`ai-${input.requestId}-${op.id}`;
      if(result.some(e=>e.id===id)||seen.has(id))fail('DUPLICATE_ID','连接 ID 重复。');seen.add(id);
      const template=templates.find(e=>e.id===id);if(!template||template.type!=='arrow'||template.link||template.locked||template.elbowed||template.angle||template.isDeleted||template.boundElements?.length)fail('INVALID_CONNECTION','连接模板无效。');
      const arrow=structuredClone(template);delete arrow.customData;arrow.strokeColor=op.color??'#35639c';arrow.strokeWidth=op.strokeWidth??2;arrow.strokeStyle=op.strokeStyle??'solid';arrow.roughness=op.roughness??1;
      if(op.regionId)arrow.customData={whiteboard:{regionId:op.regionId}};
      assignRoute(arrow,from,to,op,result);result.push(arrow);
      for(const n of [from,to])n.boundElements=[...(n.boundElements??[]),{id,type:'arrow'}];continue;
    }
    const list=targets(op.target).map(e=>op.op==='move'&&e.type==='text'&&e.containerId?get(e.containerId):e);
    if(op.op==='set_text'&&list.length!==1)fail('AMBIGUOUS_SELECTION','改字须选择一个文字或节点。');
    for(const e of list){
      const key=`${i}:${e.id}`,unique=`${op.op}:${e.id}`;if(seen.has(unique))fail('DUPLICATE_OPERATION','同一批次不能重复执行同一目标的相同操作。');seen.add(unique);
      if(op.op==='set_text'){
        const label=labelFor(e);if(!label)fail('TEXT_TARGET_REQUIRED','目标没有文字。');label.originalText=op.text;if(label.fontFamily!==undefined)label.fontFamily=editedNoteFont(label.fontFamily,op.text);
        await layout(label,label.containerId?get(label.containerId):undefined,key,true);
      }else if(op.op==='move'){
        if(!shapes.has(e.type)&&e.type!=='text'&&!e.customData?.formula)fail('UNSUPPORTED_TARGET','移动仅支持文字、节点或公式。');
        e.x+=op.dx;e.y+=op.dy;
        for(const l of result.filter(l=>!l.isDeleted&&l.containerId===e.id)){get(l.id);l.x+=op.dx;l.y+=op.dy;}
      }else if(op.op==='resize'){
        if(!shapes.has(e.type)&&!e.customData?.formula)fail('UNSUPPORTED_TARGET','调整尺寸仅支持节点、分区或公式。');
        if(e.customData?.formula){if(Math.abs(op.width/op.height-e.width/e.height)>0.02)fail('FORMULA_ASPECT','公式缩放必须保持宽高比例。');}
        e.width=op.width;e.height=op.height;const label=labelFor(e);if(label)await layout(label,e,key,false);
      }else if(op.op==='set_style'){
        if(!shapes.has(e.type)&&e.type!=='text'&&e.type!=='arrow')fail('UNSUPPORTED_TARGET','公式样式请用 set_formula。');
        const label=labelFor(e),s=op.style;
        for(const field of ['backgroundColor','strokeWidth','strokeStyle','roughness'])if(s[field]!==undefined)e[field]=s[field];
        if(s.color!==undefined){e.strokeColor=s.color;if(label){get(label.id);label.strokeColor=s.color;}}
        if(s.fontSize!==undefined){if(!label)fail('TEXT_TARGET_REQUIRED','字号修改需要文字或带文字节点。');label.fontSize=s.fontSize;await layout(label,label.containerId?get(label.containerId):undefined,key,true);}
      }else if(op.op==='set_region'){
        if(op.region){if(e.type!=='rectangle'||labelFor(e))fail('REGION_CONTAINER','分区外框必须是不带绑定标签的矩形。');e.customData={...e.customData,whiteboard:{...meta(e),role:'container',region:op.region,regionId:op.region.id}};}
        else e.customData={...e.customData,whiteboard:{...meta(e),regionId:op.regionId}};
      }else if(op.op==='reroute'){
        if(e.type!=='arrow'||e.boundElements?.some(x=>x.type==='text')||e.elbowed)fail('UNSUPPORTED_TARGET','重算连接需要无文字、非原生折肘的绑定箭头。');
        assignRoute(e,get(e.startBinding?.elementId),get(e.endBinding?.elementId),{...meta(e)?.connection,...op},result);
      }else fail('UNSUPPORTED_OPERATION','该操作需要单独处理公式。');
    }
  }
  // Existing unsupported bindings still receive the legacy engine's protection.
  const legacyMoved=result.filter(e=>before.has(e.id)&&(before.get(e.id).x!==e.x||before.get(e.id).y!==e.y||before.get(e.id).height!==e.height||before.get(e.id).width!==e.width));
  for(const arrow of result.filter(e=>!e.isDeleted&&e.type==='arrow')){
    const from=result.find(e=>e.id===arrow.startBinding?.elementId),to=result.find(e=>e.id===arrow.endBinding?.elementId);
    if(!from||!to)continue;
    const changed=[from,to].some(e=>legacyMoved.some(m=>m.id===e.id));if(!changed)continue;
    get(arrow.id);
    if(meta(arrow)?.connection){
      const opts={...meta(arrow).connection};
      const oldFrom=before.get(from.id),oldTo=before.get(to.id);
      if(opts.via&&oldFrom&&oldTo&&from.x-oldFrom.x===to.x-oldTo.x&&from.y-oldFrom.y===to.y-oldTo.y)opts.via=opts.via.map(([x,y])=>[x+from.x-oldFrom.x,y+from.y-oldFrom.y]);
      assignRoute(arrow,from,to,opts,result);
    }else{
      const moved=legacyMoved.filter(e=>shapes.has(e.type)||e.type==='text').filter(e=>before.get(e.id).width===e.width&&before.get(e.id).height===e.height).map(e=>({op:'move',target:e.id,dx:e.x-before.get(e.id).x,dy:e.y-before.get(e.id).y}));
      if(moved.length){const legacy=applyEdits(elements,{requestId:input.requestId,edits:moved},selectedIds);const next=legacy.elements.find(e=>e.id===arrow.id);if(next)Object.assign(arrow,next);}
      else fail('UNSUPPORTED_BINDING','旧式箭头需先 reroute，再调整关联框体。');
    }
  }
  orderAppended(elements,result.slice(elements.length));checkRegions(result);
  const affectedIds=[],createdIds=[];
  for(const e of result){const old=before.get(e.id);if(!old){createdIds.push(e.id);continue;}
    const comparable={...e,version:old.version,versionNonce:old.versionNonce,updated:old.updated};
    if(JSON.stringify(comparable)!==JSON.stringify(old)){get(e.id);if(Math.abs(e.x)>100000||Math.abs(e.y)>100000||e.width>20000||e.height>20000)fail('OUT_OF_BOUNDS','图元超出范围。');e.version=(old.version??0)+1;e.versionNonce=((old.versionNonce??0)+1)%2147483647;e.updated=(old.updated??0)+1;affectedIds.push(e.id);}
  }
  if(!affectedIds.length&&!createdIds.length)fail('NO_CHANGE','操作未改变内容。');
  return {elements:result,layouts,affectedIds,createdIds};
}
