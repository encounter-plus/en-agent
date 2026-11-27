import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {compareSkillsVersions,prepareSkills,skillsStatus,skillsStoreRoot,inspectSkills,updateSkills} from '../src/skills-store.mjs';
import {updateEnSkills,extractSkillsArchive,skillsReleaseUrl} from '../src/skills-update.mjs';
import {atomicJson,json} from '../src/storage.mjs';
import {lockSkills} from '../src/skills-lock.mjs';
import {activatePending,rejectCurrent,installed} from '../src/releases.mjs';
import {configuration} from '../src/opencode.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const content=label=>({'game-author/SKILL.md':'---\nname: game-author\ndescription: Synthetic skill\n---\n'+label+'\n[Reference](references/rules.md)\n','game-author/references/rules.md':'Synthetic rules','game-author/scripts/init-workspace.mjs':'export {};'});
async function tree(path,label){for(const [file,body]of Object.entries(content(label))){await mkdir(dirname(join(path,file)),{recursive:true});await writeFile(join(path,file),body);}return path;}
async function bundle(base,id,version,label=id){
 const root=join(base,'releases',id);await tree(join(root,'skills'),label);
 for(const file of ['bin/node','bin/opencode','runtime/server.mjs']){await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),'synthetic');}
 const files=(await inspectSkills(join(root,'skills'))).map(f=>({...f,path:'skills/'+f.path}));
 for(const path of ['bin/node','bin/opencode','runtime/server.mjs'])files.push({path,size:9,sha256:hash('synthetic')});
 const manifest={schemaVersion:1,bootstrapProtocol:1,id,sequence:Number(id.split('.')[2])+1,storageEpoch:2,platform:process.platform,arch:process.arch,opencode:{version:'2.3.0',configVersion:2,path:'bin/opencode'},nodePath:'bin/node',skillsPath:'skills',mcpPath:'runtime/server.mjs',skillsVersion:version,mcpVersion:'0.0.1',files};
 await atomicJson(join(root,'release.json'),manifest);return {root,manifest};
}
async function scenario(run){const home=await mkdtemp(join(tmpdir(),'en-skills-store-'));try{await run(home);}finally{await rm(home,{recursive:true,force:true});}}
async function independent(home,version,label=version){const directory=await tree(join(home,'candidate-'+version),label);return updateSkills(home,async()=>({version,directory,source:'synthetic-release'}));}

test('skills versions use numeric precedence and reject malformed/pre-release versions',()=>{
 assert.equal(compareSkillsVersions('0.10.0','0.9.9'),1);assert.equal(compareSkillsVersions('1.0.0','1.0.0'),0);
 for(const v of ['v1.0.0','1.0','01.0.0','1.0.0-preview.1','1.0.0/../x'])assert.throws(()=>compareSkillsVersions(v,'1.0.0'));
});
test('first launch migrates bundled skills outside release and OpenCode uses only selected generation',()=>scenario(async home=>{
 const b=await bundle(home,'0.1.1','0.0.2'),selected=await prepareSkills(b,home);
 assert.ok(selected.directory.startsWith(skillsStoreRoot(home)));assert.equal((await skillsStatus(home)).version,'0.0.2');
 const config=configuration(b.root,{...b.manifest,toolsPath:'runtime/tools.mjs'},home,{},undefined,undefined,selected.directory);
 assert.deepEqual(config.skills,[selected.directory]);assert.equal(config.mcp.servers.author_tools.environment.EN_AGENT_SKILLS_ACTIVE,selected.directory);
 await installed(home,b.manifest.id);assert.equal((await prepareSkills(b,home)).directory,selected.directory);
}));
test('independent update survives restart and older en-agent skills; equal/newer bundle replaces exactly once',()=>scenario(async home=>{
 const b=await bundle(home,'0.1.1','0.0.2');const original=await prepareSkills(b,home);
 assert.equal((await independent(home,'0.0.10')).status,'updated');
 let selected=await prepareSkills(b,home);assert.equal(selected.version,'0.0.10');assert.notEqual(selected.directory,original.directory);
 assert.equal((await skillsStatus(home,original.directory)).restartRequired,true);
 const older=await bundle(home,'0.1.2','0.0.9');assert.equal((await prepareSkills(older,home)).directory,selected.directory);
 const equal=await bundle(home,'0.1.3','0.0.10','equal bundled replacement');selected=await prepareSkills(equal,home);
 assert.match(await readFile(join(selected.directory,'game-author/SKILL.md'),'utf8'),/equal bundled replacement/);
 assert.equal((await prepareSkills(equal,home)).directory,selected.directory);
 const newer=await bundle(home,'0.1.4','0.1.0');assert.equal((await prepareSkills(newer,home)).version,'0.1.0');
 await installed(home,b.manifest.id);await installed(home,newer.manifest.id);
}));
test('ownerless legacy lock remnants cannot block startup or updating intact skills',()=>scenario(async home=>{
 const b=await bundle(home,'0.1.1','0.0.2');await prepareSkills(b,home);
 await mkdir(join(skillsStoreRoot(home),'launcher.lock'));
 assert.equal((await prepareSkills(b,home)).version,'0.0.2');
 assert.equal((await independent(home,'0.0.3')).status,'updated');
 assert.equal((await prepareSkills(b,home)).version,'0.0.3');
}));
test('package validator rejects missing anchors and undefined reference labels',()=>scenario(async home=>{
 const directory=await tree(join(home,'candidate'),'test'),entry=join(directory,'game-author/SKILL.md');
 const original=await readFile(entry,'utf8');
 await writeFile(entry,original+'\n[Rule](references/rules.md#missing)\n');await assert.rejects(inspectSkills(directory),/Missing anchor/);
 await writeFile(entry,original+'\n[Rule][missing-label]\n');await assert.rejects(inspectSkills(directory),/Undefined reference/);
 await writeFile(join(directory,'game-author/references/rules.md'),'# Valid section\n');
 await writeFile(entry,original+'\n[Rule](references/rules.md#valid-section)\n');await inspectSkills(directory);
}));
test('interrupted candidates, missing references and concurrent writers preserve active skills',()=>scenario(async home=>{
 const b=await bundle(home,'0.1.1','0.0.2');const selected=await prepareSkills(b,home),state=await readFile(join(skillsStoreRoot(home),'state.json'),'utf8');
 await assert.rejects(updateSkills(home,async()=>{throw Error('offline');}),/offline/);
 const dir=await tree(join(home,'bad'),'bad');await rm(join(dir,'game-author/references/rules.md'));
 await assert.rejects(updateSkills(home,async()=>({directory:dir,version:'0.0.3',source:'test'})));
 const guard=await lockSkills(skillsStoreRoot(home));try{await assert.rejects(independent(home,'0.0.4'),/running/);}finally{await guard.release();}
 assert.equal(await readFile(join(skillsStoreRoot(home),'state.json'),'utf8'),state);
 assert.equal((await prepareSkills(b,home)).directory,selected.directory);
}));
test('application rollback restores skills snapshot together with user data',()=>scenario(async home=>{
 const old=await bundle(home,'0.1.1','0.0.2'),next=await bundle(home,'0.1.2','0.1.0');await prepareSkills(old,home);await independent(home,'0.0.5');
 await writeFile(join(home,'data/chat'),'preserved');await atomicJson(join(home,'state.json'),{current:old.manifest.id,pending:next.manifest.id,highestSequence:2});
 await activatePending(home);await prepareSkills(next,home);assert.equal((await skillsStatus(home)).version,'0.1.0');
 await rejectCurrent(home);assert.equal((await prepareSkills(old,home)).version,'0.0.5');assert.equal(await readFile(join(home,'data/chat'),'utf8'),'preserved');
}));
test('tampering is detected without silently overwriting a newer user version',()=>scenario(async home=>{
 const b=await bundle(home,'0.1.1','0.0.2');await prepareSkills(b,home);await independent(home,'0.0.3');
 const selected=await prepareSkills(b,home);await writeFile(join(selected.directory,'game-author/references/rules.md'),'tampered');
 await assert.rejects(prepareSkills(b,home),/integrity/);assert.equal((await json(join(skillsStoreRoot(home),'state.json'))).active.version,'0.0.3');
 const equal=await bundle(home,'0.1.2','0.0.3','repair');const repaired=await prepareSkills(equal,home);
 assert.match(await readFile(join(repaired.directory,'game-author/SKILL.md'),'utf8'),/repair/);
}));

// Minimal stored ZIP fixture. Production extraction still goes through Windows ZipArchive.
function zip(entries){let offset=0;const local=[],central=[];for(const [path,value,mode=0]of entries){
 const name=Buffer.from(path),bytes=Buffer.from(value);let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(crc,14);h.writeUInt32LE(bytes.length,18);h.writeUInt32LE(bytes.length,22);h.writeUInt16LE(name.length,26);
 local.push(h,name,bytes);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);h.copy(c,6,4,28);c.writeUInt32LE(mode>>>0,38);c.writeUInt32LE(offset,42);central.push(c,name);offset+=h.length+name.length+bytes.length;
 }const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);}
async function extractorRoot(home){const root=join(home,'extractor');await mkdir(join(root,'launcher/src'),{recursive:true});await cp(resolve('src/extract-skills.ps1'),join(root,'launcher/src/extract-skills.ps1'));return root;}
function network(version,bytes,{badChecksum=false}={}){
 const name='en-skills-'+version+'.zip',url='https://github.com/encounter-plus/en-skills/releases/download/'+version+'/'+name;
 return async request=>{
  if(request===skillsReleaseUrl)return Response.json({tag_name:version,draft:false,prerelease:false,assets:[{name,browser_download_url:url,digest:'sha256:'+hash(bytes)},{name:name+'.sha256',browser_download_url:url+'.sha256'}]});
  if(request===url+'.sha256')return new Response((badChecksum?'0'.repeat(64):hash(bytes))+'  '+name+'\n');
  if(request===url)return new Response(bytes);throw Error('Unexpected network request');
 };
}
test('official update verifies archive and publishes extracted skills; older latest release cannot downgrade', {skip:process.platform!=='win32'},()=>scenario(async home=>{
 const b=await bundle(home,'0.1.1','0.0.2');await prepareSkills(b,home);const root=await extractorRoot(home),bytes=zip(Object.entries(content('from official archive')));
 const result=await updateEnSkills(home,root,{fetcher:network('0.0.3',bytes)});assert.equal(result.status,'updated');assert.equal((await skillsStatus(home)).version,'0.0.3');
 assert.equal((await updateEnSkills(home,root,{fetcher:network('0.0.1',bytes)})).status,'current');
 assert.deepEqual(await readdir(join(home,'skills-staging')),[]);await installed(home,b.manifest.id);
}));
test('external skills bootstrap, offline reuse across app upgrades, repair and no repeated ZIP',()=>scenario(async home=>{
 const root=await extractorRoot(home), bytes=zip(Object.entries(content('downloaded'))), requests=[];
 const official=network('0.2.0',bytes);
 const fetcher=url=>{requests.push(url);return official(url);};
 const app={root,manifest:{id:'1.0.0',minimumSkillsVersion:'0.1.0'}};
 assert.equal(await prepareSkills(app,home),null);
 await assert.rejects(updateEnSkills(home,root,{fetcher:async()=>{throw Error('offline');}}),/offline/);
 assert.equal(await prepareSkills(app,home),null);
 await updateEnSkills(home,root,{fetcher});
 const initial=await prepareSkills(app,home);
 assert.equal(initial.version,'0.2.0');
 app.manifest.id='1.1.0';
 assert.equal((await prepareSkills(app,home)).directory,initial.directory);
 await updateEnSkills(home,root,{fetcher});
 assert.equal(requests.filter(url=>url.endsWith('.zip')).length,1);
 await independent(home,'0.3.0');
 const newer=await prepareSkills(app,home);
 await writeFile(join(newer.directory,'game-author/SKILL.md'),'damaged');
 assert.equal((await prepareSkills(app,home)).directory,initial.directory);
 await writeFile(join(initial.directory,'game-author/SKILL.md'),'damaged');
 assert.equal(await prepareSkills(app,home),null);
 await updateEnSkills(home,root,{fetcher});
 assert.equal((await prepareSkills(app,home)).version,'0.2.0');
}));
test('application snapshots exclude mutable extraction and survive cancelled skills updates',{skip:process.platform!=='win32'},()=>scenario(async home=>{
 const old=await bundle(home,'0.1.1','0.0.2'),next=await bundle(home,'0.1.2','0.0.3');await prepareSkills(old,home);
 await atomicJson(join(home,'state.json'),{current:old.manifest.id,pending:next.manifest.id,highestSequence:old.manifest.sequence});
 const controller=new AbortController();let started;
 const extracting=new Promise(resolve=>{started=resolve;});
 const update=updateEnSkills(home,home,{fetcher:network('0.0.4',Buffer.from('synthetic archive')),signal:controller.signal,extract:async(archive,directory,root,{signal})=>{
  await mkdir(directory,{recursive:true});await writeFile(join(directory,'partial.txt'),'incomplete');started(directory);
  await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});
 }});
 const cancelled=assert.rejects(update,/cancel fixture/);
 try{
  const directory=await extracting;
  assert.ok(directory.startsWith(join(home,'skills-staging')+ '\\'));
  controller.abort(Error('cancel fixture'));
  const active=await activatePending(home);
  assert.deepEqual(await readdir(join(home,'backups',active.backup,'data','en-skills')),['generations','state.json']);
  await cancelled;
  assert.equal((await prepareSkills(next,home)).version,'0.0.3');
  assert.deepEqual(await readdir(join(home,'skills-staging')),[]);
 }finally{controller.abort(Error('cancel fixture'));await cancelled;}
}));
test('application snapshot waits for skills publication and rollback restores a coherent generation',{skip:process.platform!=='win32'},()=>scenario(async home=>{
 const old=await bundle(home,'0.1.1','0.0.2'),next=await bundle(home,'0.1.2','0.0.3');await prepareSkills(old,home);
 await atomicJson(join(home,'state.json'),{current:old.manifest.id,pending:next.manifest.id,highestSequence:old.manifest.sequence});
 const directory=await tree(join(home,'candidate'),'independent');let ready,proceed;
 const holding=new Promise(resolve=>{ready=resolve;}),gate=new Promise(resolve=>{proceed=resolve;});
 const update=updateSkills(home,async()=>{ready();await gate;return {version:'0.0.4',directory,source:'fixture'};});
 await holding;let activated=false;
 const activation=activatePending(home).then(state=>{activated=true;return state;});
 try{await new Promise(resolve=>setTimeout(resolve,600));assert.equal(activated,false,'Snapshot must wait for the active writer');}
 finally{proceed();}
 await update;const active=await activation;
 const snapshot=await json(join(home,'backups',active.backup,'data','en-skills','state.json'));
 assert.equal(snapshot.active.version,'0.0.4');
 assert.ok(await json(join(home,'backups',active.backup,'data','en-skills','generations',snapshot.active.generation,'files.json')));
 await prepareSkills(next,home);await rejectCurrent(home);
 assert.equal((await skillsStatus(home)).version,'0.0.4');
}));
test('extractor ignores a powershell.exe planted in the working directory',{skip:process.platform!=='win32'},()=>scenario(async home=>{
 const root=await extractorRoot(home),archive=join(home,'good.zip'),directory=join(home,'extracted');
 await writeFile(archive,zip(Object.entries(content('safe helper'))));await writeFile(join(home,'powershell.exe'),'invalid executable');
 const cwd=process.cwd();try{process.chdir(home);await extractSkillsArchive(archive,directory,root);}finally{process.chdir(cwd);}
 await inspectSkills(directory);
}));
test('bad checksum, untrusted origin and malformed archive leave current generation intact', {skip:process.platform!=='win32'},()=>scenario(async home=>{
 const b=await bundle(home,'0.1.1','0.0.2');await prepareSkills(b,home);const root=await extractorRoot(home),bytes=zip(Object.entries(content('candidate')));
 await assert.rejects(updateEnSkills(home,root,{fetcher:network('0.0.3',bytes,{badChecksum:true})}),/checksum/);
 await assert.rejects(updateEnSkills(home,root,{fetcher:async()=>new Response(null,{status:302,headers:{location:'https://evil.example/archive'}})}),/origin/);
 await assert.rejects(updateEnSkills(home,root,{fetcher:network('0.0.3',Buffer.from('invalid ZIP'))}));
 assert.equal((await skillsStatus(home)).version,'0.0.2');
}));
test('ZIP traversal, duplicate Windows paths and symlinks are rejected before publication', {skip:process.platform!=='win32'},()=>scenario(async home=>{
 const root=await extractorRoot(home);
 for(const [i,entries]of [[['../escaped','bad']], [['game-author/a','a'],['GAME-AUTHOR/A','b']], [['game-author/link','../escape',0xa1ff0000]], [['game-author/CON.txt','bad']]].entries()){
  const archive=join(home,'bad-'+i+'.zip');await writeFile(archive,zip(entries));await assert.rejects(extractSkillsArchive(archive,join(home,'out-'+i),root));
 }
 assert.ok(!(await readdir(home)).includes('escaped'));
}));
