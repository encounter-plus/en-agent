// Public network check of OpenCode's own Exa adapter, with no personal key.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {installed} from '../src/releases.mjs';
import {json} from '../src/storage.mjs';
import {startOpenCode,waitForMcp} from '../src/opencode.mjs';
const home=resolve(process.argv[2]??'.local/exa-ready');
const workspace=resolve('.local/exa-network-check');await mkdir(workspace,{recursive:true});
delete process.env.EXA_API_KEY;
const bundle=await installed(home,(await json(join(home,'state.json'))).current);
const runtime=await startOpenCode(bundle,join(workspace,'state'),workspace);
try{
  await waitForMcp(runtime,workspace,['encounter','author_tools','browser']);
  const response=await runtime.request('/api/websearch?'+new URLSearchParams({'location[directory]':workspace}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'Eiffel Tower official website'})});
  const body=await response.json();assert.ok(response.ok,JSON.stringify(body));
  assert.equal(body.data.providerID,'exa');assert.ok(body.data.results.length>0);
  console.log('Built-in Exa without key: '+body.data.results.length+' results; all 3 MCP connected.');
}finally{await runtime.stop();}
