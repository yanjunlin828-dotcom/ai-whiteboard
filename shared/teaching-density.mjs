import {teachingRegions} from './teaching.mjs';

const suffix = id => id.replace(/^ai-[a-f0-9-]{36}-/, '');
const center = e => [e.x + e.width / 2, e.y + e.height / 2];
const port = (e, side, gap = 8) => ({
  left: [e.x-gap,e.y+e.height/2], right: [e.x+e.width+gap,e.y+e.height/2],
  top: [e.x+e.width/2,e.y-gap], bottom: [e.x+e.width/2,e.y+e.height+gap],
})[side];

export function midpointRoute(a,b,startSide,endSide,via) {
  const s=port(a,startSide), t=port(b,endSide);
  const horizontal=['left','right'].includes(startSide);
  const path=via ? [s,...via(s,t),t] : horizontal
    ? [s,[(s[0]+t[0])/2,s[1]],[(s[0]+t[0])/2,t[1]],t]
    : [s,[s[0],(s[1]+t[1])/2],[t[0],(s[1]+t[1])/2],t];
  return path.filter((p,i)=>!i || p[0]!==path[i-1][0] || p[1]!==path[i-1][1]);
}

// Specific to the existing three-stage Laya lesson. Measure is supplied by the
// browser so the persisted dimensions use the real hand-written font metrics.
export function teachingDensityPlan(elements, measure) {
  const regions=teachingRegions(elements), mains=regions.filter(r=>r.id.includes('-teach-'));
  const details=regions.filter(r=>r.id.includes('-detail-'));
  if(mains.length!==3 || details.length!==6) return null;
  const prefix=mains[0].id.split('-teach-')[0]+'-';
  const marker=elements.find(e=>!e.isDeleted && e.id===prefix+'hierarchy-A-mark');
  if(!marker || details.every(r=>elements.find(e=>e.id===r.id)?.fontSize===34)) return null;
  const ids=new Set([...mains,...details].flatMap(r=>r.elementIds));
  for(const e of elements) if(!e.isDeleted && e.id.startsWith(prefix)) ids.add(e.id);
  for(const e of elements) if(!e.isDeleted && ids.has(e.containerId)) ids.add(e.id);
  const chosen=elements.filter(e=>!e.isDeleted && ids.has(e.id));
  for(const e of chosen) {
    if(e.locked || e.angle || e.frameId || !['rectangle','ellipse','text','arrow','line'].includes(e.type)) throw new Error('讲解区含锁定或不支持的对象，未调整。');
    const refs=[e.containerId,e.startBinding?.elementId,e.endBinding?.elementId,...(e.boundElements??[]).map(b=>b.id)].filter(Boolean);
    if(refs.some(id=>!ids.has(id))) throw new Error('讲解区存在外部绑定，未调整。');
  }
  const result=elements.map(e=>ids.has(e.id)&&!e.isDeleted?structuredClone(e):e);
  const byId=new Map(result.map(e=>[e.id,e]));
  const main=s=>byId.get(prefix+s);
  const label=node=>result.find(e=>!e.isDeleted && e.containerId===node.id && e.type==='text');
  const text=(e,size,width)=>{
    const m=measure(e,size,width);
    if(!m || ![m.width,m.height].every(Number.isFinite) || m.width>width+2) throw new Error('文字测量超出可用宽度。');
    Object.assign(e,m,{fontSize:size,autoResize:true});
  };
  const fitNode=(node,size,maxWidth,pad)=>{
    const t=label(node);if(!t)throw new Error('节点缺少文字。');
    const [cx,cy]=center(node);text(t,size,maxWidth-2*pad);
    node.width=t.width+pad*2;node.height=t.height+pad*2;
    node.x=cx-node.width/2;node.y=cy-node.height/2;
    t.x=node.x+pad;t.y=node.y+pad;
  };
  for(const e of chosen.filter(e=>e.id.startsWith(prefix)&&e.type==='rectangle'&&!e.id.endsWith('-frame'))) {
    fitNode(byId.get(e.id),50,Math.max(e.width,e.id.endsWith('-prob')?620:520),24);
  }
  for(const r of mains) for(const id of r.elementIds) {
    const e=byId.get(id);
    if(e.type==='text'&&!e.containerId&&!e.id.endsWith('-title')) text(e,46, r.elementIds.includes(main('teach-3-note')?.id)?1650:1100);
  }
  const shiftNode=(node,dx,dy)=>{node.x+=dx;node.y+=dy;const t=label(node);t.x+=dx;t.y+=dy;};
  Object.assign(main('teach-1-frame'),{width:1100,height:1100});
  for(const s of ['teach-1-state','teach-1-question']){const e=main(s);shiftNode(e,700-center(e)[0],0);}
  Object.assign(main('teach-1-note'),{x:164,y:5216});
  for(const s of ['teach-3-opt','teach-3-loss','teach-3-gold'])shiftNode(main(s),0,-150);
  main('teach-3-note').y-=220;
  main('teach-3-frame').height=960;
  for(const [letter,cy] of [['A',4982],['C',6608],['D',7148],['E',7148]]){
    const e=main('hierarchy-'+letter+'-mark');shiftNode(e,0,cy-center(e)[1]);
  }
  const frames=[];
  details.forEach((r,index)=>{
    const members=r.elementIds.map(id=>byId.get(id));
    const frame=members.find(e=>e.id.endsWith('-frame'));
    if(!frame)throw new Error('缺少详解外框。');
    const old=structuredClone(frame),width=index===0?800:1080,pad=28;
    const content=members.filter(e=>e!==frame && !e.containerId && !['arrow','line'].includes(e.type)).sort((a,b)=>a.y-b.y||a.x-b.x);
    const rows=[];
    for(const e of content){const row=rows.at(-1);if(row && Math.abs(row.y-e.y)<4)row.items.push(e);else rows.push({y:e.y,items:[e]});}
    let y=pad;
    for(const row of rows){
      let rowHeight=0;
      const nodes=row.items.some(e=>e.type!=='text');
      if(nodes&&y>100)y+=20;
      for(const e of row.items){
        const relCenter=(e.x+e.width/2-old.x)/old.width;
        if(e.type==='text'){
          const s=suffix(e.id),size=s.endsWith('-title')?34:s.endsWith('-source')?22:/formula|score$|softmax|gradient$|reward$|density$|loss$|fit$|ece$|noise$/.test(s)?30:28;
          text(e,size,width-pad*2);e.x=pad;e.y=y;
        } else {
          const slotWidth=e.id.endsWith('detail-5-adv')?520:(width-pad*2)*e.width/(old.width-60);
          fitNode(e,28,slotWidth,12);e.x=Math.max(pad,Math.min(width-pad-e.width,relCenter*width-e.width/2));e.y=y;
          const t=label(e);t.x=e.x+12;t.y=y+12;
        }
        rowHeight=Math.max(rowHeight,e.height);
      }
      y+=rowHeight+(nodes?54:20);
    }
    frame.width=width;frame.height=y+8;
    // Preserve hierarchy: explanations surround the large central process.
    const positions=[[-220-width,4432],[2660-width/2,4112-frame.height],
      [420-width,6288],[1550,7488],[2810,7488],[4788,5890]];
    [frame.x,frame.y]=positions[index];
    for(const e of content){e.x+=frame.x;e.y+=frame.y;if(e.type!=='text'){const t=label(e);t.x+=frame.x;t.y+=frame.y;}}
    frames.push(frame);
  });
  const route=(e,a,b,sideA,sideB,via)=>{
    const points=midpointRoute(a,b,sideA,sideB,via),start=points[0];
    Object.assign(e,{x:start[0],y:start[1],points:points.map(p=>[p[0]-start[0],p[1]-start[1]]),
      width:Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0])),
      height:Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1])),roughness:0,roundness:null});
    if(e.type==='arrow'){
      e.startBinding={elementId:a.id,focus:0,gap:8};e.endBinding={elementId:b.id,focus:0,gap:8};
      e.elbowed=false;
    }
  };
  for(const e of result.filter(e=>ids.has(e.id)&&e.type==='arrow'&&!e.isDeleted)) {
    const a=byId.get(e.startBinding?.elementId),b=byId.get(e.endBinding?.elementId);
    if(!a||!b)throw new Error('箭头缺少真实绑定对象。');
    const name=suffix(e.id),ac=center(a),bc=center(b);
    let sa='bottom',sb='top',via;
    if(name==='bridge-update') {sa='top';sb='left';via=(s,t)=>[[s[0],s[1]-100],[1550,s[1]-100],[1550,t[1]]];}
    else if(name==='bridge-calib') {sa='right';sb='top';via=(s,t)=>[[3700,s[1]],[3700,5860],[t[0],5860]];}
    else if(name==='bridge-state'||name==='bridge-task'){sa='right';sb='left';via=(s,t)=>[[1450,s[1]],[1450,t[1]]];}
    else if(Math.abs(ac[1]-bc[1])<100){sa=bc[0]>ac[0]?'right':'left';sb=bc[0]>ac[0]?'left':'right';}
    else if(bc[1]<ac[1]){sa='top';sb='bottom';}
    route(e,a,b,sa,sb,via);
  }
  // Explanatory leaders remain arrowless, attached to the letter marker and
  // the corresponding detail frame midpoint. They are not data-flow edges.
  frames.forEach((f,i)=>{
    const letter=String.fromCharCode(65+i),mark=main('hierarchy-'+letter+'-mark'),line=main('hierarchy-'+letter+'-line');
    if(!mark||!line)throw new Error('缺少详解引导线。');
    const sa=i===0||i===2?'left':i===1?'top':i===5?'right':'bottom';
    const sb=i===0||i===2?'right':i===1?'bottom':i===5?'left':'top';
    route(line,mark,f,sa,sb);
  });
  for(const e of result) if(ids.has(e.id)&&!e.isDeleted){
    if(![e.x,e.y,e.width,e.height].every(Number.isFinite))throw new Error('布局坐标无效。');
    e.version=(e.version??0)+1;e.versionNonce=((e.versionNonce??0)+1)%2147483647;e.updated=(e.updated??0)+1;
  }
  return {elements:result,affectedIds:[...ids]};
}
