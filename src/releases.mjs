import {createHash,verify,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,rename,chmod,cp,lstat,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {inside,noLinks,atomicJson,optionalJson,json} from './storage.mjs';

export function validateManifest(m) {
  if(m?.schemaVersion!==1||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(m.id)||!Number.isSafeInteger(m.sequence)||m.sequence<1)throw new Error('Invalid release identity');
  if(m.bootstrapProtocol!==undefined&&m.bootstrapProtocol!==1)throw new Error('Bootstrap installer upgrade required');
  if(m.platform!==process.platform||m.arch!==process.arch)throw new Error('Release platform mismatch');
  if(m.storageEpoch!==2)throw new Error('Storage migration requires a supported migration procedure');
  if(!/^2\.\d+\.\d+$/.test(m.opencode?.version)||m.opencode.configVersion!==2)throw new Error('Only tested OpenCode v2 configuration is supported');
  if(typeof m.skillsVersion!=='string'||typeof m.mcpVersion!=='string'||!Array.isArray(m.files)||!m.files.length)throw new Error('Incomplete release');
  const names=new Set();
  for(const f of m.files) {
    inside('.',f.path);
    if(names.has(f.path.toLowerCase())||!/^([a-f0-9]{64})$/.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0||f.size>512*1024*1024)throw new Error('Invalid release file');
    if(f.asset!==undefined&&f.asset!==f.sha256)throw new Error('Release asset must use its content hash');
    names.add(f.path.toLowerCase());
  }
  for(const p of [m.opencode.path,m.nodePath,m.skillsPath+'/game-author/SKILL.md',m.skillsPath+'/game-author/scripts/init-workspace.mjs',m.mcpPath]) {
    inside('.',p);if(!m.files.some(f=>f.path===p))throw new Error('Missing release entry: '+p);
  }
  if(Boolean(m.accountPath)!==Boolean(m.accountProxyPath))throw new Error('Incomplete account integration');
  if(m.accountPath)for(const required of ['launcher/Account.ps1','runtime/scripts/windows-credential.ps1'])if(!m.files.some(f=>f.path===required))throw new Error('Missing account helper: '+required);
  for(const p of [m.toolsPath,m.browserPath,m.launcherPath,m.accountPath,m.accountProxyPath].filter(Boolean)) {inside('.',p);if(!m.files.some(f=>f.path===p))throw new Error('Missing optional release entry: '+p);}
  return m;
}
export function signedManifest(envelope,publicKey) {
  if(typeof envelope?.payload!=='string'||typeof envelope.signature!=='string')throw new Error('Unsigned release');
  const payload=Buffer.from(envelope.payload,'base64');
  if(!verify(null,payload,publicKey,Buffer.from(envelope.signature,'base64')))throw new Error('Release signature rejected');
  return validateManifest(JSON.parse(payload.toString('utf8')));
}
export async function verifyBundle(root,m) {
  validateManifest(m);
  for(const f of m.files) {
    const path=inside(root,f.path);await noLinks(path);
    const data=await readFile(path);
    if(data.length!==f.size||createHash('sha256').update(data).digest('hex')!==f.sha256)throw new Error('Release integrity failure: '+f.path);
  }
  return m;
}
export async function installed(home,id) {
  if(!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(id))throw new Error('Invalid installed release ID');
  const root=join(home,'releases',id);await noLinks(root);
  const manifest=await json(join(root,'release.json'));
  if(manifest.id!==id)throw new Error('Release ID mismatch');
  await verifyBundle(root,manifest);return {root,manifest};
}

async function fetchBytes(url,limit,fetcher=fetch,signal) {
  // Bundled Node/OpenCode exceed 100 MB; allow the entire body to finish on ordinary connections.
  const timeout=AbortSignal.timeout(limit>1024*1024?600000:60000);
  const requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
  let response;
  for(let redirects=0;redirects<=5;redirects++){
    if(new URL(url).protocol!=='https:')throw new Error('Update channel requires HTTPS');
    response=await fetcher(url,{signal:requestSignal,redirect:'manual'});
    if(![301,302,303,307,308].includes(response.status))break;
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location||redirects===5)throw new Error('Invalid update redirect');
    url=new URL(location,url).href;
  }
  if(!response.ok)throw new Error('Update download failed: '+response.status);
  const chunks=[];let size=0;
  for await(const chunk of response.body) {size+=chunk.length;if(size>limit)throw new Error('Update download exceeds limit');chunks.push(chunk);}
  return Buffer.concat(chunks);
}

// Downloads are staged now; the next launcher invocation activates them.
export async function stageUpdate(home,channel,{fetcher=fetch,signal}={}) {
  const envelope=JSON.parse((await fetchBytes(channel.manifestUrl,1024*1024,fetcher,signal)).toString('utf8'));
  const m=signedManifest(envelope,channel.publicKey);
  const state=await optionalJson(join(home,'state.json'))??{};
  if(m.sequence<=(state.highestSequence??0)||m.id===state.current||m.id===state.pending||m.id===state.rejected||(state.rejectedVersions??[]).includes(m.id))return {status:'current'};
  const stage=join(home,'staging',randomUUID());await noLinks(stage);await mkdir(stage,{recursive:true});
  try {
  for(const f of m.files) {
    const url=new URL(m.id+'/'+(f.asset??f.path.split('/').map(encodeURIComponent).join('/')),channel.assetsUrl.endsWith('/')?channel.assetsUrl:channel.assetsUrl+'/');
    const bytes=await fetchBytes(url.href,f.size,fetcher,signal);
    if(bytes.length!==f.size||createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw new Error('Downloaded file integrity failure: '+f.path);
    const destination=inside(stage,f.path);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes,{flag:'wx'});
    if(f.executable&&process.platform!=='win32')await chmod(destination,0o755);
  }
  await atomicJson(join(stage,'release.json'),m);
  await mkdir(join(home,'releases'),{recursive:true});
  const destination=join(home,'releases',m.id);
  try{await rename(stage,destination);}catch(e){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(e.code))throw e;await verifyBundle(destination,m);}
  await atomicJson(join(home,'state.json'),{...state,pending:m.id});
  return {status:'staged',id:m.id};
  } catch(error){
    if(/integrity|exceeds limit/.test(error.message))await atomicJson(join(home,'state.json'),{...state,rejectedVersions:[...new Set([...(state.rejectedVersions??[]),m.id])]});
    throw error;
  } finally {await rm(stage,{recursive:true,force:true});}
}

async function backupData(home) {
  const backup = 'before-' + randomUUID();
  const data = join(home, 'data');
  await noLinks(data);
  const destination = join(home, 'backups', backup);
  await mkdir(destination, {recursive: true});
  let hadData = false;
  try {
    await lstat(data);
    hadData = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (hadData) {
    await cp(data, join(destination, 'data'), {
      recursive: true,
      filter: async path => {
        if ((await lstat(path)).isSymbolicLink()) throw Error('Data backup refuses symbolic links');
        return true;
      },
    });
  }
  return {backup, hadData};
}

export async function activatePending(home) {
  const state = await optionalJson(join(home, 'state.json')) ?? {};
  if (!state.pending) return state;
  const {manifest} = await installed(home, state.pending);
  const snapshot = await backupData(home);
  const next = {
    ...state, ...snapshot,
    previous: state.current ?? null,
    current: state.pending,
    pending: null,
    probation: true,
    highestSequence: Math.max(state.highestSequence ?? 0, manifest.sequence),
  };
  await atomicJson(join(home, 'state.json'), next);
  return next;
}

export async function markHealthy(home) {
  const path = join(home, 'state.json');
  const state = await json(path);
  await atomicJson(path, {...state, probation: false});
}

export async function rejectCurrent(home) {
  const path = join(home, 'state.json');
  const state = await json(path);
  if (!state.probation || !state.previous) throw Error('No previous release available');
  await installed(home, state.previous);
  if (!/^before-[a-f0-9-]+$/.test(state.backup)) throw Error('Missing data backup');
  const data = join(home, 'data');
  await noLinks(data);
  try {
    await rename(data, join(home, 'backups', 'failed-' + randomUUID()));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (state.hadData) await cp(join(home, 'backups', state.backup, 'data'), data, {recursive: true});
  await atomicJson(path, {
    ...state,
    rejectedVersions: [...new Set([...(state.rejectedVersions ?? []), state.current])],
    rejected: state.current,
    current: state.previous,
    previous: null,
    probation: false,
  });
}

// Stable EXE protocol 1 dispatches this replaceable bootstrap. Only verified bundles may supply it.
export async function syncBootstrap(home,bundle){
  await verifyBundle(bundle.root,bundle.manifest);
  for(const name of ['Launch.ps1','Install.ps1','Uninstall.ps1']){
    if(!bundle.manifest.files.some(f=>f.path==='launcher/'+name))continue;
    const target=join(home,name);await noLinks(target);
    const temporary=target+'.'+randomUUID()+'.tmp';
    await cp(join(bundle.root,'launcher',name),temporary);await rename(temporary,target);
  }
}
