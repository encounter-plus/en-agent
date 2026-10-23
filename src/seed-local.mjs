// Developer-only seed from already installed binaries; never marks a release approved.
import {readdir,mkdir,cp,readFile,stat,chmod} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {atomicJson,noLinks,optionalJson} from './storage.mjs';
import {verifyBundle} from './releases.mjs';

const {values}=parseArgs({options:{home:{type:'string'},skills:{type:'string'},opencode:{type:'string'},id:{type:'string'},sequence:{type:'string'}}});
if(!values.home||!values.skills||!values.opencode)throw new Error('Required: --home --skills --opencode');
const home=resolve(values.home),skills=resolve(values.skills),binary=resolve(values.opencode);
const version=execFileSync(binary,['--version'],{encoding:'utf8',windowsHide:true}).trim().replace(/^opencode v/,'');
if(!/^2\.\d+\.\d+$/.test(version))throw new Error('Local seed requires OpenCode v2');
await noLinks(home);
if(await optionalJson(join(home,'state.json')))throw new Error('Local seed requires a fresh installation home');
const id=values.id;if(!id||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(id))throw Error('Required: explicit valid --id');const root=join(home,'releases',id);await mkdir(root,{recursive:true});
const project=fileURLToPath(new URL('../',import.meta.url));
const exe=process.platform==='win32'?'.exe':'';
await mkdir(join(root,'bin'),{recursive:true});
await cp(binary,join(root,'bin','opencode'+exe));await cp(process.execPath,join(root,'bin','node'+exe));
await cp(join(skills,'dist','skills'),join(root,'skills'),{recursive:true});
await cp(join(skills,'runtime','dist'),join(root,'runtime','dist'),{recursive:true});
await mkdir(join(root,'runtime','scripts'),{recursive:true});
await cp(join(skills,'runtime','scripts','windows-credential.ps1'),join(root,'runtime','scripts','windows-credential.ps1'));
await cp(join(project,'dist','tools-server.mjs'),join(root,'runtime','tools-server.mjs'));
for(const name of ['account-service','account-proxy'])await cp(join(project,'dist',name+'.mjs'),join(root,'runtime',name+'.mjs'));
await cp(join(project,'src'),join(root,'launcher','src'),{recursive:true});
await cp(join(project,'Launch.ps1'),join(root,'launcher','Launch.ps1'));
await cp(join(project,'Account.ps1'),join(root,'launcher','Account.ps1'));
await cp(join(project,'en-agent.vbs'),join(root,'launcher','en-agent.vbs'));
for(const name of ['Install.ps1','Uninstall.ps1'])await cp(join(project,name),join(root,'launcher',name));
await cp(join(project,'windows'),join(root,'launcher','windows'),{recursive:true});
await cp(join(project,'dist','en-agent.exe'),join(root,'launcher','en-agent.exe'));
for(const name of ['@playwright/mcp','playwright','playwright-core'])await cp(join(project,'node_modules',name),join(root,'browser','node_modules',name),{recursive:true});
if(process.platform!=='win32'){await chmod(join(root,'bin','opencode'),0o755);await chmod(join(root,'bin','node'),0o755);}

const files=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  const p=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Symlink in seed');
  if(entry.isDirectory())await walk(p);else {const bytes=await readFile(p);files.push({path:relative(root,p).replaceAll('\\','/'),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),executable:p.includes(join(root,'bin'))});}
}}
await walk(root);
const m={schemaVersion:1,bootstrapProtocol:1,id,sequence:Number(values.sequence??10),platform:process.platform,arch:process.arch,storageEpoch:2,opencode:{version,configVersion:2,path:'bin/opencode'+exe},nodePath:'bin/node'+exe,skillsVersion:JSON.parse(await readFile(join(skills,'package.json'))).version,mcpVersion:JSON.parse(await readFile(join(skills,'runtime/package.json'))).version,skillsPath:'skills',mcpPath:'runtime/dist/server.mjs',toolsPath:'runtime/tools-server.mjs',browserPath:'browser/node_modules/@playwright/mcp/cli.js',launcherPath:'launcher/src/cli.mjs',files};
m.accountPath='runtime/account-service.mjs';m.accountProxyPath='runtime/account-proxy.mjs';
await verifyBundle(root,m);await atomicJson(join(root,'release.json'),m);await atomicJson(join(home,'state.json'),{current:id,highestSequence:m.sequence,probation:false});
await cp(join(project,'Launch.ps1'),join(home,'Launch.ps1'));
await cp(join(project,'dist','en-agent.exe'),join(home,'en-agent.exe'));
for(const name of ['Install.ps1','Uninstall.ps1'])await cp(join(project,name),join(home,name));
console.log('Local development bundle seeded: '+root);
