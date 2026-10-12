// Shared semantic edit engine: the server independently reconstructs every allowed change.
import {editedNoteFont} from './typography.mjs';
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);
export class EditError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 409; }
}
const fail = (code, message) => { throw new EditError(code, message); };
const sameIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
function preservesText(original, wrapped) {
  let position = 0;
  for (const char of wrapped) {
    if (char === '\n' && original[position] !== '\n') continue;
    if (!original.startsWith(char, position)) return false;
    position += char.length;
  }
  return position === original.length;
}
export function resolveEdits(elements, input, selectedIds = []) {
  const live = new Map(elements.filter(e => !e.isDeleted).map(e => [e.id, e]));
  if (input.selectionIds && !sameIds(input.selectionIds, selectedIds)) fail('SELECTION_CHANGED', '选区已变化，请重新读取选区。');
  const get = id => {
    const e = live.get(id);
    if (!e) fail('TARGET_MISSING', '目标不存在或已删除，请重新读取。');
    if (e.locked) fail('LOCKED', '目标或绑定对象已锁定。');
    if (e.frameId || Math.abs(e.angle ?? 0) > 0.000001) fail('UNSUPPORTED_TARGET', '暂不修改旋转或框架内的对象，请先在白板中调整。');
    return e;
  };
  const targets = target => {
    if (target !== '$selection') return [get(target)];
    if (!input.selectionIds) fail('SELECTION_REQUIRED', '使用选区时须传入刚读取的 selectionIds。');
    if (!selectedIds.length) fail('EMPTY_SELECTION', '请先选中对象。');
    // A selected container and its label describe one logical target.
    return [...new Set(selectedIds.map(id => get(id).containerId ?? id))].map(get);
  };
  const ops = [];
  const unique = new Set();
  for (const operation of input.edits ?? []) {
    if (operation.op === 'connect') {
      const from = get(operation.from), to = get(operation.to);
      if (!SHAPES.has(from.type) || !SHAPES.has(to.type) || from.id === to.id) fail('INVALID_CONNECTION', '连接需要两个不同的基础节点。');
      const id = `ai-${input.requestId}-${operation.id}`;
      if (elements.some(e => e.id === id) || unique.has(id)) fail('DUPLICATE_ID', '连接标识重复。');
      unique.add(id); ops.push({ ...operation, id }); continue;
    }
    let list = targets(operation.target);
    if (operation.op === 'set_text' && list.length !== 1) fail('AMBIGUOUS_SELECTION', '改字时只选择一个文字或带文字节点。');
    for (let target of list) {
      if (operation.op === 'set_text') {
        if (SHAPES.has(target.type)) {
          const labels = [...live.values()].filter(e => e.type === 'text' && e.containerId === target.id);
          if (labels.length !== 1) fail('TEXT_TARGET_REQUIRED', '请选中已有文字或带文字的节点；空节点可先双击输入文字。');
          target = get(labels[0].id);
        }
        if (target.type !== 'text') fail('TEXT_TARGET_REQUIRED', '目标不是文字。');
        if (target.containerId) {
          const parent = get(target.containerId);
          if (!SHAPES.has(parent.type)) fail('UNSUPPORTED_TARGET', '暂不修改箭头上的文字。');
        }
      } else {
        if (target.type === 'text' && target.containerId) target = get(target.containerId);
        if (!SHAPES.has(target.type) && target.type !== 'text') fail('UNSUPPORTED_TARGET', '移动仅支持文字及基础节点。');
      }
      const key = `${operation.op}:${target.id}`;
      if (unique.has(key)) fail('DUPLICATE_OPERATION', '同一批次不能重复操作同一目标。');
      unique.add(key); ops.push({ ...operation, target: target.id });
    }
  }
  return ops;
}

export function textWidthLimit(text, elements) {
  const parent = elements.find(e => e.id === text.containerId && !e.isDeleted);
  if (!parent) return Math.max(240, Math.min(1200, text.width || 240));
  return contentDimension(parent, parent.width);
}
// Match Excalidraw 0.18's bound-text box and focus semantics. A different layout
// would be recalculated by native undo/redo and visibly change the restored scene.
function contentDimension(parent, size) {
  return (parent.type === 'ellipse' ? Math.round(size / 2 * Math.sqrt(2)) : parent.type === 'diamond' ? Math.round(size / 2) : size) - 10;
}
function refreshFocus(arrow, elements) {
  const points = arrow.points.map(([x,y]) => [arrow.x + x, arrow.y + y]);
  for (const [key, edge, adjacent] of [['startBinding', 0, 1], ['endBinding', points.length - 1, points.length - 2]]) {
    const binding = arrow[key], parent = elements.get(binding?.elementId);
    if (!parent) continue;
    const [x,y] = points[edge], [a,b] = points[adjacent], dx = x-a, dy = y-b;
    const rx = parent.width / 2, ry = parent.height / 2;
    const extent = parent.type === 'diamond' ? Math.max(Math.abs(dx)*ry, Math.abs(dy)*rx) : Math.abs(dx)*ry + Math.abs(dy)*rx;
    const cross = dx * (y-parent.y-ry) - dy * (x-parent.x-rx);
    arrow[key] = { ...binding, focus: extent ? -cross / extent : 0 };
  }
}

export function applyEdits(elements, input, selectedIds, layouts = {}, arrowTemplates = []) {
  const ops = resolveEdits(elements, input, selectedIds);
  const result = structuredClone(elements);
  const map = new Map(result.map(e => [e.id, e]));
  const before = new Map(elements.map(e => [e.id, e]));
  const createdIds = [], directIds = new Set();
  for (const op of ops) {
    if (op.op === 'connect') continue;
    const target = map.get(op.target); directIds.add(target.id);
    if (op.op === 'move') { target.x += op.dx; target.y += op.dy; continue; }
    const layout = layouts[target.id];
    if (!layout || typeof layout.text !== 'string' || !preservesText(op.text, layout.text) || layout.text.length > op.text.length + 500 ||
      !Number.isFinite(layout.width) || !Number.isFinite(layout.height) || layout.width <= 0 || layout.width > textWidthLimit(target, elements) + 2 || layout.height <= 0 || layout.height > 1200) fail('INVALID_LAYOUT', '文字测量无效或内容过长。');
    const expectedHeight = layout.text.split('\n').length * target.fontSize * (target.lineHeight ?? 1.25);
    if (Math.abs(layout.height - expectedHeight) > 2) fail('INVALID_LAYOUT', '文字高度与行数不符。');
    Object.assign(target, { text: layout.text, originalText: op.text, width: layout.width, height: layout.height,
      ...(target.fontFamily!==undefined?{fontFamily:editedNoteFont(target.fontFamily,op.text)}:{}) });
    if (target.containerId) {
      const parent = map.get(target.containerId); directIds.add(parent.id);
      if (layout.height > contentDimension(parent, parent.height)) {
        const size = Math.ceil(layout.height) + 10;
        parent.height = parent.type === 'ellipse' ? Math.round(size / Math.sqrt(2) * 2) : parent.type === 'diamond' ? size * 2 : size;
      }
      if (parent.height > 1200) fail('TEXT_TOO_LONG', '文字太长，请缩短或拆成独立说明。');
    }
  }
  // Move/recenter labels with their container; preserve font, style, IDs and alignment.
  for (const label of result.filter(e => !e.isDeleted && e.type === 'text' && e.containerId)) {
    const parent = map.get(label.containerId), oldParent = before.get(label.containerId);
    if (!parent || !oldParent || (!changed(parent, oldParent) && !directIds.has(label.id))) continue;
    if (!SHAPES.has(parent.type)) fail('UNSUPPORTED_BINDING', '绑定文字的类型暂不支持。');
    if (label.locked || parent.locked) fail('LOCKED', '绑定对象已锁定。');
    if (directIds.has(label.id) || parent.height !== oldParent.height || parent.width !== oldParent.width) {
      const offset = size => 5 + (parent.type === 'ellipse' ? size / 2 * (1 - Math.sqrt(2) / 2) : parent.type === 'diamond' ? size / 4 : 0);
      const width = contentDimension(parent, parent.width), height = contentDimension(parent, parent.height);
      label.x = parent.x + offset(parent.width) + (label.textAlign === 'left' ? 0 : label.textAlign === 'right' ? width - label.width : (width - label.width) / 2);
      label.y = parent.y + offset(parent.height) + (label.verticalAlign === 'top' ? 0 : label.verticalAlign === 'bottom' ? height - label.height : (height - label.height) / 2);
    } else { label.x += parent.x - oldParent.x; label.y += parent.y - oldParent.y; }
  }
  // Preserve intermediate bends in world coordinates; only affected endpoints move.
  for (const arrow of result.filter(e => !e.isDeleted && e.type === 'arrow')) {
    const affected = ['startBinding', 'endBinding'].some(key => {
      const id = arrow[key]?.elementId; return id && before.has(id) && changed(map.get(id), before.get(id));
    });
    if (!affected) continue;
    if (arrow.locked) fail('LOCKED', '绑定箭头已锁定。');
    if (arrow.frameId || arrow.elbowed || arrow.angle || arrow.boundElements?.some(e => e.type === 'text')) fail('UNSUPPORTED_BINDING', '暂不自动调整框架内、折肘、旋转或带文字的箭头。');
    for (const binding of [arrow.startBinding, arrow.endBinding]) {
      const parent = map.get(binding?.elementId);
      if (parent && (!SHAPES.has(parent.type) || parent.angle || parent.frameId)) fail('UNSUPPORTED_BINDING', '关联箭头的另一端包含暂不支持的对象。');
    }
    const points = arrow.points.map(([x, y]) => [arrow.x + x, arrow.y + y]);
    for (const [key, index] of [['startBinding', 0], ['endBinding', points.length - 1]]) {
      const id = arrow[key]?.elementId, prev = before.get(id), next = map.get(id);
      if (!prev || !next || !changed(prev, next)) continue;
      const point = points[index];
      point[0] += next.x - prev.x;
      const offsetY = point[1] - prev.y;
      point[1] = next.y + (offsetY < 0 ? offsetY : offsetY > prev.height ? next.height + offsetY - prev.height : offsetY * next.height / (prev.height || 1));
    }
    assignPoints(arrow, points);
    refreshFocus(arrow, map);
  }
  for (const op of ops.filter(op => op.op === 'connect')) {
    const from = map.get(op.from), to = map.get(op.to);
    const template = arrowTemplates.find(e => e.id === op.id);
    if (!template || template.type !== 'arrow' || template.isDeleted || template.locked || template.link || template.customData || template.elbowed || template.angle || template.boundElements?.length) fail('INVALID_CONNECTION', '新连接图元无效。');
    const arrow = structuredClone(template);
    const dx = to.x + to.width / 2 - from.x - from.width / 2;
    const dy = to.y + to.height / 2 - from.y - from.height / 2;
    const horizontal = Math.abs(dx) / (from.width + to.width) >= Math.abs(dy) / (from.height + to.height);
    const sign = Math.sign(horizontal ? dx : dy) || 1;
    const point = (e, side) => [e.x + e.width / 2 + (horizontal ? side * (e.width / 2 + 12) : 0), e.y + e.height / 2 + (horizontal ? 0 : side * (e.height / 2 + 12))];
    assignPoints(arrow, [point(from, sign), point(to, -sign)]);
    Object.assign(arrow, { startBinding: { elementId: from.id, focus: 0, gap: 12 }, endBinding: { elementId: to.id, focus: 0, gap: 12 }, strokeColor: op.color ?? '#35639c' });
    refreshFocus(arrow, map);
    for (const node of [from, to]) node.boundElements = [...(node.boundElements ?? []), { id: arrow.id, type: 'arrow' }];
    result.push(arrow); createdIds.push(arrow.id);
  }
  const affectedIds = [];
  for (const element of result) {
    const old = before.get(element.id);
    if (old && changed(old, element)) {
      if (old.locked) fail('LOCKED', '不能修改锁定对象。');
      if (Math.abs(element.x) > 100000 || Math.abs(element.y) > 100000) fail('OUT_OF_BOUNDS', '坐标超出允许范围。');
      Object.assign(element, { version: (old.version ?? 0) + 1, versionNonce: ((old.versionNonce ?? 0) + 1) % 2147483647, updated: (old.updated ?? 0) + 1 });
      affectedIds.push(element.id);
    }
  }
  if (!affectedIds.length && !createdIds.length) fail('NO_CHANGE', '本次操作没有改变内容。');
  return { elements: result, affectedIds, createdIds };
}
function assignPoints(arrow, points) {
  arrow.x = points[0][0]; arrow.y = points[0][1];
  arrow.points = points.map(([x, y]) => [x - arrow.x, y - arrow.y]);
  arrow.width = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
  arrow.height = Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]));
}
