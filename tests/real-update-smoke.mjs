import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {resolve,join,basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {json,atomicJson} from '../src/storage.mjs';
import {stageUpdate,signedManifest,installed} from '../src/releases.mjs';
import {pathToFileURL} from 'node:url';
const [oldPath,releasePath]=process.argv.slice(2);if(!oldPath||!releasePath)throw Error('Pass old clean package home and signed distribution github directory');
const live=process.argv.includes('--live');
const home=await mkdtemp(resolve('.local/update-integration-')),github=resolve(releasePath);
await cp(resolve(oldPath),home,{recursive:true});
const previous=(await json(join(home,'state.json'))).current;
const oldBundle=await installed(home,previous);
await mkdir(join(home,'data'),{recursive:true});await writeFile(join(home,'data','synthetic-preserved'),'synthetic-chat');
await atomicJson(join(home,'preferences.json'),{browser:'msedge',customPreserved:'synthetic-settings'});
// Exercise a real OpenCode database migration, not just preservation of a file.
const sessionWorkspace=join(home,'session-workspace');await mkdir(sessionWorkspace,{recursive:true});
async function withRuntime(bundle,run){
  const {startOpenCode}=await import(pathToFileURL(join(bundle.root,'launcher/src/opencode.mjs')));
  const {detectBrowsers,chooseBrowser}=await import(pathToFileURL(join(bundle.root,'launcher/src/browser-choice.mjs')));
  const runtime=await startOpenCode(bundle,home,sessionWorkspace,{browserChoice:chooseBrowser(await detectBrowsers(bundle.root),'msedge')});
  try{return await run(runtime);}finally{await runtime.stop();}
}
const savedSession=await withRuntime(oldBundle,async runtime=>{
  const response=await runtime.request('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Synthetic preserved session',location:{directory:sessionWorkspace}})});
  assert.ok(response.ok,'Old OpenCode must create the synthetic session');
  const session=(await response.json()).data;assert.ok(session.id);return session;
});
const publicKey=await readFile(join(github,'public-key.pem'),'utf8'),envelope=await json(join(github,'channel.json'));
const manifest=signedManifest(envelope,publicKey),channel=live?{...await json(resolve('config/channel.example.json')),publicKey}:{publicKey,manifestUrl:'https://local-fixture.invalid/channel.json',assetsUrl:'https://local-fixture.invalid/releases/'};
await atomicJson(join(home,'channel.json'),channel);
const result=await stageUpdate(home,channel,live?{fetcher:(url,options)=>{const address=new URL(url);console.log('Download '+address.origin+address.pathname);return fetch(url,options);}}:{fetcher:async url=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://local-fixture.invalid');
  if(parsed.pathname==='/channel.json')return new Response(JSON.stringify(envelope));
  const asset=basename(parsed.pathname);assert.ok(manifest.files.some(f=>f.asset===asset));
  return new Response(Readable.toWeb(createReadStream(join(github,manifest.id,asset))));
}});
assert.equal(result.status,'staged');assert.equal((await json(join(home,'state.json'))).current,previous);
const executable=join(home,'releases',previous,'bin/node.exe'),cli=join(home,'releases',previous,'launcher/src/cli.mjs');
await promisify(execFile)(executable,[cli,'--home',home,'--game',join(home,'synthetic-game'),'--name','Synthetic update','--no-browser','--smoke'],{windowsHide:true,timeout:120000});
assert.equal((await json(join(home,'state.json'))).current,manifest.id);
assert.equal((await json(join(home,'state.json'))).probation,false);
assert.equal(await readFile(join(home,'data','synthetic-preserved'),'utf8'),'synthetic-chat');
assert.equal((await json(join(home,'preferences.json'))).customPreserved,'synthetic-settings');
assert.deepEqual(await json(join(home,'channel.json')),channel);
assert.equal(await readFile(join(home,'Launch.ps1'),'utf8'),await readFile(join(home,'releases',manifest.id,'launcher/Launch.ps1'),'utf8'));
await withRuntime(await installed(home,manifest.id),async runtime=>{
  const response=await runtime.request('/api/session/'+savedSession.id);
  assert.ok(response.ok,'Updated OpenCode must read the old session');
  const session=(await response.json()).data;
  assert.equal(session.id,savedSession.id);assert.equal(session.title,savedSession.title);
  assert.equal(session.location.directory,savedSession.location.directory);
});
assert.equal((await stageUpdate(home,channel,live?{}:{fetcher:async()=>new Response(JSON.stringify(envelope))})).status,'current');
console.log(`PASS: real ${previous} -> ${manifest.id}, ${live?'published HTTPS channel':'streamed local signed assets'}, old CLI bootstrap activation, three MCP, preserved OpenCode session/data/settings/channel, repeat check current. Evidence: ${home}`);
