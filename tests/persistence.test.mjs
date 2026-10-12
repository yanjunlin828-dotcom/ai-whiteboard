import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoardStore, blankBoard } from '../server/store.mjs';
import { createBoardServer } from '../server/http.mjs';

const artifacts = resolve('../中间过程/AI讲解白板/tests');
await mkdir(artifacts, { recursive: true });
const directory = () => mkdtemp(join(artifacts, 'run-'));
const input = (revision = 0, title = '中文手写验收') => ({ baseRevision: revision, requestId: randomUUID(), title,
  scene: { ...blankBoard().scene, elements: [{ id: 'one', type: 'text', x: 20, y: 30, width: 120, height: 30, text: '清晰表达 AI', fontFamily: 5 }] } });

test('restart preserves content, bound endpoints and idempotent retry', async () => {
  const dir = await directory(); const store = new BoardStore(dir); await store.load();
  const request = input();
  request.scene.elements.push({ id: 'arrow', type: 'arrow', x: 150, y: 45, width: 80, height: 0, startBinding: { elementId: 'one', focus: 0, gap: 5 } });
  await store.save(request);
  const restarted = new BoardStore(dir); await restarted.load();
  assert.deepEqual(restarted.read(), store.read());
  assert.equal((await restarted.save(request)).duplicate, true);
  assert.equal(restarted.read().revision, 1);
  await assert.rejects(restarted.save({ ...request, title: '不同请求' }), { code: 'REQUEST_REUSED' });
  assert.equal((await readdir(dir)).length, 1);
});

test('concurrent stale revisions cannot overwrite the winning save', async () => {
  const store = new BoardStore(await directory()); await store.load();
  const results = await Promise.allSettled([store.save(input(0, '第一份')), store.save(input(0, '第二份'))]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'REVISION_CONFLICT');
  assert.equal(store.read().title, '第一份'); assert.equal(store.read().revision, 1);
});

test('simulated disk failure preserves prior bytes and memory; retry succeeds', async () => {
  const dir = await directory(); let fail = false;
  const store = new BoardStore(dir, { beforeWrite: async () => { if (fail) throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' }); } });
  await store.load(); await store.save(input());
  const file = join(dir, (await readdir(dir))[0]); const original = await readFile(file); const previous = store.read();
  const next = input(1, '后续内容'); fail = true;
  await assert.rejects(store.save(next), { code: 'ENOSPC' });
  assert.deepEqual(store.read(), previous); assert.deepEqual(await readFile(file), original);
  const restarted = new BoardStore(dir); await restarted.load(); assert.deepEqual(restarted.read(), previous);
  fail = false; assert.equal((await store.save(next)).board.revision, 2);
});

test('incomplete and corrupt new snapshots preserve last complete version', async () => {
  const dir = await directory(); const store = new BoardStore(dir); await store.load(); await store.save(input());
  await writeFile(join(dir, `rev-0000000002-${randomUUID()}.json`), '{broken', { flag: 'wx' });
  await writeFile(join(dir, `rev-0000000003-${randomUUID()}.json.pending`), '{partial', { flag: 'wx' });
  const recovered = new BoardStore(dir); await recovered.load();
  assert.equal(recovered.read().revision, 1); assert.equal(recovered.recoveryWarnings.length, 1);
  assert.equal((await readdir(dir)).length, 3);
  const badDir = await directory(); await writeFile(join(badDir, `rev-0000000001-${randomUUID()}.json`), '{}', { flag: 'wx' });
  await assert.rejects(new BoardStore(badDir).load(), { code: 'RECOVERY_REQUIRED' });
});

test('invalid scene and duplicate IDs do not produce a revision', async () => {
  const dir = await directory(); const store = new BoardStore(dir); await store.load();
  const duplicate = input(); duplicate.scene.elements.push({ ...duplicate.scene.elements[0] });
  await assert.rejects(store.save(duplicate), { code: 'INVALID_SCENE' });
  const invalid = input(); invalid.scene.elements[0].x = Infinity;
  await assert.rejects(store.save(invalid));
  assert.equal(store.read().revision, 0); assert.equal((await readdir(dir)).length, 0);
});

test('HTTP enforces origin, session and single-writer lease; disk errors are visible', async t => {
  const dir = await directory(); let now = 1_000_000; let fail = false;
  const store = new BoardStore(dir, { beforeWrite: async () => { if (fail) throw new Error('simulated disk failure'); } }); await store.load();
  const server = createBoardServer({ store, root: dir, assets: dir, clock: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, token, headers = {}) => {
    const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  assert.equal((await call('session', { clientId: 'bad' }, null, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await call('board')).status, 401);
  const first = await call('session', { clientId: 'first' });
  const second = await call('session', { clientId: 'second' });
  assert.equal(first.writable, true); assert.equal(second.writable, false);
  const reconnect = await call('session', { clientId: 'first' }, first.token);
  assert.equal(reconnect.token, first.token); assert.equal(reconnect.writable, true);
  assert.equal((await call('board', input(), second.token)).code, 'READ_ONLY');
  assert.equal((await call('board', input(), first.token)).board.revision, 1);
  fail = true; assert.equal((await call('board', input(1), first.token)).code, 'SAVE_FAILED');
  assert.equal(store.read().revision, 1); fail = false;
  now += 31_000;
  assert.equal((await call('heartbeat', {}, first.token)).writable, false);
  assert.equal((await call('claim', {}, second.token)).writable, true);
  assert.equal((await call('board', input(1), first.token)).code, 'READ_ONLY');
  assert.equal((await call('board', input(1), second.token)).board.revision, 2);
  const status = await call('status', undefined, null, { 'X-Whiteboard-Client': 'mcp' });
  assert.deepEqual(status.capabilities, ['board_status']); assert.ok(status.lastMcpCheck);
});
