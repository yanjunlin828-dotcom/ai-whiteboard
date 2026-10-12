import { mkdir, readdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const sceneSchema = z.object({
  elements: z.array(z.object({
    id: z.string().min(1).max(200),
    type: z.enum(['rectangle', 'diamond', 'ellipse', 'text', 'line', 'arrow', 'freedraw', 'image', 'frame', 'magicframe', 'embeddable', 'iframe']),
    x: z.number().finite(), y: z.number().finite(),
    width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(),
    isDeleted: z.boolean().optional(),
  }).passthrough()).max(2000),
  appState: z.object({
    viewBackgroundColor: z.string().max(100).optional(),
    gridSize: z.number().nullable().optional(), gridModeEnabled: z.boolean().optional(),
    theme: z.enum(['light', 'dark']).optional(),
    currentItemFontFamily: z.number().optional(),
  }),
  files: z.record(z.string(), z.object({
    id: z.string(), dataURL: z.string().max(12_000_000), mimeType: z.string().max(100),
    created: z.number(), lastRetrieved: z.number().optional(), version: z.number().optional(),
  }).passthrough()),
});

export const boardIdSchema = z.string().regex(/^(main|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/);
const boardSchema = z.object({
  schemaVersion: z.literal(1), boardId: boardIdSchema,
  archived: z.boolean().optional(),
  revision: z.number().int().nonnegative(), title: z.string().min(1).max(80),
  scene: sceneSchema, savedAt: z.string().nullable(),
  requestId: z.string().max(100).nullable(), requestHash: z.string().nullable(),
  aiTransaction: z.object({ requestId: z.string().uuid(), hash: z.string(), createdIds: z.array(z.string()), affectedIds: z.array(z.string()).optional() }).optional(),
});
export const saveSchema = z.object({
  baseRevision: z.number().int().nonnegative(), requestId: z.string().uuid(),
  title: z.string().trim().min(1).max(80), scene: sceneSchema,
  aiTransaction: boardSchema.shape.aiTransaction,
});

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function blankBoard(boardId = 'main') {
  return { schemaVersion: 1, boardId, revision: 0, title: '我的讲解白板',
    scene: { elements: [], appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 5, theme: 'light' }, files: {} },
    savedAt: null, requestId: null, requestHash: null };
}
export class BoardError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export class BoardStore {
  constructor(directory, { beforeWrite = async () => {}, boardId = 'main' } = {}) {
    this.directory = directory;
    this.beforeWrite = beforeWrite;
    this.boardId = boardIdSchema.parse(boardId);
    this.board = blankBoard(boardId);
    this.requests = new Map();
    this.aiTransactions = new Map();
    this.queue = Promise.resolve();
    this.recoveryWarnings = [];
  }
  async load() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter((name) => /^rev-\d{10}-[a-f0-9-]+\.json$/.test(name)).sort().reverse();
    let latest;
    for (const name of names) {
      // IO permission failures must not be mistaken for an empty board.
      const raw = await readFile(join(this.directory, name), 'utf8');
      let record;
      try {
        const envelope = JSON.parse(raw);
        if (envelope.sha256 !== digest(envelope.board)) throw new Error('checksum');
        record = boardSchema.parse(envelope.board);
        if (record.boardId !== this.boardId) throw new Error('board identity');
      } catch {
        this.recoveryWarnings.push(name);
        continue;
      }
      latest ??= record;
      if (record.requestId) this.requests.set(record.requestId, { revision: record.revision, hash: record.requestHash });
      if (record.aiTransaction) this.aiTransactions.set(record.aiTransaction.requestId, { ...record.aiTransaction, revision: record.revision });
    }
    if (names.length && !latest) throw new BoardError('RECOVERY_REQUIRED', '没有完整的可读版本，请保留文件并检查备份。', 503);
    this.board = latest ?? blankBoard(this.boardId);
    return this.board;
  }
  read() { return structuredClone(this.board); }
  save(raw, metadata) {
    const task = this.queue.then(() => this.commit(raw, metadata));
    this.queue = task.catch(() => {});
    return task;
  }
  async commit(raw, metadata) {
    const input = saveSchema.parse(raw);
    const ids = input.scene.elements.map((element) => element.id);
    if (new Set(ids).size !== ids.length) throw new BoardError('INVALID_SCENE', '图形标识重复，未保存。');
    const requestHash = digest(metadata ? {input,metadata} : input);
    const previous = this.requests.get(input.requestId);
    if (previous) {
      if (previous.hash !== requestHash) throw new BoardError('REQUEST_REUSED', '同一请求标识不能用于不同内容。', 409);
      return { board: this.read(), duplicate: true, committedRevision: previous.revision };
    }
    if (input.baseRevision !== this.board.revision) throw new BoardError('REVISION_CONFLICT', '磁盘内容已有更新，草稿已保留，请重新连接后处理。', 409);
    const board = {
      schemaVersion: 1, boardId: this.boardId, revision: this.board.revision + 1,
      ...(this.board.archived !== undefined || metadata ? {archived: metadata?.archived ?? this.board.archived ?? false} : {}),
      title: input.title, scene: input.scene, savedAt: new Date().toISOString(),
      requestId: input.requestId, requestHash,
      ...(input.aiTransaction ? { aiTransaction: input.aiTransaction } : {}),
    };
    const filename = `rev-${String(board.revision).padStart(10, '0')}-${randomUUID()}.json`;
    const temporary = join(this.directory, `${filename}.pending`);
    const destination = join(this.directory, filename);
    await this.beforeWrite(board);
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ board, sha256: digest(board) }), 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    // A unique destination never replaces a user's file. Incomplete .pending files remain for diagnosis.
    await rename(temporary, destination);
    this.board = board;
    this.requests.set(input.requestId, { revision: board.revision, hash: requestHash });
    if (board.aiTransaction) this.aiTransactions.set(board.aiTransaction.requestId, { ...board.aiTransaction, revision: board.revision });
    return { board: this.read(), duplicate: false, committedRevision: board.revision };
  }
}
