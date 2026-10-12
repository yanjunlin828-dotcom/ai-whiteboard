export function parseBackup(text){
 if(typeof text!=='string'||new TextEncoder().encode(text).length>16*1024*1024)throw new Error('备份超过 16 MB。');
 let data;try{data=JSON.parse(text);}catch{throw new Error('文件不是有效的白板备份。');}
 if(data?.type!=='excalidraw'||data.version!==2||!Array.isArray(data.elements)||data.elements.length>2000)throw new Error('请选择标准 .excalidraw 备份。');
 const ids=new Set();
 for(const e of data.elements){
  if(!e||typeof e.id!=='string'||!e.id||ids.has(e.id)||!['rectangle','diamond','ellipse','text','line','arrow','freedraw','image','frame','magicframe','embeddable','iframe'].includes(e.type)||![e.x,e.y,e.width,e.height].every(Number.isFinite)||e.width<0||e.height<0)throw new Error('备份中的图元无效或标识重复。');
  ids.add(e.id);
 }
 if(data.files!==undefined&&(!data.files||typeof data.files!=='object'||Array.isArray(data.files)))throw new Error('备份图片数据无效。');
 for(const f of Object.values(data.files??{}))if(!f||typeof f.id!=='string'||typeof f.dataURL!=='string'||!f.dataURL.startsWith('data:image/')||typeof f.mimeType!=='string'||!Number.isFinite(f.created))throw new Error('备份含无效图片或外部图片地址。');
 const title=typeof data.whiteboard?.title==='string'?data.whiteboard.title.trim().slice(0,80):null;
 return {title:title||null};
}
