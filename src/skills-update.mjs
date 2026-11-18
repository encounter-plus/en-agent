import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {compareSkillsVersions,updateSkills} from './skills-store.mjs';
import {noLinks} from './storage.mjs';
import {systemPowerShell} from './windows-powershell.mjs';

const repository='https://github.com/encounter-plus/en-skills';
export const skillsReleaseUrl='https://api.github.com/repos/encounter-plus/en-skills/releases/latest';
async function download(url,limit,fetcher,callerSignal) {
  const timeout=AbortSignal.timeout(60000),signal=callerSignal?AbortSignal.any([callerSignal,timeout]):timeout;
  for(let i=0;i<6;i++){
    const address=new URL(url);
    if(address.protocol!=='https:'||address.username||address.password||address.port||!['github.com','api.github.com','release-assets.githubusercontent.com'].includes(address.hostname))throw Error('Unexpected skills download origin');
    const response=await fetcher(url,{redirect:'manual',signal,headers:{Accept:'application/vnd.github+json','User-Agent':'en-agent-skills-updater'}});
    if([301,302,303,307,308].includes(response.status)){
      const target=response.headers.get('location');await response.body?.cancel();if(!target)throw Error('Invalid skills redirect');url=new URL(target,url).href;continue;
    }
    if(!response.ok){await response.body?.cancel();throw Error('Skills download failed: '+response.status);}
    const parts=[];let size=0;
    for await(const part of response.body){size+=part.length;if(size>limit)throw Error('Skills download size limit exceeded');parts.push(part);}
    return Buffer.concat(parts);
  }
  throw Error('Too many skills redirects');
}

export async function extractSkillsArchive(archive,destination,bundleRoot,{signal}={}) {
  const script=join(bundleRoot,'launcher','src','extract-skills.ps1');await noLinks(script);
  await promisify(execFile)(systemPowerShell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Archive',archive,'-Destination',destination],{windowsHide:true,timeout:60000,maxBuffer:1024*1024,signal});
}

export async function updateEnSkills(home,bundleRoot,{fetcher=fetch,extract=extractSkillsArchive,signal}={}) {
  let work;
  try {
    return await updateSkills(home,async current=>{
      const release=JSON.parse((await download(skillsReleaseUrl,2*1024*1024,fetcher,signal)).toString('utf8'));
      const version=release.tag_name?.replace(/^v/,'');
      compareSkillsVersions(version,version);
      if(release.draft!==false||release.prerelease!==false||!Array.isArray(release.assets))throw Error('A stable official skills release is required');
      if(compareSkillsVersions(version,current)<=0)return null;
      const name='en-skills-'+version+'.zip',url=repository+'/releases/download/'+release.tag_name+'/'+name;
      const asset=release.assets.find(a=>a.name===name),checksum=release.assets.find(a=>a.name===name+'.sha256');
      if(!asset||!checksum||asset.browser_download_url!==url||checksum.browser_download_url!==url+'.sha256')throw Error('Official skills ZIP and checksum are required');
      const sum=(await download(checksum.browser_download_url,4096,fetcher,signal)).toString('utf8').trim();
      const match=/^([a-f0-9]{64})\s+\*?([^\r\n]+)$/i.exec(sum);
      if(!match||match[2]!==name)throw Error('Invalid skills checksum file');
      const bytes=await download(asset.browser_download_url,32*1024*1024,fetcher,signal);
      const digest=createHash('sha256').update(bytes).digest('hex');
      if(digest!==match[1].toLowerCase()||asset.digest&&asset.digest!=='sha256:'+digest)throw Error('Skills archive checksum mismatch');
      // Transient extraction must never race the application snapshot of data/.
      const staging=join(home,'skills-staging');await noLinks(staging);await mkdir(staging,{recursive:true});
      work=await mkdtemp(join(staging,'download-'));const archive=join(work,'skills.zip'),directory=join(work,'skills');
      signal?.throwIfAborted();await writeFile(archive,bytes,{flag:'wx'});await extract(archive,directory,bundleRoot,{signal});
      return {version,directory,source:repository+'/releases/tag/'+release.tag_name};
    },{signal});
  } finally {
    // An antivirus lock on disposable staging must not turn a committed update into a reported failure.
    if(work)await rm(work,{recursive:true,force:true}).catch(()=>{});
  }
}
