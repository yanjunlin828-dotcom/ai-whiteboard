import {useEffect,useRef,useState} from 'react';
import type {BoardController,BoardEntry} from './controller';
import {renderScene} from './ai-editor';
import './board-library.css';
import {UIIcon} from './ui-icon';

const previews=new Map<string,string>();
function Preview({board,controller}:{board:BoardEntry;controller:BoardController}){
  const ref=useRef<HTMLDivElement>(null),[image,setImage]=useState(''),[failed,setFailed]=useState(false);
  useEffect(()=>{
    let live=true;const key=`${board.boardId}:${board.revision}`;
    const observer=new IntersectionObserver(entries=>{
      if(!entries.some(e=>e.isIntersecting))return;observer.disconnect();
      if(!board.count)return;
      if(previews.has(key)){setImage(previews.get(key)!);return;}
      void controller.previewBoard(board.boardId).then(async({board:full})=>{
        const png=await renderScene(full.scene);if(!live)return;
        const uri=`data:image/png;base64,${png}`;if(previews.size>40)previews.delete(previews.keys().next().value!);
        previews.set(key,uri);setImage(uri);
      }).catch(()=>{if(live){setImage('');setFailed(true);}});
    });
    if(ref.current)observer.observe(ref.current);
    return()=>{live=false;observer.disconnect();};
  },[board.boardId,board.revision,board.count,controller]);
  return <div ref={ref} className="board-preview">{image?<img src={image} alt="" loading="lazy"/>:<span className="preview-placeholder"><UIIcon name="board"/>{board.count?(failed?'预览暂不可用':'预览载入中'):'空白画布'}</span>}<span className="board-open-indicator" aria-hidden="true"><UIIcon name="arrow"/></span></div>;
}

export function BoardLibrary({controller}:{controller:BoardController}){
  const [boards,setBoards]=useState<BoardEntry[]>([]),[query,setQuery]=useState(''),[archived,setArchived]=useState(false);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const [pending,setPending]=useState('');
  const [rename,setRename]=useState<BoardEntry|null>(null),[title,setTitle]=useState('');
  const input=useRef<HTMLInputElement>(null),heading=useRef<HTMLHeadingElement>(null);
  async function refresh(){const data=await controller.listBoards();setBoards(data.boards);if(data.warnings)setMessage('部分白板需要恢复，原文件已保留。');}
  useEffect(()=>{let live=true;controller.listBoards().then(data=>{if(live){setBoards(data.boards);if(data.warnings)setMessage('部分白板需要恢复，原文件已保留。');}}).catch(e=>{if(live)setMessage(e.message);}).finally(()=>{if(live)setLoading(false);});heading.current?.focus();return()=>{live=false;};},[controller]);
  async function run(action:()=>Promise<unknown>,target=''){if(busy)return;setBusy(true);setPending(target);setMessage('');try{await action();await refresh();}catch(e){setMessage(e instanceof Error?e.message:'操作未完成，请重试。');}finally{setBusy(false);setPending('');}}
  const visible=boards.filter(b=>b.archived===archived&&b.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="library-page" aria-label="我的白板">
    <header className="library-header"><h1 ref={heading} tabIndex={-1}><UIIcon name="board"/>我的白板</h1><div className="library-actions"><button className="library-secondary" disabled={busy} onClick={()=>input.current?.click()}><UIIcon name="import"/>导入</button><button className="library-primary" disabled={busy} aria-busy={pending==='new'} onClick={()=>void run(async()=>{const {board}=await controller.createBoard();await controller.leaveEditor(board.boardId);},'new')}>{pending==='new'?<span className="ui-spinner"/>:<UIIcon name="plus"/>}新建白板</button><input ref={input} type="file" hidden accept=".excalidraw,application/json" aria-label="导入新白板文件" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(async()=>{await controller.importBackup(file);setMessage('已导入为新白板');});}}/></div></header>
    <div className="library-content"><div className="library-toolbar"><nav className="library-filters" aria-label="白板分类" data-archived={archived}><button aria-pressed={!archived} onClick={()=>setArchived(false)}>最近白板</button><button aria-pressed={archived} onClick={()=>setArchived(true)}>已归档</button></nav><span className="library-count">{visible.length} 份</span><label className="search-field"><UIIcon name="search"/><span className="sr-only">搜索白板</span><input type="search" placeholder="搜索白板" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
      {message?<div className="library-message" role="status">{message}<button onClick={()=>void run(refresh)} disabled={busy}>刷新</button></div>:null}
      {rename?<form className="rename-form" onSubmit={e=>{e.preventDefault();void run(async()=>{await controller.changeBoard(rename,{title});setRename(null);});}}><label>白板名称<input autoFocus value={title} maxLength={80} onChange={e=>setTitle(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setRename(null);}}/></label><button disabled={busy||!title.trim()} className="library-primary">保存</button><button type="button" className="library-secondary" disabled={busy} onClick={()=>setRename(null)}>取消</button></form>:null}
      {loading?<p className="library-empty" role="status">正在读取白板…</p>:visible.length?<div className="board-grid">{visible.map(board=><article className="board-card" key={board.boardId} aria-label={board.title}>
        <button className="board-open" disabled={busy} aria-busy={pending===board.boardId} onClick={()=>void run(()=>controller.leaveEditor(board.boardId),board.boardId)} aria-label={`打开 ${board.title}`}><Preview board={board} controller={controller}/><h2>{pending===board.boardId?<span className="ui-spinner"/>:null}{board.title}</h2><time dateTime={board.savedAt??undefined}>{board.savedAt?new Date(board.savedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'尚未编辑'}</time><span className="board-short-id">{board.boardId==='main'?'原有文稿':board.boardId.slice(0,8)}</span></button>
        <div className="board-card-actions"><button disabled={busy} onClick={()=>{setRename(board);setTitle(board.title);}}><UIIcon name="rename"/>重命名</button><button disabled={busy} onClick={()=>void run(()=>controller.copyBoard(board))}><UIIcon name="copy"/>复制</button><button disabled={busy} onClick={()=>void run(()=>controller.changeBoard(board,{archived:!board.archived}))}><UIIcon name={board.archived?'restore':'archive'}/>{board.archived?'恢复':'归档'}</button></div>
      </article>)}</div>:<div className="library-empty">{query?'没有匹配的白板，试试其他名称。':archived?'没有已归档白板':'还没有白板，点击右上角新建。'}</div>}
    </div>
  </section>;
}
