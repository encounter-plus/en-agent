import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {installationId} from './process-identity.mjs';
import {noLinks} from './storage.mjs';
import {join} from 'node:path';
import {systemPowerShell} from './windows-powershell.mjs';

// The mutex and pointer commit live in the same process. A lost guard cannot
// leave the Node writer capable of committing after another writer takes over.
export async function lockSkills(directory,{waitMs=0,signal}={}) {
  if(process.platform!=='win32')throw Error('Managed skills storage requires Windows');
  if(!Number.isInteger(waitMs)||waitMs<0||waitMs>30000)throw Error('Invalid skills lock wait');
  signal?.throwIfAborted();await noLinks(directory);await mkdir(directory,{recursive:true});
  const name='Local\\en-agent-skills-'+await installationId(directory);
  const target=join(directory,'state.json');await noLinks(target);
  const script=`$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$mutex=New-Object Threading.Mutex($false,'${name}')
$owned=$false
try {
  try { $owned=$mutex.WaitOne(${waitMs}) } catch [Threading.AbandonedMutexException] { $owned=$true }
  if (!$owned) { exit 2 }
  [Console]::Out.WriteLine('locked'); [Console]::Out.Flush()
  while ($null -ne ($line=[Console]::In.ReadLine())) {
    $message=$line | ConvertFrom-Json
    if ($message.op -ne 'commit') { throw 'Unknown skills operation' }
    $target=$env:EN_AGENT_SKILLS_STATE_TARGET
    if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Skills state link forbidden' }
    $temporary=$target+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($temporary,$message.json+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temporary,$target,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$target) }
    [Console]::Out.WriteLine('committed'); [Console]::Out.Flush()
  }
} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }`;
  const child=spawn(systemPowerShell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,EN_AGENT_SKILLS_STATE_TARGET:target}});
  child.stderr.resume();child.stdin.on('error',()=>{});
  let ready=false,closed=false,releasing=false,pending,buffer='';
  let resolveReady,rejectReady;
  const acquired=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const failed=error=>{closed=true;rejectReady(error);pending?.reject(error);pending=undefined;};
  child.once('error',failed);
  const exited=new Promise(resolve=>child.once('exit',code=>{
    const error=Error(!ready&&code===2?'Skills update is already running':'Skills lock helper stopped; commit may be incomplete');
    if(!ready&&code===2)error.code='SKILLS_BUSY';
    failed(error);
    resolve();
  }));
  child.stdout.on('data',bytes=>{
    buffer+=bytes.toString();let end;
    while((end=buffer.indexOf('\n'))!==-1){
      const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
      if(line==='locked'){ready=true;resolveReady();}
      if(line==='committed'){pending?.resolve();pending=undefined;}
    }
  });
  const abort=()=>{failed(signal.reason??Error('Skills operation cancelled'));child.kill();};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const timer=setTimeout(()=>{failed(Error('Skills lock startup timed out'));child.kill();},waitMs+10000);
  try{await acquired;}catch(error){signal?.removeEventListener('abort',abort);throw error;}finally{clearTimeout(timer);}
  return {
    async commit(state){
      signal?.throwIfAborted();if(closed||releasing)throw Error('Skills lock is no longer held');
      if(pending)throw Error('Skills commit is already pending');
      await noLinks(target);
      if(closed||releasing)throw Error('Skills lock is no longer held');
      await new Promise((resolve,reject)=>{
        pending={resolve,reject};
        child.stdin.write(JSON.stringify({op:'commit',json:JSON.stringify(state)})+'\n',error=>{if(error){pending?.reject(error);pending=undefined;}});
      });
    },
    async release(){
      if(releasing)return;releasing=true;signal?.removeEventListener('abort',abort);child.stdin.end();
      if(closed)return;
      const timer=setTimeout(()=>child.kill(),5000);try{await exited;}finally{clearTimeout(timer);}
    },
  };
}
