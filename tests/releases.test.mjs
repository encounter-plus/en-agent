import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {signedManifest,stageUpdate,activatePending,rejectCurrent,installed} from '../src/releases.mjs';
import {atomicJson,json,lock} from '../src/storage.mjs';
import {configuration} from '../src/opencode.mjs';

const keys=generateKeyPairSync('ed25519');
function fixture(id,sequence) {
  const contents={'bin/opencode':'binary','bin/node':'node','skills/game-author/SKILL.md':'skill','skills/game-author/scripts/init-workspace.mjs':'export {};','runtime/server.mjs':'server'};
  const m={schemaVersion:1,id,sequence,storageEpoch:2,platform:process.platform,arch:process.arch,opencode:{version:'2.0.32',configVersion:2,path:'bin/opencode'},nodePath:'bin/node',skillsPath:'skills',mcpPath:'runtime/server.mjs',skillsVersion:'0.2.0',mcpVersion:'0.1.0',files:Object.entries(contents).map(([path,body])=>({path,size:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}))};
  const payload=Buffer.from(JSON.stringify(m));
  return {m,contents,envelope:{payload:payload.toString('base64'),signature:sign(null,payload,keys.privateKey).toString('base64')}};
}
async function install(home,f){const root=join(home,'releases',f.m.id);for(const [path,body]of Object.entries(f.contents)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),body);}await atomicJson(join(root,'release.json'),f.m);}
const channel={manifestUrl:'https://updates.example/channel.json',assetsUrl:'https://updates.example/releases/',publicKey:keys.publicKey.export({type:'spki',format:'pem'})};
const network=(f,corrupt=false)=>async url=>new Response(String(url).endsWith('channel.json')?JSON.stringify(f.envelope):(corrupt?'bad':f.contents[decodeURIComponent(new URL(url).pathname.split('/').slice(3).join('/'))]??'missing'));

test('only signed complete compatible manifests are accepted',()=>{
  const f=fixture('0.1.0',1);assert.equal(signedManifest(f.envelope,channel.publicKey).id,'0.1.0');
  assert.throws(()=>signedManifest({...f.envelope,payload:Buffer.from('{}').toString('base64')},channel.publicKey),/signature/);
  f.m.files[0].path='../outside';const payload=Buffer.from(JSON.stringify(f.m));
  assert.throws(()=>signedManifest({payload:payload.toString('base64'),signature:sign(null,payload,keys.privateKey).toString('base64')},channel.publicKey),/Unsafe/);
});

test('updates stage without switching, activate next start, and restore data on failed startup',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-agent-'));
  try {
    await install(home,fixture('0.1.0',1));await atomicJson(join(home,'state.json'),{current:'0.1.0',highestSequence:1});
    await mkdir(join(home,'data'));await writeFile(join(home,'data','chat'),'original');
    const next=fixture('0.2.0',2);
    assert.equal((await stageUpdate(home,channel,{fetcher:network(next)})).status,'staged');
    assert.equal((await json(join(home,'state.json'))).current,'0.1.0');
    assert.equal((await activatePending(home)).current,'0.2.0');
    await writeFile(join(home,'data','chat'),'migration');
    await rejectCurrent(home);
    assert.equal((await json(join(home,'state.json'))).current,'0.1.0');
    assert.equal(await readFile(join(home,'data','chat'),'utf8'),'original');
    assert.equal((await stageUpdate(home,channel,{fetcher:network(next)})).status,'current');
  }finally{await rm(home,{recursive:true,force:true});}
});

test('corrupt or interrupted downloads leave the installed release intact',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-agent-'));
  try {
    await install(home,fixture('0.1.0',1));await atomicJson(join(home,'state.json'),{current:'0.1.0',highestSequence:1});
    await assert.rejects(stageUpdate(home,channel,{fetcher:network(fixture('0.2.0',2),true)}),/integrity|limit/);
    await assert.rejects(stageUpdate(home,channel,{fetcher:async()=>{throw new Error('offline');}}),/offline/);
    assert.equal((await json(join(home,'state.json'))).current,'0.1.0');
    await installed(home,'0.1.0');
  }finally{await rm(home,{recursive:true,force:true});}
});

test('one launcher owns update and process lifecycle; config pins skills and MCP outside game',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-agent-'));
  try {
    const unlock=await lock(home);await assert.rejects(lock(home),/already running/);await unlock();const unlock2=await lock(home);await unlock2();
    const config=configuration(home,fixture('0.1.0',1).m,home);
    assert.equal(config.update,'disable');assert.equal(config.skills.length,1);assert.equal(config.mcp.servers.encounter.command.length,2);
    assert.deepEqual(config.websearch,{provider:'exa'});
    assert.match(config.mcp.servers.encounter.environment.ENCOUNTER_DATA_DIR,/encounter$/);
  }finally{await rm(home,{recursive:true,force:true});}
});

test('caller cancellation aborts an unfinished download and preserves the installed release',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-update-cancel-')),abort=new AbortController();
  try {
    await install(home,fixture('0.1.0',1));await atomicJson(join(home,'state.json'),{current:'0.1.0',highestSequence:1});
    const next=fixture('0.2.0',2);
    await assert.rejects(stageUpdate(home,channel,{signal:abort.signal,fetcher:async(url,options)=>{
      if(String(url).endsWith('channel.json'))return new Response(JSON.stringify(next.envelope));
      return new Response(new ReadableStream({start(controller){
        options.signal.addEventListener('abort',()=>controller.error(options.signal.reason),{once:true});
        queueMicrotask(()=>abort.abort(new Error('cancelled by user')));
      }}));
    }}),/cancelled by user/);
    assert.deepEqual(await readdir(join(home,'staging')),[]);
    assert.deepEqual(await json(join(home,'state.json')),{current:'0.1.0',highestSequence:1});
    await installed(home,'0.1.0');
  }finally{await rm(home,{recursive:true,force:true});}
});

test('mid-stream disconnect cleans staging; authenticated corrupt release is not downloaded again',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-update-'));
  try{
    await install(home,fixture('0.1.0',1));await atomicJson(join(home,'state.json'),{current:'0.1.0',highestSequence:1});
    const f=fixture('0.2.0',2);
    await assert.rejects(stageUpdate(home,channel,{fetcher:async url=>String(url).endsWith('channel.json')?new Response(JSON.stringify(f.envelope)):new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.error(Error('connection lost'));}}))}),/connection lost/);
    assert.deepEqual(await readdir(join(home,'staging')),[]);
    await assert.rejects(stageUpdate(home,channel,{fetcher:network(f,true)}),/integrity|limit/);
    let assets=0;
    const result=await stageUpdate(home,channel,{fetcher:async url=>{if(!String(url).endsWith('channel.json'))assets++;return network(f)(url);}});
    assert.equal(result.status,'current');assert.equal(assets,0);
  }finally{await rm(home,{recursive:true,force:true});}
});

test('real CLI rolls back a broken new launcher and restores data before running previous version',async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-rollback-'));
  try{
    for(const [version,sequence,source] of [
      ['0.1.0',1,"export async function run(home){const fs=await import('node:fs/promises');await fs.writeFile(home+'/recovered.txt',await fs.readFile(home+'/data/chat'));}"],
      ['0.2.0',2,"export async function run(home){const fs=await import('node:fs/promises');await fs.writeFile(home+'/data/chat','broken migration');throw Error('Broken new runtime');}"]]){
      const f=fixture(version,sequence);f.contents['launcher/cli.mjs']=source;f.m.launcherPath='launcher/cli.mjs';f.m.files.push({path:'launcher/cli.mjs',size:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex')});await install(home,f);
    }
    await mkdir(join(home,'data'));await writeFile(join(home,'data/chat'),'original chat');
    await atomicJson(join(home,'state.json'),{current:'0.1.0',pending:'0.2.0',highestSequence:1});
    await promisify(execFile)(process.execPath,['src/cli.mjs','--home',home,'--smoke'],{windowsHide:true,timeout:30000});
    assert.equal(await readFile(join(home,'recovered.txt'),'utf8'),'original chat');assert.equal((await json(join(home,'state.json'))).current,'0.1.0');
  }finally{await rm(home,{recursive:true,force:true});}
});

for (const brokenSource of ["import './missing.mjs'; export async function run(){}", "export async function run( {"]) test('CLI rolls back failed module loading: '+brokenSource,async()=>{
  const home=await mkdtemp(join(tmpdir(),'en-rollback-'));
  try{
    for(const [version,sequence,source] of [
      ['0.1.0',1,"export async function run(home){const fs=await import('node:fs/promises');await fs.writeFile(home+'/recovered.txt',await fs.readFile(home+'/data/chat'));}"],
      ['0.2.0',2,brokenSource]]){
      const f=fixture(version,sequence);f.contents['launcher/cli.mjs']=source;f.m.launcherPath='launcher/cli.mjs';f.m.files.push({path:'launcher/cli.mjs',size:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex')});await install(home,f);
    }
    await mkdir(join(home,'data'));await writeFile(join(home,'data/chat'),'original chat');
    await atomicJson(join(home,'state.json'),{current:'0.1.0',pending:'0.2.0',highestSequence:1});
    await promisify(execFile)(process.execPath,['src/cli.mjs','--home',home,'--smoke'],{windowsHide:true,timeout:30000});
    await promisify(execFile)(process.execPath,['src/cli.mjs','--home',home,'--smoke'],{windowsHide:true,timeout:30000});
    assert.equal(await readFile(join(home,'recovered.txt'),'utf8'),'original chat');assert.equal((await json(join(home,'state.json'))).current,'0.1.0');
  }finally{await rm(home,{recursive:true,force:true});}
});
