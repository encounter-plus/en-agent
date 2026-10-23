import {readFile,writeFile,mkdir,rename,lstat,rm,rmdir,open} from 'node:fs/promises';
import {installationId,processIdentity} from './process-identity.mjs';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

export async function json(path) {return JSON.parse(await readFile(path,'utf8'));}
export async function optionalJson(path) {try{return await json(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function inside(root,path) {
  if(typeof path!=='string'||!path||path.includes('\\')||path.includes(':')||path.startsWith('/')||path.split('/').some(x=>!x||x==='.'||x==='..')) throw new Error('Unsafe bundle path');
  const full=resolve(root,path),rel=relative(resolve(root),full);
  if(isAbsolute(rel)||rel.startsWith('..')) throw new Error('Unsafe bundle path');
  return full;
}
export async function noLinks(path) {
  for(let p=resolve(path);;p=dirname(p)) {
    try{if((await lstat(p)).isSymbolicLink())throw new Error('Symbolic links are not supported: '+p);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(dirname(p)===p)break;
  }
}
export async function atomicJson(path,value) {
  await noLinks(path);await mkdir(dirname(path),{recursive:true});
  const temporary=path+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  await rename(temporary,path);
}
export async function lock(home) {
  await noLinks(home);await mkdir(home,{recursive:true});
  const path=join(home,'launcher.lock');
  const installation=await installationId(home);
  const owner={pid:process.pid,birth:await processIdentity(process.pid),installation,nonce:randomUUID()};
  for(let attempt=0;attempt<3;attempt++){
    try{await mkdir(path);await atomicJson(join(path,'owner.json'),owner);break;}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      await noLinks(path);
      const previous=await optionalJson(join(path,'owner.json'));
      if(!previous?.birth||previous.installation!==installation||!previous.nonce)throw Error('Launcher lock owner is unknown; manual inspection required');
      if(await processIdentity(previous.pid)===previous.birth)throw Error('en-agent is already running');
      // Serialize recovery, then recheck the owner to avoid removing a replacement lock.
      const claim=await open(join(path,'recovery'),'wx').catch(()=>{throw Error('Launcher lock recovery is already running');});
      try{
        const current=await optionalJson(join(path,'owner.json'));
        if(current?.nonce!==previous.nonce)throw Error('Launcher owner changed; retry launch');
        if(await processIdentity(current.pid)===current.birth)throw Error('en-agent is already running');
        await rm(join(path,'owner.json'));
      }finally{await claim.close();await rm(join(path,'recovery'));}
      await rmdir(path);
      if(attempt===2)throw Error('Launcher ownership changed repeatedly');
    }
  }
  return async()=>{if((await optionalJson(join(path,'owner.json')))?.nonce!==owner.nonce)throw Error('Launcher ownership changed');await rm(join(path,'owner.json'));await rmdir(path);};
}
