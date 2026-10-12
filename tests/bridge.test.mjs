import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoardStore, blankBoard } from '../server/store.mjs';
import { EditorBridge, describeBoard, patchSchema } from '../server/bridge.mjs';
import { createBoardServer } from '../server/http.mjs';

const root = resolve('../中间过程/AI讲解白板/tests'); await mkdir(root, { recursive: true });
const original = { id: 'manual', type: 'text', x: 10, y: 10, width: 100, height: 30, text: '人工内容', locked: true };
const added = { id: 'generated', type: 'text', x: 20, y: 160, width: 100, height: 30, text: '新增内容' };
async function setup(t, options) {
  const dir = await mkdtemp(join(root, 'bridge-')); const store = new BoardStore(dir, options); await store.load();
  await store.save({ baseRevision: 0, requestId: randomUUID(), title: '合成验收', scene: { ...blankBoard().scene, elements: [original] } });
  const bridge = new EditorBridge(store); t.after(() => bridge.close());
  const input = { baseRevision: 1, requestId: randomUUID(), items: [{ id: 'note', type: 'text', x: 20, y: 160, text: '新增内容' }] };
  return { dir, store, bridge, input };
}
test('AI append preserves existing elements, acknowledges page and persists retry receipt', async t => {
  const { dir, store, bridge, input } = await setup(t);
  const pending = bridge.invoke('patch', input); const job = bridge.poll('editor');
  assert.equal(bridge.poll('second-editor'), null);
  await assert.rejects(bridge.commit('other', job.id, { elements: [original, added] }), { code: 'JOB_EXPIRED' });
  const committed = await bridge.commit('editor', job.id, { elements: [original, added] });
  assert.equal(committed.board.revision, 2); assert.deepEqual(store.read().scene.elements[0], original);
  bridge.result('editor', job.id, { revision: 2 }); assert.equal((await pending).applied, true);
  const reloaded = new BoardStore(dir); await reloaded.load(); const freshBridge = new EditorBridge(reloaded); t.after(() => freshBridge.close());
  assert.equal((await freshBridge.invoke('patch', input)).duplicate, true);
  assert.equal(reloaded.read().revision, 2);
  assert.throws(() => freshBridge.invoke('patch', { ...input, items: [{ ...input.items[0], text: '其他内容' }] }), { code: 'REQUEST_REUSED' });
});
test('AI cannot modify pre-existing content or bind new elements to existing nodes', async t => {
  const { store, bridge, input } = await setup(t); const before = store.read();
  const pending = bridge.invoke('patch', input); const job = bridge.poll('editor');
  await assert.rejects(bridge.commit('editor', job.id, { elements: [{ ...original, text: '非法改动' }, added] }), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(bridge.commit('editor', job.id, { elements: [original, { ...added, containerId: 'manual' }] }), { code: 'OUT_OF_SCOPE' });
  assert.deepEqual(store.read(), before); bridge.result('editor', job.id, { error: { code: 'OUT_OF_SCOPE' } }); await pending;
});
test('draft saved after AI read forces a version conflict', async t => {
  const { store, bridge, input } = await setup(t); const pending = bridge.invoke('patch', input);
  await store.save({ baseRevision: 1, requestId: randomUUID(), title: '用户新标题', scene: store.read().scene });
  const job = bridge.poll('editor');
  await assert.rejects(bridge.commit('editor', job.id, { elements: [original, added] }), { code: 'REVISION_CONFLICT' });
  bridge.result('editor', job.id, { error: { code: 'REVISION_CONFLICT' } }); await pending;
  assert.equal(store.read().title, '用户新标题'); assert.equal(store.read().revision, 2);
});
test('disk failure never commits candidate or transaction receipt', async t => {
  let fail = false; const { store, bridge, input } = await setup(t, { beforeWrite: async () => { if (fail) throw new Error('ENOSPC'); } });
  fail = true; const pending = bridge.invoke('patch', input); const job = bridge.poll('editor');
  await assert.rejects(bridge.commit('editor', job.id, { elements: [original, added] }), { code: 'SAVE_FAILED' });
  assert.equal(store.read().revision, 1); assert.equal(store.aiTransactions.size, 0);
  assert.equal((await pending).error.code, 'SAVE_FAILED');
  assert.equal(bridge.status().busy, false);
});

test('slow failed disk commit releases the job even after timeout without browser acknowledgement', async t => {
  let fail = false;
  const { store, input } = await setup(t, { beforeWrite: async () => {
    if (fail) { await new Promise(resolve => setTimeout(resolve, 50)); throw new Error('ENOSPC'); }
  } });
  const bridge = new EditorBridge(store, { timeout: 10 }); t.after(() => bridge.close());
  fail = true;
  const pending = bridge.invoke('patch', input); const job = bridge.poll('editor');
  await assert.rejects(bridge.commit('editor', job.id, { elements: [original, added] }), { code: 'SAVE_FAILED' });
  assert.equal(bridge.status().busy, false);
  assert.equal((await pending).error.code, 'SAVE_FAILED');
  assert.equal(store.read().revision, 1);
});
test('timeout cannot later commit a stale candidate; lost acknowledgement remains queryable', async t => {
  const { store, input } = await setup(t); const bridge = new EditorBridge(store, { timeout: 20 }); t.after(() => bridge.close());
  const pending = bridge.invoke('patch', input); const job = bridge.poll('editor');
  assert.equal((await pending).error.code, 'EDITOR_TIMEOUT');
  await assert.rejects(bridge.commit('editor', job.id, { elements: [original, added] }), { code: 'JOB_EXPIRED' });
  const second = bridge.invoke('patch', input); const job2 = bridge.poll('editor');
  await bridge.commit('editor', job2.id, { elements: [original, added] });
  assert.equal((await second).applied, false);
  assert.equal(bridge.status(input.requestId).transaction.revision, 2);
});
test('selection read includes bound label and rejects empty selection; render requires exact revision', async t => {
  const { store, bridge } = await setup(t);
  const board = store.read(); board.scene.elements.push({ ...added, id: 'label', containerId: 'manual' }); board.scene.elements[0].boundElements = [{ id: 'label', type: 'text' }];
  const result = describeBoard(board, ['manual'], { scope: 'selection', limit: 10 });
  assert.deepEqual(result.elements.map(element => element.id), ['manual', 'label']);
  assert.throws(() => describeBoard(board, [], { scope: 'selection', limit: 10 }), { code: 'EMPTY_SELECTION' });
  const pending = bridge.invoke('render', { revision: 0 }); const job = bridge.poll('editor');
  assert.throws(() => bridge.result('editor', job.id, { revision: 1, png: '' }), { code: 'REVISION_CONFLICT' });
  bridge.result('editor', job.id, { error: { code: 'REVISION_CONFLICT' } }); await pending;
});
test('schema rejects mixed layouts, ambiguous IDs and arrows outside the batch', () => {
  const input = { baseRevision: 0, requestId: randomUUID(), flow: { title: '例子', steps: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] } };
  assert.equal(patchSchema.safeParse(input).success, true);
  assert.equal(patchSchema.safeParse({ ...input, items: [{ id: 'x', type: 'arrow', from: 'a', to: 'b' }] }).success, false);
  assert.equal(patchSchema.safeParse({ ...input, flow: undefined, items: [{ id: 'x', type: 'arrow', from: 'existing', to: 'missing' }] }).success, false);
});
test('HTTP bridge requires local credential, rejects browser origin and protects the commit window', async t => {
  const { dir, store, bridge } = await setup(t); const token = 'synthetic-test-token';
  const server = createBoardServer({ store, bridge, bridgeToken: token, root: dir, assets: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { bridge.close(); server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, bearer = token, origin) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  assert.equal((await post('/api/agent/read', {}, 'wrong')).status, 403);
  assert.equal((await post('/api/agent/read', {}, token, base)).status, 403);
  assert.equal((await post('/api/agent/read', {})).code, 'EDITOR_OFFLINE');
  const session = await post('/api/session', { clientId: 'qa' });
  const pending = bridge.invoke('read', {}); const poll = await post('/api/jobs/poll', {}, session.token);
  assert.equal((await post('/api/board', { baseRevision: 1, requestId: randomUUID(), title: '测试', scene: store.read().scene }, session.token)).code, 'EDITOR_BUSY');
  assert.equal((await post('/api/jobs/result', { id: poll.job.id, revision: 1, selectedIds: [] }, session.token)).status, 200);
  assert.equal((await pending).revision, 1);
});
