import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { BoardStore } from './store.mjs';
import { BoardLibrary } from './library.mjs';
import { createBoardServer } from './http.mjs';
import { EditorBridge } from './bridge.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {typographyPlugin} from '../scripts/typography-plugin.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.WHITEBOARD_PORT ?? 48765);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid WHITEBOARD_PORT');
const data = resolve(process.env.WHITEBOARD_DATA_DIR ?? resolve(project, '../文档/自建学习材料/AI讲解白板/白板/main/revisions'));
const library = new BoardLibrary(data);
await library.load();
const store = library.get('main');
const keyFile = resolve(process.env.WHITEBOARD_BRIDGE_FILE ?? resolve(project, `.local/bridge-${port}.key`));
await mkdir(dirname(keyFile), { recursive: true });
let bridgeToken;
try { bridgeToken = (await readFile(keyFile, 'utf8')).trim(); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  bridgeToken = randomBytes(32).toString('hex');
  await writeFile(keyFile, bridgeToken, { flag: 'wx', mode: 0o600 });
}
if (!/^[a-f0-9]{64}$/.test(bridgeToken)) throw new Error('Invalid bridge credential file; preserve it and investigate.');
const bridge = new EditorBridge(store, { allowEdits: true });
const dev = process.argv.includes('--dev');
let vite;
if (dev) {
  const { createServer } = await import('vite');
  vite = await createServer({ root: project, configFile: false, plugins:[typographyPlugin(project)], server: { middlewareMode: true, hmr: false, allowedHosts: ['127.0.0.1', 'localhost'] }, appType: 'spa' });
}
const server = createBoardServer({ store, root: resolve(project, 'dist'),
  bridge, bridgeToken, library,
  assets: resolve(project, 'node_modules/@excalidraw/excalidraw/dist/prod'), middleware: vite?.middlewares });
server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，未终止任何其他进程。` : error.message); process.exitCode = 1; vite?.close(); });
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ app: 'ai-whiteboard', url: `http://127.0.0.1:${port}`, pid: process.pid, mode: dev ? 'development' : 'production', revision: store.board.revision }));
});
async function shutdown() { server.close(); server.closeAllConnections(); await vite?.close(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
