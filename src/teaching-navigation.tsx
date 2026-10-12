import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { teachingKey } from '../shared/teaching.mjs';
import type { TeachingRegion } from '../shared/teaching.mjs';
import { CaptureUpdateAction, convertToExcalidrawElements, getCommonBounds } from '@excalidraw/excalidraw';
import { teachingHierarchyPlan, enlargeTeachingDetails } from '../shared/teaching-layout.mjs';
import { teachingDensityPlan } from '../shared/teaching-density.mjs';
import { measureTeachingText, prepareTeachingFonts } from './ai-editor';

export function TeachingNavigation({ regions, editor, disabled }: {
  regions: TeachingRegion[]; editor: RefObject<ExcalidrawImperativeAPI | null>; disabled: boolean;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [layoutError, setLayoutError] = useState('');
  const index = regions.findIndex(region => region.id === active);
  const scene = editor.current?.getSceneElements() ?? [];
  const isDetail=(r:TeachingRegion)=>r.kind==='detail'||r.id.includes('-detail-');
  const legacyTemplate=regions.length===9&&regions[0]?.id.includes('-teach-');
  const modelFrame = scene.find(e=>e.id===regions[0]?.id.split('-teach-')[0]+'-teach-2-frame');
  const canEnlarge = Boolean(modelFrame && regions.filter(r=>r.id.includes('-detail-')).some(r=>
    scene.some(e=>r.elementIds.includes(e.id) && e.id.endsWith('-frame') && e.height < modelFrame.height*0.46875-0.5)));
  function focus(next: number | null, all = false) {
    const api = editor.current;
    if (!api || disabled || api.getAppState().editingTextElement || api.getAppState().isResizing || api.getAppState().isRotating) return;
    const region = next === null ? null : regions[next];
    if (next !== null && !region) return;
    const ids = new Set(region?.elementIds ?? regions.filter(item => all || !isDetail(item)).flatMap(item => item.elementIds));
    const elements = api.getSceneElements().filter(element => ids.has(element.id));
    if (!elements.length) return;
    const [left,top,right,bottom] = getCommonBounds(elements);
    const app = api.getAppState();
    const zoom = Math.max(0.1, Math.min(region&&isDetail(region) ? 2 : 1,
      Math.max(100,app.width-140)/Math.max(1,right-left), Math.max(100,app.height-160)/Math.max(1,bottom-top)));
    api.updateScene({appState:{zoom:{value:zoom as AppState['zoom']['value']},
      scrollX:app.width/(2*zoom)-(left+right)/2,scrollY:app.height/(2*zoom)-(top+bottom)/2}});
    setActive(region?.id ?? null);
    setShowAll(all);
  }
  function arrange() {
    const api = editor.current;
    if (!api || disabled || api.getAppState().editingTextElement || api.getAppState().isResizing || api.getAppState().isRotating) return;
    try {
      const plan = teachingHierarchyPlan(api.getSceneElementsIncludingDeleted());
      if (!plan) { setLayoutError('当前布局已应用，或没有完整的主流程与详解区域。'); return; }
      const guides = convertToExcalidrawElements(plan.guides, {regenerateIds:false});
      const guideIds = new Set(guides.map(e=>e.id));
      api.updateScene({elements:[...plan.elements.filter(e=>!guideIds.has(e.id)),...guides],captureUpdate:CaptureUpdateAction.IMMEDIATELY});
      setLayoutError(''); focus(null,true);
    } catch (error) { setLayoutError(error instanceof Error ? error.message : '布局未修改。'); }
  }
  function enlargeDetails() {
    const api=editor.current;
    if (!api || disabled || api.getAppState().editingTextElement || api.getAppState().isResizing || api.getAppState().isRotating) return;
    try {
      const plan=enlargeTeachingDetails(api.getSceneElementsIncludingDeleted());
      if (!plan) return;
      api.updateScene({elements:plan.elements,captureUpdate:CaptureUpdateAction.IMMEDIATELY});
      setLayoutError(''); focus(null,true);
    } catch(error) {setLayoutError(error instanceof Error ? error.message : '详解尺寸未修改。');}
  }
  async function improveReadability() {
    const api=editor.current;
    if (!api || disabled || api.getAppState().editingTextElement || api.getAppState().isResizing || api.getAppState().isRotating) return;
    try {
      const before=api.getSceneElementsIncludingDeleted();
      await prepareTeachingFonts(before.filter(e=>e.type==='text').map(e=>e.text).join(''));
      if (api!==editor.current || api.getSceneElementsIncludingDeleted()!==before) throw new Error('画布已变化，请重新调整。');
      const plan=teachingDensityPlan(before,measureTeachingText);
      if(!plan){setLayoutError('当前布局已优化，或不符合此讲解模板。');return;}
      api.updateScene({elements:plan.elements,captureUpdate:CaptureUpdateAction.IMMEDIATELY});
      setLayoutError('');focus(null,true);
    }catch(error){setLayoutError(error instanceof Error?error.message:'布局未修改。');}
  }
  useEffect(() => {
    if (!regions.length || disabled) return;
    const onKey = (event: KeyboardEvent) => {
      const action = teachingKey(event, Boolean(editor.current?.getAppState().editingTextElement));
      if (!action || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      if (action === 'overview') focus(null);
      else focus(action === 'next' ? Math.min(index + 1, regions.length - 1) : Math.max(index - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!regions.length) return null;
  return <nav className="teaching-nav" aria-label="讲解导航">
    <button disabled={disabled || index <= 0} onClick={() => focus(index - 1)} aria-label="上一块" title="上一块 · Page Up">‹</button>
    <div className="teaching-regions">{regions.map((region, i) => <button key={region.id} disabled={disabled}
      className={isDetail(region) ? 'detail-nav' : 'main-nav'}
      aria-label={`第 ${i + 1} 块：${region.title}`} aria-current={active === region.id ? 'step' : undefined}
      title={region.title} onClick={() => focus(i)}>{isDetail(region) ? region.title.split(' · ')[0].slice(0,6) : String(i + 1).padStart(2, '0')}</button>)}</div>
    <button disabled={disabled || index === regions.length - 1} onClick={() => focus(index + 1)} aria-label="下一块" title="下一块 · Page Down">›</button>
    <span className="nav-divider" />
    <button disabled={disabled} onClick={() => focus(null)} aria-label="主流程总览" title="主线 · Home" aria-pressed={index < 0 && !showAll}>主线</button>
    <button disabled={disabled} onClick={() => focus(null,true)} aria-label="主流程与详解全图" aria-pressed={index < 0 && showAll}>全图</button>
    {legacyTemplate && !editor.current?.getSceneElements().some(e => e.id === regions[0].id.split('-teach-')[0]+'-hierarchy-A-mark') && <button disabled={disabled} onClick={arrange} aria-label="应用主次布局" title="放大主线、外围详解与引导线；可撤销">主次布局</button>}
    {legacyTemplate && scene.some(e => e.id === regions[0].id.split('-teach-')[0]+'-hierarchy-A-mark') && canEnlarge && <button disabled={disabled} onClick={enlargeDetails} aria-label="放大外围详解" title="保留主线和虚线位置，适度放大详解；可撤销">详解＋</button>}
    {layoutError && <span role="status">{layoutError}</span>}
    {legacyTemplate && <button disabled={disabled} onClick={improveReadability} aria-label="优化讲解字号与连线" title="放大文字、紧凑框体、边中点连线；可撤销">优化排版</button>}
  </nav>;
}
