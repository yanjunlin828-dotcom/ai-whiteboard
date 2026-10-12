import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Excalidraw, MainMenu, convertToExcalidrawElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import './style.css';
import { BoardController } from './controller';
import type {BoardEntry} from './controller';
import {BoardLibrary} from './board-library';
import { TeachingNavigation } from './teaching-navigation';
import './teaching-navigation.css';
import {useReadingMode} from './reading-mode';
import './reading-mode.css';
import {fontFamily,prepareNoteScene,restyleNotes} from './typography';
import {FormulaEditor} from './formula-editor';
import {UIIcon} from './ui-icon';
import './interface-polish.css';

const controller = new BoardController('whiteboard:v1',true);
const UI_OPTIONS = { canvasActions: { loadScene: false, clearCanvas: true, saveToActiveFile: false, toggleTheme: true, export: { saveFileToDisk: true } } };

function Mark() {
  return <svg aria-hidden="true" width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="1" y="1" width="26" height="26" rx="8" fill="currentColor" /><path d="M8 20 20 8M8 8h6m6 6v6h-6" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function App() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const reader=useReadingMode(api,state.editorEpoch,state.page==='editor');
  const [showHelp, setShowHelp] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupResult, setBackupResult] = useState('');
  const [switchBoards,setSwitchBoards]=useState<BoardEntry[]>([]);
  const [navigationError,setNavigationError]=useState('');
  const [fontError,setFontError]=useState('');
  const [formulaOpen,setFormulaOpen]=useState(false);
  useEffect(()=>{
    if(!showHelp&&!showBackup)return;
    const trigger=document.activeElement instanceof HTMLButtonElement?document.activeElement:null;
    const close=()=>{setShowHelp(false);setShowBackup(false);};
    const onKey=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||formulaOpen)return;
      event.preventDefault();event.stopPropagation();close();trigger?.focus();
    };
    const onOutside=(event:PointerEvent)=>{
      if(formulaOpen||!(event.target instanceof Element)||event.target.closest('.help-panel, .app-header button[aria-expanded]'))return;
      close();
    };
    document.addEventListener('keydown',onKey,true);document.addEventListener('pointerdown',onOutside);
    return()=>{document.removeEventListener('keydown',onKey,true);document.removeEventListener('pointerdown',onOutside);};
  },[showHelp,showBackup,formulaOpen]);
  const normalizing=useRef(false);
  const initialScene=useMemo(()=>{
    if(!state.board)return null;
    const openingView:Pick<AppState,'zoom'|'activeTool'>={zoom:{value:0.3 as AppState['zoom']['value']},
      activeTool:{type:'hand',customType:null,lastActiveTool:null,locked:false}};
    return prepareNoteScene(state.board.scene)
    .then(scene=>({...scene,appState:{...scene.appState,...openingView},scrollToContent:true})).catch(error=>{
      setFontError(error instanceof Error?error.message:'字体加载失败，请刷新重试。');
      const scene=state.board!.scene;
      return {...scene,appState:{...scene.appState,...openingView},scrollToContent:true};
    });
  },[state.board]);
  async function navigate(boardId?:string){try{setNavigationError('');await controller.leaveEditor(boardId);setShowHelp(false);setShowBackup(false);setBackupResult('');}catch(error){setNavigationError(error instanceof Error?error.message:'切换失败');}}
  const importInput = useRef<HTMLInputElement | null>(null);
  async function importBackup(file?: File) {
    if (!file || backupBusy) return;
    setBackupBusy(true); setBackupResult('正在导入为新白板…');
    try { const imported=await controller.importBackup(file); setBackupResult(`已新建“${imported.title}”，可在我的白板中打开。`); }
    catch (error) { setBackupResult(error instanceof Error ? error.message : '导入失败，当前白板保留。'); }
    finally { setBackupBusy(false); }
  }
  async function localBackup(format: 'excalidraw' | 'png') {
    if (backupBusy) return;
    setBackupBusy(true); setBackupResult('正在保存…');
    try { const result = await controller.localBackup(format); setBackupResult(`已保存并校验：${result.path}`); }
    catch (error) { setBackupResult(error instanceof Error ? error.message : '备份未能保存。'); }
    finally { setBackupBusy(false); }
  }
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState('');
  useEffect(() => { void controller.start(); return () => controller.stop(); }, []);
  useEffect(() => {
    const release = () => controller.setBusy(false);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); };
  }, []);
  async function sample() {
    if (!api.current || state.count || !state.writable || state.bridgeBusy) return;
    setSampleBusy(true); setSampleError('');
    try {
      await document.fonts.ready;
      const elements = convertToExcalidrawElements([
        { type: 'text', x: 100, y: 85, text: '流程示例', fontSize: 38, fontFamily: fontFamily('流程示例'), strokeColor: '#2c4d79' },
        { type: 'rectangle', id: 'practice-question', x: 100, y: 235, width: 235, height: 120, roundness: { type: 3 }, strokeColor: '#35639c', backgroundColor: '#edf3fb', fillStyle: 'solid', label: { text: '输入', fontSize: 28, fontFamily: fontFamily('输入') } },
        { type: 'rectangle', id: 'practice-idea', x: 465, y: 235, width: 235, height: 120, roundness: { type: 3 }, strokeColor: '#264a78', backgroundColor: '#e5eef9', fillStyle: 'solid', label: { text: '输出', fontSize: 28, fontFamily: fontFamily('输出') } },
        { type: 'arrow', x: 345, y: 295, width: 110, height: 0, points: [[0, 0], [110, 0]], strokeColor: '#35639c', start: { id: 'practice-question' }, end: { id: 'practice-idea' } },
      ]);
      api.current.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      api.current.scrollToContent(elements, { fitToContent: true });
    } catch { setSampleError('练习图未能生成；你仍可使用顶部工具手工绘图。'); }
    finally { setSampleBusy(false); }
  }
  const statusLabel = { loading: '正在打开', saved: state.lastSaved ? '已保存' : '未编辑', dirty: '未保存', saving: '保存中', error: '保存失败' }[state.status];
  const footerMessage=state.message||(state.board&&!state.connected?'本地服务连接中断；未保存内容请先下载备份。':
    state.board&&!state.writable?state.board.archived?'已归档 · 当前只读':
      state.handoffPending?'等待原窗口结束输入并保存…':'另一窗口编辑 · 当前只读':'');
  const disabled = !state.writable || Boolean(state.recovery) || state.bridgeBusy || state.switching;
  if(state.page==='library'&&state.board)return <BoardLibrary controller={controller}/>;
  return <main ref={reader.shell} className={`app-shell${reader.reading?' is-reading':''}`}>
    <header className="app-header">
      <button className="back-library" disabled={state.switching||state.bridgeBusy||backupBusy} onClick={()=>void navigate()} aria-label="返回我的白板"><UIIcon name="back"/><span>白板</span></button>
      <span className="header-divider" />
      <input className="board-title" aria-label="白板标题" value={state.title} maxLength={80} disabled={disabled} onChange={event => controller.title(event.target.value)} onBlur={() => void controller.flush()} />
      <details className="board-switch" onToggle={event=>{if(event.currentTarget.open)void controller.listBoards().then(data=>setSwitchBoards(data.boards.filter(b=>!b.archived))).catch(()=>setNavigationError('白板列表读取失败，请重新连接。'));}}><summary aria-label="切换白板"><UIIcon name="chevron"/></summary><div className="board-switch-panel">{switchBoards.map(b=><button key={b.boardId} aria-current={b.boardId===state.board?.boardId?'page':undefined} disabled={state.switching||state.bridgeBusy||backupBusy} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');void navigate(b.boardId);}}>{b.title}{b.boardId===state.board?.boardId?' · 当前':''}</button>)}</div></details>
      <div className="header-actions">
        <button className="text-button formula-trigger" title="插入公式；选中公式后可再次编辑" disabled={disabled||!api.current} onClick={()=>setFormulaOpen(true)}><UIIcon name="formula"/>公式</button>
        <button ref={reader.enterButton} className="icon-button reading-enter" aria-label="全屏阅读" title="全屏阅读 · Esc 退出" disabled={!state.board||Boolean(state.recovery)||state.switching||state.bridgeBusy} onClick={()=>{setShowHelp(false);setShowBackup(false);reader.enter();}}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
        <span className={`save-status ${state.status}`} role="status" title={state.lastSaved ? `保存时间 ${new Date(state.lastSaved).toLocaleTimeString('zh-CN')} · 版本 ${state.revision}` : ''}><span className="status-dot" />{statusLabel}</span>
        <button className="text-button backup" title="下载可编辑白板文件" disabled={!state.board} onClick={() => controller.backup()}>下载备份</button>
        <button className="text-button" title="保存到本机或导入白板" disabled={!state.board} aria-expanded={showBackup} onClick={() => { setShowBackup(value => !value); setShowHelp(false); }}>本机备份</button>
        <button className="icon-button" aria-label="使用帮助" title="使用帮助与快捷键" aria-expanded={showHelp} onClick={() => { setShowHelp(value => !value); setShowBackup(false); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></button>
      </div>
    </header>
    {navigationError?<div className="notice" role="alert">{navigationError}<button onClick={()=>setNavigationError('')}>关闭</button></div>:null}
    {fontError?<div className="notice" role="alert">{fontError}<button onClick={()=>setFontError('')}>关闭</button></div>:null}
    {state.recovery ? <div className="notice recovery" role="alert"><span>发现上次未确认保存的草稿。{state.recovery.baseRevision !== state.revision ? '磁盘版本已变化，请先下载草稿备份。' : '可以恢复后继续编辑。'}</span><div><button onClick={() => controller.backup()}>下载草稿</button><button disabled={!state.writable || state.recovery.baseRevision !== state.revision} onClick={() => controller.recover()}>恢复草稿</button><button onClick={() => controller.keepDisk()}>查看磁盘版本</button></div></div> : null}
    {state.storageWarning ? <div className="notice" role="alert">浏览器草稿缓存不可用。关闭页面前请确认已保存到本机，或下载备份。</div> : null}
    {state.recoveryWarnings ? <div className="notice" role="alert">检测到异常版本文件，已读取最后一个完整版本。异常文件已保留，请查看使用说明。</div> : null}
    <section className="canvas-wrap" aria-label="白板编辑区" onPointerDown={() => controller.setBusy(true)} onDoubleClickCapture={event=>{
      if(disabled||reader.reading||!(event.target instanceof HTMLCanvasElement))return;
      const selected=api.current?.getSceneElements().filter(e=>api.current?.getAppState().selectedElementIds[e.id]);
      if(selected?.length===1&&selected[0].customData?.formula){event.preventDefault();event.stopPropagation();setFormulaOpen(true);}
    }}>
      {state.board ? <Excalidraw key={state.editorEpoch} excalidrawAPI={value => { api.current = value; controller.attachEditor(value); }}
        initialData={initialScene}
        onChange={(elements,app,files)=>{
          controller.change(elements,app,files);
          if(disabled||normalizing.current||app.editingTextElement||app.isResizing||app.isRotating)return;
          try {
            const next=restyleNotes(elements);
            if(next){normalizing.current=true;queueMicrotask(()=>{
              try {if(api.current?.getSceneElementsIncludingDeleted()===elements)
                api.current.updateScene({elements:next,captureUpdate:CaptureUpdateAction.NEVER});}
              finally{normalizing.current=false;}
            });}
          }catch(error){setFontError(error instanceof Error?error.message:'公式字体更新失败。');}
        }} langCode="zh-CN" viewModeEnabled={disabled||reader.reading} zenModeEnabled={reader.reading}
        UIOptions={UI_OPTIONS} name={state.title}>
        <MainMenu>
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>
      </Excalidraw> : <div className="opening"><span className="loading-line" /><p>{state.status === 'error' ? '白板服务暂未连接' : '正在打开你的白板'}</p>{state.status === 'error' ? <button onClick={() => void controller.connect()}>重新连接</button> : null}</div>}
      {reader.reading?<button ref={reader.exitButton} className="reading-exit" aria-label="退出全屏阅读" title="退出阅读 · Esc" onClick={reader.exit}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg></button>:null}
      {showBackup ? <aside className="help-panel backup-panel" aria-label="本机备份面板"><div className="help-heading"><h2>本机备份</h2><button className="text-button" onClick={() => setShowBackup(false)}>关闭</button></div><button className="text-button" disabled={backupBusy || state.bridgeBusy || !state.connected} onClick={() => void localBackup('excalidraw')}>保存可编辑稿</button><button className="text-button" disabled={backupBusy || state.bridgeBusy || !state.connected} onClick={() => void localBackup('png')}>保存 PNG</button><button className="text-button" disabled={backupBusy || disabled || !state.connected} onClick={() => importInput.current?.click()}>导入新白板</button><input ref={importInput} type="file" accept=".excalidraw,application/json" aria-label="选择白板备份文件" hidden onChange={event => { const file=event.target.files?.[0]; event.target.value=''; void importBackup(file); }} /><p>导入创建新白板，当前稿件保留。PNG 仅为图片。</p><p role="status" className="backup-path">{backupResult}</p></aside> : null}
      {showHelp && !showBackup ? <aside className="help-panel" aria-label="使用帮助"><div className="help-heading"><h2>快捷操作</h2><button className="text-button" onClick={() => setShowHelp(false)}>关闭</button></div><dl><div><dt>文字</dt><dd><kbd>T</kbd></dd></div><div><dt>矩形 / 箭头</dt><dd><kbd>R</kbd> / <kbd>A</kbd></dd></div><div><dt>移动画布</dt><dd><kbd>H</kbd> + 左键拖动</dd></div><div><dt>放大 / 缩小</dt><dd>画布上滚动滚轮</dd></div><div><dt>撤销 / 重做</dt><dd><kbd>Ctrl Z</kbd> / <kbd>Ctrl Shift Z</kbd></dd></div></dl><p>默认使用抓手浏览。按 V 切换选择工具后双击改字，停止编辑后自动保存。导入、导出在左上角菜单。</p>{state.count === 0 ? <button className="text-button" onClick={() => void sample()} disabled={sampleBusy || disabled}>{sampleBusy ? '插入中…' : '插入示例'}</button> : null}{sampleError ? <p role="alert">{sampleError}</p> : null}</aside> : null}
    </section>
    {formulaOpen&&api.current?<FormulaEditor editor={api.current} controller={controller} onClose={()=>setFormulaOpen(false)}/>:null}
    <TeachingNavigation regions={state.regions} editor={api} disabled={!state.board || Boolean(state.recovery) || state.bridgeBusy} />
    <footer className="app-footer"><span className="footer-left"><span className={`status-dot ${state.connected ? 'online' : ''}`} />{state.connected ? '本机' : '未连接'}<span className="footer-divider">/</span>{state.writable ? '可编辑' : '只读'}</span>
      {footerMessage?<span className={`footer-notice${state.status==='error'||!state.connected?' has-error':''}`} role={state.status==='error'?'alert':'status'}>
        <span className="footer-notice-text" title={footerMessage}>{footerMessage}</span>
        <span className="footer-notice-actions">{!state.connected?<button onClick={()=>void controller.connect()}>重新连接</button>:null}
          {!state.writable&&state.connected&&!state.board?.archived?<button disabled={state.switching||state.handoffPending} onClick={()=>void controller.claim()}>{state.handoffPending?'正在切换…':'在此窗口编辑'}</button>:null}
          {state.status==='error'&&state.writable?<button onClick={()=>void controller.flush()}>重试保存</button>:null}</span>
      </span>:null}
      <span className="ai-status" role="status" title={state.aiMessage||'AI 已连接'} aria-label={state.aiMessage||undefined}>{state.bridgeBusy ? 'AI 处理中…' : (state.aiMessage||state.mcpSeen ? 'AI' : '')}</span></footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
