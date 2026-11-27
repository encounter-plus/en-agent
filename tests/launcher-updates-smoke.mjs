// Runs the shipped launcher against an offline/online synthetic release. Never opens a browser.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicJson,json,optionalJson} from '../src/storage.mjs';
import {processIdentity} from '../src/process-identity.mjs';

const source=resolve(process.argv[2]),state=await json(join(source,'state.json'));
const home=await mkdtemp(resolve('.local/launcher-updates-'));
const release=join(home,'releases',state.current),manifest=await json(join(source,'releases',state.current,'release.json'));
await cp(join(source,'releases',state.current),release,{recursive:true});
await atomicJson(join(home,'state.json'),state);
await atomicJson(join(home,'channel.json'),{manifestUrl:'https://example.invalid/channel',assetsUrl:'https://example.invalid/',publicKey:'synthetic'});
const fixture=join(home,'fixture');
await mkdir(join(fixture,'game-author'),{recursive:true});
await writeFile(join(fixture,'game-author/SKILL.md'),'---\nname: game-author\ndescription: Synthetic update fixture\n---\nFixture');
const archive=join(home,'fixture.zip');
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:FIXTURE_ROOT,$env:FIXTURE_ZIP)'],
{env:{...process.env,FIXTURE_ROOT:fixture,FIXTURE_ZIP:archive},windowsHide:true});
const version='1.2.3',name='en-skills-'+version+'.zip',url='https://github.com/encounter-plus/en-skills/releases/download/'+version+'/'+name;
const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
const metadata={draft:false,prerelease:false,tag_name:version,assets:[{name,browser_download_url:url},{name:name+'.sha256',browser_download_url:url+'.sha256'}]};
const preload=join(home,'network.mjs'),online=join(home,'online'),trace=join(home,'requests');
await writeFile(preload,`import {existsSync,appendFileSync,readFileSync} from 'node:fs';
const realFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
  const href=String(input);
  if(['localhost','127.0.0.1','[::1]'].includes(new URL(href).hostname))return realFetch(input,options);
  if(process.argv[1]?.endsWith('cli.mjs'))appendFileSync(${JSON.stringify(trace)},href+'\\n');
  if(!existsSync(${JSON.stringify(online)}))throw Error('offline');
  if(href==='https://api.github.com/repos/encounter-plus/en-skills/releases/latest')return Response.json(${JSON.stringify(metadata)});
  if(href===${JSON.stringify(url)})return new Response(readFileSync(${JSON.stringify(archive)}));
  if(href===${JSON.stringify(url+'.sha256')})return new Response(${JSON.stringify(digest+'  '+name)});
  throw Error('offline');
};`);
const preferences=join(home,'preferences.json'),request=join(home,'game-request.json');
await atomicJson(preferences,{browser:'auto',keep:'fixture'});
const birth=await processIdentity(process.pid);
let child,exit,errors;
function start(){
  errors='';
  child=spawn(join(release,manifest.nodePath),[join(release,manifest.launcherPath),'--home',home,'--wait-request',request,
    '--no-browser','--parent-pid',String(process.pid),'--parent-birth',birth],{env:{...process.env,NODE_OPTIONS:'--import='+pathToFileURL(preload).href},windowsHide:true,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000);});
  exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
}
async function waitFor(predicate){
  const until=Date.now()+90000;
  while(Date.now()<until){
    if(child.exitCode!==null)throw Error('Launcher exited early: '+child.exitCode+' '+errors);
    const status=await optionalJson(join(home,'status.json'));
    if(status&&predicate(status))return status;
    await delay(150);
  }
  throw Error('Launcher status timed out: '+JSON.stringify(await optionalJson(join(home,'status.json'))));
}
async function stop(){
  await writeFile(join(home,'stop.request'),'stop');
  assert.equal(await Promise.race([exit,delay(20000,'timeout',{ref:false})]),0);
}
try{
  start();
  await waitFor(s=>s.stage==='skills'&&s.app?.status==='failed'&&s.skills?.status==='failed');
  assert.equal(await optionalJson(join(home,'data/en-skills/state.json')),null);
  await writeFile(online,'online');
  await writeFile(join(home,'updates.request'),'check');
  await waitFor(s=>s.skills?.status==='updated');
  await atomicJson(request,{game:join(home,'game'),name:'Synthetic'});
  const ready=await waitFor(s=>s.stage==='ready');
  assert.equal(ready.loadedSkills,version);
  const pointer=await json(join(home,'data/en-skills/state.json'));
  await writeFile(join(home,'updates.request'),'check');
  await waitFor(s=>s.skills?.status==='current'&&s.app?.status==='failed');
  await stop();
  await unlink(online);
  await unlink(join(home,'status.json'));
  start();
  await waitFor(s=>s.stage==='ready'&&s.loadedSkills===version&&s.skills?.status==='failed');
  assert.deepEqual(await json(join(home,'data/en-skills/state.json')),pointer);
  assert.equal((await json(preferences)).keep,'fixture');
  assert.equal((await readFile(trace,'utf8')).split('\n').filter(line=>line===url).length,1);
  await stop();
  console.log('PASS: pre-selection check, first-run offline retry, one ZIP, manual recheck, offline restart with the same generation.');
}finally{
  if(child&&child.exitCode===null)await stop();
}
