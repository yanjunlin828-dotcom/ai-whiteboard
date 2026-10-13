// Return options do not change the write transaction. Keep the original property
// order for legacy hashes and receipts; never canonicalize old requests silently.
export function mutationInput(input) {
  const {returnElements,includeRelated,previewId,verification,...operation}=input;
  return operation;
}

export function relatedIds(elements, requested, includeEdges=false) {
  const ids=new Set(requested), byId=new Map(elements.filter(e=>!e.isDeleted).map(e=>[e.id,e]));
  for(const id of requested) {
    const e=byId.get(id); if(!e)continue;
    for(const b of e.boundElements??[]) if(b.type==='text'||includeEdges)ids.add(b.id);
    for(const target of [e.containerId,e.startBinding?.elementId,e.endBinding?.elementId])if(target)ids.add(target);
  }
  if(includeEdges)for(const e of byId.values())if(ids.has(e.startBinding?.elementId)||ids.has(e.endBinding?.elementId)) {
    ids.add(e.id);
    for(const target of [e.startBinding?.elementId,e.endBinding?.elementId])if(target)ids.add(target);
  }
  for(const id of [...ids])for(const b of byId.get(id)?.boundElements??[])if(b.type==='text')ids.add(b.id);
  return ids;
}

export function aliasMaps(input,elements) {
  const live=new Map(elements.filter(e=>!e.isDeleted).map(e=>[e.id,e])),prefix=`ai-${input.requestId}-`,idMap={},labelMap={};
  const aliases=input.items?.map(i=>[i.id,i.id])??input.flow?.steps.map((s,i)=>[s.id,`step-${i}`])??input.edits?.filter(e=>e.op==='connect').map(e=>[e.id,e.id])??[];
  for(const [alias,suffix] of aliases) {
    const e=live.get(prefix+suffix);if(!e)continue;
    idMap[alias]=e.id;
    const labels=(e.boundElements??[]).filter(b=>b.type==='text'&&live.has(b.id)).map(b=>b.id);
    if(labels.length)labelMap[e.id]=labels;
  }
  return {idMap,labelMap};
}
