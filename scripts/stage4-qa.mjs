// Dedicated local integration fixture. No main-board data or existing credentials are read.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BoardStore } from '../server/store.mjs';
import { EditorBridge } from '../server/bridge.mjs';
import { createBoardServer } from '../server/http.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = resolve(project, '../中间过程/AI讲解白板/stage4-qa'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(resolve(parent, 'run-'));
const keyFile = resolve(directory, 'bridge.key'), bridgeToken = randomBytes(32).toString('hex');
await writeFile(keyFile, bridgeToken, { flag: 'wx', mode: 0o600 });
const store = new BoardStore(resolve(directory, 'revisions')); await store.load();
const bridge = new EditorBridge(store, { allowEdits: true });
const client = new Client({ name: 'stage4-isolated-qa', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(project, 'mcp/server.mjs')], env: { ...getDefaultEnvironment(), WHITEBOARD_PORT: '48767', WHITEBOARD_BRIDGE_FILE: keyFile }, stderr: 'pipe' });
const vite = await createServer({ root: project, configFile: false, define: { 'process.env.IS_PREACT': 'false' }, server: { middlewareMode: true, hmr: false, allowedHosts: ['127.0.0.1'] }, appType: 'mpa' });
const object = result => result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
async function call(name, args = {}) { const result = await client.callTool({ name, arguments: args }); if (result.isError) throw new Error(JSON.stringify(result.content)); return result; }
let report = null, active = false;
const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function middleware(req, res, next) {
  if (req.url === '/qa/report' && req.method === 'GET') return reply(res, 200, { directory, report });
  if (req.url !== '/qa/action') return vite.middlewares(req, res, next);
  if (req.method !== 'POST' || req.headers.origin !== 'http://127.0.0.1:48767' || active) return reply(res, 403, { error: 'Only one isolated page action is allowed.' });
  active = true;
  try {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 10000) throw new Error('Report too large'); }
    const input = JSON.parse(raw);
    if (input.action === 'report') {
      report = input.report;
      await writeFile(resolve(directory, `report-${Date.now()}-${randomUUID().slice(0,8)}.json`), JSON.stringify({ protocol: 'SDK MCP + real browser editor, not host tool discovery', ...report }, null, 2), { flag: 'wx' });
      console.log(JSON.stringify({ report, directory })); return reply(res, 200, { ok: true });
    }
    const board = object(await call('board_read'));
    if (input.action === 'edit') {
      const args = { baseRevision: board.revision, requestId: randomUUID(), selectionIds: board.selectedIds, edits: [
        { op: 'set_text', target: '$selection', text: 'AI 修改后的中文说明，自动换行并保留字体' },
        { op: 'move', target: '$selection', dx: 20, dy: 65 },
        { op: 'connect', id: 'bc', from: 'b', to: 'c' },
      ] };
      const receipt = object(await call('board_patch', args)); assert.equal(receipt.applied, true);
      assert.equal(object(await call('board_patch', args)).duplicate, true);
      const stale = await client.callTool({ name: 'board_patch', arguments: { ...args, requestId: randomUUID() } });
      assert.equal(stale.isError, true); assert.equal(object(stale).code, 'REVISION_CONFLICT');
      const after = object(await call('board_read'));
      const preview = await call('board_render', { revision: after.revision });
      await writeFile(resolve(directory, `preview-${after.revision}.png`), Buffer.from(preview.content.find(c => c.type === 'image').data, 'base64'), { flag: 'wx' });
      await writeFile(resolve(directory, 'mcp-edit.json'), JSON.stringify({ args, receipt, board: after }, null, 2), { flag: 'wx' });
      return reply(res, 200, { receipt });
    }
    if (!['empty-selection','locked'].includes(input.action)) throw new Error('Unknown test action');
    const result = await client.callTool({ name: 'board_patch', arguments: { baseRevision: board.revision, requestId: randomUUID(), ...(input.action === 'empty-selection' ? { selectionIds: [] } : {}), edits: [{ op: 'move', target: input.action === 'empty-selection' ? '$selection' : 'b', dx: 10, dy: 0 }] } });
    assert.equal(result.isError, true); assert.equal(object(result).code, input.action === 'empty-selection' ? 'EMPTY_SELECTION' : 'LOCKED');
    return reply(res, 200, { ok: true });
  } catch (error) { reply(res, 500, { error: error.message }); }
  finally { active = false; }
}
const server = createBoardServer({ store, bridge, bridgeToken, root: directory, assets: resolve(project, 'node_modules/@excalidraw/excalidraw/dist/prod'), middleware });
// The production static-file handler deliberately rejects POST. Keep this test-only
// endpoint outside that handler instead of weakening production routing protections.
const boardHandler = server.listeners('request')[0];
server.removeListener('request', boardHandler);
server.on('request', (req, res) => {
  if (req.url !== '/qa/action') return boardHandler(req, res);
  if (req.headers.host !== '127.0.0.1:48767') return reply(res, 403, { error: 'Invalid test host' });
  void middleware(req, res, () => reply(res, 404, { error: 'Not found' })).catch(error => {
    if (!res.headersSent) reply(res, 500, { error: error.message }); else res.destroy();
  });
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; void vite.close(); });
await new Promise((ok, no) => { server.once('error', no); server.listen(48767, '127.0.0.1', ok); });
await client.connect(transport);
console.log(JSON.stringify({ url: 'http://127.0.0.1:48767/qa/stage4.html', pid: process.pid, directory }));
async function close() { bridge.close(); await client.close(); server.closeAllConnections(); server.close(); await vite.close(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
