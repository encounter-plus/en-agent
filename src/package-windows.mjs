import {parseArgs} from 'node:util';
import {readFile,mkdir,cp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {signedManifest,verifyBundle} from './releases.mjs';
import {json,atomicJson,inside,noLinks} from './storage.mjs';
const {values}=parseArgs({options:{bundle:{type:'string'},envelope:{type:'string'},'public-key':{type:'string'},out:{type:'string'}}});
if(!values.bundle||!values.envelope||!values['public-key']||!values.out)throw Error('Required: --bundle --envelope --public-key --out');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 packaging host required');
const source=resolve(values.bundle),out=resolve(values.out);await noLinks(source);await noLinks(out);
const publicKey=await readFile(resolve(values['public-key']),'utf8');const manifest=signedManifest(await json(resolve(values.envelope)),publicKey);await verifyBundle(source,manifest);
const name='en-agent-'+manifest.id+'-windows-x64',root=join(out,name),release=join(root,'releases',manifest.id);await mkdir(out,{recursive:true});await mkdir(root);await mkdir(release,{recursive:true});
// Copy only authenticated release files, never the installation's data or credentials.
for(const f of manifest.files){if(/(^|\/)(data|backups|\.local|\.git)(\/|$)/.test(f.path))throw Error('Private directory in release');const destination=inside(release,f.path);await mkdir(resolve(destination,'..'),{recursive:true});await cp(inside(source,f.path),destination);}
await atomicJson(join(release,'release.json'),manifest);await verifyBundle(release,manifest);
for(const name of ['Launch.ps1','en-agent.exe','Install.ps1','Uninstall.ps1'])await cp(join(release,'launcher',name),join(root,name));
await atomicJson(join(root,'state.json'),{current:manifest.id,highestSequence:manifest.sequence,probation:false,pending:null});
await atomicJson(join(root,'channel.json'),{manifestUrl:'https://github.com/encounter-plus/en-agent-updates/releases/latest/download/channel.json',assetsUrl:'https://github.com/encounter-plus/en-agent-updates/releases/download/',publicKey});
await writeFile(join(root,'START-HERE.txt'),'\uFEFFen-agent — Windows x64\r\n\r\n1. Extract the whole ZIP to a permanent writable folder. Do not run inside the ZIP.\r\n2. Double-click en-agent.exe. No Node, Git or build is required.\r\n3. Choose the agent browser and a game folder.\r\n4. Connect your model provider in OpenCode.\r\n5. Use Account Encounter in the launcher when needed.\r\n\r\nRequirements: Windows 10/11 x64, Chrome or Edge, internet, Windows PowerShell and .NET Framework 4.8.\r\nClose the launcher to stop the local server. Closing the browser tab alone does not stop it.\r\nKeep this folder: settings and chats are stored here. Updates apply on the next launch.\r\nRelease channel becomes available after the publisher uploads the signed release assets.\r\n');
const archive=join(out,name+'.zip');const quote=s=>"'"+s.replaceAll("'","''")+"'";
await new Promise((ok,fail)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Compress-Archive -LiteralPath ${quote(root)} -DestinationPath ${quote(archive)} -CompressionLevel Optimal`],{windowsHide:true,stdio:'inherit'});child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error('ZIP creation failed')));});
const bytes=await readFile(archive);await writeFile(archive+'.sha256',createHash('sha256').update(bytes).digest('hex')+'  '+name+'.zip\n');console.log('Windows package prepared: '+archive+' ('+bytes.length+' bytes). Nothing published.');
