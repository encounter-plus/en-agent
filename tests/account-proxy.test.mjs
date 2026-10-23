import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startAccountService} from '../dist/account-service.mjs';
test('real MCP bridge requests recovery and never replays a failed mutation',async()=>{
 let recoveries=0;const service=await startAccountService({open:async()=>{},manager:{recover:async()=>{recoveries++;return {status:'restored'};}}});
 const client=new Client({name:'test',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/account-proxy.mjs'),resolve('tests/account-proxy-fixture.mjs')],env:{...process.env,...service.environment},stderr:'pipe'});
 try{await client.connect(transport);transport.stderr?.resume();assert.equal((await client.listTools()).tools.length,4);const response=await client.callTool({name:'write_fixture',arguments:{}});assert.equal(response.isError,true);assert.equal(JSON.parse(response.content[0].text).status,'restored');assert.equal(recoveries,1);const count=await client.callTool({name:'count_fixture',arguments:{}});assert.equal(count.content[0].text,'1');}finally{await client.close();await service.close();}
});
