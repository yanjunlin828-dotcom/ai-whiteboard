import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const qa=await (await fetch('http://127.0.0.1:48769/qa/state')).json();
const key=resolve(qa.directory,`bridge-${randomUUID()}.key`);await writeFile(key,'stage7-isolated-test-key',{flag:'wx'});
const client=new Client({name:'stage7-sdk-qa',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('mcp/server.mjs')],env:{...getDefaultEnvironment(),WHITEBOARD_PORT:'48769',WHITEBOARD_BRIDGE_FILE:key},stderr:'pipe'});
try{
 await client.connect(transport);const tools=await client.listTools();
 assert.ok(tools.tools.find(t=>t.name==='board_patch').inputSchema.required.includes('boardId'));
 assert.ok(tools.tools.find(t=>t.name==='board_patch').inputSchema.required.includes('editorSessionId'));
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(JSON.stringify(r));return r;};
 const before=(await call('board_read',{scope:'all',limit:100})).structuredContent;
 assert.equal(before.title,'B · 独立副本');
 const target=before.elements.find(e=>e.text==='输出');assert.ok(target);
 const input={boardId:before.boardId,editorSessionId:before.editorSessionId,baseRevision:before.revision,requestId:randomUUID(),edits:[{op:'set_text',target:target.id,text:'仅修改 B 副本'}]};
 const patched=(await call('board_patch',input)).structuredContent;
 assert.equal((await call('board_patch',input)).structuredContent.duplicate,true);
 const after=(await call('board_read',{boardId:before.boardId})).structuredContent;assert.equal(after.elements.find(e=>e.id===target.id).text,'仅修改 B 副本');
 const render=await call('board_render',{boardId:after.boardId,editorSessionId:after.editorSessionId,revision:after.revision});
 await writeFile(resolve(qa.directory,'sdk-preview.png'),Buffer.from(render.content.find(c=>c.type==='image').data,'base64'),{flag:'wx'});
 await writeFile(resolve(qa.directory,'sdk-mcp.json'),JSON.stringify({source:'MCP SDK and real browser editor, not host tool',before,input,patched,after},null,2),{flag:'wx'});
 console.log(JSON.stringify({passed:true,boardId:after.boardId,revision:after.revision,requiredIdentity:true,duplicate:true,render:true}));
}finally{await client.close();}
