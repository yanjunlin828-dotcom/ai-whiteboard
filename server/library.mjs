import {readdir,lstat,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {BoardStore,BoardError,boardIdSchema,sceneSchema,blankBoard} from './store.mjs';
import {EditorBridge} from './bridge.mjs';

const titleSchema=z.string().trim().min(1).max(80);
// Directory discovery is the index: no separate catalog can orphan saved boards.
export class BoardLibrary {
  constructor(mainDirectory,options={}) {
    this.mainDirectory=resolve(mainDirectory);this.root=resolve(mainDirectory,'../..');
    this.options=options;this.stores=new Map();this.bridges=new Map();this.warnings=[];
  }
  async load() {
    const main=new BoardStore(this.mainDirectory,this.options);await main.load();this.register(main);
    for(const entry of await readdir(this.root,{withFileTypes:true})){
      if(entry.name==='main'||!boardIdSchema.safeParse(entry.name).success)continue;
      if(!entry.isDirectory()||entry.isSymbolicLink()){this.warnings.push(entry.name);continue;}
      const directory=join(this.root,entry.name,'revisions');
      try{
        if((await lstat(directory)).isSymbolicLink())throw new Error('link');
        const store=new BoardStore(directory,{...this.options,boardId:entry.name});await store.load();
        if(store.board.revision)this.register(store);else this.warnings.push(entry.name);
      }catch{this.warnings.push(entry.name);}
    }
  }
  register(store){this.stores.set(store.boardId,store);this.bridges.set(store.boardId,new EditorBridge(store,{allowEdits:true}));}
  get(id){boardIdSchema.parse(id);const store=this.stores.get(id);if(!store)throw new BoardError('BOARD_NOT_FOUND','白板不存在或需要恢复。',404);return store;}
  bridge(id){this.get(id);return this.bridges.get(id);}
  list(){return [...this.stores.values()].map(({board,recoveryWarnings})=>({boardId:board.boardId,title:board.title,revision:board.revision,savedAt:board.savedAt,archived:Boolean(board.archived),count:board.scene.elements.filter(e=>!e.isDeleted).length,recoveryWarnings:recoveryWarnings.length})).sort((a,b)=>(b.savedAt??'').localeCompare(a.savedAt??'')||a.boardId.localeCompare(b.boardId));}
  async create(raw){
    const input=z.object({title:titleSchema,scene:sceneSchema.optional()}).strict().parse(raw);
    const scene=input.scene??blankBoard().scene;
    if(new Set(scene.elements.map(e=>e.id)).size!==scene.elements.length)throw new BoardError('INVALID_SCENE','图元标识重复。');
    const id=randomUUID(),directory=join(this.root,id,'revisions');
    await mkdir(directory,{recursive:true});
    const store=new BoardStore(directory,{...this.options,boardId:id});
    await store.save({baseRevision:0,requestId:randomUUID(),title:input.title,scene});
    this.register(store);return store.read();
  }
  async change(id,raw){
    const input=z.object({baseRevision:z.number().int().nonnegative(),title:titleSchema.optional(),archived:z.boolean().optional()}).strict().parse(raw);
    const store=this.get(id),board=store.read();
    return store.save({baseRevision:input.baseRevision,requestId:randomUUID(),title:input.title??board.title,scene:board.scene},input.archived===undefined?undefined:{archived:input.archived});
  }
  close(){for(const bridge of this.bridges.values())bridge.close();}
}
