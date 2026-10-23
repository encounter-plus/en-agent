import test from 'node:test';
import assert from 'node:assert/strict';
import {detectBrowsers,chooseBrowser,browserLaunchOptions,browserMcpArgs} from '../src/browser-choice.mjs';
import {configuration} from '../src/opencode.mjs';
test('auto detects installed Chrome and Edge, respects explicit choice and rejects missing browser',async()=>{
 const browsers=await detectBrowsers('',{platform:'win32',env:{LOCALAPPDATA:'C:/user',PROGRAMFILES:'C:/apps'},fileExists:async p=>p.includes('Chrome')||p.includes('Edge'),playwright:{chromium:{executablePath:()=>'/missing/chromium'},firefox:{executablePath:()=>'/missing/firefox'}}});
 assert.deepEqual(browsers.map(b=>b.id),['chrome','msedge']);assert.equal(chooseBrowser(browsers).id,'chrome');assert.equal(chooseBrowser(browsers,'msedge').id,'msedge');assert.throws(()=>chooseBrowser(browsers,'firefox'),/не найден/);assert.throws(()=>chooseBrowser([]),/не найден/);
});
test('MCP and login use identical executable, engine and isolated browser profiles',()=>{
 for(const [id,engine] of [['chrome','chromium'],['msedge','chromium'],['firefox','firefox']]){
 const browser={id,engine,executablePath:'C:/browser/'+id+'.exe'};const args=browserMcpArgs(browser,'C:/home');assert.equal(args[3],browserLaunchOptions(browser).executablePath);assert.equal(args[1],engine==='firefox'?'firefox':'chrome');assert(args[5].endsWith(id));
 const config=configuration('C:/bundle',{nodePath:'node.exe',mcpPath:'mcp.mjs',skillsPath:'skills',browserPath:'browser.mjs'},'C:/home',{},browser);assert.deepEqual(config.mcp.servers.browser.command.slice(2),args);
 assert.ok(config.mcp.servers.browser.timeout.startup>=60000);
 assert.ok(config.mcp.servers.browser.timeout.execution>120000,'Browser call must cover cold launch and navigation');
 }
});
