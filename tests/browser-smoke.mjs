import {detectBrowsers,chooseBrowser,browserMcpArgs} from '../src/browser-choice.mjs';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startPreview} from '../src/preview.mjs';

const workspace=await mkdtemp(join(tmpdir(),'en-browser-'));
const client=new Client({name:'en-agent-browser-smoke',version:'1.0'});
let preview;
const choice=chooseBrowser(await detectBrowsers(resolve('.'),{playwright:await import('playwright')}));
async function snapshotText(result){
  const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  const path=text.match(/\[Snapshot\]\(([^)]+)\)/)?.[1];
  if(!path)return text;
  const full=resolve(workspace,path);assert.ok(full.startsWith(workspace));
  return await readFile(full,'utf8');
}
try {
  await mkdir(join(workspace,'artifacts'));
  const file=join(workspace,'artifacts','level.html');await writeFile(file,'<!doctype html><title>en-agent preview</title><h1>Level one</h1>');
  preview=await startPreview(workspace);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('node_modules/@playwright/mcp/cli.js'),...browserMcpArgs(choice,workspace)],cwd:workspace,stderr:'pipe'}));
  const result=await client.callTool({name:'browser_navigate',arguments:{url:preview.url+'level.html'}});
  if(result.isError)console.error(JSON.stringify(await client.callTool({name:'browser_snapshot',arguments:{}})));
  assert.ok(!result.isError,JSON.stringify(result));
  assert.match(await snapshotText(result),/Level one/);
  await writeFile(file,'<!doctype html><title>en-agent preview</title><h1>Level two</h1>');
  let observed=false;
  for(let n=0;n<15;n++){
    const snapshot=await client.callTool({name:'browser_snapshot',arguments:{}});
    if((await snapshotText(snapshot)).includes('Level two')){observed=true;break;}
    await new Promise(r=>setTimeout(r,400));
  }
  assert.ok(observed,'Changed HTML must appear without manual reload');
  await client.callTool({name:'browser_close',arguments:{}});
  console.log('Visible selected browser controlled by Playwright MCP; HTML live reload verified.');
}finally{await client.close();if(preview)await preview.close();await rm(workspace,{recursive:true,force:true});}
