import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {saveBackup} from '../server/backup.mjs';
import {BoardStore,blankBoard} from '../server/store.mjs';
import {createBoardServer} from '../server/http.mjs';
import {parseBackup} from '../shared/backup-import.mjs';
const parent=resolve('../中间过程/AI讲解白板/stage6-tests');await mkdir(parent,{recursive:true});
const dir=()=>mkdtemp(join(parent,'run-'));
const fixture=()=>({format:'excalidraw',title:'中文备份',revision:7,draft:true,scene:{...blankBoard().scene,elements:[{id:'text',type:'text',x:1,y:2,width:100,height:30,text:'可编辑 α',fontFamily:5}],files:{}}});
test('import validates format, unique IDs and embedded images and extracts optional title',()=>{
 const x={type:'excalidraw',version:2,...fixture().scene,whiteboard:{title:'恢复标题'}};
 assert.equal(parseBackup(JSON.stringify(x)).title,'恢复标题');
 assert.equal(parseBackup(JSON.stringify({...x,whiteboard:undefined})).title,null);
 assert.throws(()=>parseBackup('{broken'));
 assert.throws(()=>parseBackup(JSON.stringify({...x,type:'unknown'})));
 assert.throws(()=>parseBackup(JSON.stringify({...x,elements:[...x.elements,...x.elements]})));
 assert.throws(()=>parseBackup(JSON.stringify({...x,files:{x:{id:'x',dataURL:'https://example.com/x.png',mimeType:'image/png',created:0}}})));
});
test('backup roundtrip keeps draft, title, bindings and images; filenames never reuse title or overwrite',async()=>{
 const folder=await dir(),input=fixture();input.title='../同名标题';
 input.scene.elements.push({id:'a',type:'arrow',x:20,y:30,width:60,height:0,startBinding:{elementId:'text',focus:0,gap:5},points:[[0,0],[60,0]]});
 input.scene.files.img={id:'img',dataURL:'data:image/png;base64,aGVsbG8=',mimeType:'image/png',created:1};
 const a=await saveBackup(folder,input),b=await saveBackup(folder,input);assert.notEqual(a.path,b.path);
 assert.equal(resolve(a.path,'..'),folder);const bytes=await readFile(a.path),file=JSON.parse(bytes);
 assert.equal(file.type,'excalidraw');assert.deepEqual(file.elements,input.scene.elements);assert.deepEqual(file.files,input.scene.files);
 assert.equal(file.whiteboard.title,input.title);assert.equal(file.whiteboard.draft,true);assert.equal(file.whiteboard.revision,7);
 assert.equal(a.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal((await readdir(folder)).length,2);
});
test('invalid paths, duplicate IDs and non-PNG data do not create backups',async()=>{
 const folder=await dir();await assert.rejects(saveBackup(folder,{...fixture(),path:'../other'}));
 const f=fixture();f.scene.elements.push({...f.scene.elements[0]});await assert.rejects(saveBackup(folder,f),{code:'INVALID_SCENE'});
 await assert.rejects(saveBackup(folder,{format:'png',png:Buffer.from('not PNG').toString('base64')}),{code:'INVALID_PNG'});
 assert.deepEqual(await readdir(folder),[]);
});
test('PNG backup preserves the complete binary bytes',async()=>{
 const folder=await dir();
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1kAAAAASUVORK5CYII=';
 const result=await saveBackup(folder,{format:'png',png});
 assert.deepEqual(await readFile(result.path),Buffer.from(png,'base64'));
 assert.ok(result.path.endsWith('.png'));
});
test('backup HTTP route requires session and same origin and leaves board revisions untouched',async t=>{
 const folder=await dir(),store=new BoardStore(resolve(folder,'revisions'));await store.load();
 const server=createBoardServer({store,root:folder,assets:folder});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>{server.closeAllConnections();server.close()});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,data,token,origin)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...(origin?{Origin:origin}:{})},body:JSON.stringify(data)});
 assert.equal((await post('/api/backup',fixture())).status,401);
 const {token}=await (await post('/api/session',{clientId:'qa-backup'})).json();
 assert.equal((await post('/api/backup',fixture(),token,'https://example.com')).status,403);
 const r=await post('/api/backup',fixture(),token,base);assert.equal(r.status,200);assert.ok((await r.json()).path.endsWith('.excalidraw'));
 assert.equal(store.read().revision,0);assert.deepEqual(await readdir(store.directory),[]);
});
