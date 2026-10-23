import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('built author MCP exposes tools and serves a preview through real stdio protocol',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'en-mcp-'));
  const client=new Client({name:'en-agent-test',version:'1.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/tools-server.mjs')],cwd:workspace,stderr:'pipe'});
  try {
    await mkdir(join(workspace,'artifacts'));await writeFile(join(workspace,'artifacts','level.html'),'<h1>Уровень</h1>');
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    const names=tools.map(t=>t.name);
    for(const name of ['wikipedia_search','wikipedia_read','google_public_read','preview_html'])assert.ok(names.includes(name));
    assert.ok(!names.includes('web_search'));
    for(const name of ['google_private_doc_read','google_sheet_read','google_sheet_prepare']) {
      assert.ok(!names.includes(name),name+' must be removed from the catalog');
      const removed=await client.callTool({name,arguments:{}});
      assert.equal(removed.isError,true,'Retired tool must not remain callable');
    }
    assert.deepEqual(tools.find(t=>t.name==='wikipedia_read').inputSchema.properties.mode.enum,['article','infobox']);
    const result=await client.callTool({name:'preview_html',arguments:{path:'level.html'}});
    assert.ok(!result.isError);
    const url=JSON.parse(result.content[0].text).url;
    assert.match(await (await fetch(url)).text(),/Уровень/);
  }finally{await client.close();await rm(workspace,{recursive:true,force:true});}
});
