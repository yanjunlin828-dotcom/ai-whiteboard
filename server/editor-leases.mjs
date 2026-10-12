import { randomUUID } from 'node:crypto';
import { BoardError } from './store.mjs';

// Each board has one writer. A live writer must finish saving before a handoff.
export class EditorLeases {
  constructor(sessions, clock, protectedBoard, closeBridge) {
    this.sessions = sessions; this.clock = clock;
    this.protectedBoard = protectedBoard; this.closeBridge = closeBridge;
    this.writers = new Map(); this.requests = new Map(); this.active = null;
  }
  refresh() {
    for (const [id, lease] of this.writers) {
      if (lease.until < this.clock() && !this.protectedBoard(id, lease.token)) {
        this.closeBridge(id); this.writers.delete(id);
      }
    }
    for (const [id, request] of this.requests) {
      if (request.until < this.clock() || !this.sessions.has(request.token)) this.requests.delete(id);
    }
  }
  owner(id) { this.refresh(); return this.writers.get(id)?.token ?? null; }
  selected() {
    this.refresh();
    const session = this.sessions.get(this.active);
    return session && this.writers.get(session.boardId)?.token === this.active ? this.active : null;
  }
  acquire(token) {
    const session = this.sessions.get(token);
    if (!session?.editor || !session.eligible) return false;
    const owner = this.owner(session.boardId);
    const requested = this.requests.get(session.boardId);
    if (owner && owner !== token || !owner && requested && requested.token !== token) return false;
    if (!owner) {
      session.previousEpoch = session.epoch;
      session.epoch = randomUUID();
      this.writers.set(session.boardId, { token, until: this.clock() + 30000 });
      this.requests.delete(session.boardId); this.active = token;
    }
    this.renew(token); return true;
  }
  renew(token) {
    const session = this.sessions.get(token), lease = session && this.writers.get(session.boardId);
    if (lease?.token === token) lease.until = this.clock() + 30000;
  }
  request(token) {
    const session = this.sessions.get(token);
    session.editor = true; session.eligible = true;
    if (this.acquire(token)) { this.active = token; return; }
    const existing = this.requests.get(session.boardId);
    if (existing && existing.token !== token) throw new BoardError('HANDOFF_BUSY', '另一窗口正在申请编辑，请稍后重试。', 409);
    this.requests.set(session.boardId, { token, until: this.clock() + 45000 });
  }
  pending(token) {
    const session = this.sessions.get(token), request = this.requests.get(session?.boardId);
    return request?.token === token;
  }
  requested(token) {
    const session = this.sessions.get(token);
    return this.owner(session?.boardId) === token && this.requests.has(session.boardId);
  }
  yield(token) {
    const session = this.sessions.get(token), id = session.boardId;
    const request = this.requests.get(id);
    if (this.owner(id) !== token || !request) return;
    if (this.protectedBoard(id, token)) throw new BoardError('EDITOR_BUSY', '保存或 AI 操作尚未完成，请稍后切换。', 409);
    this.closeBridge(id); this.writers.delete(id); session.eligible = false;
    this.acquire(request.token);
  }
  leave(token) {
    const session = this.sessions.get(token);
    if (!session) return;
    const id = session.boardId;
    if (this.owner(id) === token) {
      if (this.protectedBoard(id, token)) throw new BoardError('EDITOR_BUSY', '保存或 AI 操作尚未完成，请稍后离开。', 409);
      this.closeBridge(id); this.writers.delete(id);
    }
    if (this.requests.get(id)?.token === token) this.requests.delete(id);
    session.eligible = false; session.editor = false;
  }
}
