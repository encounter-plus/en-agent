import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {installBundle} from '../src/install-bundle.mjs';
import {atomicJson,json,lock} from '../src/storage.mjs';

async function fixture(base,id,sequence){
  const home=join(base,id),root=join(home,'releases',id);
  const contents={'bin/node':'node','bin/opencode':'opencode','skills/game-author/SKILL.md':'skill','skills/game-author/scripts/init-workspace.mjs':'init','runtime/server.mjs':'mcp','launcher/Launch.ps1':'launch '+id,'launcher/Install.ps1':'install','launcher/Uninstall.ps1':'uninstall','launcher/en-agent.exe':'exe '+id};
  for(const [path,body] of Object.entries(contents)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),body);}
  await atomicJson(join(root,'release.json'),{schemaVersion:1,bootstrapProtocol:1,id,sequence,platform:process.platform,arch:process.arch,storageEpoch:2,opencode:{version:'2.3.0',configVersion:2,path:'bin/opencode'},nodePath:'bin/node',skillsPath:'skills',mcpPath:'runtime/server.mjs',skillsVersion:'0.0.2',mcpVersion:'0.0.1',files:Object.entries(contents).map(([path,body])=>({path,size:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}))});
  await atomicJson(join(home,'state.json'),{current:id,highestSequence:sequence});
  await atomicJson(join(home,'channel.json'),{publicKey:'same-trust',manifestUrl:'https://example.test/channel'});
  return home;
}
async function scenario(run){const base=await mkdtemp(join(tmpdir(),'en-install-'));try{await run(base);}finally{await rm(base,{recursive:true,force:true});}}

test('EXE upgrade preserves data, preferences, channel and old release; repeated install preserves rollback',()=>scenario(async base=>{
  const old=await fixture(base,'0.0.1',103),source=await fixture(base,'0.0.4',108);
  await mkdir(join(old,'data'));await writeFile(join(old,'data','chat'),'saved chat');await writeFile(join(old,'preferences.json'),'saved settings');
  const channel=await readFile(join(old,'channel.json'),'utf8');
  await installBundle(source,old);
  const state=await json(join(old,'state.json'));assert.equal(state.current,'0.0.4');assert.equal(state.previous,'0.0.1');assert.equal(state.probation,true);
  assert.equal(await readFile(join(old,'data','chat'),'utf8'),'saved chat');assert.equal(await readFile(join(old,'preferences.json'),'utf8'),'saved settings');assert.equal(await readFile(join(old,'channel.json'),'utf8'),channel);
  assert.equal(await readFile(join(old,'backups',state.backup,'data','chat'),'utf8'),'saved chat');
  await installBundle(source,old);assert.deepEqual(await json(join(old,'state.json')),state);
  assert.equal(await readFile(join(old,'Launch.ps1'),'utf8'),'launch 0.0.4');
}));

test('missing state reinstalls in the same folder without deleting host data; damaged binaries can be repaired',()=>scenario(async base=>{
  const source=await fixture(base,'0.0.4',108),home=join(base,'retained');await mkdir(join(home,'data'),{recursive:true});await writeFile(join(home,'data','chat'),'retained');await writeFile(join(home,'preferences.json'),'prefs');
  await installBundle(source,home);await unlink(join(home,'state.json'));await writeFile(join(home,'releases/0.0.4/bin/opencode'),'broken');
  await installBundle(source,home);
  assert.equal((await json(join(home,'state.json'))).current,'0.0.4');assert.equal(await readFile(join(home,'data/chat'),'utf8'),'retained');assert.equal(await readFile(join(home,'preferences.json'),'utf8'),'prefs');assert.equal(await readFile(join(home,'releases/0.0.4/bin/opencode'),'utf8'),'opencode');
}));

test('running launcher, downgrades and corrupt packages leave installed state unchanged',()=>scenario(async base=>{
  const old=await fixture(base,'0.0.3',107),source=await fixture(base,'0.0.4',108),state=await json(join(old,'state.json'));
  const release=await lock(old);try{await assert.rejects(installBundle(source,old),/running/);}finally{await release();}
  await atomicJson(join(old,'state.json'),{...state,highestSequence:109});await assert.rejects(installBundle(source,old),/newer|новее/);
  await atomicJson(join(old,'state.json'),state);await writeFile(join(source,'releases/0.0.4/bin/opencode'),'corrupt');await assert.rejects(installBundle(source,old),/integrity/);assert.deepEqual(await json(join(old,'state.json')),state);
}));
