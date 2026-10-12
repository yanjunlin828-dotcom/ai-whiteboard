import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { applyEdits, resolveEdits } from '../shared/edits.mjs';
import { BoardStore, blankBoard } from '../server/store.mjs';
import { EditorBridge, patchSchema } from '../server/bridge.mjs';

const node = (id, x) => ({ id, type: 'rectangle', x, y: 100, width: 240, height: 100, angle: 0,
  strokeColor: '#123456', version: 4, versionNonce: 123, updated: 100, locked: false, boundElements: [] });
const fixture = () => [
  { ...node('a', 100), boundElements: [{ id: 'label', type: 'text' }, { id: 'edge', type: 'arrow' }] },
  { id: 'label', type: 'text', containerId: 'a', x: 180, y: 137.5, width: 80, height: 25, text: '原文', originalText: '原文', fontSize: 20, fontFamily: 5, lineHeight: 1.25, textAlign: 'center', verticalAlign: 'middle', strokeColor: '#123456', version: 1 },
  { ...node('b', 500), boundElements: [{ id: 'edge', type: 'arrow' }] },
  { id: 'edge', type: 'arrow', x: 352, y: 150, width: 136, height: 30, points: [[0, 0], [60, 30], [136, 0]], startBinding: { elementId: 'a', focus: 0, gap: 12 }, endBinding: { elementId: 'b', focus: 0, gap: 12 }, strokeColor: '#abc123' },
  { id: 'ink', type: 'freedraw', x: 20, y: 15, width: 30, height: 40, points: [[0,0],[10,40],[30,20]], pressures: [0.1,0.6,0.4], simulatePressure: false, strokeColor: '#000000' },
];
const input = edits => ({ baseRevision: 1, requestId: randomUUID(), edits });
const editText = () => ({ op: 'set_text', target: 'a', text: '更新内容' });
const layouts = { label: { text: '更新内容', width: 90, height: 25 } };

test('local text edit preserves manual ink, node style and unrelated IDs byte for byte', () => {
  const elements = fixture(), before = structuredClone(elements);
  const result = applyEdits(elements, input([editText()]), [], layouts);
  assert.deepEqual(elements, before);
  assert.deepEqual(result.affectedIds, ['label']);
  assert.equal(result.elements[1].originalText, '更新内容');
  assert.equal(result.elements[1].fontFamily, 5);
  assert.equal(result.elements[1].x, 175);
  for (const i of [0, 2, 3, 4]) assert.deepEqual(result.elements[i], before[i]);
});

test('move carries label and bound endpoint, retaining the other endpoint and intermediate bend', () => {
  const elements = fixture();
  const result = applyEdits(elements, input([{ op: 'move', target: 'a', dx: 40, dy: 20 }]), []);
  assert.deepEqual(result.affectedIds, ['a', 'label', 'edge']);
  assert.equal(result.elements[1].x, 220); assert.equal(result.elements[1].y, 157.5);
  const edge = result.elements[3];
  assert.deepEqual(edge.points.map(([x,y]) => [edge.x+x, edge.y+y]), [[392,170],[412,180],[488,150]]);
  assert.equal(edge.strokeColor, elements[3].strokeColor);
  // The new focus must describe the changed line, or native redo shifts it.
  assert.equal(edge.startBinding.focus, -0.6);
  assert.deepEqual(result.elements[4], elements[4]);
});

test('longer text grows only its container and adjusts the attached endpoint', () => {
  const result = applyEdits(fixture(), input([{ ...editText(), text: '甲乙丙丁' }]), [], { label: { text: '甲\n乙\n丙\n丁', width: 20, height: 100 } });
  assert.equal(result.elements[0].height, 110);
  assert.equal(result.elements[1].y, 105);
  assert.equal(result.elements[3].y, 155);
  assert.deepEqual(result.affectedIds, ['a','label','edge']);
});

test('selection is explicit, stable and resolves a container plus label as one target', () => {
  const elements = fixture(); const req = input([{ ...editText(), target: '$selection' }]);
  assert.throws(() => resolveEdits(elements, req, ['a']), { code: 'SELECTION_REQUIRED' });
  assert.throws(() => resolveEdits(elements, { ...req, selectionIds: [] }, []), { code: 'EMPTY_SELECTION' });
  assert.throws(() => resolveEdits(elements, { ...req, selectionIds: ['a'] }, ['b']), { code: 'SELECTION_CHANGED' });
  assert.throws(() => resolveEdits(elements, { ...req, selectionIds: ['a','b'] }, ['a','b']), { code: 'AMBIGUOUS_SELECTION' });
  assert.equal(resolveEdits(elements, { ...req, selectionIds: ['label','a'] }, ['a','label'])[0].target, 'label');
  const multi = { ...input([{ op: 'move', target: '$selection', dx: 10, dy: 0 }]), selectionIds: ['a','label','b'] };
  assert.equal(applyEdits(elements, multi, multi.selectionIds).elements[0].x, 110);
});

test('growing a node preserves the gap of a vertical bound arrow', () => {
  const elements = fixture();
  Object.assign(elements[3], { x: 220, y: 212, width: 0, height: 100, points: [[0,0],[0,100]], endBinding: null });
  const result = applyEdits(elements, input([{ ...editText(), text: '甲乙丙丁' }]), [], { label: { text: '甲\n乙\n丙\n丁', width: 20, height: 100 } });
  assert.equal(result.elements[3].y - result.elements[0].y - result.elements[0].height, 12);
});

test('locked target, label or bound arrow rejects the whole batch without changing input', () => {
  for (const index of [0,1,3]) {
    const elements = fixture(); elements[index].locked = true; const before = structuredClone(elements);
    assert.throws(() => applyEdits(elements, input([{ op: 'move', target: 'a', dx: 20, dy: 0 }]), []), { code: 'LOCKED' });
    assert.deepEqual(elements, before);
  }
});

test('new connection changes only endpoint binding lists and reports exact affected IDs', () => {
  const elements = fixture(), request = input([{ op: 'connect', id: 'second', from: 'a', to: 'b' }]);
  const id = `ai-${request.requestId}-second`;
  const template = { id, type: 'arrow', x: 0, y: 0, width: 10, height: 0, points: [[0,0],[10,0]], endArrowhead: 'arrow' };
  const result = applyEdits(elements, request, [], {}, [template]);
  assert.deepEqual(result.createdIds, [id]); assert.deepEqual(result.affectedIds, ['a','b']);
  assert.deepEqual(result.elements[3], elements[3]); assert.deepEqual(result.elements[4], elements[4]);
  assert.equal(result.elements[5].startBinding.elementId, 'a');
  assert.equal(result.elements[5].endBinding.elementId, 'b');
  assert.equal(result.elements[0].boundElements.length, 3);
});

test('unsupported targets, malformed layouts, duplicate operations and no-op fail clearly', () => {
  const elements = fixture();
  assert.throws(() => applyEdits(elements, input([{ op: 'move', target: 'missing', dx: 1, dy: 0 }]), []), { code: 'TARGET_MISSING' });
  assert.throws(() => applyEdits(elements, input([{ op: 'move', target: 'ink', dx: 1, dy: 0 }]), []), { code: 'UNSUPPORTED_TARGET' });
  assert.throws(() => applyEdits(elements, input([editText(), editText()]), [], layouts), { code: 'DUPLICATE_OPERATION' });
  assert.throws(() => applyEdits(elements, input([editText()]), [], { label: { text: '偷换内容', width: 20, height: 25 } }), { code: 'INVALID_LAYOUT' });
  assert.throws(() => applyEdits(elements, input([{ ...editText(), text: '甲\n乙' }]), [], { label: { text: '甲乙', width: 40, height: 25 } }), { code: 'INVALID_LAYOUT' });
  assert.throws(() => applyEdits(elements, input([{ op: 'move', target: 'a', dx: 0, dy: 0 }]), []), { code: 'NO_CHANGE' });
  elements[0].angle = 1;
  assert.throws(() => applyEdits(elements, input([editText()]), [], layouts), { code: 'UNSUPPORTED_TARGET' });
  elements[0].angle = 0; elements[2].angle = 1;
  assert.throws(() => applyEdits(elements, input([{ op: 'move', target: 'a', dx: 1, dy: 0 }]), []), { code: 'UNSUPPORTED_BINDING' });
});

async function setup(t) {
  const root = resolve('../中间过程/AI讲解白板/tests'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'edits-')); const store = new BoardStore(dir); await store.load();
  await store.save({ baseRevision: 0, requestId: randomUUID(), title: '阶段4合成测试', scene: { ...blankBoard().scene, elements: fixture() } });
  const bridge = new EditorBridge(store, { allowEdits: true }); t.after(() => bridge.close());
  return { dir, store, bridge };
}

test('server independently rejects forged style, ink, ordering and extra changes', async t => {
  const { store, bridge } = await setup(t); const req = input([editText()]);
  const pending = bridge.invoke('patch', req), job = bridge.poll('editor');
  const expected = applyEdits(store.read().scene.elements, req, [], layouts);
  for (const tamper of [e => { e[0].strokeColor = '#ffffff'; }, e => { e[4].points[0][0] = 99; }, e => e.reverse(), e => e.pop()]) {
    const elements = structuredClone(expected.elements); tamper(elements);
    await assert.rejects(bridge.commit('editor', job.id, { elements, layouts, affectedIds: ['label'] }), { code: 'OUT_OF_SCOPE' });
    assert.equal(store.read().revision, 1);
  }
  bridge.result('editor', job.id, { error: { code: 'OUT_OF_SCOPE' } }); await pending;
});

test('edit commits once, preserves scope receipt over restart and rejects reused request IDs', async t => {
  const { dir, store, bridge } = await setup(t); const req = input([editText(), { op: 'move', target: 'a', dx: 30, dy: 0 }]);
  const pending = bridge.invoke('patch', req), job = bridge.poll('editor');
  const candidate = applyEdits(store.read().scene.elements, req, [], layouts);
  await bridge.commit('editor', job.id, { ...candidate, layouts });
  bridge.result('editor', job.id, { revision: 2 }); const receipt = await pending;
  assert.equal(receipt.applied, true); assert.deepEqual(receipt.affectedIds, ['a','label','edge']);
  const reload = new BoardStore(dir); await reload.load(); const again = new EditorBridge(reload); t.after(() => again.close());
  assert.equal((await again.invoke('patch', req)).duplicate, true);
  assert.equal(reload.read().revision, 2);
  assert.deepEqual(again.status(req.requestId).transaction.affectedIds, receipt.affectedIds);
  assert.throws(() => again.invoke('patch', { ...req, edits: [editText()] }), { code: 'REQUEST_REUSED' });
});

test('stale local edit cannot overwrite a newer manual save', async t => {
  const { store, bridge } = await setup(t); const req = input([editText()]);
  const pending = bridge.invoke('patch', req), job = bridge.poll('editor');
  const candidate = applyEdits(store.read().scene.elements, req, [], layouts);
  await store.save({ baseRevision: 1, requestId: randomUUID(), title: '人工修改', scene: store.read().scene });
  await assert.rejects(bridge.commit('editor', job.id, { ...candidate, layouts }), { code: 'REVISION_CONFLICT' });
  assert.equal(store.read().title, '人工修改');
  bridge.result('editor', job.id, { error: { code: 'REVISION_CONFLICT' } }); await pending;
});

test('schema accepts edits and rejects mixed modes, duplicate selection and invalid coordinates', () => {
  assert.ok(patchSchema.safeParse(input([editText()])).success);
  assert.equal(patchSchema.safeParse({ ...input([editText()]), items: [{ id: 'a', type: 'text', text: 'x', x: 0, y: 0 }] }).success, false);
  assert.equal(patchSchema.safeParse({ ...input([editText()]), selectionIds: ['a','a'] }).success, false);
  assert.equal(patchSchema.safeParse(input([{ op: 'move', target: 'a', dx: Infinity, dy: 0 }])).success, false);
});

test('formal service keeps unverified local edits disabled', async t => {
  const { store } = await setup(t); const bridge = new EditorBridge(store); t.after(() => bridge.close());
  assert.throws(() => bridge.invoke('patch', input([editText()])), { code: 'EDIT_NOT_READY' });
  assert.equal(store.read().revision, 1); assert.equal(bridge.status().busy, false);
});
