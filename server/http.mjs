import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, relative, extname, sep } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { BoardError } from './store.mjs';
import { saveBackup } from './backup.mjs';
import { EditorLeases } from './editor-leases.mjs';
import { ArchiveRequests } from './archive.mjs';

const MAX_BODY = 16 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg' };
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BoardError('CONTENT_TYPE', '请求需要 JSON 格式。', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BoardError('LIMIT_EXCEEDED', '白板超过 16 MB，请减少图片大小。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new BoardError('INVALID_JSON', '无法读取请求内容。'); }
}
async function staticFile(res, root, pathname) {
  const file = resolve(root, `.${pathname}`);
  const within = relative(root, file);
  if (within.startsWith(`..${sep}`) || within === '..' || resolve(file) === resolve(root)) return false;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

export function createBoardServer({ store: defaultStore, root, assets, middleware, bridge: defaultBridge, library, bridgeToken, clock = Date.now }) {
  const instanceId = randomBytes(16).toString('hex');
  const sessions = new Map();
  let archives;
  let lastMcpCheck = null;
  const boardBridge = id => library ? library.bridge(id) : defaultBridge;
  const leases = new EditorLeases(sessions, clock,
    (id, token) => Boolean(sessions.get(token)?.saving || boardBridge(id)?.active?.owner || archives?.reserved(id)),
    id => boardBridge(id)?.close());
  if(library)archives=new ArchiveRequests(library,sessions,leases,clock);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new BoardError('HOST_DENIED', '仅允许本机访问。', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        archives?.expire();
        leases.refresh();
        const requestToken=req.headers.authorization?.replace(/^Bearer /,'');
        const currentSession=sessions.get(requestToken);
        const activeSession=sessions.get(leases.selected());
        let store=library ? library.get(currentSession?.boardId??activeSession?.boardId??'main') : defaultStore;
        let bridge=library ? library.bridge(store.boardId) : defaultBridge;
        const isWriter = token => leases.owner(store.boardId??'main') === token;
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new BoardError('ORIGIN_DENIED', '该网页不能访问本地白板。', 403);
        }
        for (const [key, value] of sessions) if (clock() - value.lastSeen > 3_600_000 && leases.owner(value.boardId) !== key) sessions.delete(key);
        if (url.pathname === '/api/status' && req.method === 'GET') {
          if (req.headers['x-whiteboard-client'] === 'mcp') lastMcpCheck = new Date(clock()).toISOString();
          const target=url.searchParams.get('boardId');
          if(library && target){store=library.get(target);bridge=library.bridge(target);}
          const writer=leases.owner(store.boardId??'main');
          const selectedSession=sessions.get(writer);
          const freshState=selectedSession&&clock()-(selectedSession.reportedAt??0)<5000;
          const readyReason=!writer?'offline':store.board.archived?'archived':freshState?selectedSession.editorState:clock()-(selectedSession?.lastPoll??0)<5000?'ready':'stale_heartbeat';
          const receiptBridge=library&&target ? library.bridge(target) : bridge;
          if(library&&url.searchParams.has('requestId')&&!target)throw new BoardError('BOARD_REQUIRED','查询事务必须指定原 boardId。',409);
          return json(res, 200, { ok: true, app: 'ai-whiteboard', instanceId, stage: library ? '7' : bridge ? '4' : '1-2',
            boardId:store.boardId,title:store.board.title,editorSessionId:selectedSession?.epoch??null,
            revision: store.board.revision, editorConnected: Boolean(writer), lastMcpCheck,
            editorReady:readyReason==='ready',readyReason,retryAfterMs:readyReason==='ready'?0:2000,
            editors:library?[...library.stores.values()].flatMap(s=>{const token=leases.owner(s.boardId),session=sessions.get(token);return token?[{boardId:s.boardId,title:s.board.title,editorSessionId:session.epoch,archived:Boolean(s.board.archived)}]:[]}):undefined,
            localEditsEnabled: bridge?.allowEdits ?? false,
            recoveryWarnings: store.recoveryWarnings.length, capabilities: bridge ? ['board_status', 'board_read', 'board_patch', 'board_render','board_preview','board_validate'] : ['board_status'],
            featureFlags:{preparedPreview:true,preciseRead:true,savedRead:true,patchVerification:true,longPoll:true},
            readinessAgeMs:selectedSession?Math.max(0,clock()-(selectedSession.reportedAt??selectedSession.lastPoll??0)):null,
            savedAt: store.board.savedAt, ...(target?{transactionBoardId:target}:{}), ...(receiptBridge ? receiptBridge.status(url.searchParams.get('requestId')) : {}) });
        }
        if (url.pathname.startsWith('/api/agent/')) {
          const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
          const expected = Buffer.from(bridgeToken ?? '');
          if (!bridge || !expected.length || given.length !== expected.length || !timingSafeEqual(given, expected) || origin) throw new BoardError('BRIDGE_DENIED', '仅允许已配置的本机 MCP 服务。', 403);
          if (req.method !== 'POST') throw new BoardError('METHOD', '需要 POST 请求。', 405);
          const kind = url.pathname.slice('/api/agent/'.length);
          if (!['read', 'patch', 'render','preview','validate'].includes(kind)) throw new BoardError('NOT_FOUND', '操作不存在。', 404);
          lastMcpCheck = new Date(clock()).toISOString();
          const input=await body(req);
          if(library&&input.boardId){store=library.get(input.boardId);bridge=library.bridge(input.boardId);}
          if(archives?.reserved(store.boardId))throw new BoardError('ARCHIVE_BUSY','白板正在保存并退出编辑，暂不接收 AI 操作。',409);
          const writer=leases.owner(store.boardId??'main');
          if(library){
            const active=sessions.get(writer);
            if(kind!=='read'&&(!input.boardId||!input.editorSessionId))throw new BoardError('BOARD_REQUIRED','修改和预览必须传入刚读取的 boardId 与 editorSessionId。请刷新 MCP 工具定义。',409);
            if((input.boardId&&input.boardId!==active?.boardId)||(input.editorSessionId&&input.editorSessionId!==active?.epoch))throw new BoardError('BOARD_MISMATCH','编辑对象或会话已切换，请重新读取目标白板。',409);
            if(!active)throw new BoardError('EDITOR_OFFLINE','请打开白板编辑窗口后重试。',409);
            input.boardId=active.boardId;input.editorSessionId=active.epoch;
            if(store.board.archived)throw new BoardError('ARCHIVED','请先恢复已归档白板。',409);
          }
          if (!writer) throw new BoardError('EDITOR_OFFLINE', '请打开白板编辑窗口后重试。', 409);
          const state=sessions.get(writer),recent=state&&clock()-(state.reportedAt??0)<2500;
          if(recent&&!(kind==='read'&&input.source==='saved')&&!bridge.active&&!bridge.status(input.requestId).transaction&&['input_active','recovery','blocked'].includes(state.editorState)){
            const reason={input_active:'编辑页正在输入，请结束输入后重试。',recovery:'编辑页正在恢复草稿，请先处理草稿。',blocked:'编辑页保存冲突尚未处理，请先确认草稿。'}[state.editorState];
            throw new BoardError('EDITOR_NOT_READY',reason,409);
          }
          const result = await bridge.invoke(kind, input);
          return json(res, result.error ? 409 : 200, result.error ?? {...result,...(library?{boardId:store.boardId,editorSessionId:input.editorSessionId}:{})});
        }
        if (url.pathname === '/api/session' && req.method === 'POST') {
          const input = await body(req);
          if (typeof input.clientId !== 'string' || input.clientId.length > 100) throw new BoardError('INVALID_SESSION', '无效的会话。');
          const priorToken = req.headers.authorization?.replace(/^Bearer /, '');
          const prior = sessions.get(priorToken);
          if (prior?.clientId === input.clientId) {
            prior.lastSeen = clock();
            if (!store.board.archived&&!archives?.reserved(store.boardId)) leases.acquire(priorToken);
            return json(res, 200, { token: priorToken, writable: isWriter(priorToken)&&!store.board.archived, instanceId, editorSessionId:prior.epoch, board: store.read(), recoveryWarnings: store.recoveryWarnings.length });
          }
          if (sessions.size >= 100) throw new BoardError('SESSION_LIMIT', '连接过多，请稍后再试。', 429);
          const token = randomBytes(32).toString('hex');
          if(library){store=library.get(input.boardId??'main');bridge=library.bridge(store.boardId);}
          if(archives?.reserved(store.boardId))throw new BoardError('ARCHIVE_BUSY','该白板正在准备归档，请等待结果后再打开。',409);
          const epoch=randomUUID();
          const session={ clientId: input.clientId, lastSeen: clock(),boardId:store.boardId??'main',epoch,editor:input.page!=='library',eligible:input.page!=='library' };
          sessions.set(token, session);
          if(!store.board.archived)leases.acquire(token);
          return json(res, 200, { token, writable: isWriter(token)&&!store.board.archived, instanceId,editorSessionId:session.epoch, board: store.read(), recoveryWarnings: store.recoveryWarnings.length });
        }
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        const session = sessions.get(token);
        if (!session) throw new BoardError('SESSION_EXPIRED', '连接已失效，请重新连接。', 401);
        session.lastSeen = clock();
        const expectedEpoch=session.epoch;
        const sessionBody=async()=>{
          const input=await body(req);
          // A slow request body must not cross an editor handoff or board switch.
          if(sessions.get(token)!==session||session.epoch!==expectedEpoch)throw new BoardError('BOARD_MISMATCH','编辑会话已切换，请重新读取白板。',409);
          return input;
        };
        if(library){
          const selected=req.headers['x-whiteboard-board'];
          const epoch=req.headers['x-whiteboard-session'];
          const handoffHeartbeat=url.pathname==='/api/heartbeat'&&epoch===session.previousEpoch;
          if(selected!==session.boardId||(epoch!==session.epoch&&!handoffHeartbeat))throw new BoardError('BOARD_MISMATCH','页面白板身份已过期，请重新连接。',409);
          if(url.pathname==='/api/boards'&&req.method==='GET')return json(res,200,{boards:library.list().map(b=>({...b,openEditors:archives.editors(b.boardId).length})),warnings:library.warnings.length});
          if(url.pathname==='/api/boards/archive-status'&&req.method==='GET')return json(res,200,{archive:archives.get(url.searchParams.get('boardId'),url.searchParams.get('requestId'),token)});
          if(url.pathname==='/api/boards/preview'&&req.method==='GET')return json(res,200,{board:library.get(url.searchParams.get('boardId')).read()});
          if(url.pathname.startsWith('/api/boards/')&&req.method==='POST'){
            const input=await sessionBody();
            if(url.pathname==='/api/boards/archive')return json(res,200,{archive:await archives.start(input,token)});
            if(url.pathname==='/api/boards/open'){
              const target=library.get(input.boardId);
              if(archives.reserved(session.boardId)||archives.reserved(target.boardId))throw new BoardError('ARCHIVE_BUSY','白板正在准备归档，请等待结果后再切换。',409);
              leases.leave(token);
              session.boardId=target.boardId;session.epoch=randomUUID();session.previousEpoch=null;session.lastPoll=0;
              session.editor=input.page!=='library';session.eligible=session.editor;
              if(!target.board.archived)leases.acquire(token);
              return json(res,200,{board:target.read(),editorSessionId:session.epoch,writable:leases.owner(target.boardId)===token&&!target.board.archived,recoveryWarnings:target.recoveryWarnings.length});
            }
            if(url.pathname==='/api/boards/create')return json(res,200,{board:await library.create(input)});
            if(url.pathname==='/api/boards/copy'){
              const source=library.get(input.boardId).read();
              if(source.revision!==input.baseRevision)throw new BoardError('REVISION_CONFLICT','白板已更新，请刷新列表。',409);
              return json(res,200,{board:await library.create({title:(source.title+' · 副本').slice(0,80),scene:source.scene})});
            }
            if(url.pathname==='/api/boards/change'){
              const {boardId,...change}=input;
              if(archives.reserved(boardId))throw new BoardError('ARCHIVE_BUSY','白板正在准备归档，请等待结果后再修改。',409);
              const owner=leases.owner(boardId);
              if(owner&&owner!==token)throw new BoardError('READ_ONLY','该白板仍在其他窗口编辑。请先返回白板列表；归档可使用“关闭并归档”。',409);
              if(library.bridge(boardId).active)throw new BoardError('EDITOR_BUSY','目标白板仍有 AI 请求。',409);
              return json(res,200,await library.change(boardId,change));
            }
          }
        }
        if (url.pathname === '/api/backup' && req.method === 'POST') {
          try { return json(res, 200, await saveBackup(resolve(store.directory, '../backups'), await sessionBody(),store.boardId)); }
          catch (error) {
            if (error instanceof ZodError || error instanceof BoardError) throw error;
            throw new BoardError('BACKUP_FAILED', '本机备份失败。当前内容仍保留，可重试或下载备份。', 503);
          }
        }
        if(url.pathname==='/api/archive/respond'&&req.method==='POST'&&archives)return json(res,200,{archive:await archives.respond(await sessionBody(),token)});
        if(url.pathname==='/api/formula/render'&&req.method==='POST'){
          const {renderFormula}=await import('./formula.mjs');
          try{return json(res,200,await renderFormula(await sessionBody()));}
          catch(error){throw new BoardError('FORMULA_ERROR',error.message,400);}
        }
        if (url.pathname.startsWith('/api/jobs/') && bridge && req.method === 'POST') {
          const input = await sessionBody();
          if (!isWriter(token)||store.board.archived) throw new BoardError('READ_ONLY', '只有活动编辑窗口可以接收 AI 操作。', 409);
          if(url.pathname==='/api/jobs/poll'&&archives?.reserved(store.boardId))throw new BoardError('ARCHIVE_BUSY','白板正在准备归档，暂不领取 AI 请求。',409);
          leases.renew(token);
          if (url.pathname === '/api/jobs/poll') {
            const waitMs=input.waitMs??0;
            if(!Number.isInteger(waitMs)||waitMs<0||waitMs>5000)throw new BoardError('INVALID_WAIT','领取等待需在0–5000毫秒内。');
            const abort=new AbortController();
            const disconnected=()=>{if(!res.writableEnded)abort.abort();};res.on('close',disconnected);
            await bridge.wait(waitMs,abort.signal);res.removeListener('close',disconnected);
            if(abort.signal.aborted||res.destroyed)return;
            if(sessions.get(token)!==session||session.epoch!==expectedEpoch||!isWriter(token)||store.board.archived)throw new BoardError('BOARD_MISMATCH','等待期间编辑归属已变化。',409);
            if(archives?.reserved(store.boardId))throw new BoardError('ARCHIVE_BUSY','白板正在准备归档，未领取 AI 请求。',409);
            session.lastPoll = clock();
            return json(res, 200, { job: bridge.poll(token),waitSupported:true });
          }
          if (url.pathname === '/api/jobs/commit') return json(res, 200, await bridge.commit(token, input.id, input));
          if (url.pathname === '/api/jobs/preview') return json(res,200,await bridge.preview(token,input.id,input));
          if (url.pathname === '/api/jobs/result') {
            bridge.result(token, input.id, input);
            return json(res, 200, { ok: true });
          }
        }
        if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
          const input=await sessionBody();
          if(['ready','input_active','unsaved','saving','ai_busy','recovery','loading','library','read_only','blocked'].includes(input.editorState)){session.editorState=input.editorState;session.reportedAt=clock();}
          if(!store.board.archived && !archives?.reserved(store.boardId) && input.autoClaim===true)leases.acquire(token);
          leases.renew(token);
          const archive=archives?.notice(token)??null;
          return json(res, 200, { writable: isWriter(token)&&!store.board.archived&&(!archives||archives.canSave(store.boardId,token)), editorSessionId:session.epoch, handoffRequested:leases.requested(token)||Boolean(isWriter(token)&&archive?.status==='waiting'&&!archive.responded), handoffPending:leases.pending(token), revision: store.board.revision, instanceId, lastMcpCheck, archive });
        }
        if (url.pathname === '/api/claim' && req.method === 'POST') {
          await sessionBody();
          if(store.board.archived)throw new BoardError('ARCHIVED','请先恢复已归档白板。',409);
          if(archives?.reserved(store.boardId))throw new BoardError('ARCHIVE_BUSY','白板正在准备归档，请等待结果。',409);
          leases.request(token);
          return json(res, 200, { writable: isWriter(token), editorSessionId:session.epoch, handoffPending:leases.pending(token), board: store.read() });
        }
        if(url.pathname==='/api/handoff'&&req.method==='POST'){
          const input=await sessionBody();
          if(archives?.reserved(store.boardId)){
            // Older AI-opened pages already know how to flush and acknowledge a handoff.
            const archive=archives.notice(token);
            if(!isWriter(token)||archive?.status!=='waiting')throw new BoardError('ARCHIVE_BUSY','白板正在准备归档，请等待结果。',409);
            const result=await archives.respond({requestId:archive.requestId,ready:true,revision:input.revision},token);
            return json(res,200,{writable:result.status==='failed'&&isWriter(token),editorSessionId:session.epoch});
          }
          if(input.revision!==store.board.revision)throw new BoardError('REVISION_CONFLICT','版本已变化，请保存并重新同步后切换。',409);
          leases.yield(token);
          return json(res,200,{writable:isWriter(token),editorSessionId:session.epoch});
        }
        if (url.pathname === '/api/release' && req.method === 'POST') {
          await sessionBody();
          leases.leave(token);
          sessions.delete(token);
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/board' && req.method === 'GET') return json(res, 200, { board: store.read() });
        if (url.pathname === '/api/board' && req.method === 'POST') {
          const input = await sessionBody();
          if (!isWriter(token)||store.board.archived) throw new BoardError('READ_ONLY', '此窗口为阅读模式；请点击“在此窗口编辑”。', 409);
          if(archives&&!archives.canSave(store.boardId,token))throw new BoardError('ARCHIVE_BUSY','此窗口已确认退出，正在归档。',409);
          if (bridge?.active?.owner) throw new BoardError('EDITOR_BUSY', 'AI 正在提交或预览，请稍后保存。', 409);
          if (input.aiTransaction) throw new BoardError('INVALID_REQUEST', '普通保存不能声明 AI 事务。');
          leases.renew(token); session.saving=(session.saving??0)+1;
          try { return json(res, 200, await store.save(input)); }
          catch (error) {
            if (error instanceof ZodError || error instanceof BoardError) throw error;
            throw new BoardError('SAVE_FAILED', '磁盘保存失败，草稿仍在。请重试或下载草稿备份。', 503);
          }
          finally { session.saving--; }
        }
        throw new BoardError('NOT_FOUND', '接口不存在。', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new BoardError('METHOD', '不支持此操作。', 405);
      if (url.pathname.startsWith('/excalidraw/')) {
        if (await staticFile(res, assets, decodeURIComponent(url.pathname.slice('/excalidraw'.length)))) return;
        throw new BoardError('ASSET_MISSING', '字体资源不存在。', 404);
      }
      if (middleware) return middleware(req, res, () => json(res, 404, { code: 'NOT_FOUND' }));
      if (await staticFile(res, root, url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname))) return;
      throw new BoardError('NOT_FOUND', '页面不存在，请先构建应用。', 404);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof ZodError) return json(res, 400, { code: 'INVALID_SCENE', message: '白板数据格式无效，尚未保存。' });
      json(res, error.status ?? 500, { code: error.code ?? 'SERVER_ERROR', message: error instanceof BoardError ? error.message : '服务暂时无法完成操作，请保留草稿后重试。' });
    }
  });
  server.on('close', () => {defaultBridge?.close();library?.close();});
  return server;
}
