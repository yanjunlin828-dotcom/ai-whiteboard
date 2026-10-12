// Read-only MCP/scene acceptance; write new evidence files exclusively.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { BoardStore } from '../server/store.mjs';
import { teachingRegions } from '../shared/teaching.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const docs = resolve(project, '../文档/自建学习材料/AI讲解白板');
const directory = resolve(docs, '白板/main/revisions');
const output = resolve(docs, 'Laya板书');
const evidence = resolve(project, '../中间过程/AI讲解白板/stage5-evidence-20261011');
const client = new Client({ name: 'stage5-evidence', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(project, 'mcp/server.mjs')],
  env: { ...getDefaultEnvironment(), WHITEBOARD_PORT: '48765' }, stderr: 'pipe' });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const data = result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
  if (data.error || data.code) throw new Error(JSON.stringify(data));
  return { result, data };
}
try {
  await client.connect(transport);
  const status = (await call('board_status', {})).data;
  assert.equal(status.editorReady, true);
  const read = (await call('board_read', { scope: 'all', limit: 500 })).data;
  const store = new BoardStore(directory);
  const board = await store.load();
  assert.equal(board.revision, read.revision);
  const old = JSON.parse(await readFile(resolve(directory, 'rev-0000000004-ea1affff-d34e-4f3d-adf3-b9a26d0dadbf.json'), 'utf8')).board;
  for (const element of old.scene.elements) assert.deepEqual(board.scene.elements.find(e => e.id === element.id), element);
  const regions = teachingRegions(board.scene.elements);
  assert.equal(regions.length, 3);
  assert.ok(board.scene.elements.length <= 100);
  for (const region of regions) {
    const elements = board.scene.elements.filter(e => region.elementIds.includes(e.id));
    for (const arrow of elements.filter(e => e.type === 'arrow')) {
      assert.ok(region.elementIds.includes(arrow.startBinding.elementId));
      assert.ok(region.elementIds.includes(arrow.endBinding.elementId));
    }
    const blocks = elements.filter(e => e.type !== 'arrow' && !e.containerId);
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      assert.ok(!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y), `Overlap: ${a.id}, ${b.id}`);
    }
  }
  // Render everything before creating the output set: failures leave no misleading report.
  const images = [];
  for (const region of regions) {
    const { result, data } = await call('board_render', { revision: board.revision, elementIds: region.elementIds });
    const picture = result.content.find(c => c.type === 'image');
    assert.ok(picture); images.push({ bytes: Buffer.from(picture.data, 'base64'), metadata: data });
  }
  assert.equal((await call('board_status', {})).data.revision, board.revision);
  await mkdir(output, { recursive: true });
  await mkdir(evidence, { recursive: true });
  for (let i = 0; i < images.length; i++) await writeFile(resolve(output, `板书-${i+1}.png`), images[i].bytes, { flag: 'wx' });
  const ids = new Set(regions.flatMap(r => r.elementIds));
  await writeFile(resolve(output, 'Laya原理.excalidraw'), JSON.stringify({ type: 'excalidraw', version: 2, source: 'local-ai-whiteboard',
    elements: board.scene.elements.filter(e => ids.has(e.id)), appState: board.scene.appState, files: board.scene.files }, null, 2), { flag: 'wx' });
  const report = { revision: board.revision, originalElementsPreserved: old.scene.elements.length, elementCount: board.scene.elements.length,
    regions, previewMetadata: images.map(image => image.metadata), overlapCheck: 'passed', bindings: 'passed',
    transport: 'MCP SDK read/render only; scene generation was invoked by host MCP', savedAt: new Date().toISOString() };
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ revision: board.revision, regions: regions.length, originalElementsPreserved: old.scene.elements.length, output, evidence }));
} finally { await client.close(); }
