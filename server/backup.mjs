import {mkdir,open,readFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {BoardError,sceneSchema} from './store.mjs';

const schema=z.discriminatedUnion('format',[
 z.object({format:z.literal('excalidraw'),title:z.string().trim().min(1).max(80),revision:z.number().int().nonnegative(),draft:z.boolean(),scene:sceneSchema}).strict(),
 z.object({format:z.literal('png'),png:z.string().min(1).max(16_000_000)}).strict(),
]);
export async function saveBackup(directory,input,boardId='main'){
 const data=schema.parse(input);
 let bytes;
 if(data.format==='excalidraw'){
  const ids=data.scene.elements.map(e=>e.id);
  if(new Set(ids).size!==ids.length)throw new BoardError('INVALID_SCENE','图形标识重复，备份未保存。');
  bytes=Buffer.from(JSON.stringify({type:'excalidraw',version:2,source:'ai-whiteboard',...data.scene,
   whiteboard:{schemaVersion:1,boardId,title:data.title,revision:data.revision,draft:data.draft,exportedAt:new Date().toISOString()}},null,2));
 }else{
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(data.png))throw new BoardError('INVALID_PNG','图片数据无效。');
  bytes=Buffer.from(data.png,'base64');
  if(bytes.length<45||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND'||!bytes.readUInt32BE(16)||!bytes.readUInt32BE(20)||bytes.readUInt32BE(16)>1600||bytes.readUInt32BE(20)>1600)throw new BoardError('INVALID_PNG','图片格式或尺寸无效。');
 }
 await mkdir(directory,{recursive:true});
 const name=`白板-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.${data.format}`;
 const path=resolve(directory,name),temporary=path+'.pending';
 const file=await open(temporary,'wx');
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
 const check=await readFile(temporary);
 if(!bytes.equals(check))throw new BoardError('BACKUP_FAILED','备份校验失败，未报告成功。',503);
 await rename(temporary,path);
 return {path,name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
