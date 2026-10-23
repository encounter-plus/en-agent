import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const execute=promisify(execFile);
export async function installationId(home) {
  let path=await realpath(home);if(process.platform==='win32')path=path.toLowerCase();
  return createHash('sha256').update(path).digest('hex');
}
// null means confirmed absent; failures mean unknown and must not unlock anything.
export async function processIdentity(pid) {
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid owner PID');
  if(process.platform==='win32'){
    const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'absent' } else { $p.StartTime.ToUniversalTime().Ticks.ToString() }`],{windowsHide:true,timeout:10000});
    const value=stdout.trim();if(value==='absent')return null;if(!/^\d+$/.test(value))throw Error('Cannot verify process owner');return value;
  }
  if(process.platform==='linux'){
    try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');return (await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  throw Error('Process identity is unsupported on this platform');
}
