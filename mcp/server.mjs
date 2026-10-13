import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { patchShape, readShape, renderShape,previewShape,validateShape } from '../server/bridge.mjs';
import {boardIdSchema} from '../server/store.mjs';

const port = Number(process.env.WHITEBOARD_PORT ?? 48765);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid WHITEBOARD_PORT');
const server = new McpServer({ name: 'ai-whiteboard', version: '0.4.0' }, {
  instructions: '先 board_status 选择目标，再 board_read 获取身份和版本。局部修改用 elementIds+includeRelated；source=saved 只读指定保存版本，不含草稿/实时选区。先 board_preview 看候选 PNG，再携带同一内容/requestId 和可选 previewId 提交，移除预览专用视图参数。patch 可选 returnElements 和 verification(validate/render)；完整同版本结果可替代相应回读、验证和渲染，检查覆盖与截断，仍实际看图。applied=false 或图片失败仍可能已保存；超时用原 boardId+requestId 查回执，不换 ID 重发。保护身份、版本、锁定对象、原笔画和公式源码；不删除、清空或自动切板。',
});
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = resolve(process.env.WHITEBOARD_BRIDGE_FILE ?? resolve(project, `.local/bridge-${port}.key`));
async function call(kind, input) {
  const key = (await readFile(keyFile, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/${kind}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Whiteboard-Client': 'mcp' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(28000),
  });
  const data = await response.json();
  if (!response.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }] };
  if (kind === 'render'||kind==='preview'||data.png) {
    const { png, ...metadata } = data;
    return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data: png, mimeType: 'image/png' }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}
const guarded = fn => async input => {
  try { return await fn(input); }
  catch(error) { const data={code:'CONNECTION_UNCONFIRMED',cause:['ENOENT','EACCES'].includes(error.code)?error.code:error.name==='TimeoutError'?'TIMEOUT':'LOCAL_CONNECTION',boardId:input.boardId,requestId:input.requestId,message:'连接未确认；写入超时先用原 boardId 与 requestId 查询 board_status，不重复生成。'};return { isError:true,content:[{type:'text',text:JSON.stringify(data)}] }; }
};
server.registerTool('board_status', {
  description: '返回活动编辑页列表、目标身份和 readyReason。多板同时打开时按用户指定标题选择 boardId。旧事务查询必须同时传原 boardId+requestId。input_active/unsaved 请结束输入并保存，stale_heartbeat 请回到编辑页；blocked/recovery 须先处理草稿。',
  inputSchema: { boardId:boardIdSchema.optional(),requestId: z.string().uuid().optional() }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ requestId,boardId }) => {
  try {
    const query=new URLSearchParams({...requestId?{requestId}:{},...boardId?{boardId}:{}});
    const response = await fetch(`http://127.0.0.1:${port}/api/status?${query}`, { headers: { 'X-Whiteboard-Client': 'mcp' }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return {isError:true,content:[{type:'text',text:JSON.stringify(await response.json())}]};
    const status = await response.json();
    if (status.app !== 'ai-whiteboard') throw new Error('Unexpected local service');
    return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: status };
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'EDITOR_OFFLINE：本地讲解白板服务不可用。请先运行项目启动入口，然后重试 board_status。' }] };
  }
});
server.registerTool('board_read', {
  description: '默认同步当前页。summary 返回分区；elementIds（最多100）+includeRelated 精确读取标签、关联边；detail=text/layout/full，修改公式读取源码。source=saved 必须携带 boardId、editorSessionId、revision，直接读保存版本，不含草稿或实时选区；适合固定版本分页。regionId/includeChildren 控制范围，分页固定 revision。检查 coverage 和截断，省略字段不代表不存在。',
  inputSchema: readShape, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, guarded(input => call('read', input)));
server.registerTool('board_patch', {
  description: '保存一批修改、一次撤销。flow/items/edits 三选一，支持字体、分区、局部编辑和公式。previewId 复用刚看过的候选，仍传同一内容/requestId。返回 idMap/labelMap、revision、saved/applied；returnElements=true 回传变化内容。verification:{validate:true,render:true,elementIds?,regionId?,includeChildren?} 按范围验收，默认检查变化及关联对象，图片对应保存版本。完整结果减少额外 read/validate/render；截断或图片失败按保存版本补查，禁止新 requestId 重发。',
  inputSchema: {...patchShape,boardId:patchShape.boardId.unwrap(),editorSessionId:patchShape.editorSessionId.unwrap()}, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, guarded(input => call('patch', input)));
server.registerTool('board_render', {
  description: '返回当前指定 revision 的实际 PNG。regionId/includeChildren 或 elementIds（最多100），含绑定文字。最长边1600px；版本过期回读。patch 已返回同版本所需范围 PNG 时无需重复调用；复杂图仍检查核心、整体和局部。',
  inputSchema: {...renderShape,boardId:renderShape.boardId.unwrap(),editorSessionId:renderShape.editorSessionId.unwrap()}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, guarded(input => call('render', input)));
server.registerTool('board_preview',{
  description:'验证并渲染候选，返回 saved=false、PNG、validation 和可选 previewId（短期候选句柄）。确认后 board_patch 携带相同内容、requestId 和 previewId 复用候选。版本、会话或选区变化后重新预览；候选不预留版本。regionId/elementIds/includeChildren 仅控制预览视图，patch 时去掉。',
  inputSchema:{...previewShape,boardId:previewShape.boardId.unwrap(),editorSessionId:previewShape.editorSessionId.unwrap()},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
},guarded(input=>call('preview',input)));
server.registerTool('board_validate',{
  description:'检查当前指定 revision 的文字、分区、遮挡、端口和穿越。regionId/includeChildren 或 elementIds 限定目标；指定 ID 考虑外部遮挡和穿越。patch 已返回同版本完整范围检查时无需重复调用。检查截断；几何结果不能证明内容或推导正确，仍需看图。',
  inputSchema:{...validateShape,boardId:validateShape.boardId.unwrap(),editorSessionId:validateShape.editorSessionId.unwrap()},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
},guarded(input=>call('validate',input)));
await server.connect(new StdioServerTransport());
