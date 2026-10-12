import test from 'node:test';
import assert from 'node:assert/strict';
import { teachingRegions, teachingKey } from '../shared/teaching.mjs';

const p = 'ai-12345678-1234-1234-1234-123456789abc-teach-1-';
const title = { id: p + 'title', type: 'text', text: '01 输入', x: 100, y: 500 };
const node = { id: p + 'input', type: 'rectangle', x: 100, y: 700 };
const label = { id: 'native-label', type: 'text', containerId: node.id, text: '输入' };
test('region includes native labels but excludes unrelated ink; persisted scene roundtrip retains membership', () => {
  const elements = [title, node, label, { id: 'manual', type: 'freedraw' }];
  const regions = teachingRegions(JSON.parse(JSON.stringify(elements)));
  assert.deepEqual(regions[0].elementIds, [title.id, node.id, label.id]);
  assert.equal(regions[0].title, '01 输入');
});
test('deleted title removes navigation; restoring it and moving shapes retains membership', () => {
  assert.deepEqual(teachingRegions([{ ...title, isDeleted: true }, node, label]), []);
  assert.deepEqual(teachingRegions([title, { ...node, y: 1500 }, label])[0].elementIds, [title.id, node.id, label.id]);
});
test('regions follow actual top-to-bottom order and exclude unrelated text', () => {
  const second = { ...title, id: title.id.replace('teach-1-', 'teach-2-'), y: 100, text: '02 计算' };
  assert.deepEqual(teachingRegions([title, second, { ...title, id: 'title' }]).map(r => r.id), [second.id, title.id]);
});
test('shortcuts never capture text, composition, modifier keys or editor interactions', () => {
  for (const flag of ['isComposing', 'repeat', 'defaultPrevented', 'ctrlKey', 'metaKey', 'altKey', 'shiftKey']) assert.equal(teachingKey({ key: 'Home', [flag]: true }), null);
  assert.equal(teachingKey({ key: 'Home', target: { closest: () => ({}) } }), null);
  assert.equal(teachingKey({ key: 'PageDown' }, true), null);
  assert.equal(teachingKey({ key: 'PageDown' }), 'next');
  assert.equal(teachingKey({ key: 'PageUp' }), 'previous');
  assert.equal(teachingKey({ key: 'Home' }), 'overview');
  assert.equal(teachingKey({ key: 'ArrowRight' }), null);
});
test('a newly appended lesson takes navigation focus without removing earlier regions', () => {
  const old = [1, 2, 3].map(n => ({ ...title, id: title.id.replace('teach-1-', `teach-${n}-`), y: n * 100 }));
  const newer = old.map(e => ({ ...e, id: e.id.replace('12345678-', '87654321-'), y: e.y + 1000 }));
  assert.deepEqual(teachingRegions([...old, ...newer]).map(r => r.id), newer.map(e => e.id));
  assert.equal(old.length, 3);
});

test('detail callouts retain main navigation, include bound labels, and do not leak into a later lesson', () => {
  const dp = p.replace('teach-1-', 'detail-2-');
  const detail = { ...title, id: dp + 'title', text: 'B · 共享评分器', y: 50 };
  const box = { ...node, id: dp + 'box' };
  const text = { ...label, id: 'detail-native-label', containerId: box.id };
  const first = { ...detail, id: detail.id.replace('detail-2-', 'detail-1-'), text: 'A · 输入' };
  const scene = [title, node, label, detail, box, text, first];
  const result = teachingRegions(scene);
  assert.deepEqual(result.map(r => r.title), ['01 输入', 'A · 输入', 'B · 共享评分器']);
  assert.deepEqual(result[2].elementIds, [detail.id, box.id, text.id]);
  const next = [1, 2, 3].map(n => ({ ...title, id: title.id.replace('12345678-', '87654321-').replace('teach-1-', `teach-${n}-`) }));
  assert.equal(teachingRegions([...scene, ...next]).length, 3);
  assert.equal(teachingRegions(scene.map(e => e === detail ? { ...e, isDeleted: true } : e)).length, 2);
});
