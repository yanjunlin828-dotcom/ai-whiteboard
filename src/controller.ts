import { captureScene, downloadJson, fingerprint } from './model';
import type { Board, Scene } from './model';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { CaptureUpdateAction, loadFromBlob } from '@excalidraw/excalidraw';
import { parseBackup } from '../shared/backup-import.mjs';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { editElements, generateElements, renderScene } from './ai-editor';
import type { EditorJob } from './ai-editor';
import { EditError } from '../shared/edits.mjs';
import { teachingRegions } from '../shared/teaching.mjs';
import type { TeachingRegion } from '../shared/teaching.mjs';
import {isFormulaPatch,planFormulaPatch} from '../shared/formulas.mjs';
import type {FormulaInput,FormulaRender} from '../shared/formulas.mjs';

type SaveStatus = 'loading' | 'saved' | 'dirty' | 'saving' | 'error';
interface Draft { schemaVersion: 1; scene: Scene; title: string; baseRevision: number; savedAt: string; pendingRequestId?: string; dirty?:boolean }
interface Snapshot {
  page: 'library' | 'editor'; switching: boolean; editorSessionId: string; handoffPending: boolean;
  board: Board | null; title: string; writable: boolean; connected: boolean;
  status: SaveStatus; message: string; revision: number; lastSaved: string | null;
  count: number; recovery: Draft | null; recoveryWarnings: number; storageWarning: boolean;
  mcpSeen: boolean; editorEpoch: number;
  bridgeBusy: boolean; aiMessage: string;
  regions: TeachingRegion[];
}
type Request = { baseRevision: number; requestId: string; title: string; scene: Scene };
class ApiError extends Error { constructor(public code: string, message: string) { super(message); } }

export class BoardController {
  private listeners = new Set<() => void>();
  private state: Snapshot = { page:'editor',switching:false,editorSessionId:'',handoffPending:false,board: null, title: '我的讲解白板', writable: false, connected: false,
    status: 'loading', message: '', revision: 0, lastSaved: null, count: 0, recovery: null,
    recoveryWarnings: 0, storageWarning: false, mcpSeen: false, editorEpoch: 0, bridgeBusy: false, aiMessage: '', regions: [] };
  private token = '';
  private clientId = crypto.randomUUID();
  private draftKey: string;
  private draftRoot: string;
  private boardId = new URLSearchParams(location.search).get('board') ?? 'main';
  private scene: Scene | null = null;
  private baseline = '';
  private current = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: Request | null = null;
  private saving = false;
  private blocked = false;
  private busy = false;
  private pointerBusy = false;
  private stopped = false;
  private heartbeatBusy = false;
  private jobTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private editor: ExcalidrawImperativeAPI | null = null;
  attachEditor = (editor: ExcalidrawImperativeAPI) => { this.editor = editor; };

  constructor(storageNamespace = 'whiteboard:v1',libraryHome=false) {
    if(libraryHome&&!location.search.includes('board='))this.state.page='library';
    let tabId = crypto.randomUUID() as string;
    try {
      tabId = sessionStorage.getItem(`${storageNamespace}:tab`) ?? tabId;
      sessionStorage.setItem(`${storageNamespace}:tab`, tabId);
    } catch { /* Disk saving remains available without browser storage. */ }
    this.draftKey = `${storageNamespace}:draft:${tabId}`;
    this.draftRoot=this.draftKey;
    this.selectDraftKey();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private set(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private async request<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
    const response = await fetch(`/api/${path}`, { method, headers: {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      'X-Whiteboard-Board':this.boardId,'X-Whiteboard-Session':this.state.editorSessionId,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.code, data.message);
    return data;
  }
  private useBoard(board: Board) {
    this.editor=null;
    this.scene = board.scene;
    this.baseline = fingerprint({ title: board.title, scene: board.scene });
    this.current = this.baseline;
    this.blocked = false; this.pending = null;
    this.set({ board, title: board.title, revision: board.revision, lastSaved: board.savedAt,
      count: board.scene.elements.filter(element => !element.isDeleted).length, regions: teachingRegions(board.scene.elements),
      status: 'saved', message: '', editorEpoch: this.state.editorEpoch + 1 });
  }
  async start() {
    this.stopped = false;
    await this.connect();
    if (this.stopped) return;
    this.heartbeat = setInterval(() => void this.ping(), 2000);
    this.jobTimer = setInterval(() => void this.pollJobs(), 650);
    window.addEventListener('beforeunload', this.beforeUnload);
    window.addEventListener('pagehide', this.pageHide);
    window.addEventListener('pageshow', this.pageShow);
    document.addEventListener('visibilitychange', this.visibilityChange);
  }
  async connect() {
    try {
      const data = await this.request<{ token: string; writable: boolean; board: Board; recoveryWarnings: number; editorSessionId:string }>('session', 'POST', { clientId: this.clientId,boardId:this.boardId,page:this.state.page });
      this.token = data.token;
      if(data.board.boardId!==this.boardId)throw new Error('白板身份不符');
      this.set({editorSessionId:data.editorSessionId});
      if (!this.state.board) {
        this.useBoard(data.board);
        try {
          const raw = localStorage.getItem(this.draftKey);
          if (raw) {
            const draft = JSON.parse(raw) as Draft;
            if (draft.schemaVersion === 1 && draft.dirty!==false && draft.scene && draft.title && fingerprint({ title: draft.title, scene: draft.scene }) !== this.baseline) {
              this.set({ recovery: draft,page:'editor' });
            }
          }
        } catch { this.set({ storageWarning: true }); }
      } else if (this.current === this.baseline) {
        this.useBoard(data.board);
      } else if (this.pending && data.board.requestId === this.pending.requestId) {
        this.baseline = fingerprint({ title: this.pending.title, scene: this.pending.scene });
        this.pending = null;
        this.set({ revision: data.board.revision, lastSaved: data.board.savedAt,
          status: this.current === this.baseline ? 'saved' : 'dirty', message: '' });
      } else if (data.board.revision !== this.state.revision) {
        this.blocked = true;
        this.set({ status: 'error', message: '磁盘已有较新内容。当前草稿已保留，请先下载备份，再重新打开。' });
      }
      this.set({ connected: true, writable: data.writable&&!this.blocked, recoveryWarnings: data.recoveryWarnings });
      if (this.current !== this.baseline && !this.blocked) this.schedule();
    } catch {
      this.set({ connected: false, status: 'error', message: '无法连接本地服务。请启动白板后点击“重新连接”。' });
    }
  }
  private async ping() {
    if (this.heartbeatBusy || this.stopped || !this.token || this.state.switching) return;
    this.heartbeatBusy = true;
    try {
      const editorState=this.state.page==='library'?'library':this.blocked?'blocked':this.state.recovery?'recovery':this.saving?'saving':this.state.bridgeBusy?'ai_busy':!this.editor?'loading':!this.state.writable?'read_only':this.inputActive()?'input_active':this.current!==this.baseline?'unsaved':'ready';
      const data = await this.request<{ writable: boolean; revision: number; lastMcpCheck: string | null; editorSessionId:string; handoffRequested:boolean; handoffPending:boolean }>('heartbeat', 'POST', {autoClaim:this.state.page==='editor'&&!this.blocked&&!this.state.recovery,editorState});
      const gained=data.writable&&!this.state.writable;
      if(!data.writable&&this.state.writable)this.writeDraft();
      this.set({ connected:true, editorSessionId:data.editorSessionId, handoffPending:data.handoffPending, mcpSeen:Boolean(data.lastMcpCheck) });
      if(gained){
        const latest=await this.request<{board:Board}>('board');
        this.acceptOwnership(latest.board);
      }else this.set({writable:data.writable&&!this.blocked});
      if (!this.state.bridgeBusy && !this.saving && this.current === this.baseline && data.revision !== this.state.revision) {
        const latest = await this.request<{ board: Board }>('board');
        this.useBoard(latest.board);
      }
      if(data.handoffRequested)await this.handoff();
    } catch (error) {
      this.set({ connected: false });
      if (error instanceof ApiError && ['SESSION_EXPIRED','BOARD_MISMATCH'].includes(error.code)) await this.connect();
    } finally { this.heartbeatBusy = false; }
  }
  async claim() {
    if(this.state.switching||this.state.handoffPending)return;
    this.set({switching:true});
    try {
      while(this.heartbeatBusy)await new Promise(resolve=>setTimeout(resolve,25));
      const data = await this.request<{ writable: boolean; board: Board; editorSessionId:string; handoffPending:boolean }>('claim', 'POST', {});
      this.set({editorSessionId:data.editorSessionId,handoffPending:data.handoffPending,message:''});
      if(data.writable)this.acceptOwnership(data.board);
    } catch(error) { this.set({ message:error instanceof ApiError?error.message:'切换未完成，请检查连接后重试。' }); }
    finally{this.set({switching:false});}
  }
  private acceptOwnership(board:Board){
    if(this.current===this.baseline&&!this.pending)this.useBoard(board);
    else if(board.revision!==this.state.revision){
      this.writeDraft();this.blocked=true;
      this.set({writable:false,status:'error',message:'白板已有较新内容。当前草稿已保留，请先下载草稿，再重新打开。'});return;
    }
    this.set({writable:!this.blocked,message:this.blocked?this.state.message:''});
    if(!this.blocked&&this.current!==this.baseline)this.schedule();
  }
  private async handoff(){
    if(!this.state.writable||this.state.switching||this.state.bridgeBusy||this.polling||this.saving||this.inputActive()||this.state.recovery||this.blocked||this.state.status==='error')return;
    this.set({switching:true});
    try{
      await this.flush();
      if(this.current!==this.baseline||this.pending||this.saving||this.blocked||this.getSnapshot().status==='error')return;
      const result=await this.request<{writable:boolean}>('handoff','POST',{revision:this.state.revision});
      this.writeDraft();this.set({writable:result.writable});
    }catch(error){
      if(!(error instanceof ApiError&&error.code==='EDITOR_BUSY'))this.set({message:'编辑窗口切换未完成，当前内容已保留。'});
    }finally{this.set({switching:false});}
  }
  change = (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    if (!this.state.writable || this.state.recovery || this.blocked || this.state.bridgeBusy || this.state.switching) return;
    this.busy = Boolean(appState.editingTextElement || appState.isResizing || appState.isRotating);
    const scene = captureScene(elements, appState, files);
    const value = fingerprint({ title: this.state.title, scene });
    if (value === this.current) return;
    // Own a stable copy: Excalidraw may update element objects after this event.
    this.scene = structuredClone(scene);
    this.current = value;
    this.set({ count: elements.filter(element => !element.isDeleted).length, regions: teachingRegions(elements),
      status: value === this.baseline ? 'saved' : 'dirty', message: '', aiMessage: '' });
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.writeDraft(), 150);
    this.schedule();
  };
  setBusy(value: boolean) { this.pointerBusy = value; if (!value) this.schedule(); }
  title = (value: string) => {
    if (!this.state.writable || !this.scene || this.state.bridgeBusy || this.state.switching) return;
    this.set({ title: value.slice(0, 80), status: 'dirty', message: '', aiMessage: '' });
    this.current = fingerprint({ title: this.state.title, scene: this.scene });
    this.writeDraft(); this.schedule();
  };
  private schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), 900); }
  private writeDraft() {
    if (!this.scene || this.state.recovery) return;
    try {
      localStorage.setItem(this.draftKey, JSON.stringify({ schemaVersion: 1, scene: this.scene,
        title: this.state.title, baseRevision: this.state.revision, savedAt: new Date().toISOString(), pendingRequestId: this.pending?.requestId,dirty:this.current!==this.baseline||Boolean(this.pending) }));
    } catch { this.set({ storageWarning: true }); }
  }
  async flush() {
    if (this.saving || this.blocked || this.state.recovery || this.state.bridgeBusy || !this.scene || !this.state.writable || (this.current === this.baseline && !this.pending)) return;
    if (this.busy || this.pointerBusy) { this.schedule(); return; }
    if (!this.state.title.trim()) { this.set({ status: 'error', message: '请给白板填写一个标题，草稿仍保留。' }); return; }
    this.saving = true;
    this.pending ??= { baseRevision: this.state.revision, requestId: crypto.randomUUID(), title: this.state.title.trim(), scene: structuredClone(this.scene) };
    const pending = this.pending;
    this.writeDraft(); this.set({ status: 'saving', message: '' });
    try {
      const result = await this.request<{ board: Board }>('board', 'POST', pending);
      this.baseline = fingerprint({ title: pending.title, scene: pending.scene });
      this.pending = null;
      if (this.state.title.trim() === pending.title) {
        this.state = { ...this.state, title: pending.title };
        this.current = fingerprint({ title: this.state.title, scene: this.scene });
      }
      this.set({ connected: true, revision: result.board.revision, lastSaved: result.board.savedAt,
        status: this.current === this.baseline ? 'saved' : 'dirty' });
      this.writeDraft();
      if (this.current !== this.baseline) this.schedule();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'REVISION_CONFLICT' || error.code === 'REQUEST_REUSED') this.blocked = true;
        if (error.code === 'READ_ONLY') this.set({ writable: false });
        if (error.code !== 'SAVE_FAILED') this.pending = null;
      }
      this.set({ status: 'error', message: error instanceof ApiError ? error.message : '尚未确认保存。草稿仍在，请重试保存或下载备份。' });
    } finally { this.saving = false; }
  }
  recover() {
    const recovery = this.state.recovery;
    if (!recovery || !this.state.board || recovery.baseRevision !== this.state.revision || !this.state.writable) return;
    const board = { ...this.state.board, title: recovery.title, scene: recovery.scene };
    this.scene = recovery.scene;
    this.current = fingerprint({ title: recovery.title, scene: recovery.scene });
    this.set({ recovery: null, board, title: recovery.title, status: 'dirty', editorEpoch: this.state.editorEpoch + 1 });
    this.schedule();
  }
  keepDisk() { this.set({ recovery: null }); /* The existing recovery file stays in browser storage until a new edit is saved. */ }
  backup() {
    const recovery = this.state.recovery;
    const scene = recovery?.scene ?? this.scene;
    if (!scene) return;
    // The standard format can be opened directly from Excalidraw's local file menu.
    downloadJson({ type: 'excalidraw', version: 2, source: 'ai-whiteboard', ...scene,
      whiteboard: { schemaVersion: 1, boardId: this.boardId, title: recovery?.title ?? this.state.title,
        revision: recovery?.baseRevision ?? this.state.revision, exportedAt: new Date().toISOString(),
        draft: this.state.status !== 'saved' || Boolean(recovery) } },
      `讲解白板-${new Date().toISOString().replace(/[:.]/g, '-')}.excalidraw`);
  }
  async localBackup(format: 'excalidraw' | 'png') {
    if (this.state.bridgeBusy || this.busy || this.pointerBusy) throw new Error('请先结束文字编辑或拖动，再保存备份。');
    const recovery = this.state.recovery;
    const scene = structuredClone(recovery?.scene ?? this.scene);
    if (!scene) throw new Error('白板尚未打开。');
    const payload = format === 'png' ? { format, png: await renderScene(scene) } : {
      format, scene, title: recovery?.title ?? this.state.title,
      revision: recovery?.baseRevision ?? this.state.revision,
      draft: this.state.status !== 'saved' || Boolean(recovery),
    };
    return this.request<{path: string; bytes: number; sha256: string}>('backup', 'POST', payload);
  }
  async importBackup(file: File) {
    if ((!this.state.writable&&this.state.page==='editor') || !this.state.connected || this.state.recovery || this.state.bridgeBusy || this.busy || this.pointerBusy || this.saving || this.pending || this.blocked || this.current !== this.baseline || !this.state.board || !this.scene) throw new Error('请先结束编辑并确认当前白板已保存，再导入备份。');
    if (file.size > 16*1024*1024) throw new Error('备份超过 16 MB。');
    this.set({bridgeBusy:true,aiMessage:'正在校验备份…'});
    try {
      const metadata=parseBackup(await file.text());
      const restored=await loadFromBlob(file,null,null);
      const scene=captureScene(restored.elements,restored.appState as AppState,restored.files ?? {});
      const title=metadata.title ?? (file.name.replace(/\.excalidraw$/i,'').slice(0,80) || '导入白板');
      const result=await this.request<{board:Board}>('boards/create','POST',{title,scene});
      this.set({aiMessage:'已导入为新白板'});
      return result.board;
    } catch (error) {
      this.set({aiMessage:'导入未完成，当前白板保留。'});
      throw error;
    } finally { this.set({bridgeBusy:false}); }
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.current !== this.baseline || this.saving || this.state.bridgeBusy) { this.writeDraft(); event.preventDefault(); event.returnValue = ''; }
  };
  private inputActive() {
    return this.busy || this.pointerBusy || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '');
  }
  private async pollJobs() {
    if (this.polling || this.stopped || this.state.switching || this.state.bridgeBusy || this.state.page!=='editor' || !this.editor || !this.token || !this.state.writable || !this.state.connected || this.state.recovery || this.blocked || this.saving || this.inputActive()) return;
    this.polling = true;
    let job: EditorJob | null = null;
    let selectedIds: string[] | null = null;
    try {
      await this.flush();
      if (this.current !== this.baseline || this.saving || this.inputActive()) return;
      const response = await this.request<{ job: EditorJob | null }>('jobs/poll', 'POST', {});
      job = response.job;
      if (!job) return;
      if(job.input.boardId && (job.input.boardId!==this.boardId || job.input.editorSessionId!==this.state.editorSessionId))throw new ApiError('BOARD_MISMATCH','白板会话已切换。');
      if (this.inputActive() || this.current !== this.baseline || !this.scene) throw new ApiError('EDITOR_BUSY', '刚有新的人工输入，请结束输入后重试。');
      selectedIds = Object.keys(this.editor.getAppState().selectedElementIds).filter(id => this.editor!.getAppState().selectedElementIds[id]);
      this.set({ bridgeBusy: true, aiMessage: job.kind === 'patch' ? '正在生成并保存图文…' : job.kind === 'render'||job.kind==='preview' ? '正在生成预览…' : job.kind==='validate'?'正在检查图形…':'正在读取最新白板…' });
      if (job.kind === 'patch'||job.kind==='preview') {
        if (job.input.baseRevision !== this.state.revision) throw new ApiError('REVISION_CONFLICT', '白板已有新修改，请重新读取后生成。');
        const candidate = isFormulaPatch(job.input,this.scene.elements)?await planFormulaPatch(this.scene,job.input,selectedIds,this.renderFormula):job.input.edits ? await editElements(job.input, this.scene, selectedIds) : { elements: await generateElements(job.input, this.scene), layouts: {} };
        if(job.kind==='preview'){
          const result=await this.request<{scene:Scene;revision:number}>('jobs/preview','POST',{id:job.id,...candidate,selectedIds});
          const png=await renderScene(result.scene,undefined,job.input.regionId);
          await this.request('jobs/result','POST',{id:job.id,revision:result.revision,png});
          this.set({aiMessage:'预览完成 · 尚未保存'});return;
        }
        const result = await this.request<{ board: Board }>('jobs/commit', 'POST', { id: job.id, ...candidate, selectedIds });
        const board = result.board;
        // Disk commits first. A failed write never displays an unsaved AI candidate.
        // Re-registering unchanged SVGs makes the native editor rewrite their
        // file versions, creating an unrelated save after each AI edit.
        const newFiles=Object.values(board.scene.files).filter(file=>!this.scene!.files[file.id]);
        if(newFiles.length)this.editor.addFiles(newFiles);
        this.editor.updateScene({ elements: structuredClone(board.scene.elements), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        const added = board.scene.elements.filter(element => !this.scene!.elements.some(previous => previous.id === element.id));
        if (added.length && !job.input.edits) this.editor.scrollToContent(added, { fitToContent: true, viewportZoomFactor: 0.72, maxZoom: 1 });
        this.scene = structuredClone(board.scene);
        this.baseline = fingerprint({ title: board.title, scene: this.scene }); this.current = this.baseline;
        this.set({ title: board.title, revision: board.revision, lastSaved: board.savedAt, status: 'saved', count: board.scene.elements.filter(element => !element.isDeleted).length, regions: teachingRegions(board.scene.elements) });
        this.writeDraft();
        await this.request('jobs/result', 'POST', { id: job.id, revision: board.revision });
        this.set({ aiMessage: job.input.edits ? '已修改 · Ctrl+Z 撤销' : `已新增 ${added.length} 项` });
      } else if (job.kind === 'read'||job.kind==='validate') {
        await this.request('jobs/result', 'POST', { id: job.id, revision: this.state.revision, selectedIds });
        this.set({ aiMessage: `已读取版本 ${this.state.revision}` });
      } else {
        if (job.input.revision !== this.state.revision) throw new ApiError('REVISION_CONFLICT', '预览版本已过期，请重新读取。');
        const png = await renderScene(this.scene, job.input.elementIds,job.input.regionId);
        await this.request('jobs/result', 'POST', { id: job.id, revision: this.state.revision, png });
        this.set({ aiMessage: `已生成版本 ${this.state.revision} 的预览` });
      }
    } catch (error) {
      if (job) {
        const message = error instanceof Error ? error.message : 'AI 操作未完成，请重新读取状态。';
        this.set({ aiMessage: message });
        try { await this.request('jobs/result', 'POST', { id: job.id, error: { code: error instanceof ApiError || error instanceof EditError ? error.code : 'EDITOR_ERROR', message } }); } catch { /* Query receipt after reconnect; never silently replay a write. */ }
      }
    } finally {
      if (this.state.bridgeBusy) {
        this.set({ bridgeBusy: false });
        // Excalidraw clears selection when entering view mode. Restore it after
        // React applies the unlocked props, without adding a history entry.
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (selectedIds && this.editor && !this.stopped) {
          const live = new Set(this.editor.getSceneElements().map(element => element.id));
          this.editor.updateScene({ appState: { selectedElementIds: Object.fromEntries(selectedIds.filter(id => live.has(id)).map(id => [id, true])) }, captureUpdate: CaptureUpdateAction.NEVER });
        }
      }
      this.polling = false;
    }
  }
  private pageHide = () => {
    this.writeDraft();
    if (this.token) void fetch('/api/release', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}`,'X-Whiteboard-Board':this.boardId,'X-Whiteboard-Session':this.state.editorSessionId }, body: '{}', keepalive: true }).catch(() => {});
  };
  private pageShow = (event:PageTransitionEvent) => {if(event.persisted)void this.connect();};
  private visibilityChange = () => { if (document.visibilityState === 'hidden') { this.writeDraft(); void this.flush(); } else void this.ping(); };
  private selectDraftKey(){this.draftKey=this.boardId==='main'?this.draftRoot:`${this.draftRoot}:${this.boardId}`;}
  private findDraft(){
    try{const raw=localStorage.getItem(this.draftKey);if(raw){const draft=JSON.parse(raw) as Draft;if(draft.schemaVersion===1&&draft.dirty!==false&&draft.scene&&draft.title&&fingerprint({title:draft.title,scene:draft.scene})!==this.baseline)this.set({recovery:draft,page:'editor'});}}
    catch{this.set({storageWarning:true});}
  }
  async leaveEditor(target?:string){
    if(this.state.switching||this.state.bridgeBusy||this.polling||this.saving||this.busy||this.pointerBusy||this.state.recovery)throw new Error('请先结束编辑或处理草稿，再切换白板。');
    await this.flush();
    if(this.current!==this.baseline||this.saving||this.pending||this.blocked||!this.state.connected)throw new Error('当前内容尚未保存，请先重试保存或备份。');
    this.set({switching:true});
    try{
      // Do not let a heartbeat response from the previous board arrive after the switch.
      while(this.heartbeatBusy)await new Promise(resolve=>setTimeout(resolve,25));
      this.writeDraft();clearTimeout(this.timer);clearTimeout(this.draftTimer);
      const data=await this.request<{board:Board;editorSessionId:string;writable:boolean;recoveryWarnings:number}>('boards/open','POST',{boardId:target??this.boardId,page:target?'editor':'library'});
      this.boardId=data.board.boardId;this.selectDraftKey();this.busy=false;this.pointerBusy=false;
      this.set({recovery:null,handoffPending:false,editorSessionId:data.editorSessionId,writable:data.writable,recoveryWarnings:data.recoveryWarnings,aiMessage:'',page:target?'editor':'library'});
      this.useBoard(data.board);this.findDraft();
      history.replaceState(null,'',target?`?board=${encodeURIComponent(target)}`:location.pathname);
    }finally{this.set({switching:false});}
  }
  renderFormula=(input:FormulaInput)=>this.request<FormulaRender>('formula/render','POST',input);
  listBoards=()=>this.request<{boards:BoardEntry[];warnings:number}>('boards');
  previewBoard=(id:string)=>this.request<{board:Board}>(`boards/preview?boardId=${encodeURIComponent(id)}`);
  createBoard=()=>this.request<{board:Board}>('boards/create','POST',{title:'未命名白板'});
  copyBoard=(board:BoardEntry)=>this.request<{board:Board}>('boards/copy','POST',{boardId:board.boardId,baseRevision:board.revision});
  changeBoard=(board:BoardEntry,change:{title?:string;archived?:boolean})=>this.request('boards/change','POST',{boardId:board.boardId,baseRevision:board.revision,...change});
  stop() {
    this.stopped = true; clearInterval(this.heartbeat); clearInterval(this.jobTimer); clearTimeout(this.timer); clearTimeout(this.draftTimer);
    window.removeEventListener('beforeunload', this.beforeUnload); window.removeEventListener('pagehide', this.pageHide);
    window.removeEventListener('pageshow',this.pageShow);
    document.removeEventListener('visibilitychange', this.visibilityChange);
  }
}
export interface BoardEntry {boardId:string;title:string;revision:number;savedAt:string|null;archived:boolean;count:number;recoveryWarnings:number}
