// Exercise installed preview_html and browser MCP, using only synthetic import evidence.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {installed} from '../src/releases.mjs';
import {json} from '../src/storage.mjs';
const home=resolve(process.argv[2]),run=resolve(process.argv[3]),work=join(run,'game'),out=join(run,'installed-preview');
const bundle=await installed(home,(await json(join(home,'state.json'))).current);
const {configuration}=await import(pathToFileURL(join(bundle.root,'launcher/src/opencode.mjs')));
const {detectBrowsers,chooseBrowser}=await import(pathToFileURL(join(bundle.root,'launcher/src/browser-choice.mjs')));
const config=configuration(bundle.root,bundle.manifest,join(out,'state'),{},chooseBrowser(await detectBrowsers(bundle.root)),work);
const state=await json(join(run,'evidence/state.json')),level=state.levels.find(l=>l.level_name==='Нейродиалог 1');
assert.ok(level);await mkdir(join(work,'artifacts'),{recursive:true});await mkdir(out,{recursive:true});
let html='<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'+state.messages.filter(m=>m.all_levels).map(m=>m.message_text).join('')+'</head><body>'+level.tasks.map(t=>t.task_text).join('')+'</body></html>';
for(const [i,asset]of Object.values(state.assets).entries()){assert.ok(html.includes(asset.url));const name='asset-'+i+'.css';html=html.replaceAll(asset.url,name);await writeFile(join(work,'artifacts',name),asset.content);}
await writeFile(join(work,'artifacts/import.html'),html);
const clients=[];
async function connect(name){const c=config.mcp.servers[name],client=new Client({name:'installed-preview-check',version:'1.0.0'});clients.push(client);const transport=new StdioClientTransport({command:c.command[0],args:[...c.command.slice(1),...(name==='browser'?['--output-dir',out]:[])],cwd:work,env:{...process.env,...c.environment},stderr:'pipe'});await client.connect(transport);transport.stderr?.resume();return client;}
async function call(client,name,args){const result=await client.callTool({name,arguments:args},undefined,{timeout:config.mcp.servers.browser.timeout.execution});assert.ok(!result.isError,JSON.stringify(result));return result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');}
let browser;
try{
 const author=await connect('author_tools');browser=await connect('browser');
 const {url}=JSON.parse(await call(author,'preview_html',{path:'import.html'}));assert.equal(new URL(url).hostname,'127.0.0.1');
 const checks=[];
 for(const width of [1280,390]){
  await call(browser,'browser_resize',{width,height:800});
  await call(browser,'browser_navigate',{url});
  const result=await call(browser,'browser_evaluate',{function:'() => ({text:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth,cssLoaded:[...document.styleSheets].some(s=>s.href&&s.cssRules.length>0),styles:[...document.querySelectorAll("[class]")].map(e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}))})'});
  const check=JSON.parse(result.split('### Result\n')[1].split('\n###')[0].trim());
  assert.ok(check.text.includes('Почему звёзды мерцают?')&&check.text.includes('Из-за неоднородности атмосферы.'));assert.equal(check.overflow,false);assert.equal(check.cssLoaded,true);
  assert.ok(check.styles.some(s=>s.color!=='rgb(0, 0, 0)'||!['rgba(0, 0, 0, 0)','rgb(255, 255, 255)'].includes(s.background)));
  await call(browser,'browser_take_screenshot',{type:'png',filename:join(out,width+'.png'),fullPage:true});assert.ok((await stat(join(out,width+'.png'))).size>0);
  checks.push({width,...check});
 }
 await writeFile(join(out,'report.json'),JSON.stringify({status:'passed',release:bundle.manifest.id,tools:['author_tools.preview_html','browser.browser_navigate','browser.browser_evaluate','browser.browser_take_screenshot'],realEngineVerified:false,checks},null,2));
 console.log('PASS installed preview: desktop/mobile, CSS loaded, screenshots '+out);
}finally{if(browser)await call(browser,'browser_close',{}).catch(()=>{});for(const c of clients.reverse())await c.close();}
