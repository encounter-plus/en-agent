// Explicit integration check; no model calls. Pass an installed v2 home and an existing game.
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {json,lock} from '../src/storage.mjs';
import {installed} from '../src/releases.mjs';
import {startOpenCode,waitForMcp} from '../src/opencode.mjs';
import {detectBrowsers,chooseBrowser} from '../src/browser-choice.mjs';
const home=resolve(process.argv[2]),workspace=resolve(process.argv[3]);
const unlock=await lock(home);let runtime;
try {
  const bundle=await installed(home,(await json(join(home,'state.json'))).current);
  runtime=await startOpenCode(bundle,home,workspace,{browserChoice:chooseBrowser(await detectBrowsers(bundle.root))});
  assert.equal((await fetch(runtime.url+'/api/info')).status,401);
  await waitForMcp(runtime,workspace,['encounter','author_tools','browser']);
  const link=await runtime.pair();
  const paired=await fetch(link,{headers:{Accept:'text/html'},redirect:'manual'});
  assert.ok([302,303,307].includes(paired.status));
  const cookie=paired.headers.get('set-cookie');assert.ok(cookie);
  assert.equal((await fetch(runtime.url+'/api/info',{headers:{Cookie:cookie.split(';')[0]}})).status,200);
  assert.equal((await fetch(link,{redirect:'manual'})).status,401);
  const page=await fetch(runtime.url);assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);assert.match(await page.text(),/<html/i);
  console.log('OpenCode '+bundle.manifest.opencode.version+': 3 MCP connected; API auth, browser pairing, single-use code and embedded GUI verified.');
}finally{if(runtime)await runtime.stop();await unlock();}
