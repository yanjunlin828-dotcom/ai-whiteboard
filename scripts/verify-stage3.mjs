import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// This script mutates only the dedicated synthetic QA board on port 48766.
const command = process.argv[2] ?? 'read';
if (!['read', 'generate', 'shapes', 'render'].includes(command)) throw new Error('Use read, generate, shapes or render');
const client = new Client({ name: 'stage3-protocol-qa', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))],
  env: { ...getDefaultEnvironment(), WHITEBOARD_PORT: '48766' }, stderr: 'pipe' });
const call = async (name, input = {}) => {
  const result = await client.callTool({ name, arguments: input });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result;
};
const object = result => result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(tools, ['board_status', 'board_read', 'board_patch', 'board_render']);
  const initial = object(await call('board_read'));
  if (command === 'read') console.log(JSON.stringify({ protocol: 'SDK MCP call; not host discovery', tools, board: initial }, null, 2));
  else {
    let patch;
    if (command === 'shapes') {
      const y = Math.max(...initial.elements.map(element => element.y + element.height)) + 160;
      patch = object(await call('board_patch', { baseRevision: initial.revision, requestId: randomUUID(), items: [
        { id: 'caption', type: 'text', x: 100, y, text: '基础图形与方向验证 · 假设示例', fontSize: 32 },
        { id: 'a', type: 'rectangle', x: 100, y: y + 100, width: 240, height: 160, text: '返回核对' },
        { id: 'b', type: 'diamond', x: 500, y: y + 100, width: 240, height: 160, text: '是否清晰' },
        { id: 'c', type: 'ellipse', x: 500, y: y + 400, width: 240, height: 160, text: '完成讲解' },
        { id: 'back', type: 'arrow', from: 'b', to: 'a' },
        { id: 'down', type: 'arrow', from: 'b', to: 'c' },
      ] }));
      assert.equal(patch.applied, true);
    }
    if (command === 'generate') {
      const input = { baseRevision: initial.revision, requestId: randomUUID(), flow: {
        title: '从资料到结论：一个清晰的处理流程',
        steps: [{ id: 'input', label: '资料输入', description: '收集公开资料\n明确需要回答的问题' },
          { id: 'process', label: '处理', description: '提取关键事实\n整理步骤与关系' },
          { id: 'output', label: '结果输出', description: '形成可解释的结论\n保留来源与限制' }],
        note: '假设示例 · 每一步都有明确的输入与输出；生成后可以直接双击修改。',
      } };
      patch = object(await call('board_patch', input));
      assert.equal(patch.applied, true);
      const retry = object(await call('board_patch', input)); assert.equal(retry.duplicate, true);
      const stale = await client.callTool({ name: 'board_patch', arguments: { ...input, requestId: randomUUID() } }); assert.equal(stale.isError, true);
    }
    const current = object(await call('board_read'));
    const preview = await call('board_render', { revision: current.revision, ...(patch ? { elementIds: patch.createdIds } : {}) });
    const png = preview.content.find(item => item.type === 'image'); assert.ok(png);
    const directory = resolve('../中间过程/AI讲解白板/stage3-qa'); await mkdir(directory, { recursive: true });
    const suffix = `${Date.now()}-${randomUUID().slice(0,8)}`;
    const pngPath = resolve(directory, `mcp-preview-${suffix}.png`);
    await writeFile(pngPath, Buffer.from(png.data, 'base64'), { flag: 'wx' });
    await writeFile(resolve(directory, `mcp-result-${suffix}.json`), JSON.stringify({ protocol: 'SDK MCP call; not host discovery', tools, patch, board: current, preview: object(preview) }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ tools, patch, revision: current.revision, elements: current.total, pngPath }, null, 2));
  }
} finally { await client.close(); }
