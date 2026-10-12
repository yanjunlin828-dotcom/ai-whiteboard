// Stable IDs survive saves, undo and export; native labels follow containerId.
import {regionDefinitions,regionMembers} from './diagram.mjs';
export function teachingRegions(elements) {
  const live = elements.filter(element => !element.isDeleted);
  const definitions=regionDefinitions(live);
  if(definitions.length){
    const lessonId=definitions.at(-1).lessonId;
    return definitions.filter(r=>r.lessonId===lessonId).sort((a,b)=>(a.kind==='main'?0:1)-(b.kind==='main'?0:1)||a.order-b.order||a.id.localeCompare(b.id))
      .map(r=>({id:r.elementId,regionId:r.id,kind:r.kind,parentId:r.parentId,title:r.title,elementIds:regionMembers(live,r.id,false).map(e=>e.id)}));
  }
  const main = live.filter(element => element.type === 'text' && !element.containerId &&
    /^ai-[0-9a-f-]{36}-teach-[123]-title$/.test(element.id))
    .slice(-3);
  if (!main.length) return [];
  const lessonStart = Math.min(...main.map(element => live.indexOf(element)));
  const details = new Map();
  for (const element of live.slice(lessonStart)) {
    const match = /^ai-[0-9a-f-]{36}-detail-([1-6])-title$/.exec(element.id);
    if (match && element.type === 'text' && !element.containerId) details.set(Number(match[1]), element);
  }
  const titles = [...main.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id)),
    ...[...details.entries()].sort((a, b) => a[0] - b[0]).map(([, title]) => title)];
  return titles.map(title => {
      const prefix = title.id.slice(0, -5);
      const members = new Set(live.filter(element => element.id.startsWith(prefix)).map(element => element.id));
      for (const element of live) if (members.has(element.containerId)) members.add(element.id);
      return { id: title.id, title: (title.originalText || title.text || '').replace(/\s+/g, ' ').slice(0, 100),
        elementIds: live.filter(element => members.has(element.id)).map(element => element.id) };
    });
}

export function teachingKey(event, editing = false) {
  const target = event.target;
  if (editing || event.defaultPrevented || event.isComposing || event.repeat ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="dialog"], .help-panel')) return null;
  return ({ PageDown: 'next', PageUp: 'previous', Home: 'overview' })[event.key] ?? null;
}
