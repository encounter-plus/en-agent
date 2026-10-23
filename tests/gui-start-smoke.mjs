import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {json} from '../src/storage.mjs';
import {installed} from '../src/releases.mjs';
import {startOpenCode,waitForMcp} from '../src/opencode.mjs';
import {ensureSession,startGui} from '../src/gui-start.mjs';
import {detectBrowsers,chooseBrowser} from '../src/browser-choice.mjs';

const source=resolve(process.argv[2]);
const home=await mkdtemp(resolve('.local/gui-start-'));
const workspace=join(home,'Игра & первый старт');await mkdir(workspace);
const bundle=await installed(source,(await json(join(source,'state.json'))).current);
let runtime,gui,browser;
try {
  runtime=await startOpenCode(bundle,home,workspace,{browserChoice:chooseBrowser(await detectBrowsers(bundle.root))});
  await waitForMcp(runtime,workspace,['encounter','author_tools','browser']);
  const session=await ensureSession(runtime,workspace);
  assert.equal((await ensureSession(runtime,workspace)).id,session.id);
  gui=await startGui(runtime,workspace,session);
  assert.equal((await fetch(gui.url+'/api/info')).status,401);
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage();
  const link=await gui.pair();await page.goto(link);
  await page.waitForURL('**/session/'+session.id,{timeout:30000});
  await page.locator('[contenteditable="true"]').first().waitFor({timeout:60000});
  assert.equal((await fetch(link,{redirect:'manual'})).status,401);
  // API queries through the GUI gateway use the browser's HttpOnly cookie.
  assert.equal(await page.evaluate(async()=> (await fetch('/api/info')).status),200);
  await page.screenshot({path:join(home,'session.png')});
  await page.goto(gui.url);
  await page.getByText('Игра & первый старт',{exact:true}).first().waitFor({timeout:30000});
  await page.screenshot({path:join(home,'projects.png')});
  await gui.close();gui=undefined;await runtime.stop();runtime=undefined;
  runtime=await startOpenCode(bundle,home,workspace,{browserChoice:chooseBrowser(await detectBrowsers(bundle.root))});
  assert.equal((await ensureSession(runtime,workspace)).id,session.id);
  console.log('PASS: first session, repeat/restart reuse, GUI composer, Projects, cookie auth and single-use pairing. Evidence: '+home);
}finally{if(browser)await browser.close();if(gui)await gui.close();if(runtime)await runtime.stop();}
