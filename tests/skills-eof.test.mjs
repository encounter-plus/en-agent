import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {atomicJson,json} from '../src/storage.mjs';
import {prepareSkills} from '../src/skills-store.mjs';
import {activatePending} from '../src/releases.mjs';
import {lockSkills} from '../src/skills-lock.mjs';

async function bundle(home,id,version,sequence){
 const root=join(home,'releases',id),files=[];
 const contents={'bin/node':'node','bin/opencode':'opencode','runtime/server.mjs':'server','skills/game-author/SKILL.md':'---\nname: game-author\ndescription: Fixture\n---\nSynthetic','skills/game-author/scripts/init-workspace.mjs':'export {};'};
 for(const [path,body]of Object.entries(contents)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),body);files.push({path,size:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});}
 const manifest={schemaVersion:1,id,sequence,storageEpoch:2,platform:process.platform,arch:process.arch,opencode:{version:'2.3.0',configVersion:2,path:'bin/opencode'},nodePath:'bin/node',skillsPath:'skills',mcpPath:'runtime/server.mjs',skillsVersion:version,mcpVersion:'0.0.1',files};
 await atomicJson(join(root,'release.json'),manifest);return {root,manifest};
}

test('CLI preserves pending application update when the skills mutex remains busy',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const home=await mkdtemp(join(tmpdir(),'skills-busy-cli-'));let guard,child;
 try{
  const old=await bundle(home,'0.1.1','1.0.0',1);await bundle(home,'0.1.2','1.1.0',2);await prepareSkills(old,home);
  const body="export async function run(){console.log('SYNTHETIC_CURRENT_STARTED');return false;}";
  await writeFile(join(old.root,'fixture.mjs'),body);old.manifest.launcherPath='fixture.mjs';old.manifest.files.push({path:'fixture.mjs',size:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});await atomicJson(join(old.root,'release.json'),old.manifest);
  const state={current:'0.1.1',pending:'0.1.2',highestSequence:1};await atomicJson(join(home,'state.json'),state);
  guard=await lockSkills(join(home,'data','en-skills'));
  child=spawn(process.execPath,[resolve('src/cli.mjs'),'--home',home],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{output+=bytes;});
  const [code]=await once(child,'exit');assert.equal(code,0,output);assert.match(output,/SYNTHETIC_CURRENT_STARTED/);
  assert.deepEqual(await json(join(home,'state.json')),state,'A temporary busy lock must not reject or discard the prepared release');
 }finally{child?.kill();await guard?.release();await rm(home,{recursive:true,force:true});}
});
test('MCP EOF cancels download and does not reject a valid pending application update',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const home=await mkdtemp(join(tmpdir(),'skills-eof-'));let child;
 try{
  const old=await bundle(home,'0.1.1','1.0.0',1),next=await bundle(home,'0.1.2','1.1.0',2);await prepareSkills(old,home);
  await atomicJson(join(home,'state.json'),{current:'0.1.1',pending:'0.1.2',highestSequence:1});
  const marker=join(home,'downloading'),preload=join(home,'network.mjs');
  await writeFile(preload,`import {writeFile} from 'node:fs/promises';globalThis.fetch=async(url,{signal})=>{await writeFile(${JSON.stringify(marker)},'started');return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});};`);
  child=spawn(process.execPath,['--import',pathToFileURL(preload).href,resolve('dist/tools-server.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,EN_AGENT_HOME:home,EN_AGENT_BUNDLE_ROOT:old.root}});
  child.stderr.resume();let buffer='';const responses=new Map();
  child.stdout.on('data',bytes=>{buffer+=bytes;let end;while((end=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const message=JSON.parse(line);responses.get(message.id)?.(message);}});
  const initialize=new Promise(resolve=>responses.set(1,resolve));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})+'\n');
  assert.ok((await initialize).result);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'en_skills_update',arguments:{}}})+'\n');
  const deadline=Date.now()+10000;let downloading=false;
  while(Date.now()<deadline){try{await access(marker);downloading=true;break;}catch{}await new Promise(done=>setTimeout(done,20));}
  assert.ok(downloading,'Download must hold the guard when stdin closes');
  const exit=once(child,'exit');child.stdin.end();
  await activatePending(home);assert.equal((await prepareSkills(next,home)).version,'1.1.0');
  await exit;
  const state=await json(join(home,'state.json'));assert.equal(state.current,'0.1.2');assert.ok(!state.rejectedVersions?.includes('0.1.2'));
 }finally{child?.kill();await rm(home,{recursive:true,force:true});}
});
