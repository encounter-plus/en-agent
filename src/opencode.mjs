import {exaStore,exaEnvironment} from './exa.mjs';
import {browserMcpArgs} from './browser-choice.mjs';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {inside} from './storage.mjs';

export function configuration(root,m,home,accountEnvironment={},browserChoice,workspace) {
  const config={
    update:'disable',
    // Shared communication policy and selected-game memory; project config stays disabled.
    instructions:[inside(root,'launcher/src/agent-instructions.md'),...(workspace?[resolve(workspace,'AGENTS.md')]:[])],
    websearch:{provider:'exa'},
    skills:[inside(root,m.skillsPath)],
    mcp:{servers:{encounter:{type:'local',command:[inside(root,m.nodePath),inside(root,m.mcpPath)],disabled:false,codemode:false,timeout:{startup:30000,catalog:30000,execution:30000},environment:{ENCOUNTER_DATA_DIR:join(home,'data','encounter')}}}},
  };
  if(m.accountProxyPath){config.mcp.servers.encounter.command=[inside(root,m.nodePath),inside(root,m.accountProxyPath),inside(root,m.mcpPath)];Object.assign(config.mcp.servers.encounter.environment,accountEnvironment);config.mcp.servers.encounter.timeout={startup:60000,catalog:30000,execution:120000};}
  if(m.toolsPath)config.mcp.servers.author_tools={type:'local',command:[inside(root,m.nodePath),inside(root,m.toolsPath)],disabled:false,codemode:false,timeout:{startup:30000,catalog:30000,execution:30000}};
  // A cold browser launch plus its navigation can outlive a 30s MCP call.
  if(m.browserPath)config.mcp.servers.browser={type:'local',command:[inside(root,m.nodePath),inside(root,m.browserPath),...browserMcpArgs(browserChoice,home)],disabled:false,codemode:false,timeout:{startup:60000,catalog:30000,execution:150000}};
  return config;
}
export async function freePort() {
  const server=createServer();await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  const port=server.address().port;await new Promise(ok=>server.close(ok));return port;
}
export async function openGui(url) {
  const command=process.platform==='win32'?'powershell.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',"Start-Process -FilePath '"+url.replaceAll("'","''")+"'"]:[url];
  await new Promise((resolve,reject)=>{const child=spawn(command,args,{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Could not open OpenCode GUI')));});
}
export async function waitForMcp(runtime,workspace,names,{timeout=90000,onStatus=async()=>{}}={}) {
  const deadline=Date.now()+timeout;
  let previous;
  while(Date.now()<deadline) {
    const response=await runtime.request('/api/mcp?'+new URLSearchParams({'location[directory]':workspace}));
    if(!response.ok)throw new Error('MCP status endpoint failed');
    const status=await response.json();
    if(!Array.isArray(status.data))throw new Error('Invalid OpenCode v2 MCP response');
    const states=names.map(name=>({name,status:status.data.find(item=>item.name===name)?.status?.status}));
    const serialized=JSON.stringify(states);if(serialized!==previous){await onStatus(Object.fromEntries(states.map(x=>[x.name,x.status])));previous=serialized;}
    if(states.every(item=>item.status==='connected'))return;
    const failed=states.find(item=>['failed','disabled','needs_auth'].includes(item.status));
    if(failed)throw new Error(failed.name+' MCP is '+failed.status);
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error('MCP readiness timed out');
}
export async function stopTree(child) {
  if(child.exitCode!==null||!child.pid)return;
  if(process.platform==='win32')await new Promise(resolve=>{
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.once('error',resolve);killer.once('exit',resolve);
  });
  else {try{process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}}
}
export async function startOpenCode({root,manifest:m},home,workspace,{timeout=60000,accountEnvironment={},browserChoice}={}) {
  const port=await freePort();
  const password=randomBytes(32).toString('hex');
  const data=join(home,'data');await mkdir(data,{recursive:true});
  const searchEnv=process.platform==='win32'?await exaEnvironment(exaStore(root,home),process.env):process.env;
  const env={...searchEnv,
    XDG_DATA_HOME:join(data,'share'),XDG_CONFIG_HOME:join(data,'config'),XDG_CACHE_HOME:join(data,'cache'),XDG_STATE_HOME:join(data,'state'),
    OPENCODE_CONFIG_CONTENT:JSON.stringify(configuration(root,m,home,accountEnvironment,browserChoice,workspace)),OPENCODE_CONFIG_PROJECT_DISABLE:'true',OPENCODE_PASSWORD:password,
  };
  // Stdio mode owns its lifecycle and removes the server password before starting tools.
  const child=spawn(inside(root,m.opencode.path),['serve','--stdio','--hostname','127.0.0.1','--port',String(port)],{cwd:workspace,env,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
  let error;child.on('error',e=>{error=e;});
  // Drain output without exposing prompts or credential-bearing diagnostics.
  child.stdout.resume();child.stderr.resume();
  const url=`http://127.0.0.1:${port}`;
  const request=(path,options={})=>fetch(url+path,{...options,headers:{...options.headers,Authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64')},signal:options.signal??AbortSignal.timeout(45000)});
  const pair=async()=>{const response=await request('/api/pair',{method:'POST'});if(!response.ok)throw new Error('OpenCode pairing failed');const {code}=await response.json();if(typeof code!=='string'||!code)throw new Error('Invalid pairing response');return url+'/auth/connect/'+encodeURIComponent(code);};
  try {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) {
      if(error)throw error;if(child.exitCode!==null)throw new Error('OpenCode exited before readiness');
      try {
        const response=await request('/api/info',{signal:AbortSignal.timeout(1000)});
        const status=await response.json();
        if(response.ok&&status.version===m.opencode.version)return {child,url,request,pair,stop:()=>stopTree(child)};
      } catch {}
      await new Promise(r=>setTimeout(r,200));
    }
    throw new Error('OpenCode readiness/version check failed');
  } catch(e) {await stopTree(child);throw e;}
}
