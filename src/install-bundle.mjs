import {mkdir,cp,rename,rm,readdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {installed,verifyBundle,validateManifest,activatePending,syncBootstrap} from './releases.mjs';
import {json,optionalJson,atomicJson,noLinks,inside,lock} from './storage.mjs';

// Offline setup uses the same activation/backup protocol as the online updater.
// No host data, preferences, game files or Credential Manager entries are replaced.
export async function installBundle(source,home){
  source=resolve(source);home=resolve(home);
  const bundle=await installed(source,(await json(join(source,'state.json'))).current),m=bundle.manifest;
  const channel=await json(join(source,'channel.json'));
  const unlock=await lock(home);
  let stage;
  try{
    const state=await optionalJson(join(home,'state.json'))??{};
    if(state.current&&!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(state.current))throw Error('Invalid installed release ID');
    if((state.highestSequence??0)>m.sequence)throw Error('Установлена или подготовлена версия новее этого установщика.');
    const releases=join(home,'releases');await noLinks(releases);
    // Also protect a newer installation whose state.json was lost.
    for(const entry of await readdir(releases,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
      if(!entry.isDirectory()||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(entry.name))continue;
      const path=join(releases,entry.name,'release.json');await noLinks(path);
      const previous=await optionalJson(path);if(!previous)continue;
      validateManifest(previous);
      if(previous.sequence>m.sequence)throw Error('В этой папке есть версия новее этого установщика.');
    }
    const trusted=await optionalJson(join(home,'channel.json'));
    if(trusted&&trusted.publicKey!==channel.publicKey)throw Error('Ключ подписи установленного канала отличается от установщика.');
    const target=join(releases,m.id);await noLinks(target);
    let intact=false;try{await verifyBundle(target,m);intact=true;}catch(e){if(!/ENOENT|integrity/.test(String(e)))throw e;}
    if(!intact){
      stage=join(home,'staging','setup-'+randomUUID());await noLinks(stage);await mkdir(stage,{recursive:true});
      for(const file of m.files){const destination=inside(stage,file.path);await mkdir(dirname(destination),{recursive:true});await cp(inside(bundle.root,file.path),destination);}
      await atomicJson(join(stage,'release.json'),m);await verifyBundle(stage,m);await mkdir(releases,{recursive:true});
      // Preserve a damaged copy for inspection instead of merging or deleting it.
      const saved=join(home,'backups','release-'+randomUUID());await noLinks(saved);await mkdir(dirname(saved),{recursive:true});
      let moved=false;try{await rename(target,saved);moved=true;}catch(e){if(e.code!=='ENOENT')throw e;}
      try{await rename(stage,target);stage=undefined;}catch(e){if(moved)await rename(saved,target);throw e;}
    }
    await atomicJson(join(target,'release.json'),m);
    const selected={root:target,manifest:m};
    await syncBootstrap(home,selected);
    const exe=join(home,'en-agent.exe');await noLinks(exe);
    const temporary=exe+'.'+randomUUID()+'.tmp';
    try{await cp(join(target,'launcher/en-agent.exe'),temporary);await rename(temporary,exe);}finally{await rm(temporary,{force:true});}
    if(!trusted)await atomicJson(join(home,'channel.json'),channel);
    if(state.current!==m.id){
      await atomicJson(join(home,'state.json'),{...state,pending:m.id});
      return await activatePending(home);
    }
    // Re-running setup must not destroy the rollback snapshot from the first install.
    return state;
  }finally{if(stage)await rm(stage,{recursive:true,force:true});await unlock();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const state=await installBundle(process.argv[2],process.argv[3]);console.log('Установлен en-agent '+state.current+'. Данные сохранены.');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
