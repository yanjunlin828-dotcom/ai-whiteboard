// Only served by scripts/stage4-qa.mjs. This page uses synthetic data, never the main board.
import { createRoot } from 'react-dom/client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Excalidraw, convertToExcalidrawElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import { BoardController } from '../src/controller';
import { editElements } from '../src/ai-editor';
import { captureScene, fingerprint } from '../src/model';

const runStatus = await (await fetch('/api/status')).json();
const controller = new BoardController(`stage4-qa:${runStatus.instanceId}`);
let api: ExcalidrawImperativeAPI;
const wait = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function settled() {
  for (let i = 0; i < 100; i++) {
    await wait(100);
    const state = controller.getSnapshot();
    if (!state.bridgeBusy && state.status === 'saved') return;
    if (state.status === 'error') throw new Error(state.message);
  }
  throw new Error('等待保存超时');
}
const live = () => structuredClone(api.getSceneElements());
const visible = (elements: readonly ExcalidrawElement[]) => fingerprint(elements.filter(e => !e.isDeleted).map(e => {
  const { version, versionNonce, updated, ...rest } = e;
  // Native history treats boundElements as a set and recalculates floating-point
  // geometry. Normalize only set order and sub-nanopixel roundoff; all IDs,
  // text, styles, binding membership and visible geometry remain asserted.
  const precision = (value: number) => Math.round(value * 1e9) / 1e9;
  return { ...rest, boundElements: rest.boundElements?.slice().sort((a,b) => a.id.localeCompare(b.id)) ?? rest.boundElements,
    x: precision(rest.x), y: precision(rest.y), width: precision(rest.width), height: precision(rest.height),
    ...('points' in rest ? { points: rest.points.map(point => point.map(precision)) } : {}) };
}));
const scene = () => captureScene(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles());
async function apply(elements: readonly ExcalidrawElement[]) {
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  await wait(); await controller.flush(); await settled();
}
async function action(action: string, report?: unknown) {
  const response = await fetch('/qa/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, report }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? result.message ?? `HTTP ${response.status}`); return result;
}
async function history(direction: 'undo' | 'redo', expected: readonly ExcalidrawElement[]) {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="button-${direction}"]`);
  check(button && !button.disabled, `${direction} 按钮不可用`);
  button!.click(); await wait(); await controller.flush(); await settled();
  check(visible(live()) === visible(expected), `${direction} 的内容顺序不符`);
}

function App() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [running, setRunning] = useState(false), [message, setMessage] = useState('准备就绪后点击开始，只使用独立测试白板。');
  useEffect(() => { void controller.start(); return () => controller.stop(); }, []);
  async function run() {
    setRunning(true); const checks: string[] = [];
    try {
      check(location.port === '48767' && api.getSceneElements().length === 0, '必须在全新隔离白板执行');
      setMessage('生成合成内容…');
      const original = convertToExcalidrawElements([
        { id: 'manual', type: 'text', x: 70, y: 60, text: '人工内容', fontSize: 24, fontFamily: 5 },
        { id: 'a', type: 'rectangle', x: 80, y: 200, width: 240, height: 120, label: { text: '第一块', fontSize: 26, fontFamily: 5 } },
        { id: 'b', type: 'rectangle', x: 460, y: 200, width: 240, height: 120, label: { text: '第二块', fontSize: 26, fontFamily: 5 } },
        { id: 'c', type: 'ellipse', x: 850, y: 200, width: 240, height: 180, label: { text: '结果', fontSize: 26, fontFamily: 5 } },
        { id: 'ab', type: 'arrow', x: 332, y: 260, width: 116, height: 0, points: [[0,0],[116,0]], start: { id: 'a' }, end: { id: 'b' } },
      ], { regenerateIds: false });
      // The converter adds a 0.5px endpoint nudge for rendering. Use a canonical
      // bound arrow fixture so exact native-history comparisons aren't testing it.
      const boundArrow = original.find(element => element.id === 'ab')!;
      Object.assign(boundArrow, { x: 332, y: 260, width: 116, height: 0, points: [[0, 0], [116, 0]] });
      const ink = { ...original[1], id: 'ink', type: 'freedraw', x: 70, y: 450, width: 100, height: 30, boundElements: null, points: [[0,0],[40,30],[100,10]], pressures: [0.1,0.6,0.4], simulatePressure: false, lastCommittedPoint: null } as unknown as ExcalidrawElement;
      await apply([...original, ink]); const initial = live();
      const manual = await editElements({ baseRevision: state.revision, requestId: crypto.randomUUID(), edits: [{ op: 'set_text', target: 'manual', text: '人工修改第一块，必须保留' }] }, scene(), []);
      await apply(manual.elements); const beforeAI = live();
      api.updateScene({ appState: { selectedElementIds: { b: true } }, captureUpdate: CaptureUpdateAction.NEVER }); await wait();
      setMessage('通过 MCP 改字、移动和补箭头…');
      const outcome = await action('edit'); await settled(); await wait(); const afterAI = live();
      check(outcome.receipt.applied === true, '页面未确认');
      check(fingerprint(afterAI.find(e => e.id === 'manual')) === fingerprint(beforeAI.find(e => e.id === 'manual')), '人工文字被改动');
      check(fingerprint(afterAI.find(e => e.id === 'ink')) === fingerprint(beforeAI.find(e => e.id === 'ink')), '手工笔画被改动');
      check(afterAI.some(e => e.type === 'text' && e.originalText === 'AI 修改后的中文说明，自动换行并保留字体'), '中文编辑没有生效');
      checks.push('MCP 改字、移动、连接与无关内容保护', '重复请求幂等、过期版本拒绝、真实 PNG 预览');
      const later = afterAI.map(e => e.id === 'manual' ? { ...e, x: e.x + 90, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e);
      await apply(later); const afterManual = live();
      setMessage('验证原生撤销与重做…');
      await history('undo', afterAI); await history('undo', beforeAI); await history('undo', initial);
      await history('redo', beforeAI); await history('redo', afterAI); await history('redo', afterManual);
      checks.push('手动 → AI → 手动：三次原生撤销与三次重做，AI 批次一步恢复');
      api.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER }); await wait();
      await action('empty-selection'); checks.push('空选区明确拒绝');
      await apply(live().map(e => e.id === 'b' ? { ...e, locked: true, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e));
      const locked = visible(live()); await action('locked'); await settled();
      check(visible(live()) === locked, '锁定检查修改了场景'); checks.push('锁定对象拒绝且场景不变');
      await action('report', { passed: true, checks, revision: controller.getSnapshot().revision });
      setMessage(`通过 ${checks.length} 组浏览器验收，可关闭本页。`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(`验收停止：${detail}`);
      await action('report', { passed: false, checks, error: detail, revision: controller.getSnapshot().revision }).catch(() => {});
    } finally { setRunning(false); }
  }
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'sans-serif' }}>
    <header style={{ background: '#2c4d79', color: 'white', padding: '12px 20px', display: 'flex', gap: 18, alignItems: 'center' }}><strong>阶段 4 · 隔离验收</strong><button disabled={running || !state.writable || Boolean(state.recovery) || state.status !== 'saved'} onClick={() => void run()}>开始验收</button>{!state.writable && <button onClick={() => void controller.claim()}>取得测试编辑权</button>}<span role="status">{state.recovery ? '测试草稿与当前数据不同，请启动新一轮隔离服务。' : message}</span></header>
    <section style={{ flex: 1, minHeight: 0 }}>{state.board && <Excalidraw key={state.editorEpoch} initialData={{ ...state.board.scene, scrollToContent: true }} excalidrawAPI={value => { api = value; controller.attachEditor(value); }} onChange={controller.change} viewModeEnabled={state.bridgeBusy || !state.writable} langCode="zh-CN" />}</section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
