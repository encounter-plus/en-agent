import {readFile,mkdir,readdir,lstat,cp} from 'node:fs/promises';
import {join,dirname,relative,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {inside,noLinks,optionalJson,json,atomicJson} from './storage.mjs';
import {lockSkills} from './skills-lock.mjs';
import {validateMarkdown} from './skills-validation.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function compareSkillsVersions(a,b) {
  const parse=v=>{
    if(typeof v!=='string'||! /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v))throw Error('Invalid stable skills version');
    const parts=v.split('.').map(Number);if(parts.some(n=>!Number.isSafeInteger(n)))throw Error('Invalid skills version');return parts;
  };
  const left=parse(a),right=parse(b);
  for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;
  return 0;
}
export const skillsStoreRoot=home=>join(home,'data','en-skills');

// Validate the installed, self-contained tree, never execute its scripts.
export async function inspectSkills(directory) {
  await noLinks(directory);const files=[],names=new Set();let total=0;
  async function walk(dir) {
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const path=join(dir,entry.name),rel=relative(directory,path).replaceAll('\\','/');inside(directory,rel);
      if(/[<>:"|?*\x00-\x1f]/.test(rel)||rel.split('/').some(p=>/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe skills filename');
      if(names.has(rel.toLowerCase()))throw Error('Duplicate skills path');names.add(rel.toLowerCase());
      if(entry.isDirectory())await walk(path);
      else {
        if(!entry.isFile())throw Error('Skills links and special files are not supported');
        const size=(await lstat(path)).size;total+=size;
        if(size>8*1024*1024||total>64*1024*1024||files.length>=5000)throw Error('Skills size limit exceeded');
        const bytes=await readFile(path);files.push({path:rel,size:bytes.length,sha256:hash(bytes)});
      }
    }
  }
  await walk(directory);
  const entries=await readdir(directory,{withFileTypes:true});
  if(!entries.length||entries.some(e=>!e.isDirectory()||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.name)))throw Error('Invalid skills package layout');
  for(const entry of entries){
    const skillRoot=join(directory,entry.name),text=await readFile(join(skillRoot,'SKILL.md'),'utf8');
    const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if(!front||!new RegExp('^name: '+entry.name+'\\r?$','m').test(front)||!/^description: .+/m.test(front))throw Error('Invalid skill metadata: '+entry.name);
    for(const file of files.filter(f=>f.path.startsWith(entry.name+'/')&&f.path.endsWith('.md'))){
      await validateMarkdown(inside(directory,file.path),skillRoot);
    }
  }
  if(!entries.some(e=>e.name==='game-author'))throw Error('Incomplete en-skills package: game-author missing');
  return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}

async function selection(home,verify=true) {
  const store=skillsStoreRoot(home);await noLinks(store);
  await noLinks(join(store,'state.json'));
  const state=await optionalJson(join(store,'state.json'));if(!state)return null;
  if(state.schemaVersion!==1||!state.active||! /^[a-f0-9-]{36}$/.test(state.active.generation))throw Error('Invalid skills state');
  compareSkillsVersions(state.active.version,state.active.version);
  const directory=inside(store,'generations/'+state.active.generation+'/skills');
  if(verify){
    await noLinks(join(dirname(directory),'files.json'));
    const manifest=await json(join(dirname(directory),'files.json'));
    if(JSON.stringify(await inspectSkills(directory))!==JSON.stringify(manifest))throw Error('Skills integrity failure');
  }
  return {state,directory,version:state.active.version};
}

async function publish(home,source,version,origin,state,appliedBundle,guard,signal) {
  compareSkillsVersions(version,version);
  const files=await inspectSkills(source),store=skillsStoreRoot(home),generation=randomUUID();
  const root=inside(store,'generations/'+generation),directory=join(root,'skills');
  await noLinks(root);await mkdir(directory,{recursive:true});
  for(const file of files){signal?.throwIfAborted();const target=inside(directory,file.path);await mkdir(dirname(target),{recursive:true});await cp(inside(source,file.path),target);}
  if(JSON.stringify(await inspectSkills(directory))!==JSON.stringify(files))throw Error('Skills changed during installation');
  await atomicJson(join(root,'files.json'),files);
  const next={schemaVersion:1,appliedBundle,active:{generation,version,source:origin},previous:state?.active??null};
  // The pointer is the only mutable publication step. Older generations stay available.
  signal?.throwIfAborted();await guard.commit(next);
  return {state:next,directory,version};
}

export async function prepareSkills(bundle,home) {
  const store=skillsStoreRoot(home),guard=await lockSkills(store,{waitMs:10000});
  try {
    const current=await selection(home,false),m=bundle.manifest;
    compareSkillsVersions(m.skillsVersion,m.skillsVersion);
    if(current?.state.appliedBundle===m.id)return await selection(home);
    if(current&&compareSkillsVersions(m.skillsVersion,current.version)<0){
      await selection(home);
      const state={...current.state,appliedBundle:m.id};await guard.commit(state);return {...current,state};
    }
    // Copy only manifest-listed files from the verified bundle, never untracked additions.
    const source=inside(bundle.root,m.skillsPath),prefix=m.skillsPath+'/';
    const actual=await inspectSkills(source),expected=m.files.filter(f=>f.path.startsWith(prefix)).map(f=>({path:f.path.slice(prefix.length),size:f.size,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path,'en'));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Bundled skills integrity failure');
    return await publish(home,source,m.skillsVersion,'bundle:'+m.id,current?.state,m.id,guard);
  } finally {await guard.release();}
}

export async function skillsStatus(home,loadedDirectory) {
  const current=await selection(home);if(!current)throw Error('Skills store is not initialized');
  return {version:current.version,source:current.state.active.source,restartRequired:Boolean(loadedDirectory&&resolve(loadedDirectory)!==current.directory)};
}

// The callback prepares a validated candidate while the store lock serializes all writers.
export async function updateSkills(home,prepare,{signal}={}) {
  const guard=await lockSkills(skillsStoreRoot(home),{signal});
  try {
    const current=await selection(home);if(!current)throw Error('Skills store is not initialized');
    const candidate=await prepare(current.version);
    signal?.throwIfAborted();
    if(!candidate)return {status:'current',version:current.version};
    if(compareSkillsVersions(candidate.version,current.version)<=0)return {status:'current',version:current.version};
    const next=await publish(home,candidate.directory,candidate.version,candidate.source,current.state,current.state.appliedBundle,guard,signal);
    return {status:'updated',previousVersion:current.version,version:next.version,restartRequired:true};
  } finally {await guard.release();}
}
