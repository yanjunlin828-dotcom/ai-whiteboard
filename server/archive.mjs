import {BoardError} from './store.mjs';

// Archive only after every connected editor acknowledges a saved, safe exit.
export class ArchiveRequests {
  constructor(library,sessions,leases,clock){
    this.library=library;this.sessions=sessions;this.leases=leases;this.clock=clock;this.requests=new Map();
  }
  expire(){
    for(const [id,request] of this.requests){
      if(request.status==='waiting'&&this.clock()>request.deadline)this.fail(request,'有编辑窗口未响应，未归档。请刷新该白板的编辑窗口后重试。');
      if(!['waiting','saving'].includes(request.status)&&this.clock()-request.updatedAt>300000)this.requests.delete(id);
    }
  }
  active(boardId){return [...this.requests.values()].find(r=>r.boardId===boardId&&['waiting','saving'].includes(r.status));}
  reserved(boardId){return Boolean(this.active(boardId));}
  editors(boardId){return [...this.sessions.entries()].filter(([token,s])=>s.boardId===boardId&&s.editor&&(this.clock()-s.lastSeen<30000||this.leases.owner(boardId)===token));}
  view(request){return {requestId:request.requestId,boardId:request.boardId,status:request.status,message:request.message??'',waiting:request.participants.filter(p=>!p.ready).length};}
  fail(request,message){request.status='failed';request.message=message;request.updatedAt=this.clock();}
  get(boardId,requestId,token){
    this.expire();const request=this.requests.get(requestId);
    if(!request||request.boardId!==boardId||request.requester!==token)throw new BoardError('ARCHIVE_NOT_FOUND','归档请求不存在，请刷新列表核对。',404);
    return this.view(request);
  }
  async start(input,token){
    const {boardId,baseRevision,requestId}=input;
    if(typeof requestId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId))throw new BoardError('INVALID_REQUEST','归档请求标识无效。');
    const previous=this.requests.get(requestId);
    if(previous){if(previous.requester!==token||previous.boardId!==boardId)throw new BoardError('REQUEST_REUSED','归档请求标识已用于其他操作。',409);return this.view(previous);}
    const store=this.library.get(boardId);
    if(this.reserved(boardId))throw new BoardError('ARCHIVE_BUSY','该白板正在准备归档，请稍后刷新列表。',409);
    if(baseRevision!==store.board.revision)throw new BoardError('REVISION_CONFLICT','白板已更新，请刷新列表后重新确认归档。',409);
    if(this.library.bridge(boardId).active)throw new BoardError('EDITOR_BUSY','该白板仍有 AI 请求，未关闭、未归档。请等待完成后重试。',409);
    const request={requestId,boardId,requester:token,status:'waiting',deadline:this.clock()+20000,updatedAt:this.clock(),participants:[]};
    if(!store.board.archived)request.participants=this.editors(boardId).map(([token,s])=>({token,epoch:s.epoch,ready:false}));
    this.requests.set(requestId,request);
    if(store.board.archived){request.status='complete';return this.view(request);}
    if(!request.participants.length)await this.commit(request);
    return this.view(request);
  }
  notice(token){
    const session=this.sessions.get(token);
    const request=[...this.requests.values()].reverse().find(r=>r.boardId===session?.boardId&&r.participants.some(p=>p.token===token&&p.epoch===session.epoch));
    if(!request)return null;
    const participant=request.participants.find(p=>p.token===token);
    return {...this.view(request),responded:participant.ready};
  }
  async respond(input,token){
    this.expire();const request=this.requests.get(input.requestId),session=this.sessions.get(token);
    const participant=request?.participants.find(p=>p.token===token&&p.epoch===session?.epoch);
    if(!request||!participant||request.boardId!==session?.boardId)throw new BoardError('BOARD_MISMATCH','归档目标或编辑窗口已变化，当前内容保留。',409);
    if(request.status!=='waiting')return this.view(request);
    if(input.ready!==true){this.fail(request,typeof input.message==='string'?input.message.slice(0,240):'编辑窗口尚未保存，未归档。');return this.view(request);}
    const store=this.library.get(request.boardId);
    if(session.saving||this.library.bridge(request.boardId).active)throw new BoardError('EDITOR_BUSY','保存或 AI 操作尚未完成，未归档。',409);
    if(input.revision!==store.board.revision)throw new BoardError('REVISION_CONFLICT','白板版本已更新，请同步后确认退出。',409);
    participant.ready=true;
    if(request.participants.every(p=>p.ready))await this.commit(request);
    return this.view(request);
  }
  canSave(boardId,token){const request=this.active(boardId);return !request||request.status==='waiting'&&request.participants.some(p=>p.token===token&&!p.ready);}
  async commit(request){
    const store=this.library.get(request.boardId);
    request.status='saving';
    try{
      if(this.library.bridge(request.boardId).active||request.participants.some(p=>this.sessions.get(p.token)?.saving))throw new BoardError('EDITOR_BUSY','保存或 AI 操作尚未完成，未归档。',409);
      await this.library.change(request.boardId,{baseRevision:store.board.revision,archived:true});
      request.status='complete';request.updatedAt=this.clock();
      for(const p of request.participants)this.leases.leave(p.token);
    }catch(error){this.fail(request,error instanceof BoardError?error.message:'归档保存失败，编辑窗口和内容保留。请重试或备份。');}
  }
}
