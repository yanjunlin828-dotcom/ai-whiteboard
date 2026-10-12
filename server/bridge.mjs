import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { BoardError, sceneSchema, boardIdSchema } from './store.mjs';
import { applyEdits, EditError } from '../shared/edits.mjs';
import {isFormulaPatch,planFormulaPatch} from '../shared/formulas.mjs';
import {patchShape,patchSchema,readShape,renderShape,validateShape,previewShape,previewSchema,elementId} from './authoring-schema.mjs';
import {meta,bounds,regionDefinitions,regionMembers,validateDiagram,checkNewCollisions,itemMetadata,assignRoute} from '../shared/diagram.mjs';
import {needsDiagramEdits,planDiagramEdits} from '../shared/diagram-edits.mjs';
export {patchShape,patchSchema,readShape,renderShape,validateShape,previewShape};

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function describeBoard(board, selectedIds = [], input = { scope: 'all', limit: 150 }) {
  if(input.revision!==undefined&&input.revision!==board.revision)throw new BoardError('REVISION_CONFLICT','分页版本已变化，请从结构摘要重新读取。',409);
  const live = board.scene.elements.filter(element => !element.isDeleted);
  const selection = selectedIds.filter(id => live.some(element => element.id === id));
  let relevant = live;
  if(input.regionId)relevant=regionMembers(live,input.regionId);
  if (input.scope === 'selection') {
    if (!selection.length) throw new BoardError('EMPTY_SELECTION', '请先选中图元，或使用 scope=all。', 409);
    const ids = new Set(selection);
    for (const element of live) if (ids.has(element.id)) {
      for (const bound of element.boundElements ?? []) ids.add(bound.id);
      if (element.containerId) ids.add(element.containerId);
      if (element.startBinding) ids.add(element.startBinding.elementId);
      if (element.endBinding) ids.add(element.endBinding.elementId);
    }
    relevant = relevant.filter(element => ids.has(element.id));
  }
  const offset=input.offset??0,limit=input.limit??150,regions=regionDefinitions(live).map(r=>({...r,count:regionMembers(live,r.id).length,bounds:bounds(regionMembers(live,r.id))}));
  const page=input.summary?[]:relevant.slice(offset,offset+limit);
  return { boardId: board.boardId, title: board.title, revision: board.revision, savedAt: board.savedAt,
    selectedIds: selection, total: relevant.length, bounds:bounds(relevant),regions,offset,nextOffset:!input.summary&&offset+page.length<relevant.length?offset+page.length:null,truncated:input.summary?false:offset+page.length<relevant.length,
    elements: page.map(element => ({ id: element.id, type: element.type, x: element.x, y: element.y,
      width: element.width, height: element.height, angle: element.angle, frameId: element.frameId, text: element.text, originalText: element.originalText, fontSize: element.fontSize,
      fontFamily: element.fontFamily, strokeColor: element.strokeColor, backgroundColor: element.backgroundColor,
      locked: element.locked, containerId: element.containerId, boundElements: element.boundElements,
      startBinding: element.startBinding, endBinding: element.endBinding, points: element.points,
      strokeWidth:element.strokeWidth,strokeStyle:element.strokeStyle,roughness:element.roughness,diagram:meta(element),
      ...(element.customData?.formula?{formula:element.customData.formula,text:`$$${element.customData.formula.latex}$$`}:{}) })) };
}

// One job owns a short commit window. Rendering and font measurement stay in the real editor.
export class EditorBridge {
  constructor(store, { timeout = 20000, allowEdits = false } = {}) { this.store = store; this.timeout = timeout; this.allowEdits = allowEdits; this.active = null; }
  status(requestId) {
    const receipt = requestId ? this.store.aiTransactions.get(requestId) : undefined;
    return { busy: Boolean(this.active), operation: this.active?.kind ?? null, transaction: receipt ?? null };
  }
  invoke(kind, raw) {
    const input = kind==='preview'?previewSchema.parse(raw):kind==='patch'?patchSchema.parse(raw):kind === 'read' ? z.object(readShape).strict().parse(raw) : kind==='validate'?z.object(validateShape).strict().parse(raw):z.object(renderShape).strict().parse(raw);
    if(input.boardId && input.boardId!==this.store.boardId)throw new BoardError('BOARD_MISMATCH','目标白板不匹配，请重新读取。',409);
    const requestHash = hash(input);
    if (kind === 'patch') {
      const previous = this.store.aiTransactions.get(input.requestId);
      if (previous) {
        if (previous.hash !== requestHash) throw new BoardError('REQUEST_REUSED', 'requestId 已用于不同操作。', 409);
        return Promise.resolve({ ...previous, requestId: input.requestId, duplicate: true, currentRevision: this.store.board.revision, applied: 'previously_committed' });
      }
      if (input.edits && !this.allowEdits) throw new BoardError('EDIT_NOT_READY', '局部编辑正在完成撤销验收，正式白板暂未开放。', 409);
    }
    if (this.active) {
      if (kind === 'patch' && this.active.kind === kind && this.active.input.requestId === input.requestId && this.active.hash === requestHash) return this.active.promise;
      throw new BoardError('EDITOR_BUSY', '另一个白板操作正在执行，请稍后读取最新版本后重试。', 409);
    }
    let complete;
    const promise = new Promise(resolve => { complete = resolve; });
    const job = { id: randomUUID(), kind, input, hash: requestHash, owner: null, promise, complete, committed: null, committing: false };
    this.active = job;
    job.timer = setTimeout(() => {
      // A disk commit is never cancelled mid-write; the caller can query its receipt.
      if (job.committing) return;
      this.finish(job, job.committed ? { ...job.committed, applied: false, message: '已保存，但页面确认超时；重新读取核对，不要更换 requestId 重复生成。' }
        : { error: { code: 'EDITOR_TIMEOUT', message: '编辑窗口未就绪或仍在输入；保持窗口打开，结束输入后重试。' } });
    }, this.timeout);
    return promise;
  }
  poll(owner) {
    const job = this.active;
    if (!job || job.owner) return null;
    job.owner = owner;
    return { id: job.id, kind: job.kind, input: job.input };
  }
  get(owner, id) {
    const job = this.active;
    if (!job || job.id !== id || job.owner !== owner) throw new BoardError('JOB_EXPIRED', '操作已过期；未提交的内容不会自动写入。', 409);
    return job;
  }
  finish(job, result) {
    if (this.active !== job) return;
    clearTimeout(job.timer); this.active = null; job.complete(result);
  }
  async candidate(job, raw) {
    const board = this.store.read();
    if (board.revision !== job.input.baseRevision) throw new BoardError('REVISION_CONFLICT', '人工内容已保存为新版本，请重新读取后生成。', 409);
    let candidate = sceneSchema.parse({ ...board.scene, elements: raw.elements });
    let affectedIds = [];
    if(isFormulaPatch(job.input,board.scene.elements)){
      const {renderFormula}=await import('./formula.mjs');
      const planned=await planFormulaPatch(board.scene,job.input,z.array(elementId).max(2000).parse(raw.selectedIds??[]),renderFormula);
      if(!isDeepStrictEqual(candidate.elements,planned.elements))throw new BoardError('OUT_OF_SCOPE','公式提交与指定修改不一致。',409);
      candidate=sceneSchema.parse({...board.scene,elements:planned.elements,files:planned.files});
      affectedIds=planned.affectedIds;
    } else if (job.input.edits) {
      try {
        const selected=z.array(elementId).max(2000).parse(raw.selectedIds??[]);
        const planned = needsDiagramEdits(job.input,board.scene.elements)?await planDiagramEdits(board.scene.elements,job.input,selected,async (_e,_w,key)=>raw.layouts?.[key],candidate.elements.slice(board.scene.elements.length)):
          applyEdits(board.scene.elements, job.input, selected, raw.layouts ?? {}, candidate.elements.slice(board.scene.elements.length));
        if (!isDeepStrictEqual(candidate.elements, planned.elements)) throw new BoardError('OUT_OF_SCOPE', '提交与允许的局部修改不一致。', 409);
        affectedIds = planned.affectedIds;
      } catch (error) {
        if (error instanceof EditError) throw new BoardError(error.code, error.message, error.status);
        throw error;
      }
    } else {
      if (candidate.elements.length <= board.scene.elements.length || candidate.elements.length > board.scene.elements.length + 100) throw new BoardError('INVALID_PATCH', '新增图元数量异常。');
      for (let i = 0; i < board.scene.elements.length; i++) if (!isDeepStrictEqual(candidate.elements[i], board.scene.elements[i])) throw new BoardError('OUT_OF_SCOPE', '新增操作不能更改原有内容，请使用 edits。', 409);
      const added = candidate.elements.slice(board.scene.elements.length);
      const ids = new Set(added.map(element => element.id));
      for (const element of added) {
        if (!['text', 'rectangle', 'ellipse', 'diamond', 'arrow'].includes(element.type) || element.isDeleted || element.link) throw new BoardError('INVALID_PATCH', '包含不允许的图元。');
        if(element.customData){
          const item=job.input.items?.find(i=>element.id===`ai-${job.input.requestId}-${i.id}`);
          const nativeLabel=element.type==='text'&&element.containerId&&job.input.items?.some(i=>['rectangle','ellipse','diamond'].includes(i.type)&&element.containerId===`ai-${job.input.requestId}-${i.id}`);
          if(!item&&!nativeLabel)throw new BoardError('INVALID_PATCH','新增元数据必须来自声明的图元。');
          let expected=item?itemMetadata(item):undefined;
          if(element.type==='text')expected={...expected,noteTypography:3};
          if(item?.type==='arrow'){
            const source=candidate.elements.find(e=>e.id===`ai-${job.input.requestId}-${item.from}`),target=candidate.elements.find(e=>e.id===`ai-${job.input.requestId}-${item.to}`);
            const route=assignRoute({...element,customData:expected},source,target,item,candidate.elements);
            expected=route.customData;
            for(const field of ['x','y','points','startBinding','endBinding','startArrowhead','endArrowhead'])if(!isDeepStrictEqual(route[field],element[field]))throw new BoardError('INVALID_CONNECTION','新增连接不符合声明的边中点与路线。');
          }
          if(!isDeepStrictEqual(expected,element.customData))throw new BoardError('INVALID_PATCH','新增元数据超出声明范围。');
        }
        for (const target of [element.containerId, element.startBinding?.elementId, element.endBinding?.elementId, ...(element.boundElements ?? []).map(value => value.id)].filter(Boolean)) {
          if (!ids.has(target)) throw new BoardError('OUT_OF_SCOPE', '新增图形只能绑定本批次中的图元。', 409);
        }
      }
      checkNewCollisions(board.scene.elements,added);
    }
    const ids = candidate.elements.slice(board.scene.elements.length).map(element => element.id);
    if(this.store.board.revision!==board.revision)throw new BoardError('REVISION_CONFLICT','测量期间白板已变化，请重新读取。',409);
    return {board,candidate,ids,affectedIds};
  }
  async preview(owner,id,raw){
    const job=this.get(owner,id);if(job.kind!=='preview')throw new BoardError('INVALID_JOB','不是提交前预览请求。');
    const planned=await this.candidate(job,raw);this.get(owner,id);
    job.preview={validation:validateDiagram(planned.candidate.elements,{regionId:job.input.regionId}),createdIds:planned.ids,affectedIds:planned.affectedIds};
    return {scene:planned.candidate,revision:planned.board.revision,...job.preview};
  }
  async commit(owner, id, raw) {
    const job = this.get(owner, id);
    if (job.kind !== 'patch') throw new BoardError('INVALID_JOB', '操作类型不符。');
    if (job.committed) return { board: this.store.read(), receipt: job.committed };
    if (job.committing) throw new BoardError('EDITOR_BUSY', '正在提交，请查询状态。', 409);
    const {board,candidate,ids,affectedIds}=await this.candidate(job,raw);
    this.get(owner,id);
    const aiTransaction = { requestId: job.input.requestId, hash: job.hash, createdIds: ids, affectedIds };
    job.committing = true;
    try {
      const result = await this.store.save({ baseRevision: job.input.baseRevision, requestId: job.input.requestId,
        title: board.title, scene: candidate, aiTransaction });
      job.committed = { boardId: this.store.boardId, requestId: job.input.requestId, revision: result.board.revision, createdIds: ids, affectedIds, duplicate: false };
      clearTimeout(job.timer);
      job.timer = setTimeout(() => this.finish(job, { ...job.committed, applied: false }), this.timeout);
      return { board: result.board, receipt: job.committed };
    } catch (error) {
      this.finish(job, { error: { code: error instanceof BoardError ? error.code : 'SAVE_FAILED', message: '保存未完成，请重新读取白板后重试。' } });
      if (!(error instanceof BoardError) && !(error instanceof z.ZodError)) throw new BoardError('SAVE_FAILED', '磁盘写入失败；原有白板未被改动。', 503);
      throw error;
    } finally { job.committing = false; }
  }
  result(owner, id, value) {
    const job = this.get(owner, id);
    if (value.error) {
      this.finish(job, job.committed ? { ...job.committed, applied: false } : { error: { code: String(value.error.code ?? 'EDITOR_ERROR').slice(0,80), message: String(value.error.message ?? '操作失败').slice(0,500) } });
      return;
    }
    if (value.revision !== this.store.board.revision) throw new BoardError('REVISION_CONFLICT', '内容版本已变化，请重新读取。', 409);
    if (job.kind === 'patch') {
      if (!job.committed) throw new BoardError('NOT_COMMITTED', '尚未保存。', 409);
      this.finish(job, { ...job.committed, applied: true });
    } else if (job.kind === 'read') {
      const selected = z.array(z.string().max(200)).max(2000).parse(value.selectedIds ?? []);
      this.finish(job, describeBoard(this.store.read(), selected, job.input));
    } else if(job.kind==='validate'){
      if(job.input.revision!==value.revision)throw new BoardError('REVISION_CONFLICT','检查版本已变化。',409);
      this.finish(job,{boardId:this.store.boardId,revision:value.revision,...validateDiagram(this.store.board.scene.elements,job.input)});
    } else {
      if ((job.kind==='preview'?job.input.baseRevision:job.input.revision) !== value.revision) throw new BoardError('REVISION_CONFLICT', '预览请求不是当前版本。', 409);
      if(job.kind==='preview'&&!job.preview)throw new BoardError('INVALID_PREVIEW','候选图尚未通过校验。');
      const png = z.string().max(8_000_000).parse(value.png);
      const bytes = Buffer.from(png, 'base64');
      if (bytes.length < 24 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) > 1600 || bytes.readUInt32BE(20) > 1600) throw new BoardError('INVALID_PREVIEW', '预览图片无效或尺寸超限。');
      this.finish(job, { boardId: this.store.boardId, revision: value.revision,...(job.kind==='preview'?{saved:false,...job.preview}:{}), png, mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    }
  }
  close() { if (this.active) this.finish(this.active, { error: { code: 'EDITOR_OFFLINE', message: '服务正在关闭，请稍后重新读取。' } }); }
}
