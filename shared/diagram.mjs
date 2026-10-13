import {EditError} from './edits.mjs';
const fail=(code,message)=>{throw new EditError(code,message);};
const shapes=new Set(['rectangle','ellipse','diamond']);
export const meta=e=>e.customData?.whiteboard;
export function bounds(elements){
  const live=elements.filter(e=>!e.isDeleted);
  if(!live.length)return null;
  const boxes=live.map(e=>{
    if(!e.angle&&['arrow','line','freedraw'].includes(e.type)&&e.points?.length&&e.points.every(p=>p.length>=2&&p.slice(0,2).every(Number.isFinite))){
      const xs=e.points.map(p=>e.x+p[0]),ys=e.points.map(p=>e.y+p[1]);
      return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
    }
    return [e.x,e.y,e.x+e.width,e.y+e.height];
  });
  return [Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
}
export function contains(parent,child,padding=0){return child.x>=parent.x+padding&&child.y>=parent.y+padding&&child.x+child.width<=parent.x+parent.width-padding&&child.y+child.height<=parent.y+parent.height-padding;}
export function regionDefinitions(elements){return elements.filter(e=>!e.isDeleted&&meta(e)?.region).map(e=>({elementId:e.id,...meta(e).region}));}
export function regionMembers(elements,id,includeChildren=true){
  const defs=regionDefinitions(elements),ids=new Set([id]);
  if(!defs.some(d=>d.id===id))fail('REGION_MISSING','分区不存在，请读取结构摘要。');
  if(includeChildren)for(let n=0;n<defs.length;n++)for(const d of defs)if(ids.has(d.parentId))ids.add(d.id);
  const members=new Set(elements.filter(e=>!e.isDeleted&&ids.has(meta(e)?.regionId)).map(e=>e.id));
  for(const e of elements)if(!e.isDeleted&&members.has(e.containerId))members.add(e.id);
  return elements.filter(e=>!e.isDeleted&&members.has(e.id));
}
export function itemMetadata(item){
  if(!item.region&&!item.regionId&&item.padding===undefined&&item.maxWidth===undefined)return undefined;
  return {whiteboard:{...(item.region||item.regionId?{regionId:item.region?.id??item.regionId}:{}),...(item.region?{role:'container',region:item.region}:{}),...(item.padding!==undefined?{padding:item.padding}:{}),...(item.maxWidth!==undefined?{maxWidth:item.maxWidth}:{})}};
}
export function checkRegions(elements){
  const live=elements.filter(e=>!e.isDeleted),defs=regionDefinitions(live),byId=new Map();
  for(const d of defs){if(byId.has(d.id))fail('REGION_DUPLICATE','分区 ID 已存在，请使用该分区 ID 追加内容。');byId.set(d.id,d);}
  for(const d of defs){
    const chain=new Set([d.id]);let next=d.parentId;
    while(next){if(chain.has(next))fail('REGION_CYCLE','分区层级不能形成循环。');chain.add(next);const parent=byId.get(next);if(!parent)fail('REGION_MISSING','父分区不存在。');if(parent.lessonId!==d.lessonId)fail('REGION_LESSON','父子分区必须属于同一课程。');next=parent.parentId;}
  }
  for(const e of live)if(meta(e)?.regionId&&!byId.has(meta(e).regionId))fail('REGION_MISSING','图元引用的分区不存在。');
  return defs;
}
export function permittedContainment(a,b,elements){
  if(meta(a)?.role!=='container'||!contains(a,b,8))return false;
  let id=meta(b)?.regionId;const defs=new Map(regionDefinitions(elements).map(d=>[d.id,d]));
  const visited=new Set();while(id&&!visited.has(id)){if(id===meta(a).regionId)return true;visited.add(id);id=defs.get(id)?.parentId;}
  return false;
}
export function checkNewCollisions(existing,added){
  const all=[...existing,...added];checkRegions(all);
  for(const e of added.filter(e=>!['arrow','line'].includes(e.type)&&!e.containerId))for(const p of existing.filter(p=>!p.isDeleted&&!['arrow','line'].includes(p.type))){
    if(permittedContainment(p,e,all))continue;
    if(e.x<p.x+p.width+12&&e.x+e.width>p.x-12&&e.y<p.y+p.height+12&&e.y+e.height>p.y-12)fail('CONTENT_COLLISION',`新增 ${e.id} 与已有 ${p.id} 重叠，请使用分区或调整位置。`);
  }
}
const normals={left:[-1,0],right:[1,0],top:[0,-1],bottom:[0,1]};
export function portPoint(e,port,gap=12){const [dx,dy]=normals[port];return [e.x+e.width/2+dx*(e.width/2+gap),e.y+e.height/2+dy*(e.height/2+gap)];}
const compress=points=>points.filter((p,i)=>!i||p[0]!==points[i-1][0]||p[1]!==points[i-1][1]).filter((p,i,a)=>!i||i===a.length-1||!((a[i-1][0]===p[0]&&p[0]===a[i+1][0])||(a[i-1][1]===p[1]&&p[1]===a[i+1][1])));
function intersects(a,b,r){
  const l=r.x-4,t=r.y-4,right=r.x+r.width+4,bottom=r.y+r.height+4;
  if(a[0]===b[0])return a[0]>l&&a[0]<right&&Math.max(a[1],b[1])>t&&Math.min(a[1],b[1])<bottom;
  if(a[1]===b[1])return a[1]>t&&a[1]<bottom&&Math.max(a[0],b[0])>l&&Math.min(a[0],b[0])<right;
  // Segment clipping also catches diagonal arrows in the quality report.
  let lo=0,hi=1;for(const [origin,delta,min,max] of [[a[0],b[0]-a[0],l,right],[a[1],b[1]-a[1],t,bottom]]){if(!delta){if(origin<=min||origin>=max)return false;}else{let x=(min-origin)/delta,y=(max-origin)/delta;if(x>y)[x,y]=[y,x];lo=Math.max(lo,x);hi=Math.min(hi,y);if(lo>=hi)return false;}}return true;
}
export function routeConnection(from,to,options={},elements=[]){
  if(!shapes.has(from.type)||!shapes.has(to.type)||from.id===to.id)fail('INVALID_CONNECTION','连接需要两个不同基础节点。');
  const dx=to.x+to.width/2-from.x-from.width/2,dy=to.y+to.height/2-from.y-from.height/2;
  const horizontal=Math.abs(dx)/(from.width+to.width)>=Math.abs(dy)/(from.height+to.height);
  const fp=options.fromPort??(horizontal?(dx>=0?'right':'left'):(dy>=0?'bottom':'top'));
  const tp=options.toPort??(horizontal?(dx>=0?'left':'right'):(dy>=0?'top':'bottom'));
  const start=portPoint(from,fp),end=portPoint(to,tp),n=normals[fp],m=normals[tp];
  const stub=[start[0]+n[0]*24,start[1]+n[1]*24],tail=[end[0]+m[0]*24,end[1]+m[1]*24];
  const obstacles=elements.filter(e=>!e.isDeleted&&e.id!==from.id&&e.id!==to.id&&e.containerId!==from.id&&e.containerId!==to.id&&meta(e)?.role!=='container'&&!['arrow','line'].includes(e.type));
  let points;
  if(options.route==='straight')points=[start,end];
  else{
    const candidates=options.via?.length?[[start,...options.via,end]]:[
      [start,stub,[stub[0],tail[1]],tail,end],[start,stub,[tail[0],stub[1]],tail,end],
    ];
    if(!options.via?.length){
      const near=obstacles.filter(e=>e.x+e.width>=Math.min(start[0],end[0])-400&&e.x<=Math.max(start[0],end[0])+400&&e.y+e.height>=Math.min(start[1],end[1])-400&&e.y<=Math.max(start[1],end[1])+400).slice(0,80);
      const xs=new Set([(stub[0]+tail[0])/2,...near.flatMap(e=>[e.x-24,e.x+e.width+24])]);
      const ys=new Set([(stub[1]+tail[1])/2,...near.flatMap(e=>[e.y-24,e.y+e.height+24])]);
      for(const x of xs)candidates.push([start,stub,[x,stub[1]],[x,tail[1]],tail,end]);
      for(const y of ys)candidates.push([start,stub,[stub[0],y],[tail[0],y],tail,end]);
    }
    const valid=candidates.map(compress).filter(ps=>{
      const second=ps[1],penultimate=ps.at(-2);
      if(!second||!penultimate||(second[0]-start[0])*n[0]+(second[1]-start[1])*n[1]<=0||(penultimate[0]-end[0])*m[0]+(penultimate[1]-end[1])*m[1]<=0)return false;
      return ps.slice(1).every((p,i)=>(ps[i][0]===p[0]||ps[i][1]===p[1])&&!obstacles.some(r=>intersects(ps[i],p,r)));
    });
    const cost=ps=>ps.slice(1).reduce((s,p,i)=>s+Math.abs(p[0]-ps[i][0])+Math.abs(p[1]-ps[i][1]),ps.length*8);
    valid.sort((a,b)=>cost(a)-cost(b));points=valid[0];
    if(!points)fail('ROUTE_BLOCKED','无法在当前布局中安全走线，请增加通道或指定直角 via 路径。');
  }
  return {points,fromPort:fp,toPort:tp,route:options.route??'orthogonal',via:options.via,endArrowhead:options.endArrowhead??'arrow'};
}
export function assignRoute(arrow,from,to,options,elements){
  const r=routeConnection(from,to,options,elements),p=r.points;
  arrow.x=p[0][0];arrow.y=p[0][1];arrow.points=p.map(q=>[q[0]-arrow.x,q[1]-arrow.y]);
  arrow.width=Math.max(...p.map(q=>q[0]))-Math.min(...p.map(q=>q[0]));arrow.height=Math.max(...p.map(q=>q[1]))-Math.min(...p.map(q=>q[1]));
  arrow.startBinding={elementId:from.id,focus:0,gap:12};arrow.endBinding={elementId:to.id,focus:0,gap:12};
  arrow.startArrowhead=null;arrow.endArrowhead=r.endArrowhead==='none'?null:'arrow';
  arrow.customData={...arrow.customData,whiteboard:{...meta(arrow),connection:{fromPort:r.fromPort,toPort:r.toPort,route:r.route,...(r.via?{via:r.via}:{}),endArrowhead:r.endArrowhead}}};
  return arrow;
}
export function validateDiagram(elements,{regionId,elementIds,includeChildren=true,minFontSize=24}={}){
  const live=elements.filter(e=>!e.isDeleted),members=regionId?regionMembers(live,regionId,includeChildren):live,requested=elementIds?new Set(elementIds):null,scope=requested?members.filter(e=>requested.has(e.id)):members,ids=new Set(scope.map(e=>e.id)),issues=[];
  const issue=(code,targets,message,severity='warning')=>{if(targets.some(id=>ids.has(id))&&issues.length<200)issues.push({code,severity,elementIds:targets,message});};
  try{checkRegions(live);}catch(e){issue(e.code,scope.map(e=>e.id),e.message,'error');}
  for(const e of (requested?live.filter(e=>ids.has(e.id)||e.type==='arrow'):scope)){
    if(e.type==='text'&&e.fontSize<minFontSize)issue('SMALL_TEXT',[e.id],`字号 ${e.fontSize} 小于检查阈值 ${minFontSize}。`);
    if(e.type==='text'&&e.containerId){const p=live.find(p=>p.id===e.containerId);if(p&&!contains(p,e,4))issue('TEXT_OVERFLOW',[e.id,p.id],'绑定文字超出框体。','error');if(p&&e.height/p.height<0.2&&e.width/p.width<0.4)issue('LOW_DENSITY',[p.id,e.id],'短文字占框体比例偏小，可收紧框体。');}
    const id=meta(e)?.regionId,container=id?live.find(p=>meta(p)?.region?.id===id):undefined;
    if(container&&container.id!==e.id&&!['arrow','line'].includes(e.type)&&!contains(container,e,8))issue('REGION_OVERFLOW',[e.id,container.id],'内容超出所属分区。');
    if(e.type==='arrow'){
      const points=e.points?.map(p=>[e.x+p[0],e.y+p[1]])??[];
      for(const [binding,index,port] of [[e.startBinding,0,meta(e)?.connection?.fromPort],[e.endBinding,points.length-1,meta(e)?.connection?.toPort]]){
        const node=live.find(n=>n.id===binding?.elementId);
        if(node&&points[index]){const candidates=port?[port]:Object.keys(normals);if(!candidates.some(p=>{const q=portPoint(node,p,binding.gap??12);return Math.hypot(q[0]-points[index][0],q[1]-points[index][1])<=2;}))issue('PORT_OFFSET',[e.id,node.id],'箭头端点未落在边中点。');}
      }
      if(meta(e)?.connection?.route==='orthogonal'&&points.slice(1).some((p,i)=>p[0]!==points[i][0]&&p[1]!==points[i][1]))issue('DIAGONAL_ROUTE',[e.id],'直角连接包含斜线段。');
      const endpointIds=[e.startBinding?.elementId,e.endBinding?.elementId].filter(Boolean);
      for(const p of live.filter(p=>!['arrow','line'].includes(p.type)&&meta(p)?.role!=='container'&&!endpointIds.includes(p.id)&&!endpointIds.includes(p.containerId)))if(points.slice(1).some((q,i)=>intersects(points[i],q,p)))issue('EDGE_CROSSING',[e.id,p.id],'连接穿过文字或图形。');
    }
  }
  const content=(requested?live:scope).filter(e=>!['arrow','line'].includes(e.type)&&meta(e)?.role!=='container');
  for(let i=0;i<content.length;i++)for(let j=i+1;j<content.length;j++){
    const a=content[i],b=content[j];if(requested&&!ids.has(a.id)&&!ids.has(b.id)||a.containerId===b.id||b.containerId===a.id)continue;
    if(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y)issue('CONTENT_OVERLAP',[a.id,b.id],'内容包围盒相交，请检查遮挡。');
  }
  return {checked:scope.length,bounds:bounds(scope),issueCount:issues.length,truncated:issues.length>=200,issues,limits:'几何检查不能判断知识、数学推导或视觉美感；仍需查看真实预览。'};
}
