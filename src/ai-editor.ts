import { convertToExcalidrawElements, exportToCanvas, getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { Scene } from './model';
import { applyEdits, resolveEdits, textWidthLimit } from '../shared/edits.mjs';
import type { EditOperation, TextLayout } from '../shared/edits.mjs';
import {fontFamily,fontStack,prepareNoteFonts,wrapNote} from './typography';
import {isNoteFont,editedNoteFont} from '../shared/typography.mjs';
import {itemMetadata,assignRoute,checkNewCollisions,regionMembers} from '../shared/diagram.mjs';
import type {DiagramRegion,ConnectionOptions} from '../shared/diagram.mjs';
import {needsDiagramEdits,planDiagramEdits} from '../shared/diagram-edits.mjs';
import type {DiagramEdit} from '../shared/diagram-edits.mjs';
import {orderAppended} from '../shared/element-order.mjs';

type Item = { id: string; type: 'text' | 'rectangle' | 'ellipse' | 'diamond' | 'arrow';
  x?: number; y?: number; width?: number; height?: number; text?: string; fontSize?: number; color?: string; from?: string; to?: string;
  backgroundColor?:string;strokeWidth?:number;strokeStyle?:'solid'|'dashed'|'dotted';roughness?:number;padding?:number;maxWidth?:number;region?:DiagramRegion;regionId?:string } & ConnectionOptions;
export interface Patch {
  boardId?:string;editorSessionId?:string;
  baseRevision: number; requestId: string;
  flow?: { title: string; steps: { id: string; label: string; description?: string }[]; note?: string };
  items?: Item[];
  edits?: (EditOperation|DiagramEdit)[];
  selectionIds?: string[];
}
export interface EditorJob { id: string; kind: 'read' | 'patch' | 'render' | 'preview' | 'validate'; input: Patch & { revision?: number; elementIds?: string[];regionId?:string } }
type Skeleton = Parameters<typeof convertToExcalidrawElements>[0];

async function fonts(text: string) {
  await prepareNoteFonts(text);
  await Promise.all([document.fonts.load('24px Excalifont', text), document.fonts.load('24px Xiaolai', text)]);
  await document.fonts.ready;
}
function wrap(value: string, size: number, width: number, family = fontStack(fontFamily(value))) {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `${size}px ${family}`;
  return value.split('\n').flatMap(line => {
    const lines: string[] = []; let current = '';
    for (const char of Array.from(line)) {
      if (current && ctx.measureText(current + char).width > width) { lines.push(current); current = char; }
      else current += char;
    }
    lines.push(current); return lines;
  }).join('\n');
}

export async function prepareTeachingFonts(text: string) { await fonts(text); }
export function measureTeachingText(element: Extract<ExcalidrawElement,{type:'text'}>, size: number, width: number) {
  if (!isNoteFont(element.fontFamily)) throw new Error('此讲解布局需要先核对自定义字体。');
  const text=wrapNote(element.originalText || element.text,size,width,element.fontFamily);
  const measured=convertToExcalidrawElements([{type:'text',x:0,y:0,text,fontSize:size,
    fontFamily:element.fontFamily,lineHeight:element.lineHeight}])[0];
  return {text,width:measured.width,height:measured.height};
}

export async function editElements(input: Patch, scene: Scene, selectedIds: string[]) {
  if(needsDiagramEdits(input,scene.elements)){
    const arrows:Skeleton=[];
    for(const op of input.edits??[])if(op.op==='connect')arrows.push({id:`ai-${input.requestId}-${op.id}`,type:'arrow',x:0,y:0,width:100,height:0,points:[[0,0],[100,0]],strokeWidth:2});
    return planDiagramEdits(scene.elements,input,selectedIds,async(e,width)=>{
      const raw=e.originalText??e.text;await fonts(raw);
      const text=wrapNote(raw,e.fontSize,width,e.fontFamily);
      const measured=convertToExcalidrawElements([{type:'text',x:0,y:0,text,fontSize:e.fontSize,fontFamily:e.fontFamily,lineHeight:e.lineHeight}])[0];
      return {text,width:measured.width,height:measured.height};
    },convertToExcalidrawElements(arrows,{regenerateIds:false}));
  }
  const legacyInput=input as Patch&{edits:EditOperation[]};
  const ops = resolveEdits(scene.elements, legacyInput, selectedIds);
  const layouts: Record<string, TextLayout> = {};
  const templates: Skeleton = [];
  for (const op of ops) {
    if (op.op === 'set_text') {
      const element = scene.elements.find(e => e.id === op.target)!;
      if (element.type !== 'text') throw new Error('文字目标无效。');
      // Use the public converter to measure with the element's actual font and line height.
      await fonts(op.text);
      const nextFamily=editedNoteFont(element.fontFamily,op.text) as typeof element.fontFamily;
      const family = `${fontStack(nextFamily)}, Segoe UI Emoji`;
      await document.fonts.load(`${element.fontSize}px ${family.split(',')[0]}`, op.text);
      const parent = scene.elements.find(value => value.id === element.containerId);
      if (parent && (parent.type === 'rectangle' || parent.type === 'ellipse' || parent.type === 'diamond')) {
        const label = { text: op.text, fontSize: element.fontSize, fontFamily: nextFamily, lineHeight: element.lineHeight,
          textAlign: element.textAlign, verticalAlign: element.verticalAlign, autoResize: element.autoResize, width: element.width };
        const converted = convertToExcalidrawElements([{ type: parent.type, x: parent.x, y: parent.y, width: parent.width, height: parent.height,
          label }]);
        const measured = converted.find(value => value.type === 'text')!;
        if (measured.type !== 'text') throw new Error('文字测量失败。');
        layouts[element.id] = { text: measured.text, width: measured.width, height: measured.height };
        continue;
      }
      const wrapped = wrap(op.text, element.fontSize, textWidthLimit(element, scene.elements), family);
      const measured = convertToExcalidrawElements([{ type: 'text', x: 0, y: 0, text: wrapped,
        fontSize: element.fontSize, fontFamily: nextFamily, lineHeight: element.lineHeight }])[0];
      layouts[element.id] = { text: wrapped, width: measured.width, height: wrapped.split('\n').length * element.fontSize * element.lineHeight };
    } else if (op.op === 'connect') {
      templates.push({ id: op.id, type: 'arrow', x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]], strokeColor: op.color ?? '#35639c', strokeWidth: 2 });
    }
  }
  return { ...applyEdits(scene.elements, legacyInput, selectedIds, layouts, convertToExcalidrawElements(templates, { regenerateIds: false })), layouts };
}

export async function generateElements(input: Patch, scene: Scene): Promise<ExcalidrawElement[]> {
  await fonts(JSON.stringify(input));
  const prefix = `ai-${input.requestId}-`;
  const live = scene.elements.filter(element => !element.isDeleted);
  const startY = live.length ? getCommonBounds(live)[3] + 140 : 100;
  const items: Item[] = [];
  if (input.flow) {
    const flow = input.flow;
    const nodeWidth = 240, gap = 100, lineWidth = flow.steps.length * (nodeWidth + gap) - gap;
    const title = wrap(flow.title, 36, lineWidth);
    const nodeY = startY + title.split('\n').length * 45 + 65;
    const labels = flow.steps.map(step => wrap(step.label, 26, 206));
    const height = Math.max(116, ...labels.map(label => label.split('\n').length * 34 + 40));
    if (height > 460) throw new Error('节点文字过长，请改为短句，将解释放在 description 中。');
    items.push({ id: 'flow-title', type: 'text', x: 100, y: startY, text: title, fontSize: 36, color: '#2c4d79' });
    let descriptionBottom = nodeY + height;
    flow.steps.forEach((step, i) => {
      const x = 100 + i * (nodeWidth + gap);
      const nodeId = `step-${i}`;
      items.push({ id: nodeId, type: 'rectangle', x, y: nodeY, width: nodeWidth, height, text: labels[i], color: i === flow.steps.length - 1 ? '#264a78' : '#35639c' });
      if (step.description) {
        const description = wrapNote(step.description, 24, nodeWidth);
        items.push({ id: `description-${i}`, type: 'text', x, y: nodeY + height + 30, text: description, fontSize: 24, color: '#586d84' });
        descriptionBottom = Math.max(descriptionBottom, nodeY + height + 30 + description.split('\n').length * 30);
      }
      if (i) items.push({ id: `edge-${i}`, type: 'arrow', from: `step-${i-1}`, to: nodeId });
    });
    if (flow.note) items.push({ id: 'flow-note', type: 'text', x: 100, y: descriptionBottom + 62, text: wrap(flow.note, 22, lineWidth), fontSize: 22, color: '#63758b' });
  } else items.push(...(input.items ?? []));

  const skeletons: NonNullable<Skeleton> = [];
  for (const item of items.filter(item => item.type !== 'arrow')) {
    const common = { id: prefix + item.id, x: item.x!, y: item.y!, strokeColor: item.color ?? '#35639c', roughness:item.roughness??1, strokeWidth:item.strokeWidth??2,strokeStyle:item.strokeStyle??'solid',...(itemMetadata(item)?{customData:itemMetadata(item)}:{}) };
    if (item.type === 'text') skeletons.push({ ...common, type: 'text', text:item.maxWidth?wrapNote(item.text!,item.fontSize??28,item.maxWidth):item.text!, fontSize: item.fontSize ?? 28, fontFamily: fontFamily(item.text!) });
    else {
      const size=item.fontSize??28,padding=item.padding??10;
      const label = item.text ? wrapNote(item.text,size,(item.width??240)*(item.type==='rectangle'?1:item.type==='ellipse'?Math.SQRT1_2:0.5)-padding*2) : '';
      const minimum = label?label.split('\n').length*size*1.25+padding*2:40;
      if (minimum > (item.height ?? 120) && !input.flow) throw new Error(`节点 ${item.id} 高度不足，请增高或缩短文字。`);
      skeletons.push({ ...common, type: item.type as 'rectangle' | 'ellipse' | 'diamond', width: item.width ?? 240, height: Math.max(item.height ?? 120, minimum),
        roundness: { type: 3 }, backgroundColor: item.backgroundColor??(item.region?'transparent':item.color === '#264a78' ? '#e5eef9' : '#edf3fb'), fillStyle: 'solid',
        ...(label ? { label: { text: label, fontSize:size, fontFamily: fontFamily(label), textAlign: 'center' as const } } : {}) });
    }
  }
  for (const edge of items.filter(item => item.type === 'arrow')) {
    const from = items.find(item => item.id === edge.from)!; const to = items.find(item => item.id === edge.to)!;
    const fw = from.width ?? 240, fh = from.height ?? 120, tw = to.width ?? 240, th = to.height ?? 120;
    const fx = from.x! + fw / 2, fy = from.y! + fh / 2, tx = to.x! + tw / 2, ty = to.y! + th / 2;
    const horizontal = Math.abs(tx - fx) / ((fw + tw) / 2) >= Math.abs(ty - fy) / ((fh + th) / 2);
    const direction = Math.sign(horizontal ? tx - fx : ty - fy) || 1;
    const x = fx + (horizontal ? direction * (fw / 2 + 12) : 0);
    const y = fy + (horizontal ? 0 : direction * (fh / 2 + 12));
    const endX = tx - (horizontal ? direction * (tw / 2 + 12) : 0);
    const endY = ty - (horizontal ? 0 : direction * (th / 2 + 12));
    skeletons.push({ id: prefix + edge.id, type: 'arrow', x, y, width: Math.abs(endX - x), height: Math.abs(endY - y),
      points: [[0,0], [endX-x,endY-y]], strokeColor: edge.color ?? '#35639c', strokeWidth: 2,
      roughness:edge.roughness??1,strokeStyle:edge.strokeStyle??'solid',start: { id: prefix + edge.from }, end: { id: prefix + edge.to },...(itemMetadata(edge)?{customData:itemMetadata(edge)}:{}) });
  }
  const added = convertToExcalidrawElements(skeletons, { regenerateIds: false }).map(e=>input.items&&e.type==='text'?{...e,customData:{...e.customData,noteTypography:3}}:e);
  orderAppended(scene.elements,added);
  for(const edge of items.filter(i=>i.type==='arrow'))assignRoute(added.find(e=>e.id===prefix+edge.id)!,added.find(e=>e.id===prefix+edge.from)!,added.find(e=>e.id===prefix+edge.to)!,edge,[...live,...added]);
  checkNewCollisions(live,added);
  return [...structuredClone(scene.elements), ...added];
}

export async function renderScene(scene: Scene, ids?: string[], regionId?:string) {
  let elements = scene.elements.filter(element => !element.isDeleted);
  if(regionId)elements=regionMembers(elements,regionId);
  if (ids?.length) {
    const included = new Set(ids);
    if (ids.some(id => !elements.some(element => element.id === id))) throw new Error('预览目标不存在，请重新读取图元 ID。');
    for (const element of elements) if (included.has(element.id)) for (const bound of element.boundElements ?? []) if (bound.type === 'text') included.add(bound.id);
    elements = elements.filter(element => included.has(element.id));
  }
  if (!elements.length) throw new Error('白板没有可预览的内容。');
  await fonts(elements.filter(element => element.type === 'text').map(element => element.text).join(''));
  const canvas = await exportToCanvas({ elements, files: scene.files, appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: scene.appState.theme === 'dark' }, exportPadding: 40, maxWidthOrHeight: 1600 });
  return canvas.toDataURL('image/png').split(',')[1];
}
