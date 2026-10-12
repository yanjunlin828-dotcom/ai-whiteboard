import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const client = new Client({ name: 'whiteboard-local-probe', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))],
  env: { ...getDefaultEnvironment(), WHITEBOARD_PORT: process.env.WHITEBOARD_PORT ?? '48765' }, stderr: 'pipe' });
try {
  await client.connect(transport);
  const list = await client.listTools();
  const result = await client.callTool({ name: 'board_status', arguments: {} });
  console.log(JSON.stringify({ probe: 'MCP SDK client, not host registration', tools: list.tools.map(tool => tool.name), result }, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
