import {win32} from 'node:path';
// Never search the game's cwd or PATH for a trusted helper executable.
const windows=process.env.SystemRoot??process.env.WINDIR??'C:\\Windows';
if(!win32.isAbsolute(windows))throw Error('Windows directory must be absolute');
export const systemPowerShell=win32.join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe');
