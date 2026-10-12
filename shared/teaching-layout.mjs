import { teachingRegions } from './teaching.mjs';
import {NOTE_HAND} from './typography.mjs';

export function scaleTeachingElements(elements, ids, origin, destination, scale) {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('缩放比例无效。');
  const chosen = new Set(ids);
  return elements.map(original => {
    if (!chosen.has(original.id)) return original;
    if (original.locked || original.frameId || original.angle || original.elbowed ||
        !['rectangle', 'ellipse', 'diamond', 'text', 'arrow'].includes(original.type)) throw new Error('此区域包含不支持重排的对象。');
    for (const id of [original.containerId, original.startBinding?.elementId, original.endBinding?.elementId,
      ...(original.boundElements ?? []).map(e => e.id)].filter(Boolean)) {
      if (!chosen.has(id)) throw new Error('区域存在外部绑定，不能单独缩放。');
    }
    const e = structuredClone(original);
    e.x = destination.x + (e.x-origin.x)*scale; e.y = destination.y + (e.y-origin.y)*scale;
    e.width *= scale; e.height *= scale;
    if (e.fontSize) e.fontSize *= scale;
    if (e.strokeWidth) e.strokeWidth *= scale;
    if (e.points) e.points = e.points.map(([x,y]) => [x*scale,y*scale]);
    for (const key of ['startBinding','endBinding']) if (e[key]?.gap) e[key].gap *= scale;
    e.version = (e.version ?? 0)+1; e.versionNonce = ((e.versionNonce ?? 0)+1)%2147483647; e.updated = (e.updated ?? 0)+1;
    return e;
  });
}

const bounds = elements => ({ x: Math.min(...elements.map(e=>e.x)), y: Math.min(...elements.map(e=>e.y)),
  right: Math.max(...elements.map(e=>e.x+e.width)), bottom: Math.max(...elements.map(e=>e.y+e.height)) });

// Keep the edge facing the main diagram fixed so annotation leaders retain their endpoints.
export function enlargeTeachingDetails(elements) {
  const regions = teachingRegions(elements), main = regions.filter(r=>r.id.includes('-teach-'));
  const details = regions.filter(r=>r.id.includes('-detail-'));
  if (main.length!==3 || details.length!==6) return null;
  const prefix = main[0].id.split('-teach-')[0]+'-';
  const model = elements.find(e=>!e.isDeleted && e.id===prefix+'teach-2-frame');
  if (!model || !elements.some(e=>!e.isDeleted && e.id===prefix+'hierarchy-A-mark')) return null;
  const targetHeight = model.height*0.46875;
  let result=elements, changed=false;
  details.forEach((region,i)=>{
    const frame=result.find(e=>!e.isDeleted && region.elementIds.includes(e.id) && e.id.endsWith('-frame'));
    if (!frame) throw new Error('详解区域缺少外框。');
    const factor=targetHeight/frame.height;
    if (factor<=1.001) return;
    if (factor>1.5) throw new Error('详解尺寸与当前布局不匹配，请先检查。');
    const anchor = i===0||i===2 ? {x:frame.x+frame.width,y:frame.y+frame.height/2}
      : i===1 ? {x:frame.x+frame.width/2,y:frame.y+frame.height}
      : i===5 ? {x:frame.x,y:frame.y+frame.height/2}
      : {x:frame.x+frame.width/2,y:frame.y};
    result=scaleTeachingElements(result,region.elementIds,anchor,anchor,factor); changed=true;
  });
  return changed ? {elements:result,detailIds:details.flatMap(r=>r.elementIds)} : null;
}

export function teachingHierarchyPlan(elements) {
  const regions = teachingRegions(elements), main = regions.filter(r=>r.id.includes('-teach-'));
  const details = regions.filter(r=>r.id.includes('-detail-'));
  if (main.length!==3 || details.length!==6) return null;
  const prefix = main[0].id.split('-teach-')[0]+'-';
  if (!main.every(r=>r.id.startsWith(prefix)) || elements.some(e=>!e.isDeleted && e.id===prefix+'hierarchy-A-mark')) return null;
  const live = elements.filter(e=>!e.isDeleted);
  const mainIds = new Set(live.filter(e=>e.id.startsWith(prefix)).map(e=>e.id));
  for (const e of live) if (mainIds.has(e.containerId)) mainIds.add(e.id);
  const selected = new Set([...mainIds,...details.flatMap(r=>r.elementIds)]);
  const box = bounds(live.filter(e=>mainIds.has(e.id)));
  const protectedBottom = Math.max(0,...live.filter(e=>!selected.has(e.id)).map(e=>e.y+e.height));
  const destination = {x:box.x, y:Math.max(box.y, protectedBottom+1200)};
  let result = scaleTeachingElements(elements, mainIds, box, destination, 1.6);
  const find = suffix => result.find(e=>e.id===prefix+suffix && !e.isDeleted);
  const input = find('teach-1-frame'), model = find('teach-2-frame'), train = find('teach-3-frame'), calibration = find('teach-3-calib');
  if (!input || !model || !train || !calibration) return null;
  const positions = [
    {x:input.x-800,y:input.y},
    {x:model.x+model.width/2-360,y:model.y-940},
    {x:input.x,y:train.y+320},
    {x:train.x+150,y:train.y+train.height+400},
    {x:train.x+1150,y:train.y+train.height+400},
    {x:calibration.x+calibration.width+320,y:calibration.y-24},
  ];
  const frames = [];
  details.forEach((region,i) => {
    const frame = result.find(e=>region.elementIds.includes(e.id) && e.id.endsWith('-frame'));
    if (!frame) throw new Error('详解区域缺少外框。');
    result = scaleTeachingElements(result, region.elementIds, frame, positions[i], 0.6);
    const next = result.find(e=>e.id===frame.id);
    Object.assign(next,{backgroundColor:'transparent',strokeColor:'#9caec6',strokeWidth:1,roughness:0.5});
    frames.push(next);
  });
  const starts = [
    [input.x-60,input.y+input.height/2],
    [model.x+model.width/2,model.y-60],
    [train.x-60,train.y+train.height/2],
    [train.x+400,train.y+train.height+60],
    [train.x+1500,train.y+train.height+60],
    [calibration.x+calibration.width+60,calibration.y+calibration.height/2],
  ];
  const guides = frames.flatMap((frame,i) => {
    const horizontal = [0,2,5].includes(i), positive = i===5;
    const end = horizontal ? [positive?frame.x-8:frame.x+frame.width+8,frame.y+frame.height/2]
      : [frame.x+frame.width/2,i===1?frame.y+frame.height+8:frame.y-8];
    const start = starts[i], middle = horizontal ? (start[0]+end[0])/2 : (start[1]+end[1])/2;
    const points = horizontal ? [start,[middle,start[1]],[middle,end[1]],end] : [start,[start[0],middle],[end[0],middle],end];
    const label = String.fromCharCode(65+i), id = prefix+'hierarchy-'+label;
    return [{id:id+'-line',type:'line',x:start[0],y:start[1],points:points.map(([x,y])=>[x-start[0],y-start[1]]),
      strokeColor:'#6d83a3',strokeWidth:3,strokeStyle:'dashed',roughness:0},
    {id:id+'-mark',type:'ellipse',x:start[0]-50,y:start[1]-50,width:100,height:100,
      strokeColor:'#35639c',backgroundColor:'#ffffff',fillStyle:'solid',strokeWidth:3,roughness:0,
      label:{text:label,fontSize:50,fontFamily:NOTE_HAND}}];
  });
  const moved = result.filter(e=>selected.has(e.id));
  for (const e of moved) if (![e.x,e.y,e.width,e.height].every(Number.isFinite) || Math.abs(e.x)>100000 || Math.abs(e.y)>100000) throw new Error('布局坐标无效。');
  return {elements:result,guides,mainIds:[...mainIds],detailIds:details.flatMap(r=>r.elementIds)};
}
